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
const { MANUAL_TYPES, MAX_MANUAL_ACCOUNTS, getManualAccount, saveManualAccount } = await import('@/lib/manual');
const { TAG_COLORS, TAG_NAME_MAX, MAX_TAGS, MAX_TAGS_PER_TRANSACTION, readTagSet } = await import('@/lib/tags');
const { NAME_MAX, ICON_MAX, MAX_CATEGORIES, MAX_GROUPS } = await import('@/lib/categories');
const { MAX_PAYEE_CHARS, MAX_NOTE_CHARS } = await import('@/lib/manual-txn-input');
const { ensureTaxonomy, readTaxonomy } = await import('@/lib/category-store');
const { manualTxnStore, findManualTxn } = await import('@/lib/manual-txns');
const { changeAnnotation } = await import('@/lib/txn-annotations');
const { changeStore, claimStore } = await import('@/lib/api-changes');
const { apiWriteDays } = await import('@/lib/api-token-store');

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const WALLET = 'manual_wallet';
const MARKET = 'manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';

let writer = '';
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
  writer = (await createToken(ctx, 'Importer', new Date(NOW), null, 'write')).token;
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
      writer = (await createToken(ctx, 'Importer', new Date(NOW), null, 'write')).token;
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
    expect((await send('PATCH', `transactions/${MARKET}`, { body: { note: 'x' } })).headers.get('allow')).toBe('GET');
    // Reading by id is reading: it works either way.
    expect((await send('GET', `transactions/${MARKET}`)).status).toBe(200);
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

  test('at most 100 creates a day for a token', async () => {
    const writerId = [...(await apiTokenStore.getAll(ctx))].find(([, t]) => t.label === 'Importer')![0];
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

  test('two sent at once with one key make one record', async () => {
    const [x, y] = await Promise.all([
      send('POST', 'tags', { body: { name: 'Once' }, headers: { 'idempotency-key': 'race' } }),
      send('POST', 'tags', { body: { name: 'Once' }, headers: { 'idempotency-key': 'race' } }),
    ]);
    expect([x.status, y.status].sort()).toEqual(expect.arrayContaining([201]));
    expect((await readTagSet(ctx))!.tags.filter((t) => t.name === 'Once')).toHaveLength(1);
    expect([x.status, y.status].every((s) => s === 201 || s === 200 || s === 409)).toBe(true);
  });

  test('one that stopped part way is taken over after a minute: found and replayed, or made again under a new id, never the old one', async () => {
    // A first attempt that made its tag, then stopped before saying so.
    const first = await send('POST', 'tags', { body: { name: 'Halfway' }, headers: { 'idempotency-key': 'k-2' } });
    const changeId = first.body.change_id;
    await changeStore.update(ctx, changeId, (c) => (c ? { ...c, state: 'pending' } : null));
    const soon = await send('POST', 'tags', { body: { name: 'Halfway' }, headers: { 'idempotency-key': 'k-2' } });
    expect([soon.status, soon.body.error.code]).toEqual([409, 'in_progress']);
    setSystemTime(new Date(NOW + 61_000));
    const later = await send('POST', 'tags', { body: { name: 'Halfway' }, headers: { 'idempotency-key': 'k-2' } });
    expect([later.status, later.body.tag.id]).toEqual([200, first.body.tag.id]);
    expect((await changeStore.get(ctx, changeId))!.state).toBe('done');

    // One that made nothing: made now, under a fresh id.
    const lost = await send('POST', 'tags', { body: { name: 'Lost' }, headers: { 'idempotency-key': 'k-3' } });
    const lostChange = (await changeStore.get(ctx, lost.body.change_id))!;
    await quietly(async () => {
      const { deleteTag } = await import('@/lib/tag-delete');
      await deleteTag(ctx, lost.body.tag.id);
    });
    // Its tag swept away entirely, and the change left pending: no trace.
    await changeStore.update(ctx, lost.body.change_id, (c) => (c ? { ...c, state: 'pending' } : null));
    setSystemTime(new Date(NOW + 130_000));
    const again = await send('POST', 'tags', { body: { name: 'Lost' }, headers: { 'idempotency-key': 'k-3' } });
    expect(again.status).toBe(201);
    expect(again.body.tag.id).not.toBe(lostChange.target.id);
  });

  test('made, then removed since: a key sent again says so, and makes nothing', async () => {
    const made = await send('POST', 'tags', { body: { name: 'Gone' }, headers: { 'idempotency-key': 'k-4' } });
    const { deleteTag } = await import('@/lib/tag-delete');
    await deleteTag(ctx, made.body.tag.id);
    const again = await send('POST', 'tags', { body: { name: 'Gone' }, headers: { 'idempotency-key': 'k-4' } });
    expect([again.status, again.body]).toEqual([200, { deleted: true, change_id: made.body.change_id }]);
    expect((await readTagSet(ctx))!.tags.some((t) => t.name === 'Gone')).toBe(false);
    // A pending first attempt whose tag is being deleted: a trace, refused.
    const second = await send('POST', 'tags', { body: { name: 'Swept' }, headers: { 'idempotency-key': 'k-5' } });
    await changeStore.update(ctx, second.body.change_id, (c) => (c ? { ...c, state: 'pending' } : null));
    const { changeTagSet, markDeleted } = await import('@/lib/tags');
    await changeTagSet(ctx, (s) => markDeleted(s, second.body.tag.id));
    setSystemTime(new Date(NOW + 61_000));
    const refused = await send('POST', 'tags', { body: { name: 'Swept' }, headers: { 'idempotency-key': 'k-5' } });
    expect([refused.status, refused.body.error.code]).toEqual([409, 'conflict']);
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
    const { account } = await versionOf(`manual-accounts/${WALLET}`);
    const r = await send('PATCH', `manual-accounts/${WALLET}`, { body: { type: 'credit' }, headers: { 'if-match': account.version } });
    expect([r.status, r.body.error.code, r.body.error.message]).toEqual([409, 'conflict', expect.stringContaining('held and money owed')]);
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

