import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Rules (#36), end to end through the routes: a rule made from a transaction
// changes every past and future match, applied on read and never written
// into a row; a choice made on one transaction beats every rule; a rule
// turned off puts its rows back and is kept; rules survive a resync and a
// cache clear; a category's rename and merge are followed and its deletion
// is refused; the preview counts every stored transaction; and the routes
// check what they are told and answer the seam's errors in the seam's way.

const ctx = TEST_CTX;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
// The real ceiling on a stored value: a file run before this one may have
// lowered it for its own tests (lib/blob.ts reads it on every write).
delete process.env.MAX_TXN_BLOB_CHARS;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

// What Plaid sends for each Item: its first sync, and what a later one adds.
const plaidTxns: Record<string, any[]> = {};
const plaidLater: Record<string, any[]> = {};
const plaidAccounts: Record<string, any[]> = {};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async (req: any) => ({
      data: {
        added: req.cursor ? (plaidLater[req.access_token] ?? []) : (plaidTxns[req.access_token] ?? []),
        modified: [],
        removed: [],
        accounts: plaidAccounts[req.access_token] ?? [],
        next_cursor: 'c1',
        has_more: false,
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      },
    }),
  },
}));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { rememberAccounts } = await import('@/lib/last-known');
const { saveManualAccount } = await import('@/lib/manual');
const { addManualTxn, newManualTxn } = await import('@/lib/manual-txns');
const { clearCaches } = await import('@/lib/cache');
const { rulesStore } = await import('@/lib/rules');

const account = (id: string) => ({
  account_id: id,
  name: 'Checking',
  official_name: null,
  type: 'depository',
  subtype: 'checking',
  mask: '4821',
  balances: { available: 100, current: 100, limit: null, iso_currency_code: 'USD' },
});
const row = (id: string, over: Record<string, unknown> = {}) => ({
  transaction_id: id,
  account_id: 'acct_a',
  amount: 12,
  iso_currency_code: 'USD',
  date: daysAgo(3),
  name: 'AMZN MKTP US*2K4',
  merchant_name: null,
  pending: false,
  counterparties: [],
  personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES' },
  ...over,
});

const route = async (path: string, method: string, body?: unknown, raw?: string) => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res = await mod[method](new Request(`http://x/api/${path}`, { method, body: raw ?? (body ? JSON.stringify(body) : undefined) }));
  return { status: res.status, body: await res.json() };
};
const listed = async () => (await route('transactions', 'GET')).body;
const rowOf = async (id: string) => (await listed()).transactions.find((t: any) => t.transaction_id === id);
const ruleAction = (body: Record<string, unknown>) => route('rules', 'POST', body);
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [error, warn] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    [console.error, console.warn] = [error, warn];
  }
};

let categories: any;
const catId = (name: string) => categories.categories.find((c: any) => c.name === name).id;
const MANUAL = 'manual_6b1f3e2a-1c4d-4e5f-8a9b-0c1d2e3f4a5b';
let typed = '';

beforeEach(async () => {
  fake.reset();
  for (const k of Object.keys(plaidLater)) delete plaidLater[k];
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  const token = 'token-item_a';
  plaidAccounts[token] = [account('acct_a')];
  plaidTxns[token] = [
    row('t_recent'),
    row('t_old', { date: daysAgo(500), amount: 40 }),
    row('t_coffee', { name: 'BLUE BOTTLE', amount: 5, personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' } }),
  ];
  await fake.hset(ctxKey('plaid:items'), { item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', encrypted_access_token: await encrypt(token) }) });
  await rememberAccounts(ctx, [{ item_id: 'item_a', institution_name: 'Chase', institution_id: null, error: null, accounts: [{ ...account('acct_a'), balance: 1 }] } as any]);
  await saveManualAccount(ctx, { account_id: MANUAL, name: 'Cash', institution_name: 'Wallet', type: 'depository', subtype: 'cash', balance: 50 } as any);
  const t = newManualTxn(MANUAL, { date: daysAgo(2), name: 'AMZN locker pickup', amount: 9, currency: 'USD', category: null, note: null });
  await addManualTxn(ctx, t);
  typed = t.id;
  categories = (await route('categories', 'GET')).body.categories;
});

/** The rule that files Amazon under shopping, made as the app makes it. */
const amazonRule = async (actions: Record<string, unknown> = { set_category: catId('general merchandise') }) => {
  const r = await ruleAction({ action: 'add', rule: { conditions: [{ field: 'name', op: 'contains', value: 'amzn' }], actions } });
  expect(r.status).toBe(200);
  return r.body.created as string;
};

describe('applied on read, to every past and future match', () => {
  test('a rule made changes every match at once, the bank’s and one entered by hand, and one synced later', async () => {
    const travel = catId('travel');
    await amazonRule({ set_category: travel, set_name: 'Amazon', hide: true });
    const body = await listed();
    const recent = body.transactions.find((t: any) => t.transaction_id === 't_recent');
    expect(recent).toMatchObject({ name: 'Amazon', category_id: travel, excluded: true, excluded_by_rule: true, rule_ids: [expect.any(String)] });
    // Entered by hand: filed (it has no category of its own) and hidden, its name its own.
    expect(body.transactions.find((t: any) => t.transaction_id === typed)).toMatchObject({ name: 'AMZN locker pickup', category_id: travel, excluded: true });
    expect(body.transactions.find((t: any) => t.transaction_id === 't_coffee').rule_ids).toBeUndefined();
    // Nothing a rule did was written into a stored row.
    expect(JSON.stringify([...((fake as any).strings as Map<string, string>).keys()])).not.toContain('rules-applied');
    // A transaction that arrives later matches too.
    plaidLater['token-item_a'] = [row('t_new', { date: daysAgo(1) })];
    await clearCaches(ctx);
    expect(await rowOf('t_new')).toMatchObject({ name: 'Amazon', category_id: travel, excluded: true });
  });

  test('rules survive a resync and a cache clear', async () => {
    await amazonRule({ set_name: 'Amazon' });
    // Read from the cache, and synced again once it is cleared.
    expect((await rowOf('t_recent')).name).toBe('Amazon');
    await clearCaches(ctx);
    expect((await rowOf('t_recent')).name).toBe('Amazon');
  });

  test('a choice made on one transaction beats every rule', async () => {
    await amazonRule({ set_category: catId('travel'), set_name: 'Amazon', hide: true, add_tags: [(await route('tags', 'POST', { action: 'add', name: 'Work' })).body.created] });
    const groceries = catId('food and drink');
    expect((await route('recategorize', 'POST', { transaction_id: 't_recent', category_id: groceries })).status).toBe(200);
    expect((await route('transaction-annotations', 'PATCH', { transaction_id: 't_recent', excluded: false })).status).toBe(200);
    const work = (await route('tags', 'GET')).body.tags.tags[0].id;
    expect((await route('transaction-annotations', 'PATCH', { transaction_id: 't_recent', remove_tags: [work] })).status).toBe(200);
    const vendor = (await rowOf('t_recent')).vendor_key;
    expect((await route('rename', 'POST', { vendor_key: vendor, name: 'My Amazon' })).status).toBe(200);
    const t = await rowOf('t_recent');
    expect([t.category_id, t.excluded, t.tags, t.name]).toEqual([groceries, undefined, undefined, 'My Amazon']);
    // Still matched, so the person can see which rule would apply.
    expect(t.rule_ids).toHaveLength(1);
  });

  test('turning a rule off puts its rows back and keeps it; on again applies it again', async () => {
    const id = await amazonRule({ set_name: 'Amazon', hide: true });
    expect((await ruleAction({ action: 'enable', id, enabled: false })).status).toBe(200);
    const t = await rowOf('t_recent');
    expect([t.name, t.excluded, t.rule_ids]).toEqual(['AMZN MKTP US*2K4', undefined, undefined]);
    expect((await route('rules', 'GET')).body.rules.rules).toHaveLength(1);
    await ruleAction({ action: 'enable', id, enabled: true });
    expect((await rowOf('t_recent')).name).toBe('Amazon');
    await ruleAction({ action: 'delete', id });
    expect((await rowOf('t_recent')).name).toBe('AMZN MKTP US*2K4');
  });

  test('rules in priority order: the first to set a field decides it, and reordering changes which', async () => {
    const shop = await amazonRule({ set_name: 'Amazon shopping' });
    const all = await ruleAction({ action: 'add', rule: { conditions: [{ field: 'amount', op: 'gt', value: 10 }], actions: { set_name: 'Big one' } } });
    // The newest is first.
    expect((await rowOf('t_recent')).name).toBe('Big one');
    await ruleAction({ action: 'order', ids: [shop, all.body.created] });
    expect((await rowOf('t_recent')).name).toBe('Amazon shopping');
  });

  test('a rule follows its category through a rename and a merge; deleting a category a rule uses is refused', async () => {
    const add = await route('categories', 'POST', { action: 'add-category', name: 'Online', group: categories.groups[1].id });
    const online = add.body.categories.categories.find((c: any) => c.name === 'Online').id;
    await amazonRule({ set_category: online });
    await route('categories', 'POST', { action: 'rename-category', id: online, name: 'Web shops' });
    expect((await rowOf('t_recent'))).toMatchObject({ category_id: online, category_name: 'Web shops' });
    const refused = await route('categories', 'POST', { action: 'delete-category', id: online });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('rule');
    const into = catId('general merchandise');
    await route('categories', 'POST', { action: 'merge', id: online, into });
    expect((await rowOf('t_recent')).category_id).toBe(into);
    const after = (await route('rules', 'GET')).body;
    expect(after.problems).toEqual({});
    // Shown, and so edited, with the category it went into; stored as it was until saved.
    expect(after.rules.rules[0].actions.set_category).toBe(into);
    expect((await rulesStore.get(ctx))!.rules[0].actions.set_category).toBe(online);
  });

  test('a rule whose category is gone is shown broken and does nothing, never re-pointed', async () => {
    const id = await amazonRule({ set_category: catId('travel'), set_name: 'Amazon' });
    // Deleted from outside the app (a restore, a hand edit): the rule still names it.
    const set = (await rulesStore.get(ctx))!;
    await rulesStore.set(ctx, { ...set, rules: set.rules.map((r) => (r.id === id ? { ...r, actions: { ...r.actions, set_category: 'gone-category' } } : r)) });
    expect((await route('rules', 'GET')).body.problems).toEqual({ [id]: 'A category it names was deleted, so it does nothing until you choose another.' });
    const t = await rowOf('t_recent');
    expect([t.name, t.rule_ids]).toEqual(['AMZN MKTP US*2K4', undefined]);
  });
});

describe('the preview', () => {
  test('counts every stored match, of any date, and lists the newest few', async () => {
    await route('transactions', 'GET'); // stored
    const r = await route('rules/preview', 'POST', { rule: { conditions: [{ field: 'name', op: 'contains', value: 'amzn' }], actions: { set_category: catId('travel') } } });
    expect(r.status).toBe(200);
    // The one from 500 days ago too, which the Activity tab's year doesn't show.
    expect(r.body.matches).toBe(3);
    expect(r.body.samples.map((s: any) => s.transaction_id)).toEqual([typed, 't_recent', 't_old']);
    expect(r.body.keep_category).toBe(0);
  });

  test('says how many keep a category the person chose', async () => {
    await route('transactions', 'GET');
    await route('recategorize', 'POST', { transaction_id: 't_recent', category_id: catId('food and drink') });
    const r = await route('rules/preview', 'POST', { rule: { conditions: [{ field: 'name', op: 'contains', value: 'amzn' }], actions: { set_category: catId('travel') } } });
    expect([r.body.matches, r.body.keep_category]).toEqual([3, 1]);
  });

  test('a rule it can’t take is refused as a save would be', async () => {
    const r = await route('rules/preview', 'POST', { rule: { conditions: [], actions: { hide: true } } });
    expect(r.status).toBe(400);
  });
});

describe('the rules route', () => {
  test('checks everything it is told, saying why', async () => {
    const cases: [unknown, number, string][] = [
      [{ action: 'add', rule: { conditions: [{ field: 'name', op: 'contains', value: 'x' }], actions: {} } }, 400, 'Say what the rule does: a category, a name, tags, or hiding what it matches.'],
      [{ action: 'add', rule: 'x' }, 400, 'Invalid request'],
      [{ action: 'edit', id: 'gone', rule: { conditions: [{ field: 'name', op: 'contains', value: 'x' }], actions: { hide: true } } }, 404, 'That rule no longer exists. Reload to see your rules as they are.'],
      [{ action: 'enable', id: 'gone', enabled: true }, 404, 'That rule no longer exists. Reload to see your rules as they are.'],
      [{ action: 'order', ids: ['a'] }, 409, 'Your rules changed since this page loaded. Reload to see them as they are.'],
      [{ action: 'shout' }, 400, 'Invalid request'],
    ];
    for (const [body, status, error] of cases) expect([body, await ruleAction(body as any)]).toEqual([body, { status, body: { error } }]);
    expect(await route('rules', 'POST', undefined, 'not json')).toEqual({ status: 400, body: { error: 'Invalid request' } });
    expect((await route('rules', 'POST', undefined, JSON.stringify({ action: 'add', pad: 'x'.repeat(40_000) }))).status).toBe(413);
    expect(await rulesStore.get(ctx)).toBeNull();
  });

  test('rules that can’t be read: 409 and flagged on every change, left as they are, and the Activity tab says none apply', async () => {
    await fake.set(ctxKey('rules'), 'not-ciphertext-but-long-enough-to-be-tried');
    for (const r of [await quietly(() => route('rules', 'GET')), await quietly(() => ruleAction({ action: 'delete', id: 'x' }))]) {
      expect(r.status).toBe(409);
      expect(r.body.unreadable).toBe(true);
    }
    expect(await fake.get<string>(ctxKey('rules'))).toBe('not-ciphertext-but-long-enough-to-be-tried');
    const body = await quietly(() => listed());
    expect(body.notes).toContain("Your rules couldn't be read, so none are applied until they can be: transactions show as the bank and you have them.");
  });

  test('a change that keeps losing its compare-and-set answers 409; no container answers 503', async () => {
    await amazonRule();
    const real = fake.eval.bind(fake);
    fake.eval = (async (script: string, keys: string[], args: string[]) => (script.includes('nya:repo-update-value') ? 0 : real(script, keys, args))) as typeof fake.eval;
    try {
      const r = await ruleAction({ action: 'add', rule: { conditions: [{ field: 'name', op: 'contains', value: 'x' }], actions: { hide: true } } });
      expect(r.status).toBe(409);
      expect(r.body.error).toContain('kept changing');
    } finally {
      fake.eval = real;
    }
    fake.reset();
    (await import('@/lib/sessions')).forgetEpochs();
    expect((await quietly(() => route('rules', 'GET'))).status).toBe(503);
  });

  test('each container keeps its own', async () => {
    await amazonRule();
    expect(await rulesStore.get(OTHER)).toBeNull();
  });
});

describe('kept as every financial payload is', () => {
  test('rules and tags are encrypted at rest: nothing they say is in the stored bytes', async () => {
    await route('tags', 'POST', { action: 'add', name: 'SECRET-TAG-NAME' });
    await ruleAction({ action: 'add', rule: { conditions: [{ field: 'name', op: 'contains', value: 'SECRET-MERCHANT' }], actions: { set_name: 'SECRET-NAME' } } });
    await route('transaction-annotations', 'PATCH', { transaction_id: 't_recent', note: 'SECRET-NOTE' });
    const stored = JSON.stringify([fake.strings.get(ctxKey('rules')), fake.strings.get(ctxKey('tags')), [...(fake.hashes.get(ctxKey('transaction-annotations')) ?? new Map()).values()]]);
    expect(stored).not.toMatch(/SECRET/i);
    expect(stored.length).toBeGreaterThan(100);
  });

  test('a write too large for one request is refused whole (413), never trimmed', async () => {
    await amazonRule();
    const before = process.env.MAX_TXN_BLOB_CHARS;
    process.env.MAX_TXN_BLOB_CHARS = '300';
    try {
      const r = await quietly(() => ruleAction({ action: 'add', rule: { conditions: [{ field: 'name', op: 'contains', value: 'x'.repeat(90) }], actions: { set_name: 'y'.repeat(90) } } }));
      expect(r.status).toBe(413);
      expect(r.body.error).toContain('Your rules are too large to save');
    } finally {
      if (before === undefined) delete process.env.MAX_TXN_BLOB_CHARS;
      else process.env.MAX_TXN_BLOB_CHARS = before;
    }
    expect((await rulesStore.get(ctx))!.rules).toHaveLength(1);
  });

  test('storage usage measures them, as every store on the seam', async () => {
    await amazonRule();
    await route('tags', 'POST', { action: 'add', name: 'Work' });
    const usage = (await route('storage-usage', 'GET')).body;
    const names = usage.stores.map((s: any) => s.store);
    expect(names).toContain('rules');
    expect(names).toContain('tags');
    expect(usage.stores.find((s: any) => s.store === 'rules')).toMatchObject({ what: 'rules', entries: 1 });
  });
});
