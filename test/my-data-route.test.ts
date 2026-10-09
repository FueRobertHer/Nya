import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, testKey, ctxKey, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { parseCsv } from './csv-parse';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveManualAccount } = await import('@/lib/manual');
const { setBudgets } = await import('@/lib/budgets');
const { ownerContainer } = await import('@/lib/owners');
const { DOWNLOADS_PER_WINDOW, LOGIN_MAX_FAILURES } = await import('@/lib/rate-limit');
const route = await import('@/app/api/my-data/route');

const IP = '203.0.113.7';
const post = (body: unknown, ip = IP) =>
  route.POST(
    new Request('http://x/api/my-data', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );

const manual = (id: string, name: string) =>
  ({ account_id: id, name, institution_name: 'By hand', type: 'depository', subtype: null, balance: 10, updated_at: '2026-09-01T00:00:00.000Z' }) as const;

/** Quiet console.log and console.error for one call, keeping what was said. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; said: string[] }> {
  const said: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...a: unknown[]) => void said.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => void said.push(a.map(String).join(' '));
  try {
    return { result: await fn(), said };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  (await import('@/lib/auth-mode')).forgetEmails();
  await registerTestContainer(fake);
  clerk.signedIn = null;
  clerk.reverified = true;
});
afterEach(() => {
  process.env = { ...saved };
  clerk.signedIn = null;
  clerk.reverified = true;
});

describe('with the shared password', () => {
  beforeEach(async () => {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_SECRET_KEY;
    process.env.APP_PASSWORD = 'hunter2';
    process.env.SESSION_SECRET = 'test-session-secret';
    await saveManualAccount(TEST_CTX, manual('manual_mine', 'Piggy bank') as any);
    await setBudgets(TEST_CTX, { Food: 400 });
  });

  test('the password again, then the whole file, as an attachment nobody keeps a copy of', async () => {
    const { result: res, said } = await quietly(() => post({ format: 'json', password: 'hunter2' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="nya-data-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // The size goes ahead of the body, twice (one survives an edge that
    // compresses), and it is what arrives: the page checks it before saving.
    const body = new Uint8Array(await res.arrayBuffer());
    expect(res.headers.get('content-length')).toBe(String(body.byteLength));
    expect(res.headers.get('x-nya-export-bytes')).toBe(String(body.byteLength));
    const doc = JSON.parse(new TextDecoder().decode(body));
    expect(doc).toMatchObject({ format: 'nya-export', version: 1, sharing: null, budgets: [{ category: 'Food', monthly_amount: 400 }] });
    expect(doc.manual_accounts.map((m: { name: string }) => m.name)).toEqual(['Piggy bank']);
    // The log says a download happened, and nothing of what was in it.
    expect(said).toEqual(['Data download: json']);
  });

  test('a wrong or missing password is refused with a 403, never the 401 that means signed out', async () => {
    for (const body of [{ format: 'json', password: 'nope' }, { format: 'json' }, { format: 'json', password: '' }]) {
      const res = await post(body);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ wrong_password: true });
    }
    // Counted with the login's wrong passwords, per IP.
    expect(Number(await fake.get(testKey(`ratelimit:login:${IP}`)))).toBe(3);
    // Nothing was downloaded, so no download was counted.
    expect(await fake.get(ctxKey('download-count'))).toBeNull();
  });

  test('after the login’s limit of wrong passwords, even the right one waits', async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await post({ format: 'json', password: 'nope' });
    expect((await post({ format: 'json', password: 'hunter2' })).status).toBe(429);
    // The login sees the same count: this route can't be used to guess faster.
    const login = await import('@/app/api/login/route');
    const res = await login.POST(new Request('http://x/api/login', { method: 'POST', headers: { 'x-forwarded-for': IP }, body: JSON.stringify({ password: 'hunter2' }) }));
    expect(res.status).toBe(429);
  });

  test('the right password clears the wrong ones', async () => {
    await post({ format: 'json', password: 'nope' });
    expect((await quietly(() => post({ format: 'json', password: 'hunter2' }))).result.status).toBe(200);
    expect(await fake.get(testKey(`ratelimit:login:${IP}`))).toBeNull();
  });

  test(`${DOWNLOADS_PER_WINDOW} downloads an hour, then a 429 that says when`, async () => {
    for (let i = 0; i < DOWNLOADS_PER_WINDOW; i++) {
      const { result } = await quietly(() => post({ format: 'balances-csv', password: 'hunter2' }));
      expect(result.status).toBe(200);
      await result.text();
    }
    const res = await post({ format: 'json', password: 'hunter2' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect((await res.json()).error).toBe(`You can download your data ${DOWNLOADS_PER_WINDOW} times an hour. Try again in 60 minutes.`);
  });

  test('turned away for the limit before the password is even checked', async () => {
    await fake.set(ctxKey('download-count'), String(DOWNLOADS_PER_WINDOW));
    expect((await post({ format: 'json', password: 'nope' })).status).toBe(429);
    expect(await fake.get(testKey(`ratelimit:login:${IP}`))).toBeNull();
  });

  test('a limit that can’t be read stops the download', async () => {
    fake.failNext('eval');
    const res = await post({ format: 'json', password: 'hunter2' });
    expect(res.status).toBe(503);
  });

  test('a store that can’t be read: a 500 naming it, no file, and a log that names no bank', async () => {
    await fake.hset(ctxKey('plaid:items'), {
      item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Secret Credit Union', institution_id: null, encrypted_access_token: await encrypt('t') }),
    });
    await fake.set(ctxKey('txns:item_a'), 'garbage-ciphertext');
    const { result: res, said } = await quietly(() => post({ format: 'json', password: 'hunter2' }));
    expect(res.status).toBe(500);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect((await res.json()).error).toStartWith('Your transactions from Secret Credit Union could not be read, so nothing was downloaded');
    expect(said).toEqual(['Data download stopped: transactions could not be read (StateUnreadableError)']);
  });

  test('a stored value of a shape the file can’t be written from: the route’s own 500, nothing sent, a log naming only the error’s class', async () => {
    await fake.hset(ctxKey('plaid:items'), {
      item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', institution_id: null, encrypted_access_token: await encrypt('t') }),
    });
    // Counterparties that aren't a list: the CSV writer can't flatten them,
    // which the counting pass finds before the first byte.
    await fake.set(
      ctxKey('txns:item_a'),
      await encodeJsonBlob({ schema_version: 2, cursor: '', accounts: {}, txns: { t1: { transaction_id: 't1', account_id: 'a1', date: '2026-01-02', amount: 5, name: 'X', pending: false, counterparties: { name: 'SECRET-PAYEE' }, account_name: 'Checking', institution_name: 'Chase' } } })
    );
    const { result: res, said } = await quietly(() => post({ format: 'transactions-csv', password: 'hunter2' }));
    expect(res.status).toBe(500);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('x-nya-export-bytes')).toBeNull();
    expect(await res.json()).toEqual({ error: 'The download could not be prepared, so nothing was downloaded. Try again later.' });
    // Not logged as a download, and nothing from the data in the log.
    expect(said).toEqual(['Data download failed TypeError']);
  });

  test('the CSVs, and a caveat about the data travelling with them', async () => {
    await fake.hset(ctxKey('plaid:items'), {
      item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', institution_id: null, encrypted_access_token: await encrypt('t') }),
    });
    await fake.set(
      ctxKey('txns:item_a'),
      await encodeJsonBlob({ schema_version: 2, cursor: '', accounts: {}, txns: { t1: { transaction_id: 't1', account_id: 'a1', date: '2026-01-02', amount: 5, name: 'X', pending: false, counterparties: [], account_name: 'Checking', institution_name: 'Chase' } } })
    );
    await fake.set(ctxKey('txns-unsaved:item_a'), '2026-10-01T00:00:00.000Z');
    const { result: res } = await quietly(() => post({ format: 'transactions-csv', password: 'hunter2' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/filename="nya-transactions-\d{4}-\d{2}-\d{2}\.csv"/);
    const notes = JSON.parse(decodeURIComponent(res.headers.get('x-nya-export-notes')!));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Chase');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(res.headers.get('x-nya-export-bytes')).toBe(String(body.byteLength));
    // UTF-8 with a byte order mark (EF BB BF), for Excel.
    expect([...body.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const rows = parseCsv(new TextDecoder('utf-8', { ignoreBOM: true }).decode(body));
    expect(rows).toHaveLength(2);
  });

  test('every field is checked', async () => {
    for (const body of ['not json', [], { format: 'xml', password: 'hunter2' }, { password: 'hunter2' }, { format: 'json', password: 42 }, { format: 'json', password: 'x'.repeat(1025) }]) {
      expect((await post(body)).status).toBe(400);
    }
  });
});

describe('with Clerk', () => {
  let other: { container: any };
  beforeEach(async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    process.env.CLERK_ALLOWED_USER_IDS = 'user_a,user_b';
    await ownerContainer('user_a'); // claims the test container
    other = { container: await ownerContainer('user_b') };
    await saveManualAccount(TEST_CTX, manual('manual_a', 'Alex savings') as any);
    await saveManualAccount(other as any, manual('manual_b', 'Bea savings') as any);
  });

  test('a recent sign-in gets the signed-in person’s own data, and only theirs', async () => {
    clerk.signedIn = 'user_b';
    const { result: res } = await quietly(() => post({ format: 'json' }));
    expect(res.status).toBe(200);
    const doc = JSON.parse(await res.text());
    expect(doc.manual_accounts.map((m: { name: string }) => m.name)).toEqual(['Bea savings']);
    expect(JSON.stringify(doc)).not.toContain('Alex savings');
    expect(doc.sharing).toEqual({ connections: [], blocked: [], ended: [] });
  });

  test('a sign-in that isn’t recent gets Clerk’s reverification hint, and uses up nothing', async () => {
    clerk.signedIn = 'user_a';
    clerk.reverified = false;
    const res = await post({ format: 'json' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ clerk_error: { type: 'forbidden', reason: 'reverification-error', metadata: { reverification: 'strict' } } });
    expect(await fake.get(ctxKey('download-count'))).toBeNull();
    // Once confirmed, the same request goes through.
    clerk.reverified = true;
    expect((await quietly(() => post({ format: 'json' }))).result.status).toBe(200);
  });

  test('a password is not what Clerk asks for', async () => {
    clerk.signedIn = 'user_a';
    clerk.reverified = false;
    expect((await post({ format: 'json', password: 'anything' })).status).toBe(403);
  });

  test('signed out, nothing is read', async () => {
    // The proxy answers 401 before this route runs; reaching it signed out
    // anyway, the container can't be resolved, as on every route.
    const { result: res } = await quietly(() => post({ format: 'json' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  test('each person’s limit is their own', async () => {
    clerk.signedIn = 'user_a';
    for (let i = 0; i < DOWNLOADS_PER_WINDOW; i++) await (await quietly(() => post({ format: 'balances-csv' }))).result.text();
    expect((await post({ format: 'balances-csv' })).status).toBe(429);
    clerk.signedIn = 'user_b';
    expect((await quietly(() => post({ format: 'balances-csv' }))).result.status).toBe(200);
  });
});
