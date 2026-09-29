import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { createHash, generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { FakeRedis, storageMock, TEST_CTX, unscopedDataKeys } from './fake-redis';

// Plaid's webhooks (lib/plaid-webhook.ts and its route): only a genuine one may
// do anything, and what it does is drop the container's cached payloads.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const ctx = TEST_CTX;

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'ES256', expired_at: null as number | null };
let lookups = 0;
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    webhookVerificationKeyGet: async (req: any) => {
      lookups++;
      if (req.key_id !== 'k1') throw new Error('unknown key');
      return { data: { key: jwk } };
    },
  },
}));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { writeCache, readCache, CacheKey } = await import('@/lib/cache');
const { registerTestContainer } = await import('./fake-redis');
const { verifyWebhook, WebhookRejected, invalidates, forgetKeys } = await import('@/lib/plaid-webhook');
const { POST } = await import('@/app/api/plaid/webhook/route');

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(body: string, over: { iat?: number; hash?: string; alg?: string; kid?: string } = {}) {
  const head = b64({ alg: over.alg ?? 'ES256', kid: over.kid ?? 'k1', typ: 'JWT' });
  const claims = b64({
    iat: over.iat ?? Math.floor(Date.now() / 1000),
    request_body_sha256: over.hash ?? createHash('sha256').update(body).digest('hex'),
  });
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${head}.${claims}.${sig.toString('base64url')}`;
}

const errors = console.error;
beforeEach(async () => {
  fake.reset();
  lookups = 0;
  forgetKeys();
  jwk.expired_at = null;
  console.error = () => {};
  await registerTestContainer(fake);
});
afterEach(() => {
  console.error = errors;
});

describe('verifying a webhook', () => {
  const body = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item1' });
  const refused = async (body: string, header: string | null) => {
    try {
      await verifyWebhook(body, header);
    } catch (err) {
      return err instanceof WebhookRejected ? err.message : `other: ${String(err)}`;
    }
    return 'accepted';
  };

  test('accepts a genuine one', async () => {
    expect(await refused(body, token(body))).toBe('accepted');
  });

  test('refuses a missing, malformed or forged signature', async () => {
    expect(await refused(body, null)).toContain('missing');
    expect(await refused(body, 'a.b')).toContain('malformed');
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const [h, p] = token(body).split('.');
    const forged = sign('sha256', Buffer.from(`${h}.${p}`), { key: other.privateKey, dsaEncoding: 'ieee-p1363' });
    expect(await refused(body, `${h}.${p}.${forged.toString('base64url')}`)).toBe('bad signature');
  });

  test('refuses a body that is not the one signed', async () => {
    expect(await refused(body.replace('item1', 'item2'), token(body))).toBe('body does not match');
  });

  test('refuses an old one, and an algorithm the token names for itself', async () => {
    expect(await refused(body, token(body, { iat: Math.floor(Date.now() / 1000) - 3600 }))).toBe('stale or undated');
    expect(await refused(body, token(body, { alg: 'none' }))).toBe('unexpected algorithm');
    expect(await refused(body, token(body, { alg: 'HS256' }))).toBe('unexpected algorithm');
  });

  test('refuses an unknown or expired key', async () => {
    expect(await refused(body, token(body, { kid: 'nope' }))).toBe('unknown key');
    jwk.expired_at = Math.floor(Date.now() / 1000) - 10;
    expect(await refused(body, token(body))).toBe('key expired');
  });
});

describe('the key lookups', () => {
  const body = '{}';
  const verifyAt = (t: string, now: number) => verifyWebhook(body, t, now).then(() => 'ok', (e) => e.message);

  test('a key is looked up once, then again after a day', async () => {
    const now = Date.now();
    expect(await verifyAt(token(body), now)).toBe('ok');
    expect(await verifyAt(token(body), now + 1000)).toBe('ok');
    expect(lookups).toBe(1);
    expect(await verifyAt(token(body), now + 25 * 3600_000)).toBe('stale or undated'); // token is a day old by then
    expect(lookups).toBe(2);
  });

  test('a key that expired after it was cached is refused', async () => {
    const now = Date.now();
    expect(await verifyAt(token(body), now)).toBe('ok');
    jwk.expired_at = Math.floor(now / 1000) + 60;
    expect(await verifyAt(token(body), now + 120_000)).toBe('key expired');
  });

  test('an unknown key id costs one Plaid call a minute, not one per request', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) expect(await verifyAt(token(body, { kid: 'nope' }), now + i)).toBe('unknown key');
    expect(lookups).toBe(1);
    expect(await verifyAt(token(body, { kid: 'nope' }), now + 61_000)).toBe('unknown key');
    expect(lookups).toBe(2);
  });
});

describe('the lookup cap', () => {
  test('ids never seen before cost at most 20 Plaid calls a minute in all', async () => {
    const now = Date.now();
    const tries = Array.from({ length: 30 }, (_, i) => verifyWebhook('{}', token('{}', { kid: `nope${i}` }), now).catch((e) => e.message));
    await Promise.all(tries);
    expect(lookups).toBe(20);
    // A minute later the cap has reset, and the real key still works.
    await verifyWebhook('{}', token('{}'), now + 61_000).catch(() => {});
    expect(lookups).toBe(21);
  });
});

describe('what changes the data', () => {
  test('new data and Item trouble do; everything else does not', () => {
    for (const b of [
      { webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE' },
      { webhook_type: 'HOLDINGS', webhook_code: 'DEFAULT_UPDATE' },
      { webhook_type: 'LIABILITIES', webhook_code: 'DEFAULT_UPDATE' },
      { webhook_type: 'ITEM', webhook_code: 'ERROR' },
      { webhook_type: 'ITEM', webhook_code: 'PENDING_EXPIRATION' },
    ]) expect(invalidates(b)).toBe(true);
    for (const b of [
      { webhook_type: 'TRANSACTIONS', webhook_code: 'RECURRING_TRANSACTIONS_UPDATE' },
      { webhook_type: 'ITEM', webhook_code: 'WEBHOOK_UPDATE_ACKNOWLEDGED' },
      { webhook_type: 'AUTH', webhook_code: 'DEFAULT_UPDATE' },
      {},
    ]) expect(invalidates(b)).toBe(false);
  });
});

describe('the route', () => {
  const hook = (over: Record<string, unknown> = {}) => ({
    webhook_type: 'TRANSACTIONS',
    webhook_code: 'SYNC_UPDATES_AVAILABLE',
    item_id: 'item1',
    ...over,
  });
  async function call(body: unknown, opts: { container?: string | null; header?: string | null } = {}) {
    const text = JSON.stringify(body);
    const c = opts.container === undefined ? ctx.container : opts.container;
    const url = `https://nya.example/api/plaid/webhook${c ? `?c=${c}` : ''}`;
    const headers: Record<string, string> = {};
    const header = opts.header === undefined ? token(text) : opts.header;
    if (header) headers['plaid-verification'] = header;
    return POST(new Request(url, { method: 'POST', body: text, headers }));
  }
  const cached = async () => (await readCache(ctx, CacheKey.NetWorth)) !== null;

  beforeEach(async () => {
    await saveItem(ctx, { item_id: 'item1', institution_name: 'Bank', encrypted_access_token: await encrypt('tok') });
    await writeCache(ctx, CacheKey.NetWorth, { netWorth: 1 });
  });

  test('a genuine webhook for an Item of the container drops its caches', async () => {
    expect(await cached()).toBe(true);
    expect((await call(hook())).status).toBe(200);
    expect(await cached()).toBe(false);
  });

  test('an unsigned or forged one is a 401 and touches nothing', async () => {
    expect((await call(hook(), { header: null })).status).toBe(401);
    expect((await call(hook(), { header: token('{}') })).status).toBe(401);
    expect(await cached()).toBe(true);
  });

  test('a genuine one for an unknown Item, another container or no container is ignored', async () => {
    expect((await call(hook({ item_id: 'someone_elses' }))).status).toBe(200);
    expect((await call(hook(), { container: randomUUID() })).status).toBe(200);
    expect((await call(hook(), { container: null })).status).toBe(200);
    expect((await call(hook(), { container: 'not-a-container' })).status).toBe(200);
    expect(await cached()).toBe(true);
  });

  test('one that changes nothing leaves the caches', async () => {
    expect((await call(hook({ webhook_code: 'RECURRING_TRANSACTIONS_UPDATE' }))).status).toBe(200);
    expect(await cached()).toBe(true);
  });
});
