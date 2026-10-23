import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime, spyOn } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Writing through the API (lib/api-writes.ts, lib/api-run.ts): each write the
// same stored result as the app's own route makes, the gate every operation
// passes (access, the switch, the limits), versions and idempotency keys,
// strict bodies, what no write can reach, and a token never reaching another
// container. The record of changes and undo are test/api-changes.test.ts; the
// MCP tools test/mcp-writes.test.ts.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy({}, { get: () => async () => { throw new Error('Plaid must not be called'); } }),
}));
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx, OTHER, daysAgo, seedPerson, seedOther } = await import('./api-fixture');
const { createToken } = await import('@/lib/api-tokens');
const { apiTokenStore } = await import('@/lib/api-token-store');
const { forgetEpochs } = await import('@/lib/sessions');
const { decryptJsonText } = await import('@/lib/blob');
const spec = await import('@/lib/api-spec');
const limits = await import('@/lib/api-limits');
const { MANUAL_TYPES, MAX_MANUAL_ACCOUNTS, MAX_BALANCE, getManualAccount, saveManualAccount } = await import('@/lib/manual');
const { TAG_COLORS, TAG_NAME_MAX, MAX_TAGS, MAX_TAGS_PER_TRANSACTION, readTagSet } = await import('@/lib/tags');
const { NAME_MAX, ICON_MAX, MAX_CATEGORIES, MAX_GROUPS } = await import('@/lib/categories');
const { MAX_PAYEE_CHARS, MAX_NOTE_CHARS } = await import('@/lib/manual-txn-input');
const { ensureTaxonomy, readTaxonomy } = await import('@/lib/category-store');
const { manualTxnStore, findManualTxn } = await import('@/lib/manual-txns');
const { changeAnnotation } = await import('@/lib/txn-annotations');
const { changeStore, claimStore } = await import('@/lib/api-changes');
const { PENDING_MS } = await import('@/lib/api-writes');
const { apiWriteDays } = await import('@/lib/api-token-store');

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const WALLET = 'manual_wallet';
const MARKET = 'manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';

let writer = '';
let writerId = '';
let reader = '';
let balancer = '';
const saved = { ...process.env };
beforeEach(async () => {
  setSystemTime(new Date(NOW));
  fake.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  process.env.API_WRITES_ENABLED = '1';
  await registerTestContainer(fake);
  await seedPerson(fake);
  ({ token: writer, info: { id: writerId } } = await createToken(ctx, 'Importer', new Date(NOW), null, 'write'));
  reader = (await createToken(ctx, 'Dashboard', new Date(NOW))).token;
  balancer = (await createToken(ctx, 'Home Assistant', new Date(NOW), null, 'balances')).token;
});
afterEach(() => {
  process.env = { ...saved };
  setSystemTime();
});

type Sent = { status: number; body: any; headers: Headers };

/** One request to an /api/v1 path, as the router would hand it over. */
async function send(method: string, path: string, opts: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Sent> {
  const parts = path.split('/');
  const dir = parts.length === 1 ? parts[0] : parts.length === 2 ? `${parts[0]}/[id]` : `${parts[0]}/[id]/${parts[2]}`;
  const id = parts[1];
  const mod: any = await import(`@/app/api/v1/${dir}/route`);
  const withBody = opts.body !== undefined || opts.raw !== undefined;
  const res: Response = await mod[method](
    new Request(`https://nya.test/api/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${opts.token ?? writer}`, ...(withBody ? { 'content-type': 'application/json' } : {}), ...opts.headers },
      ...(withBody ? { body: opts.raw ?? JSON.stringify(opts.body) } : {}),
    }),
    { params: Promise.resolve({ id }) }
  );
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

/** The app's own route, as the page calls it. */
async function app(path: string, method: string, body: unknown): Promise<{ status: number; body: any }> {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res: Response = await mod[method](new Request(`https://nya.test/api/${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}

const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [error, warn] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    [console.error, console.warn] = [error, warn];
  }
};

/** Every value stored in the container, decrypted, but for the API's own
 *  record and bookkeeping, the tokens, and the caches. */
async function stored(): Promise<Record<string, unknown>> {
  const prefix = ctxKey('');
  // The Items' records hold a token sealed afresh each time they are seeded,
  // and no write touches them.
  const skip = (k: string) => k.startsWith('api-') || k.startsWith('cache:') || k.startsWith('ratelimit:') || k === 'plaid:items';
  const open = async (v: string) => {
    let text: string;
    try {
      text = await decryptJsonText(ctx, v);
    } catch {
      return v; // not encrypted: plain as stored
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of fake.strings) if (k.startsWith(prefix) && !skip(k.slice(prefix.length))) out[k.slice(prefix.length)] = await open(v);
  for (const [k, h] of fake.hashes) {
    if (!k.startsWith(prefix) || skip(k.slice(prefix.length))) continue;
    for (const [f, v] of h) out[`${k.slice(prefix.length)} ${f}`] = await open(v);
  }
  return out;
}

/** Ids as the app and the API mint them, the same sequence for both runs. */
function pinIds() {
  let n = 0;
  return spyOn(crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`);
}

/** Runs the app's way and the API's way of one change on the same seeded
 *  data, and answers each run's stores. */
async function both(viaApp: () => Promise<unknown>, viaApi: () => Promise<unknown>, prepare: () => Promise<unknown> = async () => {}) {
  const runs: Record<string, unknown>[] = [];
  for (const run of [viaApp, viaApi]) {
    const ids = pinIds();
    try {
      fake.reset();
      forgetEpochs();
      await registerTestContainer(fake);
      await seedPerson(fake);
      ({ token: writer, info: { id: writerId } } = await createToken(ctx, 'Importer', new Date(NOW), null, 'write'));
      // The set of categories stored first: the app's own answers seed it on
      // their first read; the API's never do (lib/category-store.ts).
      await ensureTaxonomy(ctx);
      await prepare();
      await run();
    } finally {
      ids.mockRestore();
    }
    runs.push(await stored());
  }
  return runs;
}

const versionOf = async (path: string) => (await send('GET', path)).body;

describe('declared once, for good', () => {
  test('write access means exactly what this release ships: a new kind of change needs a new access value', () => {
    expect(spec.WRITE_V1).toEqual([
      'manual-accounts.create',
      'manual-accounts.update',
      'manual-accounts.balance',
      'transactions.create',
      'transactions.update',
      'transactions.delete',
      'categories.create',
      'categories.update',
      'category-groups.create',
      'category-groups.update',
      'tags.create',
      'tags.update',
      'changes.list',
      'changes.undo',
    ]);
    // Every operation beyond reading is in it, and nothing else.
    const beyond = spec.RESOURCE_SPECS.filter((r) => !r.allows.includes('read')).map((r) => r.name);
    expect(beyond.sort()).toEqual([...spec.WRITE_V1].sort());
    for (const r of spec.RESOURCE_SPECS.filter((r) => r.write)) expect([r.name, r.allows.includes('write')]).toEqual([r.name, true]);
    expect(limits.ACCESS).toEqual(['read', 'balances', 'write']);
  });

  test('the declared limits are the app’s own', () => {
    expect(spec.MANUAL_TYPE_NAMES).toEqual([...MANUAL_TYPES]);
    expect(spec.TAG_COLOR_NAMES).toEqual([...TAG_COLORS]);
    expect(spec.APP_CAPS).toEqual({ manualAccounts: MAX_MANUAL_ACCOUNTS, categories: MAX_CATEGORIES, groups: MAX_GROUPS, tags: MAX_TAGS });
    expect(spec.FIELD_LIMITS.balance).toBe(MAX_BALANCE);
    expect(spec.FIELD_LIMITS).toMatchObject({ categoryName: NAME_MAX, icon: ICON_MAX, tagName: TAG_NAME_MAX, payee: MAX_PAYEE_CHARS, note: MAX_NOTE_CHARS, tagsPerTransaction: MAX_TAGS_PER_TRANSACTION });
  });
});

describe('the gate', () => {
  test('a read token can write nothing, and counts no write', async () => {
    for (const [method, path, body] of [
      ['POST', 'transactions', { account_id: WALLET, date: daysAgo(0, NOW), amount: 5, name: 'Coffee' }],
      ['POST', 'manual-accounts', { name: 'Jar', institution_name: 'Home', type: 'depository', balance: 1 }],
      ['POST', `manual-accounts/${WALLET}/balance`, { balance: 1 }],
      ['PATCH', `transactions/${MARKET}`, { note: 'x' }],
      ['POST', 'tags', { name: 'X' }],
      ['GET', 'changes', undefined],
    ] as const) {
      const r = await send(method, path, { token: reader, ...(body ? { body } : {}) });
      expect([path, r.status, r.body.error.code]).toEqual([path, 403, 'insufficient_scope']);
      expect(r.headers.get('www-authenticate')).toContain('insufficient_scope');
    }
    expect(await fake.hgetall(ctxKey('api-write-requests'))).toBeNull();
    expect(await fake.hgetall(ctxKey('api-write-days'))).toBeNull();
    expect(await changeStore.ids(ctx)).toEqual([]);
  });

  test('a token made before tokens could write stays read only, whatever is turned on', async () => {
    const { info, token } = await createToken(ctx, 'Old', new Date(NOW));
    // As the release before wrote it: no access field at all.
    expect(Object.keys((await apiTokenStore.get(ctx, info.id))!)).not.toContain('access');
    expect((await send('POST', 'tags', { token, body: { name: 'X' } })).status).toBe(403);
    expect((await send('GET', 'me', { token })).body.token.access).toBe('read');
  });

  test('a balances token sees its accounts and sets a balance, and reads and changes nothing else', async () => {
    expect((await send('GET', 'me', { token: balancer })).status).toBe(200);
    expect((await send('GET', 'accounts', { token: balancer })).status).toBe(200);
    for (const path of ['transactions', 'net-worth', 'budgets', 'categories', 'tags', 'holdings']) {
      expect([path, (await send('GET', path, { token: balancer })).status]).toEqual([path, 403]);
    }
    expect((await send('GET', `transactions/${MARKET}`, { token: balancer })).status).toBe(403);
    expect((await send('PATCH', `manual-accounts/${WALLET}`, { token: balancer, body: { name: 'X' }, headers: { 'if-match': 'x' } })).status).toBe(403);
    const set = await send('POST', `manual-accounts/${WALLET}/balance`, { token: balancer, body: { balance: 55.5 } });
    expect([set.status, set.body.changed, set.body.account.balance]).toEqual([200, true, 55.5]);
  });

  test('turned off, the API answers as it did before writing existed', async () => {
    delete process.env.API_WRITES_ENABLED;
    const post = await send('POST', 'transactions', { body: { account_id: WALLET, date: daysAgo(0, NOW), amount: 5, name: 'Coffee' } });
    expect([post.status, post.body.error.code, post.headers.get('allow')]).toEqual([405, 'method_not_allowed', 'GET']);
    expect((await send('POST', 'manual-accounts', { body: { name: 'Jar' } })).status).toBe(404);
    expect((await send('GET', 'changes')).status).toBe(404);
    expect((await send('PATCH', `transactions/${MARKET}`, { body: { note: 'x' } })).status).toBe(404);
    // Reading one resource by id came with writing, and goes with it.
    for (const path of [`transactions/${MARKET}`, `manual-accounts/${WALLET}`, 'changes']) expect([path, (await send('GET', path)).status]).toEqual([path, 404]);
    expect((await send('GET', `transactions/${MARKET}`)).body).toEqual({ error: { code: 'not_found', message: 'There is no such endpoint. The endpoints are listed at /developers.' } });
    expect(await manualTxnStore.get(ctx, WALLET)).toMatchObject({ rows: [{ id: MARKET, note: 'apples' }] });
  });

  test('30 writes a minute per token, counted whether or not they are valid, with headers of their own', async () => {
    for (let i = 0; i < limits.WRITES_PER_MINUTE; i++) {
      const r = await send('POST', 'tags', { body: { nope: 1 } });
      expect(r.status).toBe(400);
      expect(r.headers.get('write-ratelimit-remaining')).toBe(String(limits.WRITES_PER_MINUTE - i - 1));
    }
    const over = await send('POST', 'tags', { body: { name: 'Late' } });
    expect([over.status, over.body.error.code, Number(over.headers.get('retry-after')) > 0]).toEqual([429, 'rate_limited', true]);
    // The minute ends: writing again.
    setSystemTime(new Date(NOW + 61_000));
    expect((await send('POST', 'tags', { body: { name: 'Late' } })).status).toBe(201);
  });

  test('a day’s changes per token, and the person’s, and creates; a balance that changes nothing counts as none', async () => {
    const same = await send('POST', `manual-accounts/${WALLET}/balance`, { body: { balance: 40 } });
    expect([same.status, same.body.changed, same.body.change_id]).toEqual([200, false, undefined]);
    expect(await fake.hgetall(ctxKey('api-write-days'))).toBeNull();
    // The person's day, nearly used up by other tokens.
    for (let i = 0; i < limits.PERSON_CHANGES_PER_DAY; i++) await apiWriteDays.take(ctx, 'person', NOW);
    const over = await send('POST', `manual-accounts/${WALLET}/balance`, { body: { balance: 41 } });
    expect([over.status, over.body.error.message]).toEqual([429, expect.stringContaining('Your tokens have made 2000 changes today')]);
    expect((await getManualAccount(ctx, WALLET))!.balance).toBe(40);
  });

  test('only a change that is made counts: a refused one never costs the token’s day, the person’s or its creates', async () => {
    const days = async (...ids: string[]) => (await apiWriteDays.peek(ctx, ids, Date.now())).map((w) => w.count);
    const balancerId = [...(await apiTokenStore.getAll(ctx))].find(([, t]) => t.label === 'Home Assistant')![0];
    // A token past its own day keeps pushing: each refused, none counted for anyone.
    for (let i = 0; i < limits.CHANGES_PER_DAY; i++) await apiWriteDays.take(ctx, balancerId, NOW);
    let t = NOW;
    for (let i = 0; i < 40; i++) {
      if (i % limits.WRITES_PER_MINUTE === 0) setSystemTime(new Date((t += 61_000)));
      const r = await send('POST', `manual-accounts/${WALLET}/balance`, { token: balancer, body: { balance: 100 + i } });
      expect(r.status).toBe(429);
    }
    expect(await days(balancerId, 'person')).toEqual([limits.CHANGES_PER_DAY, 0]);
    // A stale version, a name already taken, a crossing type: refused, uncounted.
    const { account } = await versionOf(`manual-accounts/${WALLET}`);
    expect((await send('PATCH', `manual-accounts/${WALLET}`, { body: { name: 'Purse' }, headers: { 'if-match': '"AAAAAAAAAAAAAAAAAAAAAA"' } })).status).toBe(412);
    expect((await send('PATCH', `manual-accounts/${WALLET}`, { body: { type: 'credit' }, headers: { 'if-match': `"${account.version}"` } })).status).toBe(409);
    expect((await send('POST', 'tags', { body: { name: 'Trip' } })).status).toBe(201);
    expect((await send('POST', 'tags', { body: { name: 'trip' } })).status).toBe(409);
    expect((await send('POST', 'transactions', { body: { account_id: WALLET, date: '1999-01-01', amount: 1, name: 'Old' } })).status).toBe(400);
    // Of all of these, the one tag made, alone.
    expect(await days(writerId, 'person', `${writerId}.creates`)).toEqual([1, 1, 1]);
    // And the same read: nothing changed counts.
    expect(await days(balancerId, 'person')).toEqual([limits.CHANGES_PER_DAY, 1]);
  });

  test('another token keeps its day, whatever one token past its own limit sends', async () => {
    const balancerId = [...(await apiTokenStore.getAll(ctx))].find(([, t]) => t.label === 'Home Assistant')![0];
    for (let i = 0; i < limits.CHANGES_PER_DAY; i++) await apiWriteDays.take(ctx, balancerId, NOW);
    for (let i = 0; i < limits.PERSON_CHANGES_PER_DAY - limits.CHANGES_PER_DAY; i++) await apiWriteDays.take(ctx, 'person', NOW);
    let t = NOW;
    for (let i = 0; i < 60; i++) {
      if (i % limits.WRITES_PER_MINUTE === 0) setSystemTime(new Date((t += 61_000)));
      await send('POST', `manual-accounts/${WALLET}/balance`, { token: balancer, body: { balance: 100 + i } });
    }
    // The person's day has room for the others' changes still.
    const r = await send('POST', 'tags', { body: { name: 'First of the day' } });
    expect(r.status).toBe(201);
  });

  test('at most 100 creates a day for a token', async () => {
    for (let i = 0; i < limits.CREATES_PER_DAY; i++) await apiWriteDays.take(ctx, `${writerId}.creates`, NOW);
    const r = await send('POST', 'tags', { body: { name: 'One too many' } });
    expect([r.status, r.body.error.message]).toEqual([429, expect.stringContaining('100 new things today')]);
    expect((await readTagSet(ctx))?.tags.some((t) => t.name === 'One too many') ?? false).toBe(false);
  });
});

describe('the same stored result as the app’s own route', () => {
  test('a manual account made', async () => {
    const fields = { name: 'Jar', institution_name: 'Home', type: 'depository', subtype: 'cash', balance: 12.5, currency: 'EUR' };
    const [a, b] = await both(
      async () => expect((await app('manual-accounts', 'POST', fields)).status).toBe(200),
      async () => expect((await send('POST', 'manual-accounts', { body: fields })).status).toBe(201)
    );
    expect(b).toEqual(a);
  });

  test('a manual account’s details, and its balance', async () => {
    const wallet = { name: 'Purse', institution_name: 'Cash', type: 'other', subtype: null, balance: 40 };
    const [a, b] = await both(
      async () => expect((await app('manual-accounts', 'PATCH', { ...wallet, account_id: WALLET })).status).toBe(200),
      async () => {
        const { account } = await versionOf(`manual-accounts/${WALLET}`);
        expect((await send('PATCH', `manual-accounts/${WALLET}`, { body: { name: 'Purse', type: 'other', subtype: null }, headers: { 'if-match': `"${account.version}"` } })).status).toBe(200);
      }
    );
    expect(b).toEqual(a);
    const [c, d] = await both(
      async () => expect((await app('manual-accounts', 'PATCH', { name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: 'cash', balance: 75.25, account_id: WALLET })).status).toBe(200),
      async () => expect((await send('POST', `manual-accounts/${WALLET}/balance`, { body: { balance: 75.25 } })).status).toBe(200)
    );
    expect(d).toEqual(c);
  });

  test('a transaction added, changed, its exclusion and tags, and deleted', async () => {
    const tagId = async () => (await readTagSet(ctx))!.tags[0].id;
    const prepare = async () => expect((await app('tags', 'POST', { action: 'add', name: 'Trip' })).status).toBe(200);
    const food = async () => (await readTaxonomy(ctx))!.categories.find((c) => c.name.toLowerCase().includes('food'))!.id;
    const add = { account_id: WALLET, date: daysAgo(1, NOW), amount: 4.5, currency: 'USD', name: 'Coffee', note: 'oat milk' };
    let [a, b] = await both(
      async () => expect((await app('manual-transactions', 'POST', { ...add, category_id: await food() })).status).toBe(200),
      async () => expect((await send('POST', 'transactions', { body: { ...add, category_id: await food() } })).status).toBe(201),
      prepare
    );
    expect(b).toEqual(a);

    [a, b] = await both(
      async () => expect((await app('manual-transactions', 'PATCH', { id: MARKET, account_id: WALLET, amount: 30, name: 'Market', note: null })).status).toBe(200),
      async () => {
        const { transaction } = await versionOf(`transactions/${MARKET}`);
        expect((await send('PATCH', `transactions/${MARKET}`, { body: { amount: 30, name: 'Market', note: null }, headers: { 'if-match': transaction.version } })).status).toBe(200);
      },
      prepare
    );
    expect(b).toEqual(a);

    [a, b] = await both(
      async () => expect((await app('transaction-annotations', 'PATCH', { transaction_id: MARKET, excluded: true, add_tags: [await tagId()] })).status).toBe(200),
      async () => {
        const { transaction } = await versionOf(`transactions/${MARKET}`);
        expect((await send('PATCH', `transactions/${MARKET}`, { body: { excluded: true, add_tag_ids: [await tagId()] }, headers: { 'if-match': transaction.version } })).status).toBe(200);
      },
      prepare
    );
    expect(b).toEqual(a);

    [a, b] = await both(
      async () => expect((await app('manual-transactions', 'DELETE', { id: MARKET, account_id: WALLET })).status).toBe(200),
      async () => {
        const { transaction } = await versionOf(`transactions/${MARKET}`);
        expect((await send('DELETE', `transactions/${MARKET}`, { headers: { 'if-match': transaction.version } })).status).toBe(200);
      },
      prepare
    );
    expect(b).toEqual(a);
  });

  test('categories and groups, made and changed', async () => {
    const group = async () => (await readTaxonomy(ctx))!.groups[0].id;
    const other = async () => (await readTaxonomy(ctx))!.groups[1].id;
    let [a, b] = await both(
      async () => expect((await app('categories', 'POST', { action: 'add-category', name: 'Pets', group: await group(), icon: '🐶' })).status).toBe(200),
      async () => expect((await send('POST', 'categories', { body: { name: 'Pets', group_id: await group(), icon: '🐶' } })).status).toBe(201)
    );
    expect(b).toEqual(a);
    const make = async () => expect((await app('categories', 'POST', { action: 'add-category', name: 'Pets', group: await group() })).status).toBe(200);
    const pets = async () => (await readTaxonomy(ctx))!.categories.find((c) => c.name === 'Pets')!.id;
    [a, b] = await both(
      async () => {
        const id = await pets();
        for (const body of [
          { action: 'rename-category', id, name: 'Animals' },
          { action: 'move-category', id, group: await other() },
          { action: 'set-icon', id, icon: '🐱' },
          { action: 'archive', id, archived: true },
        ]) expect((await app('categories', 'POST', body)).status).toBe(200);
      },
      async () => {
        const id = await pets();
        const { category } = await versionOf(`categories/${id}`);
        const r = await send('PATCH', `categories/${id}`, { body: { name: 'Animals', group_id: await other(), icon: '🐱', archived: true }, headers: { 'if-match': category.version } });
        expect(r.status).toBe(200);
      },
      make
    );
    expect(b).toEqual(a);
    [a, b] = await both(
      async () => expect((await app('categories', 'POST', { action: 'add-group', name: 'Hobbies', kind: 'expense' })).status).toBe(200),
      async () => expect((await send('POST', 'category-groups', { body: { name: 'Hobbies', kind: 'expense' } })).status).toBe(201)
    );
    expect(b).toEqual(a);
  });

  test('a group renamed, a row moved to another account, and a category taken off', async () => {
    let [a, b] = await both(
      async () => {
        const g = (await readTaxonomy(ctx))!.groups[0];
        expect((await app('categories', 'POST', { action: 'rename-group', id: g.id, name: 'Eating' })).status).toBe(200);
      },
      async () => {
        const g = (await readTaxonomy(ctx))!.groups[0];
        const { group } = await versionOf(`category-groups/${g.id}`);
        expect((await send('PATCH', `category-groups/${g.id}`, { body: { name: 'Eating' }, headers: { 'if-match': group.version } })).status).toBe(200);
      }
    );
    expect(b).toEqual(a);
    const jar = async () => (await saveManualAccount(ctx, { account_id: 'manual_jar', name: 'Jar', institution_name: 'Home', type: 'depository', subtype: 'cash', balance: 10, updated_at: new Date(NOW).toISOString() }), null);
    [a, b] = await both(
      async () => expect((await app('manual-transactions', 'PATCH', { id: MARKET, account_id: WALLET, move_to: 'manual_jar' })).status).toBe(200),
      async () => {
        const { transaction } = await versionOf(`transactions/${MARKET}`);
        expect((await send('PATCH', `transactions/${MARKET}`, { body: { account_id: 'manual_jar' }, headers: { 'if-match': transaction.version } })).status).toBe(200);
      },
      jar
    );
    expect(b).toEqual(a);
    [a, b] = await both(
      async () => expect((await app('manual-transactions', 'PATCH', { id: MARKET, account_id: WALLET, category_id: null })).status).toBe(200),
      async () => {
        const { transaction } = await versionOf(`transactions/${MARKET}`);
        expect((await send('PATCH', `transactions/${MARKET}`, { body: { category_id: null }, headers: { 'if-match': transaction.version } })).status).toBe(200);
      }
    );
    expect(b).toEqual(a);
  });

  test('tags, made and changed', async () => {
    let [a, b] = await both(
      async () => expect((await app('tags', 'POST', { action: 'add', name: 'Work', color: 'blue' })).status).toBe(200),
      async () => expect((await send('POST', 'tags', { body: { name: 'Work', color: 'blue' } })).status).toBe(201)
    );
    expect(b).toEqual(a);
    const make = async () => expect((await app('tags', 'POST', { action: 'add', name: 'Work' })).status).toBe(200);
    const work = async () => (await readTagSet(ctx))!.tags[0].id;
    [a, b] = await both(
      async () => {
        const id = await work();
        expect((await app('tags', 'POST', { action: 'rename', id, name: 'Job' })).status).toBe(200);
        expect((await app('tags', 'POST', { action: 'recolor', id, color: 'red' })).status).toBe(200);
      },
      async () => {
        const id = await work();
        const { tag } = await versionOf(`tags/${id}`);
        expect((await send('PATCH', `tags/${id}`, { body: { name: 'Job', color: 'red' }, headers: { 'if-match': tag.version } })).status).toBe(200);
      },
      make
    );
    expect(b).toEqual(a);
  });
});

describe('idempotency keys', () => {
  const coffee = { account_id: WALLET, date: daysAgo(0, NOW), amount: 4.5, name: 'Coffee' };
  const rows = async () => (await manualTxnStore.get(ctx, WALLET))!.rows.filter((r) => r.name === 'Coffee');

  test('a create sent again with its key makes one record, and answers the first, as it is now', async () => {
    const first = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-1' } });
    expect(first.status).toBe(201);
    const again = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-1' } });
    expect([again.status, again.headers.get('idempotent-replayed'), again.body.transaction.id, again.body.change_id]).toEqual([200, 'true', first.body.transaction.id, first.body.change_id]);
    expect(await rows()).toHaveLength(1);
    // Another request under the key: refused, nothing made.
    const other = await send('POST', 'transactions', { body: { ...coffee, amount: 9 }, headers: { 'idempotency-key': 'k-1' } });
    expect([other.status, other.body.error.code]).toEqual([422, 'idempotency_key_reused']);
    // Another token's key of the same text is its own.
    const otherToken = (await createToken(ctx, 'Other', new Date(NOW), null, 'write')).token;
    expect((await send('POST', 'transactions', { token: otherToken, body: coffee, headers: { 'idempotency-key': 'k-1' } })).status).toBe(201);
    expect(await rows()).toHaveLength(2);
    // Past 24 hours, the key names nothing any more.
    setSystemTime(new Date(NOW + 25 * 3_600_000));
    expect((await send('POST', 'transactions', { body: { ...coffee, date: daysAgo(0, NOW + 25 * 3_600_000) }, headers: { 'idempotency-key': 'k-1' } })).status).toBe(201);
  });

  test('two sent at once with one key make one transaction, whose names aren’t kept apart', async () => {
    // Each request's steps interleaved: the second claims the key while the
    // first is still making its row.
    const [x, y] = await Promise.all([
      send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'race' } }),
      send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'race' } }),
    ]);
    expect(await rows()).toHaveLength(1);
    const id = (await rows())[0].id;
    const made = [x, y].find((r) => r.status === 201)!;
    const other = [x, y].find((r) => r !== made)!;
    expect(made.body.transaction.id).toBe(id);
    expect([`200:${id}`, '409:in_progress']).toContain(`${other.status}:${other.body.error?.code ?? other.body.transaction?.id}`);
  });

  /** A first attempt that stopped before it was settled, as a function cut
   *  off: its change left pending (and, `unmade`, before its key was marked
   *  made too). */
  const stopped = async (changeId: string, opts: { unmade?: boolean } = {}) => {
    await changeStore.update(ctx, changeId, (c) => {
      if (!c) return null;
      const next = { ...c, state: 'pending' as const };
      delete (next as Partial<typeof c>).before;
      delete (next as Partial<typeof c>).after;
      return next;
    });
    if (opts.unmade) await claimStore.update(ctx, writerId, (cur) => (cur ? { ...cur, claims: cur.claims.map(({ made: _, ...c }) => c) } : null));
  };
  const LATER = NOW + PENDING_MS + 1000;

  test('one that stopped part way waits out every route that could still be making it, then is found and replayed', async () => {
    const first = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-2' } });
    await stopped(first.body.change_id);
    // Inside the longest a route can run (the MCP server's 120 seconds): still in progress.
    setSystemTime(new Date(NOW + 130_000));
    const soon = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-2' } });
    expect([soon.status, soon.body.error.code]).toEqual([409, 'in_progress']);
    setSystemTime(new Date(LATER));
    const later = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-2' } });
    expect([later.status, later.body.transaction.id]).toEqual([200, first.body.transaction.id]);
    expect((await changeStore.get(ctx, first.body.change_id))!.state).toBe('done');
    expect(await rows()).toHaveLength(1);
  });

  test('a retry never brings back what the person deleted: made, then deleted, is refused, whatever the first attempt’s record says', async () => {
    // Settled, then deleted in the app: answered as deleted.
    const done = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-3' } });
    expect((await app('manual-transactions', 'DELETE', { id: done.body.transaction.id, account_id: WALLET })).status).toBe(200);
    const again = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-3' } });
    expect([again.status, again.body]).toEqual([200, { deleted: true, change_id: done.body.change_id }]);
    // Stopped before it was settled, its row deleted in the app since: its
    // key says it was made, so nothing is made again.
    const cut = await send('POST', 'transactions', { body: { ...coffee, name: 'Tea' }, headers: { 'idempotency-key': 'k-4' } });
    await stopped(cut.body.change_id);
    expect((await app('manual-transactions', 'DELETE', { id: cut.body.transaction.id, account_id: WALLET })).status).toBe(200);
    setSystemTime(new Date(LATER));
    const retry = await send('POST', 'transactions', { body: { ...coffee, name: 'Tea' }, headers: { 'idempotency-key': 'k-4' } });
    expect([retry.status, retry.body.error.code]).toEqual([409, 'conflict']);
    expect(retry.body.error.message).toBe('What this Idempotency-Key made has been removed since, so nothing was made again. If you still want it, send the request with a new key.');
    expect((await manualTxnStore.get(ctx, WALLET))!.rows.some((r) => r.name === 'Tea')).toBe(false);
    expect((await changeStore.get(ctx, cut.body.change_id))!).toMatchObject({ state: 'failed', error: 'removed' });
    // A tag being deleted is a trace of one made too.
    const swept = await send('POST', 'tags', { body: { name: 'Swept' }, headers: { 'idempotency-key': 'k-5' } });
    await stopped(swept.body.change_id, { unmade: true });
    const { changeTagSet, markDeleted } = await import('@/lib/tags');
    await changeTagSet(ctx, (s) => markDeleted(s, swept.body.tag.id));
    setSystemTime(new Date(LATER + PENDING_MS));
    const refused = await send('POST', 'tags', { body: { name: 'Swept' }, headers: { 'idempotency-key': 'k-5' } });
    expect([refused.status, refused.body.error.code]).toEqual([409, 'conflict']);
  });

  test('a change removed in the app as damaged: its key, sent again, never makes it again', async () => {
    const first = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-damaged' } });
    expect(first.status).toBe(201);
    // Stopped before its key was marked made, then its record damaged and removed in the app.
    await stopped(first.body.change_id, { unmade: true });
    fake.hashes.get(ctxKey('api-changes'))!.set(first.body.change_id, 'not a stored value');
    const removed = await quietly(() => app('api-changes', 'DELETE', { id: first.body.change_id }));
    expect(removed.body).toEqual({ removed: true });
    setSystemTime(new Date(LATER));
    const again = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-damaged' } });
    expect([again.status, again.body.error.code, again.body.error.message]).toEqual([
      409,
      'conflict',
      'What this Idempotency-Key began may have been made and removed since, so nothing was made again. Check, and if you still want it, send the request with a new key.',
    ]);
    expect(await rows()).toHaveLength(1);
  });

  test('removing a damaged change settles only its own key: another of its token’s keys, nothing begun under it, is still made', async () => {
    const other = await claimedAlone('k-other');
    const first = await send('POST', 'transactions', { body: { ...coffee, name: 'Tea' }, headers: { 'idempotency-key': 'k-damaged-2' } });
    await stopped(first.body.change_id, { unmade: true });
    fake.hashes.get(ctxKey('api-changes'))!.set(first.body.change_id, 'not a stored value');
    expect((await quietly(() => app('api-changes', 'DELETE', { id: first.body.change_id }))).body).toEqual({ removed: true });
    const claims = (await claimStore.get(ctx, writerId))!.claims;
    expect(claims.find((c) => c.change === other)?.made).toBeUndefined();
    setSystemTime(new Date(LATER));
    const made = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-other' } });
    expect(made.status).toBe(201);
  });

  test('a damaged change whose token’s keys can’t be read is left, and the words say what to do', async () => {
    const first = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-damaged-3' } });
    await stopped(first.body.change_id, { unmade: true });
    fake.hashes.get(ctxKey('api-changes'))!.set(first.body.change_id, 'not a stored value');
    fake.hashes.get(ctxKey('api-change-keys'))!.set(writerId, 'not a stored value');
    const refused = await quietly(() => app('api-changes', 'DELETE', { id: first.body.change_id }));
    expect([refused.status, refused.body.error]).toEqual([
      409,
      'The keys of the token “Importer” can’t be read, so this change was left as it is: removing it now could let one of those keys make it again. Revoking the token “Importer” forgets its keys; then remove this change.',
    ]);
    expect(fake.hashes.get(ctxKey('api-changes'))!.get(first.body.change_id)).toBe('not a stored value');
  });

  test('another token’s keys that can’t be read don’t hold back the removal', async () => {
    const first = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-damaged-4' } });
    await stopped(first.body.change_id, { unmade: true });
    fake.hashes.get(ctxKey('api-changes'))!.set(first.body.change_id, 'not a stored value');
    const { info } = await createToken(ctx, 'Sorter', new Date(NOW), null, 'write');
    fake.hashes.get(ctxKey('api-change-keys'))!.set(info.id, 'not a stored value');
    expect((await quietly(() => app('api-changes', 'DELETE', { id: first.body.change_id }))).body).toEqual({ removed: true });
    expect((await claimStore.get(ctx, writerId))!.claims.find((c) => c.change === first.body.change_id)?.made).toBe(true);
  });

  test('stopped after its row landed, before its key was marked made, then deleted in the app: refused, never made again', async () => {
    const first = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-crash' } });
    expect(first.status).toBe(201);
    await stopped(first.body.change_id, { unmade: true });
    expect((await app('manual-transactions', 'DELETE', { id: first.body.transaction.id, account_id: WALLET })).status).toBe(200);
    setSystemTime(new Date(LATER));
    const again = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-crash' } });
    expect([again.status, again.body.error.code, again.body.error.message]).toEqual([
      409,
      'conflict',
      'What this Idempotency-Key began may have been made and removed since, so nothing was made again. Check, and if you still want it, send the request with a new key.',
    ]);
    expect(await rows()).toHaveLength(0);
    expect((await changeStore.get(ctx, first.body.change_id))!).toMatchObject({ state: 'failed', error: 'stopped' });
    // Sent again, still refused: the failed change is begun all the same.
    const third = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-crash' } });
    expect([third.status, third.body.error.code]).toEqual([409, 'conflict']);
    // One that failed before anything of it was found, the same.
    const failed = await send('POST', 'transactions', { body: { ...coffee, name: 'Tea' }, headers: { 'idempotency-key': 'k-failed' } });
    await manualTxnStore.update(ctx, WALLET, (b) => ({ ...b!, rows: b!.rows.filter((r) => r.id !== failed.body.transaction.id) }));
    await stopped(failed.body.change_id, { unmade: true });
    await changeStore.update(ctx, failed.body.change_id, (c) => (c ? { ...c, state: 'failed', error: 'internal' } : null));
    const retried = await send('POST', 'transactions', { body: { ...coffee, name: 'Tea' }, headers: { 'idempotency-key': 'k-failed' } });
    expect([retried.status, retried.body.error.code]).toEqual([409, 'conflict']);
    expect((await manualTxnStore.get(ctx, WALLET))!.rows.some((r) => r.name === 'Tea')).toBe(false);
    expect((await changeStore.get(ctx, failed.body.change_id))!).toMatchObject({ state: 'failed', error: 'internal' });
  });

  test('a takeover that can’t read where the first’s row would be, or the first’s change, makes nothing: 409 unreadable', async () => {
    const first = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-unread' } });
    await stopped(first.body.change_id, { unmade: true });
    setSystemTime(new Date(LATER));
    // The book that would hold it can't be read.
    const book = fake.hashes.get(ctxKey('manual-transactions'))!;
    const kept = book.get(WALLET)!;
    book.set(WALLET, 'damaged');
    const r1 = await quietly(() => send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-unread' } }));
    book.set(WALLET, kept);
    expect([r1.status, r1.body.error.code]).toEqual([409, 'unreadable']);
    // The change itself can't be read.
    fake.hashes.get(ctxKey('api-changes'))!.set(first.body.change_id, 'damaged');
    const r2 = await quietly(() => send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-unread' } }));
    expect([r2.status, r2.body.error.code]).toEqual([409, 'unreadable']);
    expect(await rows()).toHaveLength(1);
  });

  /** A key claimed alone, as a first attempt that stopped before it wrote
   *  its change leaves it: the change id the claim names. */
  const claimedAlone = async (key: string): Promise<string> => {
    const { claimKey, sha256 } = await import('@/lib/api-changes');
    const args = { account_id: WALLET, amount: 4.5, date: coffee.date, name: 'Coffee' };
    const request = sha256(JSON.stringify([spec.resourceSpec('transactions.create').name, Object.keys(args).sort().map((k) => [k, (args as Record<string, unknown>)[k]])]));
    const claim = await claimKey(ctx, writerId, key, request, NOW);
    expect(claim.kind).toBe('new');
    return (claim as { change: string }).change;
  };

  test('made again, under a new id, only when no change was ever begun under its key', async () => {
    const first = await claimedAlone('k-6');
    setSystemTime(new Date(LATER));
    const made = await send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-6' } });
    expect(made.status).toBe(201);
    expect(made.body.change_id).not.toBe(first);
    expect(await rows()).toHaveLength(1);
  });

  test('two takeovers at once make it once: the claim moves to one of them alone', async () => {
    const first = await claimedAlone('k-7');
    setSystemTime(new Date(LATER));
    // Each takeover's read of the first's change held until both have read
    // the claim and reached it, as a network round trip could, so both read
    // before either moves the claim, however slow the machine (a fixed delay
    // let one finish first on a loaded one).
    const changes = await import('@/lib/api-changes');
    const real = changes.getChange;
    let looked = 0;
    // Let go after 1.5 s if the second never comes, well inside the test's
    // own 5 s, so a missed barrier fails on `looked`, not as a timeout.
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let bothThere: () => void = () => {};
    const both = new Promise<void>((resolve) => {
      bothThere = resolve;
      fallback = setTimeout(resolve, 1500);
    });
    const slow = spyOn(changes, 'getChange').mockImplementation(async (c, id, now) => {
      if (id === first) {
        if (++looked === 2) {
          clearTimeout(fallback);
          bothThere();
        }
        await both;
      }
      return real(c, id, now);
    });
    // The second request slower to claim its key, as on a loaded machine.
    const claim = changes.claimKey;
    let claims = 0;
    const late = spyOn(changes, 'claimKey').mockImplementation(async (...args) => {
      if (++claims === 2) await new Promise((r) => setTimeout(r, 60));
      return claim(...args);
    });
    try {
      const [x, y] = await Promise.all([
        send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-7' } }),
        send('POST', 'transactions', { body: coffee, headers: { 'idempotency-key': 'k-7' } }),
      ]);
      expect(looked).toBe(2);
      expect([x.status, y.status].sort()).toEqual([201, 409]);
      expect([x, y].find((r) => r.status === 409)!.body.error.code).toBe('in_progress');
    } finally {
      clearTimeout(fallback);
      slow.mockRestore();
      late.mockRestore();
    }
    expect(await rows()).toHaveLength(1);
  });

  test('every route that can run a create stops before a takeover would begin', async () => {
    for (const path of ['app/api/mcp/route.ts', 'app/api/v1/transactions/route.ts', 'app/api/v1/manual-accounts/route.ts', 'app/api/v1/categories/route.ts', 'app/api/v1/category-groups/route.ts', 'app/api/v1/tags/route.ts']) {
      const source = await Bun.file(new URL(`../${path}`, import.meta.url)).text();
      const seconds = Number(/export const maxDuration = (\d+);/.exec(source)?.[1]);
      expect([path, seconds > 0 && seconds * 1000 < PENDING_MS]).toEqual([path, true]);
    }
    for (const path of ['app/api/api-changes/route.ts', 'app/api/v1/changes/[id]/undo/route.ts']) {
      const source = await Bun.file(new URL(`../${path}`, import.meta.url)).text();
      expect([path, /export const maxDuration = 120;/.test(source)]).toEqual([path, true]);
    }
  });

  test('a refusal before anything was made frees the key', async () => {
    expect((await send('POST', 'tags', { body: { name: 'Work' } })).status).toBe(201);
    const taken = await send('POST', 'tags', { body: { name: 'work' }, headers: { 'idempotency-key': 'k-6' } });
    expect([taken.status, taken.body.error.code]).toEqual([409, 'conflict']);
    // Nothing recorded, and the key free for the corrected request.
    expect((await claimStore.getAll(ctx)).size === 0 || [...(await claimStore.getAll(ctx)).values()].every((c) => c.claims.length === 0)).toBe(true);
    expect((await send('POST', 'tags', { body: { name: 'Work 2' }, headers: { 'idempotency-key': 'k-6' } })).status).toBe(201);
  });
});

describe('versions', () => {
  test('a change that turns out to change nothing still checks its version, and records and counts nothing', async () => {
    const tag = (await send('POST', 'tags', { body: { name: 'Gone soon' } })).body.tag.id;
    await quietly(async () => (await import('@/lib/tag-delete')).deleteTag(ctx, tag));
    const stale = await send('PATCH', `transactions/${MARKET}`, { body: { remove_tag_ids: [tag] }, headers: { 'if-match': 'AAAAAAAAAAA.AAAAAAAAAAA' } });
    expect([stale.status, stale.body.error.code]).toEqual([412, 'version_mismatch']);
    const before = await changeStore.count(ctx);
    const days = (await apiWriteDays.peek(ctx, [writerId], Date.now()))[0].count;
    const { transaction } = await versionOf(`transactions/${MARKET}`);
    const fine = await send('PATCH', `transactions/${MARKET}`, { body: { remove_tag_ids: [tag] }, headers: { 'if-match': transaction.version } });
    expect([fine.status, fine.body.change_id, fine.body.transaction.version]).toEqual([200, undefined, transaction.version]);
    expect(await changeStore.count(ctx)).toBe(before);
    expect((await apiWriteDays.peek(ctx, [writerId], Date.now()))[0].count).toBe(days);
  });

  test('a version is keyed with a key only the server holds: no token can work one out from a guess', async () => {
    const { createHash } = await import('node:crypto');
    const { accountVersion } = await import('@/lib/api-versions');
    const wallet = (await getManualAccount(ctx, WALLET))!;
    const unkeyed = createHash('sha256').update(JSON.stringify(['account', wallet.name, wallet.institution_name, wallet.type, wallet.subtype ?? null, wallet.currency ?? 'USD']), 'utf8').digest('base64url').slice(0, 22);
    const served = (await versionOf(`manual-accounts/${WALLET}`)).account.version;
    expect(served).toBe(accountVersion(wallet));
    expect(served).not.toBe(unkeyed);
    const key = process.env.PLAID_ENCRYPTION_KEY;
    process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    try {
      expect(accountVersion(wallet)).not.toBe(served);
    } finally {
      process.env.PLAID_ENCRYPTION_KEY = key;
    }
    expect(accountVersion(wallet)).toBe(served);
  });

  test('one manual account by id: never a bank’s', async () => {
    const r = await send('GET', 'manual-accounts/acc_chk');
    expect([r.status, r.body.error.code]).toEqual([404, 'not_found']);
  });

  test('the runner runs nothing that hasn’t passed the gate', async () => {
    const { runResource } = await import('@/lib/api-writes');
    const { authenticate } = await import('@/lib/api-tokens');
    const auth = (await authenticate(`Bearer ${writer}`))!;
    expect(auth).not.toBeNull();
    const forged = { headers: {} } as unknown as Parameters<typeof runResource>[3];
    await expect(runResource(auth, spec.resourceSpec('tags.create'), { args: { name: 'Sneaky' }, via: 'api' }, forged)).rejects.toThrow('without passing the gate');
    // Nor one that passed it for another operation.
    const { gate } = await import('@/lib/api-run');
    const forRead = await gate(auth, spec.resourceSpec('tags.get'));
    await expect(runResource(auth, spec.resourceSpec('tags.create'), { args: { name: 'Sneaky' }, via: 'api' }, forRead)).rejects.toThrow('without passing the gate');
    expect(await readTagSet(ctx)).toBeNull();
  });

  test('a balance set through the API has the estimate rebuilt the first time in a day for each account, never on every push', async () => {
    const { markBackfillDone, isBackfillDone } = await import('@/lib/history');
    await markBackfillDone(ctx);
    expect((await send('POST', `manual-accounts/${WALLET}/balance`, { token: balancer, body: { balance: 41 } })).status).toBe(200);
    expect(await isBackfillDone(ctx)).toBe(false);
    await markBackfillDone(ctx);
    expect((await send('POST', `manual-accounts/${WALLET}/balance`, { token: balancer, body: { balance: 42 } })).status).toBe(200);
    expect(await isBackfillDone(ctx)).toBe(true);
    // The app's own form rebuilds every time, as it always has.
    expect((await app('manual-accounts', 'PATCH', { account_id: WALLET, name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: 'cash', balance: 43 })).status).toBe(200);
    expect(await isBackfillDone(ctx)).toBe(false);
    // The next day, the first push rebuilds again.
    await markBackfillDone(ctx);
    setSystemTime(new Date(NOW + 86_400_000 + 1000));
    expect((await send('POST', `manual-accounts/${WALLET}/balance`, { token: balancer, body: { balance: 44 } })).status).toBe(200);
    expect(await isBackfillDone(ctx)).toBe(false);
  });

  test('a push that skipped its rebuild is caught up the next night, so the estimate is never more than a day behind', async () => {
    const { markBackfillDone, isBackfillDone } = await import('@/lib/history');
    const { snapshotData } = await import('@/lib/snapshot-job');
    await markBackfillDone(ctx);
    expect((await send('POST', `manual-accounts/${WALLET}/balance`, { token: balancer, body: { balance: 200 } })).status).toBe(200);
    expect(await isBackfillDone(ctx)).toBe(false);
    await markBackfillDone(ctx); // the app opened, and the estimate was rebuilt on 200
    // Two hours on, the same window: the push skips its rebuild.
    setSystemTime(new Date(NOW + 2 * 3_600_000));
    expect((await send('POST', `manual-accounts/${WALLET}/balance`, { token: balancer, body: { balance: 5000 } })).status).toBe(200);
    expect(await isBackfillDone(ctx)).toBe(true);
    // The night after, within a day of that push, with none since: rebuilt
    // on the next visit.
    setSystemTime(new Date(NOW + 2 * 3_600_000 + 86_400_000 - 60_000));
    await quietly(() => snapshotData(ctx, []));
    expect(await isBackfillDone(ctx)).toBe(false);
    // Caught up once: the next night leaves the rebuilt estimate alone.
    await markBackfillDone(ctx);
    setSystemTime(new Date(NOW + 2 * 3_600_000 + 2 * 86_400_000));
    await quietly(() => snapshotData(ctx, []));
    expect(await isBackfillDone(ctx)).toBe(true);
  });

  test('each skipped push keeps its mark a day past it, so one late in a window is caught up too', async () => {
    const { markBackfillDone, isBackfillDone } = await import('@/lib/history');
    const { catchUpRebuilds } = await import('@/lib/api-rebuilds');
    const push = async (balance: number, at: number) => {
      setSystemTime(new Date(at));
      expect((await send('POST', `manual-accounts/${WALLET}/balance`, { token: balancer, body: { balance } })).status).toBe(200);
    };
    await push(100, NOW);
    await markBackfillDone(ctx); // rebuilt on 100
    await push(101, NOW + 3_600_000); // skipped: marked
    await push(102, NOW + 23 * 3_600_000); // skipped too, its mark started again
    // The next night falls past a day from the first skip, within a day of the last.
    await catchUpRebuilds(ctx, NOW + 26 * 3_600_000);
    expect(await isBackfillDone(ctx)).toBe(false);
    // A night with no mark leaves the estimate alone.
    await markBackfillDone(ctx);
    await catchUpRebuilds(ctx, NOW + 50 * 3_600_000);
    expect(await isBackfillDone(ctx)).toBe(true);
  });

  test('a night whose clear of the flag fails keeps the mark, and the next night catches it up', async () => {
    const { markBackfillDone, isBackfillDone } = await import('@/lib/history');
    const { catchUpRebuilds } = await import('@/lib/api-rebuilds');
    expect((await send('POST', `manual-accounts/${WALLET}/balance`, { token: balancer, body: { balance: 100 } })).status).toBe(200);
    await markBackfillDone(ctx);
    setSystemTime(new Date(NOW + 3_600_000));
    expect((await send('POST', `manual-accounts/${WALLET}/balance`, { token: balancer, body: { balance: 101 } })).status).toBe(200);
    fake.failNext('del');
    await quietly(() => catchUpRebuilds(ctx, NOW + 2 * 3_600_000));
    expect(await isBackfillDone(ctx)).toBe(true);
    await catchUpRebuilds(ctx, NOW + 20 * 3_600_000);
    expect(await isBackfillDone(ctx)).toBe(false);
  });

  test('a stale version is refused and nothing is written; none is 428; a weak one never matches', async () => {
    const { transaction } = await versionOf(`transactions/${MARKET}`);
    // The person edits it in the app meanwhile.
    expect((await app('manual-transactions', 'PATCH', { id: MARKET, account_id: WALLET, name: 'Farmers’ market' })).status).toBe(200);
    const stale = await send('PATCH', `transactions/${MARKET}`, { body: { amount: 99 }, headers: { 'if-match': `"${transaction.version}"` } });
    expect([stale.status, stale.body.error.code]).toEqual([412, 'version_mismatch']);
    expect((await findManualTxn(ctx, MARKET))!.row.amount).toBe(25);
    expect((await send('PATCH', `transactions/${MARKET}`, { body: { amount: 99 } })).status).toBe(428);
    expect((await send('PATCH', `transactions/${MARKET}`, { body: { amount: 99 }, headers: { 'if-match': '*' } })).status).toBe(428);
    const fresh = (await versionOf(`transactions/${MARKET}`)).transaction.version;
    expect((await send('PATCH', `transactions/${MARKET}`, { body: { amount: 99 }, headers: { 'if-match': `W/"${fresh}"` } })).status).toBe(412);
    const ok = await send('PATCH', `transactions/${MARKET}`, { body: { amount: 99 }, headers: { 'if-match': `"${fresh}"` } });
    expect([ok.status, ok.headers.get('etag')]).toEqual([200, `"${ok.body.transaction.version}"`]);
  });

  test('two changes sent at once from one version: one lands, the other is refused', async () => {
    const { transaction } = await versionOf(`transactions/${MARKET}`);
    const [x, y] = await Promise.all([
      send('PATCH', `transactions/${MARKET}`, { body: { name: 'A' }, headers: { 'if-match': transaction.version } }),
      send('PATCH', `transactions/${MARKET}`, { body: { name: 'B' }, headers: { 'if-match': transaction.version } }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 412]);
    const name = (await findManualTxn(ctx, MARKET))!.row.name;
    expect(name).toBe(x.status === 200 ? 'A' : 'B');
  });

  test('the row and what is said beside it are versioned apart, and never changed in one request', async () => {
    const { transaction } = await versionOf(`transactions/${MARKET}`);
    // A tag put on in the app moves only what is said beside it.
    await changeAnnotation(ctx, MARKET, { excluded: true });
    expect((await send('PATCH', `transactions/${MARKET}`, { body: { name: 'Still fine' }, headers: { 'if-match': transaction.version } })).status).toBe(200);
    expect((await send('PATCH', `transactions/${MARKET}`, { body: { excluded: false }, headers: { 'if-match': transaction.version } })).status).toBe(412);
    const mixed = await send('PATCH', `transactions/${MARKET}`, { body: { name: 'X', excluded: false }, headers: { 'if-match': transaction.version } });
    expect([mixed.status, mixed.body.error.message]).toEqual([400, expect.stringContaining('separate requests')]);
  });

  test('every read gives what a write can change its version, and nothing else one', async () => {
    const accounts = (await send('GET', 'accounts', { token: reader, headers: {} })).body.accounts;
    for (const a of accounts) expect([a.id, typeof a.version]).toEqual([a.id, a.source === 'manual' ? 'string' : 'object']);
    const txns = (await send('GET', 'transactions', { token: reader })).body.transactions;
    for (const t of txns) expect([t.id, typeof t.version]).toEqual([t.id, t.source === 'manual' ? 'string' : 'object']);
    expect((await send('GET', 'tags', { token: reader })).body.tags.every((t: any) => typeof t.version === 'string')).toBe(true);
  });
});

describe('a write that something else takes away meanwhile', () => {
  /** The person deleting `account` in the app while a row is written into
   *  it: just after the row's book is written. */
  const deletedDuring = async (account: string) => {
    const txns = await import('@/lib/manual-txns');
    const { removeManualAccount } = await import('@/lib/manual');
    const real = txns.editManualTxn;
    return spyOn(txns, 'editManualTxn').mockImplementationOnce(async (c, id, changes, opts) => {
      const saved = await real(c, id, changes, opts);
      await removeManualAccount(c, account);
      return saved;
    });
  };

  test('a row moved into an account deleted at the same moment: answered 404, and the change recorded failed, never dropped', async () => {
    const { transaction } = await versionOf(`transactions/${MARKET}`);
    const racing = await deletedDuring('manual_house');
    let moved: Sent;
    try {
      moved = await send('PATCH', `transactions/${MARKET}`, { body: { account_id: 'manual_house' }, headers: { 'if-match': transaction.version } });
    } finally {
      racing.mockRestore();
    }
    expect([moved.status, moved.body.error.code, moved.body.error.message]).toEqual([404, 'not_found', 'Its account was deleted meanwhile, and the transaction went with it.']);
    expect(await findManualTxn(ctx, MARKET)).toBeNull();
    const recorded = [...(await changeStore.getAll(ctx)).values()].filter((c) => c.op === 'transaction.update');
    expect(recorded.map((c) => [c.target.id, c.state, c.error])).toEqual([[MARKET, 'failed', 'account-gone']]);
  });

  test('an undo moving a row back into an account deleted at the same moment: refused, and the undo recorded failed', async () => {
    const { transaction } = await versionOf(`transactions/${MARKET}`);
    const moved = await send('PATCH', `transactions/${MARKET}`, { body: { account_id: 'manual_house' }, headers: { 'if-match': transaction.version } });
    expect(moved.status).toBe(200);
    const racing = await deletedDuring(WALLET);
    let undone: Sent;
    try {
      undone = await send('POST', `changes/${moved.body.change_id}/undo`);
    } finally {
      racing.mockRestore();
    }
    expect([undone.status, undone.body.error.code, undone.body.error.message]).toEqual([409, 'conflict', 'Its account was deleted meanwhile, and the transaction went with it. It wasn’t undone.']);
    const undos = [...(await changeStore.getAll(ctx)).values()].filter((c) => c.op === 'undo');
    expect(undos.map((c) => [c.state, c.error])).toEqual([['failed', 'account-gone']]);
  });
});

describe('the app’s own checks, on every create', () => {
  // Every body the app's own route refuses, the API refuses too, and neither
  // stores anything: the API may be stricter, never looser.
  const nothingNew = async () => JSON.stringify(await stored());
  const both = async (what: string, viaApp: () => Promise<{ status: number }>, viaApi: () => Promise<{ status: number }>) => {
    const before = await nothingNew();
    const [a, b] = [await viaApp(), await viaApi()];
    expect([what, a.status >= 400, b.status >= 400]).toEqual([what, true, true]);
    expect([what, await nothingNew()]).toEqual([what, before]);
  };

  test('a manual account: the balance ceiling, an owed balance below zero, a name, a type, a currency', async () => {
    await ensureTaxonomy(ctx);
    const good = { name: 'Jar', institution_name: 'Home', type: 'depository', subtype: 'cash', balance: 12.5 };
    for (const [what, body] of [
      ['past the balance ceiling', { ...good, balance: 9.9e12 }],
      ['an owed balance below zero', { ...good, type: 'credit', balance: -5 }],
      ['no name', { ...good, name: '   ' }],
      ['no institution', { ...good, institution_name: '' }],
      ['another type', { ...good, type: 'savings' }],
      ['a currency no one has', { ...good, currency: 'XYZ' }],
      ['a balance that is no number', { ...good, balance: 'lots' }],
    ] as const) {
      await both(what, () => app('manual-accounts', 'POST', body), () => send('POST', 'manual-accounts', { body }));
    }
    // At the ceiling, both take it.
    expect((await app('manual-accounts', 'POST', { ...good, balance: 1e12 })).status).toBe(200);
    expect((await send('POST', 'manual-accounts', { body: { ...good, name: 'Jar 2', balance: -1e12 } })).status).toBe(201);
  });

  test('a transaction: its amount, name, day, currency and note', async () => {
    await ensureTaxonomy(ctx);
    const good = { account_id: WALLET, date: daysAgo(0, NOW), amount: 4.5, currency: 'USD', name: 'Coffee' };
    for (const [what, body] of [
      ['zero', { ...good, amount: 0 }],
      ['more decimals than its currency has', { ...good, amount: 4.555 }],
      ['no name', { ...good, name: ' ' }],
      ['no such day', { ...good, date: '2026-02-30' }],
      ['far ahead', { ...good, date: '2030-01-01' }],
      ['a currency no one has', { ...good, currency: 'XYZ' }],
      ['a note too long', { ...good, note: 'x'.repeat(501) }],
      ['no such account', { ...good, account_id: 'manual_nope' }],
      ['a bank’s account', { ...good, account_id: 'acc_chk' }],
    ] as const) {
      await both(what, () => app('manual-transactions', 'POST', body), () => send('POST', 'transactions', { body }));
    }
  });

  test('a category, a group and a tag: names, kinds, colors, and one already there', async () => {
    const t = await ensureTaxonomy(ctx);
    const group = t.groups[0].id;
    const taken = t.categories[0].name;
    for (const [what, viaApp, viaApi] of [
      ['a category with no name', { action: 'add-category', name: ' ', group }, { name: ' ', group_id: group }],
      ['a category name too long', { action: 'add-category', name: 'x'.repeat(61), group }, { name: 'x'.repeat(61), group_id: group }],
      ['a category name taken', { action: 'add-category', name: taken.toUpperCase(), group }, { name: taken.toUpperCase(), group_id: group }],
      ['a category in no group', { action: 'add-category', name: 'Pets', group: 'nope' }, { name: 'Pets', group_id: 'nope' }],
    ] as const) {
      await both(what, () => app('categories', 'POST', viaApp), () => send('POST', 'categories', { body: viaApi }));
    }
    for (const [what, viaApp, viaApi] of [
      ['a group of no kind', { action: 'add-group', name: 'Side', kind: 'savings' }, { name: 'Side', kind: 'savings' }],
      ['a group name taken', { action: 'add-group', name: t.groups[0].name, kind: 'expense' }, { name: t.groups[0].name, kind: 'expense' }],
    ] as const) {
      await both(what, () => app('categories', 'POST', viaApp), () => send('POST', 'category-groups', { body: viaApi }));
    }
    expect((await app('tags', 'POST', { action: 'add', name: 'Trip' })).status).toBe(200);
    for (const [what, viaApp, viaApi] of [
      ['a tag with no name', { action: 'add', name: '' }, { name: '' }],
      ['a tag of no color', { action: 'add', name: 'Work', color: 'black' }, { name: 'Work', color: 'black' }],
      ['a tag name taken', { action: 'add', name: 'trip' }, { name: 'trip' }],
      ['a tag name too long', { action: 'add', name: 'x'.repeat(41) }, { name: 'x'.repeat(41) }],
    ] as const) {
      await both(what, () => app('tags', 'POST', viaApp), () => send('POST', 'tags', { body: viaApi }));
    }
  });
});

describe('strict bodies', () => {
  test('an unknown field, a field twice, a wrong type, a null where none is taken, too long, not JSON, not sent as JSON', async () => {
    const base = { account_id: WALLET, date: daysAgo(0, NOW), amount: 4.5, name: 'Coffee' };
    for (const [why, opts, status] of [
      ['unknown', { body: { ...base, payee: 'Coffee' } }, 400],
      ['twice', { raw: `{"account_id":"${WALLET}","date":"${daysAgo(0, NOW)}","name":"Coffee","amount":1,"amount":1000}` }, 400],
      ['type', { body: { ...base, amount: '4.50' } }, 400],
      ['null', { body: { ...base, amount: null } }, 400],
      ['long', { body: { ...base, name: 'x'.repeat(101) } }, 400],
      ['huge', { raw: JSON.stringify({ ...base, note: 'x'.repeat(9000) }) }, 413],
      ['not json', { raw: '{"name": ' }, 400],
      ['not sent as json', { raw: JSON.stringify(base), headers: { 'content-type': 'text/plain' } }, 415],
      ['cents', { body: { ...base, amount: 4.555 } }, 400],
      ['missing', { body: { account_id: WALLET, amount: 1, name: 'x' } }, 400],
      ['too early', { body: { ...base, date: '2024-01-01' } }, 400],
    ] as const) {
      const r = await send('POST', 'transactions', opts as any);
      expect([why, r.status]).toEqual([why, status]);
    }
    expect((await manualTxnStore.get(ctx, WALLET))!.rows).toHaveLength(1);
    // Null where it means none: the note cleared.
    const { transaction } = await versionOf(`transactions/${MARKET}`);
    expect((await send('PATCH', `transactions/${MARKET}`, { body: { note: null }, headers: { 'if-match': transaction.version } })).status).toBe(200);
    expect((await findManualTxn(ctx, MARKET))!.row.note).toBeNull();
  });
});

describe('what a write can never do', () => {
  test('a bank’s transaction, a connector’s or a file’s row, a linked or connector-fed account', async () => {
    expect((await send('PATCH', 'transactions/t_rent', { body: { name: 'x' }, headers: { 'if-match': 'x' } })).body.error.code).toBe('forbidden');
    expect((await send('DELETE', 'transactions/t_rent', { headers: { 'if-match': 'x' } })).body.error.code).toBe('forbidden');
    // A row SimpleFIN brought into a kept account, and one from a file.
    const at = new Date(NOW).toISOString();
    const row = (id: string, source: string) => ({ id, account_id: WALLET, date: daysAgo(2, NOW), amount: 9, currency: 'USD', name: 'Bank row', category: null, note: null, source, source_id: 'x', created_at: at, updated_at: at });
    await manualTxnStore.update(ctx, WALLET, (b) => ({ ...b!, rows: [...b!.rows, row('manual-txn:sf-1-aaaaaaaaaaaa', 'simplefin'), row('manual-txn:ofx-1-aaaaaaaaaa', 'import:ofx')] }));
    for (const id of ['manual-txn:sf-1-aaaaaaaaaaaa', 'manual-txn:ofx-1-aaaaaaaaaa']) {
      expect([id, (await send('PATCH', `transactions/${id}`, { body: { name: 'x' }, headers: { 'if-match': 'x' } })).body.error.code]).toEqual([id, 'forbidden']);
      expect([id, (await send('DELETE', `transactions/${id}`, { headers: { 'if-match': 'x' } })).body.error.code]).toEqual([id, 'forbidden']);
    }
    expect((await send('POST', 'manual-accounts/acc_chk/balance', { body: { balance: 1 } })).body.error.code).toBe('forbidden');
    expect((await send('POST', 'transactions', { body: { account_id: 'acc_chk', date: daysAgo(0, NOW), amount: 1, name: 'x' } })).body.error.code).toBe('forbidden');
    // An account a connector feeds has a manual account's kind of id.
    await fake.hset(ctxKey('connector-accounts'), { manual_sf: 'held' });
    expect((await send('POST', 'manual-accounts/manual_sf/balance', { body: { balance: 1 } })).body.error.code).toBe('forbidden');
    expect((await send('POST', 'transactions', { body: { account_id: 'manual_sf', date: daysAgo(0, NOW), amount: 1, name: 'x' } })).body.error.code).toBe('forbidden');
  });

  test('a manual account crossing between held and owed', async () => {
    const { OWED_FLIP } = await import('@/lib/manual-account-writes');
    const { account } = await versionOf(`manual-accounts/${WALLET}`);
    const r = await send('PATCH', `manual-accounts/${WALLET}`, { body: { type: 'credit' }, headers: { 'if-match': account.version } });
    expect([r.status, r.body.error.code, r.body.error.message]).toEqual([409, 'conflict', OWED_FLIP]);
    expect((await getManualAccount(ctx, WALLET))!.type).toBe('depository');
    // Within one side: allowed.
    expect((await send('PATCH', `manual-accounts/${WALLET}`, { body: { type: 'other' }, headers: { 'if-match': account.version } })).status).toBe(200);
  });

  test('a split row, deleted; room the app keeps for itself', async () => {
    // A split of it, as the seam would find one there.
    await fake.hset(ctxKey('transaction-splits'), { [MARKET]: 'present' });
    const { transaction } = await versionOf(`transactions/${MARKET}`);
    const r = await send('DELETE', `transactions/${MARKET}`, { headers: { 'if-match': transaction.version } });
    expect([r.status, r.body.error.message]).toEqual([409, expect.stringContaining('split')]);
    expect(await findManualTxn(ctx, MARKET)).not.toBeNull();
    // Accounts: the API stops at 45 of the 50.
    for (let i = 0; i < 43; i++) {
      await saveManualAccount(ctx, { account_id: `manual_x${i}`, name: `X${i}`, institution_name: 'X', type: 'other', subtype: null, balance: 0, updated_at: new Date(NOW).toISOString() });
    }
    const full = await send('POST', 'manual-accounts', { body: { name: 'One more', institution_name: 'X', type: 'other', balance: 1 } });
    expect([full.status, full.body.error.message]).toEqual([409, expect.stringContaining('kept for the app')]);
  });

  test('another container: its ids are nowhere, and nothing of it changes', async () => {
    await seedOther(fake);
    const before = JSON.stringify([...fake.hashes].filter(([k]) => k.startsWith(ctxKey('', OTHER))));
    expect((await send('PATCH', 'transactions/t_o', { body: { name: 'x' }, headers: { 'if-match': 'x' } })).status).toBe(403);
    expect((await send('POST', 'manual-accounts/manual_other/balance', { body: { balance: 1 } })).status).toBe(404);
    expect((await send('GET', 'transactions/t_o')).status).toBe(404);
    expect(JSON.stringify([...fake.hashes].filter(([k]) => k.startsWith(ctxKey('', OTHER))))).toBe(before);
  });
});

