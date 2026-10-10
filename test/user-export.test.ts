import { describe, expect, test, mock, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRedis, storageMock, testKey, ctxKey, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { parseCsv } from './csv-parse';

// Real AES-256-GCM: the point is that everything comes out decrypted.
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Deserializing like Upstash: what production reads back.
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { contentKey } = await import('@/lib/transactions');
const { connectionId } = await import('@/lib/sharing');
const { getHistory, getAccountHistory } = await import('@/lib/history');
const {
  collectUserData,
  buildUserExport,
  countAccounts,
  exportFile,
  jsonPieces,
  fileByteLength,
  fileChunks,
  ONE_RECORD_PER_LINE,
  ExportReadError,
  STORED_KEYS,
  storedKeyListed,
  SECTIONS,
  declaredSections,
  TRANSACTION_COLUMNS,
  BALANCE_COLUMNS,
  EXPORT_FORMAT,
  EXPORT_VERSION,
} = await import('@/lib/user-export');

const { defineMapStore, defineValueStore, forgetDeclaredStore, UnreadableEntriesError, UnreadableValueError } = await import('@/lib/repo');
const { declaredStores } = await import('@/lib/stores');

const ctx = TEST_CTX;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
/** Sam's container: the one I'm connected with. */
const FRIEND = { container: '2b3c4d5e-6f70-4a81-9b2c-3d4e5f607182' } as typeof TEST_CTX;
/** How connections are kept, environment-wide: by an id made from the two
 *  people's sign-in ids. Never in a download. */
const CONN = connectionId('user_me', 'user_friend');
/** The connection's log id: random, made with it. Both records of showings
 *  on it are kept under this, one in each container. */
const LOG_ID = '5e1f0c9a7b3d4e2f8a6b1c0d9e8f7a6b';
const MY_RECORD = { shown: [{ at: '2026-05-03T14:00:00.000Z', times: 2, read: { acc_chk: 'balance' as const, manual_house: 'exists' as const } }] };
/** Sam's record of what Sam shares being shown to me: an account they shared then. */
const THEIR_RECORD = { shown: [{ at: '2026-05-04T08:15:00.000Z', times: 1, read: { acc_friend_then: 'transactions' as const } }] };
const DAMAGED = 'not-ciphertext-but-long-enough-to-be-tried';
const NOW = new Date('2026-10-06T12:00:00.000Z');

// ---- A container with something in every store ----

const txn = (over: Record<string, unknown>) => ({
  transaction_id: 't',
  pending_transaction_id: null,
  account_id: 'acc_chk',
  amount: 4.5,
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
  date: '2026-01-02',
  authorized_date: '2026-01-01',
  authorized_datetime: null,
  datetime: '2026-01-02T08:15:00Z',
  name: 'COFFEE 123',
  merchant_name: 'Blue Bottle',
  merchant_entity_id: 'ent_bb',
  website: 'bluebottle.example',
  logo_url: 'https://logo.example/bb.png',
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE', confidence_level: 'VERY_HIGH' },
  personal_finance_category_icon_url: 'https://icon.example/food.png',
  pending: false,
  payment_channel: 'in store',
  transaction_code: null,
  transaction_type: 'place',
  check_number: null,
  account_owner: null,
  location: { address: '1 Main St', city: 'Oakland', region: 'CA', postal_code: '94607', country: 'US', lat: 37.8, lon: -122.27, store_number: '12' },
  payment_meta: { reference_number: 'REF1', ppd_id: null, payee: null, by_order_of: null, payer: null, payment_method: null, payment_processor: 'Square', reason: null },
  counterparties: [{ name: 'Blue Bottle', type: 'merchant', entity_id: 'ent_bb', website: null, logo_url: null, confidence_level: 'HIGH' }],
  category: 'food and drink',
  account_name: 'Checking',
  institution_name: 'Chase',
  ...over,
});

const TXNS = {
  t_coffee: txn({ transaction_id: 't_coffee' }),
  t_pending: txn({ transaction_id: 't_pending', pending: true, amount: 20, date: '2026-01-03', name: 'GAS', merchant_name: 'Shell', merchant_entity_id: null }),
  t_posted: txn({ transaction_id: 't_posted', pending_transaction_id: 't_pending', amount: 20.5, date: '2026-01-04', name: 'GAS', merchant_name: 'Shell', merchant_entity_id: null }),
  t_evil: txn({ transaction_id: 't_evil', amount: -1200, date: '2026-01-05', name: '@SUM(1+1)', merchant_name: '=HYPERLINK("http://evil.example","click")', merchant_entity_id: null }),
  t_card: txn({ transaction_id: 't_card', account_id: 'acc_card', amount: 30, date: '2026-01-03', account_name: 'Sapphire', name: 'BOOKS', merchant_name: 'Green Apple', merchant_entity_id: 'ent_ga' }),
  t_bakery: txn({ transaction_id: 't_bakery', amount: 7.25, date: '2025-12-20', name: 'BAKERY 12', merchant_name: 'Tartine', merchant_entity_id: null }),
};

const invRow = (id: string, over: Record<string, unknown> = {}) => ({
  investment_transaction_id: id,
  cancel_transaction_id: null,
  account_id: 'acc_brk',
  security_id: 's1',
  date: '2026-09-01',
  name: 'BUY Target 2055',
  quantity: 2,
  amount: 1000,
  price: 500,
  fees: 0,
  type: 'buy',
  subtype: 'buy',
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
  ...over,
});

const INV_STATE = {
  schema_version: 1,
  txns: {
    it_buy: { raw: invRow('it_buy'), seen_at: '2026-10-01' },
    it_gone: { raw: invRow('it_gone', { date: '2026-08-01' }), seen_at: '2026-09-01', missing_since: '2026-09-10T00:00:00.000Z', excluded: true },
    it_cxl: { raw: invRow('it_cxl', { date: '2026-07-01' }), seen_at: '2026-09-01', missing_since: '2026-09-15T00:00:00.000Z', excluded: true },
  },
  securities: { s1: { name: 'Target 2055', ticker_symbol: 'VFFVX', type: 'mutual fund', is_cash_equivalent: false, cusip: null, isin: null, iso_currency_code: 'USD' } },
  accounts: { acc_brk: { name: 'Brokerage', official_name: 'Fidelity Brokerage', mask: '9999', type: 'investment', subtype: 'brokerage', last_seen: '2026-10-01' } },
  coverage: { acc_brk: { from: '2024-10-06', through: '2026-10-01' } },
  synced_at: '2026-10-01T00:00:00.000Z',
  verified_at: '2026-10-01T00:00:00.000Z',
  attempted_at: '2026-10-01T00:00:00.000Z',
  cancelled: { it_cxl: '2026-09-15' },
};

const enc = async (value: unknown) => encrypt(typeof value === 'string' ? value : JSON.stringify(value));

async function seedPerson() {
  await fake.hset(ctxKey('plaid:items'), {
    item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', institution_id: 'ins_3', encrypted_access_token: await encrypt('access-sandbox-SECRET-a') }),
    // Linked as a brokerage: whether Plaid included transactions when it was linked is bookkeeping, left out.
    item_b: JSON.stringify({ item_id: 'item_b', institution_name: 'Fidelity', institution_id: 'ins_12', encrypted_access_token: await encrypt('access-sandbox-SECRET-b'), transactions_billed: false }),
  });
  await fake.hset(ctxKey('accounts:meta'), {
    item_a: await enc([
      { account_id: 'acc_chk', name: 'Checking', official_name: 'Total Checking', mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' },
      { account_id: 'acc_card', name: 'Sapphire', official_name: null, mask: '2222', type: 'credit', subtype: 'credit card', limit: 5000, currency: 'USD' },
    ]),
    item_b: await enc([{ account_id: 'acc_brk', name: 'Brokerage', official_name: null, mask: '9999', type: 'investment', subtype: 'brokerage', limit: null, currency: 'USD' }]),
  });
  await fake.hset(ctxKey('accounts:directory'), {
    acc_chk: await enc({ provider: 'plaid', item_id: 'item_a', institution_id: 'ins_3', institution_name: 'Chase', name: 'Checking', official_name: 'Total Checking', mask: '1111', type: 'depository', subtype: 'checking', persistent_account_id: 'pers_1', first_seen: '2025-06-01', last_seen: '2026-10-05' }),
    acc_old: await enc({ item_id: 'item_gone', institution_id: 'ins_3', institution_name: 'Chase', name: 'Old Checking', official_name: null, mask: '0000', type: 'depository', subtype: 'checking', persistent_account_id: null, first_seen: '2024-01-01', last_seen: '2025-05-31' }),
  });
  await fake.set(
    ctxKey('txns:item_a'),
    await encodeJsonBlob({
      schema_version: 2,
      cursor: 'cursor-SECRET',
      accounts: {
        acc_chk: { name: 'Checking', official_name: 'Total Checking', type: 'depository', subtype: 'checking', mask: '1111', balances: { available: 1650, current: 1700, limit: null, iso_currency_code: 'USD', unofficial_currency_code: null } },
        acc_card: { name: 'Sapphire', official_name: null, type: 'credit', subtype: 'credit card', mask: '2222', balances: { available: 4500, current: 500, limit: 5000, iso_currency_code: 'USD', unofficial_currency_code: null } },
      },
      txns: TXNS,
    })
  );
  await fake.set(ctxKey('invtxns:item_b'), await encodeJsonBlob(INV_STATE));
  await fake.hset(ctxKey('manual:accounts'), {
    manual_house: await enc({ account_id: 'manual_house', name: 'House', institution_name: 'Zillow estimate', type: 'other', subtype: null, balance: 400000, updated_at: '2026-09-30T10:00:00.000Z' }),
  });
  await fake.hset(ctxKey('hidden:accounts'), { acc_card: await enc({ type: 'credit', hidden_at: '2026-03-01T00:00:00.000Z' }) });
  await fake.hset(ctxKey('txn-category-overrides'), { t_coffee: await encrypt('Treats'), t_vanished: await encrypt('Old category') });
  await fake.hset(ctxKey('txn-vendor-renames'), { 'mid:ent_bb': await encrypt('BB Coffee') });
  await fake.hset(ctxKey('account-links'), {
    acc_old: await enc({ to: 'acc_chk', linked_at: '2025-06-02T00:00:00.000Z', evidence: { old_last: '2025-05-31', old_type: 'depository' } }),
  });
  await fake.hset(ctxKey('account-links:dismissed'), { 'acc_x>acc_chk': '2025-07-01T00:00:00.000Z', 'acc_y>*': '2025-07-02T00:00:00.000Z' });
  await fake.hset(ctxKey('txn-category-carry'), {
    acc_old: await enc({
      [contentKey('acc_old', { date: '2025-12-20', amount: 7.25, name: 'BAKERY 12' })]: 'Bread',
      [contentKey('acc_old', { date: '2025-11-01', amount: 100, name: 'ATM | withdrawal' })]: null,
    }),
  });
  await fake.hset(ctxKey('history:net-worth'), { '2026-01-01': await encrypt('1000'), '2026-01-02': await encrypt('1100.5'), '2026-01-03': await encrypt('1050') });
  // The estimate on 2026-01-01 is superseded by the recorded total.
  await fake.hset(ctxKey('history:net-worth:est'), { '2025-12-30': await encrypt('900'), '2025-12-31': await encrypt('950'), '2026-01-01': await encrypt('123456') });
  await fake.hset(ctxKey('history:accounts'), {
    '2026-01-01': await enc({ acc_chk: 1500, acc_card: 500 }),
    '2026-01-02': await enc({ acc_chk: 1600.5, acc_card: 500 }),
    '2026-01-03': await enc({ acc_chk: 1550, acc_card: 500, acc_ghost: 3 }),
  });
  await fake.hset(ctxKey('history:accounts:partial'), { '2026-01-03': await enc({ acc_chk: 1555 }), '2026-01-04': await enc({ acc_chk: 1700 }) });
  await fake.hset(ctxKey('history:accounts:est'), { '2025-12-30': await enc({ acc_chk: 1400, acc_card: 500 }), '2025-12-31': await enc({ acc_chk: 1450 }) });
  await fake.hset(ctxKey('history:accounts:est:ext'), { '2025-12-29': await enc({ acc_brk: 20000 }), '2025-12-31': await enc({ acc_chk: 1449 }) });
  await fake.hset(ctxKey('history:accounts:est:flatd'), { '2025-12-30': await enc({ acc_brk: 25000.25 }) });
  await fake.set(ctxKey('budgets'), await enc({ Travel: 150, Food: 400 }));
  await fake.set(ctxKey('goals'), await enc([{ id: 'g1', name: 'Trip', target: 3000, account_id: 'acc_chk' }]));

  // The machinery: none of it is the person's data.
  await fake.set(ctxKey('cache:net-worth'), await enc({ secret: 'CACHED-SECRET' }));
  await fake.hset(ctxKey('accounts:vanished'), { item_a: await enc({ acc_vanished: '2026-10-01T00:00:00.000Z' }) });
  await fake.hset(ctxKey('plaid:new-accounts'), { item_a: '2026-10-01T00:00:00.000Z' });
  await fake.hset(ctxKey('snapshot:taken'), { '2026-01-03': '2026-01-03T13:00:00.000Z' });
  await fake.set(ctxKey('history:backfill-done'), '5');
  await fake.set(ctxKey('sessions:epoch'), '3');
  await fake.set(ctxKey('download-count'), '1'); // the download limit's counter, on the seam

  // Sharing: my side of one connection, one person I blocked, one who blocked me.
  const id = CONN;
  const blocked = connectionId('user_me', 'user_pest');
  const blockedMe = connectionId('user_me', 'user_blocker');
  await fake.hset(testKey('connections'), {
    [id]: JSON.stringify({ users: ['user_friend', 'user_me'], status: 'active', created_at: '2026-05-01T09:00:00.000Z' }),
    [`${id}|label|user_me`]: JSON.stringify('Sam'),
    [`${id}|label|user_friend`]: JSON.stringify('THEIR-NAME-FOR-ME'),
    [`${id}|intro|user_me`]: JSON.stringify('Alex'),
    [`${id}|intro|user_friend`]: JSON.stringify('THEIR-INTRODUCTION'),
    [`${id}|share|user_me`]: JSON.stringify({ accounts: { acc_chk: 'balance', manual_house: 'exists' }, updated_at: '2026-05-02T09:00:00.000Z' }),
    [`${id}|share|user_friend`]: JSON.stringify({ accounts: { THEIR_ACCOUNT: 'transactions' }, updated_at: '2026-05-03T09:00:00.000Z' }),
    [`${id}|log`]: JSON.stringify({ id: LOG_ID, since: '2026-05-01T09:00:00.000Z' }),
    [blocked]: JSON.stringify({ users: ['user_me', 'user_pest'], status: 'blocked', blocked_by: 'user_me', created_at: '2026-04-01T00:00:00.000Z' }),
    [`${blocked}|label|user_me`]: JSON.stringify('Pest'),
    [blockedMe]: JSON.stringify({ users: ['user_blocker', 'user_me'], status: 'blocked', blocked_by: 'user_blocker', created_at: '2026-04-01T00:00:00.000Z' }),
    [`${blockedMe}|label|user_me`]: JSON.stringify('GONE-TO-ME'),
  });
  // Both records of showings on it, on the storage seam, under its log id:
  // mine (what I share, shown to Sam) here, and Sam's (what Sam shares, shown
  // to me) in Sam's container.
  const { accessLogStore } = await import('@/lib/access-log');
  await accessLogStore.set(ctx, LOG_ID, MY_RECORD);
  await fake.hset(testKey('containers'), { [FRIEND.container]: JSON.stringify({ status: 'active', primary: false, created_at: '2026-01-01T00:00:00.000Z' }) });
  await fake.hset(testKey('owners'), { user_friend: FRIEND.container });
  await accessLogStore.set(FRIEND, LOG_ID, THEIR_RECORD);
}

/** Someone else, in the same database: none of it may reach the download. */
async function seedOther() {
  await fake.set(ctxKey('budgets', OTHER), await enc({ 'OTHER-BUDGET': 1 }));
  await fake.hset(ctxKey('manual:accounts', OTHER), {
    manual_secret: await enc({ account_id: 'manual_secret', name: 'OTHER-ACCOUNT', institution_name: 'Elsewhere', type: 'depository', subtype: null, balance: 1, updated_at: '2026-01-01T00:00:00.000Z' }),
  });
  await fake.hset(ctxKey('plaid:items', OTHER), {
    item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'OTHER-BANK', institution_id: null, encrypted_access_token: await encrypt('x') }),
  });
  await fake.set(ctxKey('txns:item_a', OTHER), await encodeJsonBlob({ schema_version: 2, cursor: '', accounts: {}, txns: { o1: txn({ transaction_id: 'o1', merchant_name: 'OTHER-MERCHANT' }) } }));
  await fake.hset(ctxKey('history:net-worth', OTHER), { '2026-01-01': await encrypt('777777') });
}

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  await seedPerson();
  await seedOther();
});

const download = async (userId: string | null = 'user_me') => buildUserExport(await collectUserData({ ctx, userId }), NOW);

describe('everything stored, decrypted, and nothing else', () => {
  test('the document says what it is', async () => {
    const doc = await download();
    expect(doc).toMatchObject({ format: EXPORT_FORMAT, version: EXPORT_VERSION, exported_at: NOW.toISOString(), notes: [], problems: [] });
    expect(doc.format).toBe('nya-export');
    // 2: a file can be short, said under problems (lib/user-export.ts EXPORT_VERSION).
    expect(doc.version).toBe(2);
    expect(Object.keys(doc)).toEqual([
      'format',
      'version',
      'exported_at',
      'documentation',
      'not_included',
      'notes',
      'problems',
      'institutions',
      'accounts',
      'manual_accounts',
      'hidden_accounts',
      'net_worth_history',
      'account_history',
      'transactions',
      'category_overrides',
      'merchant_renames',
      'investment_transactions',
      'investment_history_coverage',
      'account_links',
      'budgets',
      'goals',
      'api_tokens',
      'sharing',
      // Then a section for each store on the storage seam declared exportable.
      ...declaredSections().map((s) => s.key),
    ]);
  });

  test('institutions, without their access tokens, and the file says why', async () => {
    const doc = await download();
    expect(doc.institutions).toEqual([
      { item_id: 'item_a', institution_name: 'Chase', institution_id: 'ins_3', provider: 'plaid' },
      { item_id: 'item_b', institution_name: 'Fidelity', institution_id: 'ins_12', provider: 'plaid' },
    ]);
    const text = JSON.stringify(doc);
    expect(text).not.toContain('access-sandbox');
    expect(text).not.toContain('encrypted_access_token');
    expect(text).not.toContain('access_token');
    expect(doc.not_included[0]).toMatch(/^Bank access tokens: .*credentials/);
  });

  test('every account any part of the file mentions, named from the freshest record', async () => {
    const doc = await download();
    const byId = Object.fromEntries(doc.accounts.map((a) => [a.account_id, a]));
    expect(byId.acc_chk).toEqual({
      account_id: 'acc_chk',
      provider: 'plaid',
      item_id: 'item_a',
      institution_name: 'Chase',
      institution_id: 'ins_3',
      connected: true,
      name: 'Checking',
      official_name: 'Total Checking',
      type: 'depository',
      subtype: 'checking',
      mask: '1111',
      currency: 'USD',
      credit_limit: null,
      persistent_account_id: 'pers_1',
      first_seen: '2025-06-01',
      last_seen: '2026-10-05',
      hidden: false,
      hidden_at: null,
      // The newest RECORDED balance, with its day (a partial measurement counts).
      latest_balance: { balance: 1700, date: '2026-01-04' },
    });
    expect(byId.acc_card).toMatchObject({ type: 'credit', credit_limit: 5000, hidden: true, hidden_at: '2026-03-01T00:00:00.000Z', latest_balance: { balance: 500, date: '2026-01-03' } });
    expect(byId.acc_brk).toMatchObject({ item_id: 'item_b', institution_name: 'Fidelity', connected: true, name: 'Brokerage', mask: '9999', type: 'investment', latest_balance: null });
    // An earlier account, its institution disconnected: still named. Its
    // directory entry predates the provider field: those are Plaid's.
    expect(byId.acc_old).toMatchObject({ provider: 'plaid', item_id: 'item_gone', institution_name: 'Chase', connected: false, name: 'Old Checking', mask: '0000', first_seen: '2024-01-01' });
    // Known only from its balance history, or a declined offer: its id, honestly nothing more.
    expect(byId.acc_ghost).toMatchObject({ provider: null, connected: false, name: null, institution_name: null, latest_balance: { balance: 3, date: '2026-01-03' } });
    expect(byId.acc_x).toMatchObject({ provider: null, name: null, connected: false });
    // Manual accounts are listed apart, once.
    expect(byId.manual_house).toBeUndefined();
    expect(doc.manual_accounts).toEqual([
      { account_id: 'manual_house', name: 'House', institution_name: 'Zillow estimate', type: 'other', subtype: null, balance: 400000, updated_at: '2026-09-30T10:00:00.000Z', hidden: false, hidden_at: null },
    ]);
    expect(doc.hidden_accounts).toEqual([{ account_id: 'acc_card', type: 'credit', hidden_at: '2026-03-01T00:00:00.000Z' }]);
  });

  test('an account only a goal, a share or history still names is listed too, and says only what is known', async () => {
    await fake.set(ctxKey('goals'), await enc([{ id: 'g1', name: 'Trip', target: 3000, account_id: 'acc_forgotten' }]));
    const id = CONN;
    await fake.hset(testKey('connections'), {
      [`${id}|share|user_me`]: JSON.stringify({ accounts: { acc_chk: 'balance', acc_shared_gone: 'balance' }, updated_at: '2026-05-02T09:00:00.000Z' }),
    });
    // A manual account since removed: its balance history stays.
    await fake.hset(ctxKey('history:accounts'), { '2026-01-02': await enc({ acc_chk: 1600.5, acc_card: 500, manual_boat: 9000 }) });
    const byId = Object.fromEntries((await download()).accounts.map((a) => [a.account_id, a]));
    const unknown = { provider: null, item_id: null, institution_name: null, connected: false, name: null, type: null };
    expect(byId.acc_forgotten).toMatchObject(unknown);
    expect(byId.acc_shared_gone).toMatchObject(unknown);
    // Its id says what kind it was, and nothing more is known.
    expect(byId.manual_boat).toMatchObject({ ...unknown, provider: 'manual', latest_balance: { balance: 9000, date: '2026-01-02' } });
  });

  test('transactions: every stored field, with my own edits beside the bank’s', async () => {
    const doc = await download();
    // Newest first; on the same day and time, by id.
    expect(doc.transactions.map((t) => t.transaction_id)).toEqual(['t_evil', 't_posted', 't_card', 't_pending', 't_coffee', 't_bakery']);
    const coffee = doc.transactions.find((t) => t.transaction_id === 't_coffee')!;
    expect(coffee).toEqual({
      ...(TXNS.t_coffee as any),
      item_id: 'item_a',
      vendor_key: 'mid:ent_bb',
      your_category: 'Treats',
      your_category_from_earlier_account: null,
      your_merchant_name: 'BB Coffee',
      superseded_by_posted: false,
      account_hidden: false,
    });
    // Plaid's category and merchant are kept as they came.
    expect(coffee.category).toBe('food and drink');
    expect(coffee.merchant_name).toBe('Blue Bottle');
    // The pending row its posted row replaced is kept, and marked.
    expect(doc.transactions.find((t) => t.transaction_id === 't_pending')).toMatchObject({ pending: true, superseded_by_posted: true });
    expect(doc.transactions.find((t) => t.transaction_id === 't_posted')).toMatchObject({ pending_transaction_id: 't_pending', superseded_by_posted: false });
    // A hidden account's rows are there, marked.
    expect(doc.transactions.find((t) => t.transaction_id === 't_card')).toMatchObject({ account_hidden: true });
    // A category set before a re-link, carried to the linked account's row.
    expect(doc.transactions.find((t) => t.transaction_id === 't_bakery')).toMatchObject({ your_category: null, your_category_from_earlier_account: 'Bread' });
    // Every override and rename, including one whose transaction is gone.
    expect(doc.category_overrides).toEqual([
      { transaction_id: 't_coffee', category: 'Treats' },
      { transaction_id: 't_vanished', category: 'Old category' },
    ]);
    expect(doc.merchant_renames).toEqual([{ vendor_key: 'mid:ent_bb', name: 'BB Coffee' }]);
  });

  test('investment transactions: every field Plaid sent, with what the store knows about each', async () => {
    const doc = await download();
    expect(doc.investment_transactions.map((t) => t.investment_transaction_id)).toEqual(['it_buy', 'it_gone', 'it_cxl']);
    expect(doc.investment_transactions[0]).toEqual({
      ...invRow('it_buy'),
      item_id: 'item_b',
      security: INV_STATE.securities.s1,
      seen_at: '2026-10-01',
      missing_since: null,
      excluded: false,
      cancelled: false,
    });
    expect(doc.investment_transactions[1]).toMatchObject({ excluded: true, cancelled: false, missing_since: '2026-09-10T00:00:00.000Z' });
    expect(doc.investment_transactions[2]).toMatchObject({ excluded: true, cancelled: true });
    expect(doc.investment_history_coverage).toEqual([{ item_id: 'item_b', account_id: 'acc_brk', from: '2024-10-06', through: '2026-10-01' }]);
  });

  test('links, declined offers and carried categories', async () => {
    const doc = await download();
    expect(doc.account_links).toEqual({
      links: [{ earlier_account_id: 'acc_old', account_id: 'acc_chk', linked_at: '2025-06-02T00:00:00.000Z', evidence: { old_last: '2025-05-31', old_type: 'depository' } }],
      declined_suggestions: [
        { earlier_account_id: 'acc_x', account_id: 'acc_chk', declined_at: '2025-07-01T00:00:00.000Z' },
        { earlier_account_id: 'acc_y', account_id: null, declined_at: '2025-07-02T00:00:00.000Z' },
      ],
      carried_categories: [
        {
          earlier_account_id: 'acc_old',
          rows: [
            // A "|" in the bank's text survives the split; an ambiguous row carries nothing.
            { date: '2025-11-01', amount: 100, description: 'atm | withdrawal', category: null },
            { date: '2025-12-20', amount: 7.25, description: 'bakery 12', category: 'Bread' },
          ],
        },
      ],
    });
  });

  test('budgets and goals', async () => {
    const doc = await download();
    expect(doc.budgets).toEqual([
      { category: 'Food', monthly_amount: 400 },
      { category: 'Travel', monthly_amount: 150 },
    ]);
    expect(doc.goals).toEqual([{ id: 'g1', name: 'Trip', target: 3000, account_id: 'acc_chk' }]);
  });

  test('API tokens: each one’s name and dates, never the token, its hash or its id, and one that can’t be read is counted, never named', async () => {
    const { createToken, parseToken } = await import('@/lib/api-tokens');
    const { apiTokenStore } = await import('@/lib/api-token-store');
    expect((await download()).api_tokens).toEqual([]);
    const first = await createToken(ctx, 'Raycast', new Date('2026-09-01T10:00:00.000Z'));
    const second = await createToken(ctx, 'Claude', new Date('2026-09-02T10:00:00.000Z'));
    await apiTokenStore.update(ctx, second.info.id, (t) => t && { ...t, last_used_at: '2026-10-01T08:00:00.000Z' });
    const doc = await download();
    expect(doc.api_tokens).toEqual([
      { label: 'Raycast', created_at: '2026-09-01T10:00:00.000Z', last_used_at: null },
      { label: 'Claude', created_at: '2026-09-02T10:00:00.000Z', last_used_at: '2026-10-01T08:00:00.000Z' },
    ]);
    const text = JSON.stringify(doc);
    const stored = await apiTokenStore.getAll(ctx);
    for (const [id, t] of stored) {
      expect(text).not.toContain(id);
      expect(text).not.toContain(t.hash);
    }
    // The secret by its place in the token: base64url, so it may hold "_" itself.
    for (const { token } of [first, second]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(parseToken(token)!.secret);
    }
    expect(doc.not_included.some((s: string) => s.startsWith('Your API tokens themselves, and the hashes'))).toBe(true);
    // A damaged record, and one from a version this one doesn't know: the
    // others are listed, and these are counted under problems, never named by
    // their ids, which are part of the tokens. Nothing stops the download.
    await fake.hset(ctxKey('api-tokens'), { [first.info.id]: DAMAGED });
    await fake.hset(ctxKey('api-tokens'), { ['0123456789abcdef']: await encrypt(JSON.stringify({ v: 2, label: 'Later' })) });
    const short = await download();
    expect(short.api_tokens).toEqual([{ label: 'Claude', created_at: '2026-09-02T10:00:00.000Z', last_used_at: '2026-10-01T08:00:00.000Z' }]);
    expect(short.problems).toEqual([
      { section: 'api_tokens', problem: 'unreadable', count: 1 },
      { section: 'api_tokens', problem: 'unrecognised', count: 1 },
    ]);
    expect(short.notes).toEqual([
      'Not all of your API tokens could be read, so this file is missing 1 token whose stored data is damaged and 1 token saved in a form this version of Nya does not know. The API tokens card lists them, and can remove a damaged one. Nothing was changed: what could not be read is still stored as it was.',
    ]);
    const shortText = JSON.stringify(short);
    for (const id of [first.info.id, '0123456789abcdef']) expect(shortText).not.toContain(id);
    // Storage out of reach still stops it, naming the store.
    const real = fake.hgetall.bind(fake);
    (fake as any).hgetall = async (key: string) => {
      if (key === ctxKey('api-tokens')) throw new Error('FakeRedis: out of reach');
      return real(key);
    };
    try {
      const err = await collectUserData({ ctx, userId: 'user_me' }).catch((e) => e);
      expect(err).toBeInstanceOf(ExportReadError);
      expect(err.message).toContain('Your API tokens could not be read');
    } finally {
      (fake as any).hgetall = real;
    }
  });

  test('sharing: my side of each connection, never theirs, with both records of showings on it', async () => {
    const doc = await download();
    expect(doc.sharing).toEqual({
      connections: [
        {
          name: 'Sam',
          my_introduction: 'Alex',
          connected_at: '2026-05-01T09:00:00.000Z',
          shared: [
            { account_id: 'acc_chk', level: 'balance' },
            { account_id: 'manual_house', level: 'exists' },
          ],
          shared_updated_at: '2026-05-02T09:00:00.000Z',
          shared_until: null,
          record_since: '2026-05-01T09:00:00.000Z',
          // When what I share was shown to Sam: my record.
          shown_to_them: MY_RECORD.shown,
          // When what Sam shares was shown to me: Sam's record, the same one Sam sees.
          shown_to_me: THEIR_RECORD.shown,
        },
      ],
      blocked: [{ name: 'Pest' }],
      unmatched: [],
    });
    const text = JSON.stringify(doc);
    // Their settings are theirs: what they call me, how they introduced
    // themselves, what they share now. And nobody is named by an id: not a
    // sign-in id, not a connection's (made from those), not its log id.
    for (const theirs of ['THEIR-NAME-FOR-ME', 'THEIR-INTRODUCTION', 'THEIR_ACCOUNT', 'GONE-TO-ME', 'user_friend', 'user_me', CONN, LOG_ID]) {
      expect(text).not.toContain(theirs);
    }
    for (const other of ['user_pest', 'user_blocker']) expect(text).not.toContain(connectionId('user_me', other));
    // The records are in "sharing", beside their connection, and nowhere else.
    expect(Object.keys(doc)).not.toContain('sharing-access-log');
    // Only my own accounts are listed: what was shown to me of Sam's is Sam's.
    const listed = doc.accounts.map((a) => a.account_id);
    expect(listed).toContain('acc_chk');
    expect(listed).not.toContain('acc_friend_then');
  });

  test('sharing: a share with an end says until when', async () => {
    await fake.hset(testKey('connections'), {
      [`${CONN}|share|user_me`]: JSON.stringify({ expiring: { acc_chk: 'balance' }, expires_at: '2026-06-01T04:00:00.000Z', updated_at: '2026-05-02T09:00:00.000Z' }),
    });
    const [conn] = ((await download()).sharing as any).connections;
    expect(conn).toMatchObject({ shared: [{ account_id: 'acc_chk', level: 'balance' }], shared_until: '2026-06-01T04:00:00.000Z' });
  });

  test('sharing: a record of showings that can’t be read is named where it belongs, and never stops the download', async () => {
    const { accessLogStore } = await import('@/lib/access-log');
    await fake.hset(ctxKey('sharing-access-log'), { [LOG_ID]: DAMAGED });
    await fake.hset(ctxKey('sharing-access-log', FRIEND), { [LOG_ID]: DAMAGED });
    // And two of mine that no connection is matched to: ended, until the nightly pass deletes them.
    await accessLogStore.set(ctx, 'a'.repeat(32), MY_RECORD);
    await fake.hset(ctxKey('sharing-access-log'), { ['b'.repeat(32)]: DAMAGED });
    const sharing = (await download()).sharing as any;
    expect(sharing.connections[0]).toMatchObject({
      name: 'Sam',
      shown_to_them: null,
      shown_to_them_problem: 'unreadable',
      shown_to_me: null,
      shown_to_me_problem: 'unreadable',
    });
    expect(sharing.unmatched).toEqual([{ shown_to_them: MY_RECORD.shown }, { shown_to_them: null, problem: 'unreadable' }]);
    expect(JSON.stringify(sharing)).not.toContain('a'.repeat(32));
  });

  test('sharing: a connection from before records has none yet, and Sam’s container out of reach is said so', async () => {
    await fake.hdel(testKey('connections'), `${CONN}|log`);
    expect(((await download()).sharing as any).connections[0]).toMatchObject({ record_since: null, shown_to_them: [], shown_to_me: [] });
    await fake.hset(testKey('connections'), { [`${CONN}|log`]: JSON.stringify({ id: LOG_ID, since: '2026-05-01T09:00:00.000Z' }) });
    await fake.hset(testKey('containers'), { [FRIEND.container]: JSON.stringify({ status: 'restoring', primary: false, created_at: '2026-01-01T00:00:00.000Z' }) });
    expect(((await download()).sharing as any).connections[0]).toMatchObject({
      shown_to_them: MY_RECORD.shown,
      shown_to_me: null,
      shown_to_me_problem: 'unavailable',
    });
  });

  test('sharing: a connection whose record id can’t be read says so, and its record is filed as matched to no connection, never as ended', async () => {
    await fake.hset(testKey('connections'), { [`${CONN}|log`]: 'not json' });
    const sharing = (await download()).sharing as any;
    expect(sharing.connections[0]).toMatchObject({
      name: 'Sam',
      record_since: null,
      shown_to_them: null,
      shown_to_them_problem: 'record_id_unreadable',
      shown_to_me: null,
      shown_to_me_problem: 'record_id_unreadable',
    });
    // Mine is still in the file, whole, where a record no connection is matched to goes.
    expect(sharing.unmatched).toEqual([{ shown_to_them: MY_RECORD.shown }]);
    expect(sharing).not.toHaveProperty('ended');
  });

  test('sharing: storage out of reach fails the download, never reads as no showings', async () => {
    const real = fake.hgetall.bind(fake);
    for (const where of [ctx, FRIEND]) {
      (fake as any).hgetall = async (key: string) => {
        if (key === ctxKey('sharing-access-log', where)) throw new Error('FakeRedis: out of reach');
        return real(key);
      };
      (fake as any).eval = ((realEval) => async (script: string, keys: string[], args: string[]) => {
        if (keys[0] === ctxKey('sharing-access-log', where)) throw new Error('FakeRedis: out of reach');
        return realEval(script, keys, args);
      })(FakeRedis.prototype.eval.bind(fake));
      try {
        const err = await collectUserData({ ctx, userId: 'user_me' }).catch((e) => e);
        expect(err).toBeInstanceOf(ExportReadError);
        expect(err.what).toBe('sharing settings');
      } finally {
        (fake as any).hgetall = real;
        delete (fake as any).eval;
      }
    }
    expect((await download()).sharing).toMatchObject({ connections: [{ shown_to_them: MY_RECORD.shown, shown_to_me: THEIR_RECORD.shown }] });
  });

  test('with the shared password there is no sharing, and the file says so', async () => {
    // Records of showings left from when it had accounts are still in it.
    expect((await download(null)).sharing).toEqual({ connections: [], blocked: [], unmatched: [{ shown_to_them: MY_RECORD.shown }] });
    await fake.del(ctxKey('sharing-access-log'));
    const doc = await download(null);
    expect(doc.sharing).toBeNull();
    expect(doc.not_included.some((s) => s.startsWith('Sharing:'))).toBe(true);
    expect(doc.not_included.some((s) => s.startsWith('The app password'))).toBe(true);
    expect((await download()).not_included.some((s) => s.startsWith('Your sign-in'))).toBe(true);
  });

  test('nothing from anyone else’s container', async () => {
    const text = JSON.stringify(await download());
    for (const theirs of ['OTHER-BUDGET', 'OTHER-ACCOUNT', 'manual_secret', 'OTHER-BANK', 'OTHER-MERCHANT', '777777']) expect(text).not.toContain(theirs);
  });

  test('the machinery is left out: cursors, caches, timings, counters', async () => {
    const text = JSON.stringify(await download());
    for (const machinery of ['cursor-SECRET', 'CACHED-SECRET', 'acc_vanished', '2026-01-03T13:00:00.000Z', TEST_CTX.container, 'transactions_billed']) {
      expect(text).not.toContain(machinery);
    }
    // The flat balances behind estimated totals are not an account's history.
    expect(text).not.toContain('25000.25');
  });

  test('reading changes nothing, not even a remembered record of the old shape the app would tidy away', async () => {
    await fake.hset(ctxKey('accounts:meta'), { acc_legacy: await enc({ item_id: 'item_gone', type: 'depository', name: 'Old' }) });
    const before = JSON.stringify([...fake.strings, ...[...fake.hashes].map(([k, h]) => [k, [...h]])]);
    await download();
    expect(JSON.stringify([...fake.strings, ...[...fake.hashes].map(([k, h]) => [k, [...h]])])).toBe(before);
  });
});

describe('history, marked', () => {
  test('net worth as recorded: hidden accounts in, a recorded total over an estimate', async () => {
    const doc = await download();
    expect(doc.net_worth_history).toEqual({
      includes_hidden_accounts: true,
      points: [
        { date: '2025-12-30', total: 900, kind: 'estimated' },
        { date: '2025-12-31', total: 950, kind: 'estimated' },
        // Not the superseded estimate of 123456.
        { date: '2026-01-01', total: 1000, kind: 'recorded' },
        { date: '2026-01-02', total: 1100.5, kind: 'recorded' },
        { date: '2026-01-03', total: 1050, kind: 'recorded' },
      ],
    });
    expect(JSON.stringify(doc)).not.toContain('123456');
  });

  test('each account’s own series, by the app’s precedence', async () => {
    const doc = await download();
    const series = Object.fromEntries(doc.account_history.map((s) => [s.account_id, s.points]));
    expect(series.acc_chk).toEqual([
      { date: '2025-12-30', balance: 1400, kind: 'estimated' },
      // The extension wins over the estimate on the same day.
      { date: '2025-12-31', balance: 1449, kind: 'estimated' },
      { date: '2026-01-01', balance: 1500, kind: 'recorded' },
      { date: '2026-01-02', balance: 1600.5, kind: 'recorded' },
      // A partial measurement beside a recorded map is the newer one.
      { date: '2026-01-03', balance: 1555, kind: 'recorded' },
      { date: '2026-01-04', balance: 1700, kind: 'recorded' },
    ]);
    expect(series.acc_brk).toEqual([{ date: '2025-12-29', balance: 20000, kind: 'estimated' }]);
    expect(series.acc_card.map((p) => p.date)).toEqual(['2025-12-30', '2026-01-01', '2026-01-02', '2026-01-03']);
  });

  test('agrees with what the app itself reads', async () => {
    const doc = await download();
    const app = await getHistory(ctx);
    expect(doc.net_worth_history.points).toEqual(app.map((p) => ({ date: p.date, total: p.value, kind: p.estimated ? 'estimated' : 'recorded' })));
    for (const { account_id, points } of doc.account_history) {
      const own = await getAccountHistory(ctx, account_id);
      expect(points).toEqual(own.map((p) => ({ date: p.date, balance: p.value, kind: p.estimated ? 'estimated' : 'recorded' })));
    }
  });
});

/** A value as written under another PLAID_ENCRYPTION_KEY: what every value
 *  under k0 looks like once the key is replaced, and so the deployment's
 *  problem, never the value's (lib/repo.ts). */
async function underAnotherK0(plain: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(1), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
  return Buffer.concat([iv, sealed]).toString('base64');
}

// The older stores the file cross-references are read whole: one of their
// entries left out would read as its absence elsewhere in the file. Balance
// history and manual accounts, and every store on the seam, name what they
// can't read instead (below).
describe('a store that can’t be read fails the download, by name', () => {
  const cases: [string, () => Promise<unknown>, string][] = [
    ['an Item’s record', () => fake.hset(ctxKey('plaid:items'), { item_a: 'not json at all' }), 'linked institutions'],
    ['the remembered accounts', () => fake.hset(ctxKey('accounts:meta'), { item_a: 'garbage-ciphertext' }), 'accounts'],
    ['the account directory', () => fake.hset(ctxKey('accounts:directory'), { acc_chk: 'garbage-ciphertext' }), 'accounts'],
    ['a hidden account', () => fake.hset(ctxKey('hidden:accounts'), { acc_card: 'garbage-ciphertext' }), 'hidden accounts'],
    ['an Item’s transactions', () => fake.set(ctxKey('txns:item_a'), 'garbage-ciphertext'), 'transactions from Chase'],
    ['an Item’s investment transactions', () => fake.set(ctxKey('invtxns:item_b'), 'garbage-ciphertext'), 'investment transactions from Fidelity'],
    ['a category', async () => fake.hset(ctxKey('txn-category-overrides'), { t_coffee: 'garbage-ciphertext' }), 'categories'],
    ['a carried category', async () => fake.hset(ctxKey('txn-category-carry'), { acc_old: 'garbage-ciphertext' }), 'categories'],
    ['a rename', async () => fake.hset(ctxKey('txn-vendor-renames'), { 'mid:ent_bb': 'garbage-ciphertext' }), 'merchant names'],
    ['a link', async () => fake.hset(ctxKey('account-links'), { acc_old: 'garbage-ciphertext' }), 'account links'],
    // Never damage, for the stores that report it: a day or an account sealed
    // under another PLAID_ENCRYPTION_KEY is what the deployment's own problem
    // looks like (k0 doesn't commit to its key), so it stops the download.
    ['a day of balances under another PLAID_ENCRYPTION_KEY', async () => fake.hset(ctxKey('history:net-worth'), { '2026-01-02': await underAnotherK0('1100.5') }), 'balance history'],
    ['a manual account under another PLAID_ENCRYPTION_KEY', async () => fake.hset(ctxKey('manual:accounts'), { manual_house: await underAnotherK0('{}') }), 'manual accounts'],
    ['the budgets under another PLAID_ENCRYPTION_KEY', async () => fake.set(ctxKey('budgets'), await underAnotherK0('{}')), 'budgets'],
    ['the goals under another PLAID_ENCRYPTION_KEY', async () => fake.set(ctxKey('goals'), await underAnotherK0('[]')), 'goals'],
  ];
  for (const [name, damage, what] of cases) {
    test(name, async () => {
      await damage();
      const err = await collectUserData({ ctx, userId: 'user_me' }).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(ExportReadError);
      expect((err as InstanceType<typeof ExportReadError>).what).toBe(what);
      expect((err as Error).message).toStartWith(`Your ${what} could not be read, so nothing was downloaded`);
    });
  }

  // The API names such an account and answers the rest (unavailable); a file
  // is never shaped around the deployment's own problem.
  test('a manual account under a key this deployment can’t use stops it as the deployment’s problem', async () => {
    const { ManualAccountsUnavailableError } = await import('@/lib/manual');
    await fake.hset(ctxKey('manual:accounts'), { manual_house: await underAnotherK0('{}') });
    const err = await collectUserData({ ctx, userId: 'user_me' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportReadError);
    expect((err as Error).cause).toBeInstanceOf(ManualAccountsUnavailableError);
    expect(((err as Error).cause as InstanceType<typeof ManualAccountsUnavailableError>).ids).toEqual(['manual_house']);
  });

  test('the database failing is a failure too, never an empty store', async () => {
    fake.failNext('hgetall');
    await expect(collectUserData({ ctx, userId: 'user_me' })).rejects.toBeInstanceOf(ExportReadError);
  });

  test('a stored investment transaction without its record', async () => {
    await fake.set(ctxKey('invtxns:item_b'), await encodeJsonBlob({ ...INV_STATE, txns: { broken: { seen_at: '2026-10-01' } } }));
    const data = await collectUserData({ ctx, userId: 'user_me' });
    expect(() => buildUserExport(data, NOW)).toThrow(ExportReadError);
  });

  test('an Item that never stored transactions is empty, not unreadable', async () => {
    await fake.del(ctxKey('txns:item_a'));
    expect((await download()).transactions).toEqual([]);
  });
});

describe('what can’t be read is named, and everything else is in the file', () => {
  const unchanged = 'Nothing was changed: what could not be read is still stored as it was.';

  test('a day of net worth that is damaged or not a number is named, never read around, and the others are in', async () => {
    // A damaged recorded total, with an estimate the same day: the estimate
    // never stands in for it, as the chart gives that day none either.
    await fake.hset(ctxKey('history:net-worth'), { '2026-01-02': 'garbage-ciphertext', '2026-01-03': await encrypt('abc') });
    await fake.hset(ctxKey('history:net-worth:est'), { '2026-01-02': await encrypt('999'), '2025-12-30': await encrypt('') });
    // A damaged estimate on a day with a recorded total is superseded, so never read or named.
    await fake.hset(ctxKey('history:net-worth:est'), { '2026-01-01': 'garbage-ciphertext' });
    const doc = await download();
    expect(doc.net_worth_history.points).toEqual([
      { date: '2025-12-31', total: 950, kind: 'estimated' },
      { date: '2026-01-01', total: 1000, kind: 'recorded' },
    ]);
    expect(doc.problems).toEqual([
      { section: 'net_worth_history', problem: 'unreadable', ids: ['2026-01-02'] },
      // Not a number, and empty (never a zero net worth): intact, but not understood.
      { section: 'net_worth_history', problem: 'unrecognised', ids: ['2025-12-30', '2026-01-03'] },
    ]);
    expect(doc.notes).toEqual([
      `Not all of your net worth history could be read, so this file is missing 1 day whose stored data is damaged and 2 days saved in a form this version of Nya does not know. The JSON file lists them under problems. ${unchanged}`,
    ]);
    expect(JSON.stringify(doc.net_worth_history)).not.toContain('999');
  });

  test('a day of account balances that can’t be read is named; on it, an account has another record of that day, or nothing', async () => {
    // The partial measurement of the 4th is damaged: acc_chk has no point
    // that day (no other layer has one). The recorded map of the 2nd is too:
    // no account has a point that day, and the estimate beside it never stands in.
    await fake.hset(ctxKey('history:accounts:partial'), { '2026-01-04': 'garbage-ciphertext' });
    await fake.hset(ctxKey('history:accounts'), { '2026-01-02': 'garbage-ciphertext' });
    await fake.hset(ctxKey('history:accounts:est'), { '2026-01-02': await enc({ acc_chk: 7, acc_card: 7 }) });
    // An estimate on a day with no recorded map, not a map of balances: named.
    await fake.hset(ctxKey('history:accounts:est'), { '2025-12-30': await encrypt('[1,2]') });
    // A damaged estimate on a recorded day is superseded: never named.
    await fake.hset(ctxKey('history:accounts:est:ext'), { '2026-01-01': 'garbage-ciphertext' });
    const doc = await download();
    const series = Object.fromEntries(doc.account_history.map((s) => [s.account_id, s.points]));
    expect(series.acc_chk.map((p) => p.date)).toEqual(['2025-12-31', '2026-01-01', '2026-01-03']);
    expect(series.acc_card.map((p) => p.date)).toEqual(['2026-01-01', '2026-01-03']);
    expect(JSON.stringify(doc.account_history)).not.toContain('"balance":7');
    expect(doc.problems).toEqual([
      { section: 'account_history', problem: 'unreadable', ids: ['2026-01-02', '2026-01-04'] },
      { section: 'account_history', problem: 'unrecognised', ids: ['2025-12-30'] },
    ]);
    expect(doc.notes).toEqual([
      `Not all of your account balance history could be read, so this file may be missing balances on 2 days whose stored data is damaged and 1 day saved in a form this version of Nya does not know. The JSON file lists them under problems. ${unchanged}`,
    ]);
    // The newest balance an account lists is the newest that could be read.
    expect(doc.accounts.find((a) => a.account_id === 'acc_chk')?.latest_balance).toEqual({ balance: 1555, date: '2026-01-03' });
  });

  // A map that reads, holding a balance this version doesn't know (a later
  // one's shape, say): the numbers on it are in, and the day is named, so the
  // file never looks whole without the rest.
  test('a day of account balances holding one that isn’t a number is named; the numbers on it are in', async () => {
    await fake.hset(ctxKey('history:accounts'), {
      '2026-01-05': await enc({ acc_chk: 1650, acc_eur: { value: 50, currency: 'EUR' }, acc_text: 'seventy', acc_null: null }),
    });
    const doc = await download();
    const series = Object.fromEntries(doc.account_history.map((s) => [s.account_id, s.points]));
    expect(series.acc_chk.at(-1)).toEqual({ date: '2026-01-05', balance: 1650, kind: 'recorded' });
    expect(Object.keys(series).filter((id) => ['acc_eur', 'acc_text', 'acc_null'].includes(id))).toEqual([]);
    expect(doc.problems).toEqual([{ section: 'account_history', problem: 'unrecognised', ids: ['2026-01-05'] }]);
    expect(exportFile(doc, 'json').incomplete).toEqual(['account_history']);
    expect(exportFile(doc, 'balances-csv').incomplete).toEqual(['account_history']);
  });

  // On a day with no recorded map, a measurement that can't be read falls
  // back to the estimate, marked as one, as the chart does. The day is named.
  test('a partial measurement that can’t be read, on a day with no recorded map, falls back to the estimate, as the chart does', async () => {
    await fake.hset(ctxKey('history:accounts:est'), { '2026-01-04': await enc({ acc_chk: 1650 }) });
    await fake.hset(ctxKey('history:accounts:partial'), { '2026-01-04': DAMAGED });
    const doc = await download();
    const chk = doc.account_history.find((s) => s.account_id === 'acc_chk')!.points;
    expect(chk.find((p) => p.date === '2026-01-04')).toEqual({ date: '2026-01-04', balance: 1650, kind: 'estimated' });
    expect(doc.problems).toEqual([{ section: 'account_history', problem: 'unreadable', ids: ['2026-01-04'] }]);
    const own = await getAccountHistory(ctx, 'acc_chk');
    expect(chk).toEqual(own.map((p) => ({ date: p.date, balance: p.value, kind: p.estimated ? 'estimated' : 'recorded' })));
  });

  test('with days that can’t be read, the file still agrees with what the app reads', async () => {
    await fake.hset(ctxKey('history:net-worth'), { '2026-01-02': 'garbage-ciphertext' });
    await fake.hset(ctxKey('history:accounts'), { '2026-01-02': 'garbage-ciphertext' });
    await fake.hset(ctxKey('history:accounts:partial'), { '2026-01-04': 'garbage-ciphertext' });
    await fake.hset(ctxKey('history:accounts:est:ext'), { '2025-12-31': await encrypt('not json') });
    const doc = await download();
    const app = await getHistory(ctx);
    expect(doc.net_worth_history.points).toEqual(app.map((p) => ({ date: p.date, total: p.value, kind: p.estimated ? 'estimated' : 'recorded' })));
    for (const { account_id, points } of doc.account_history) {
      const own = await getAccountHistory(ctx, account_id);
      expect([account_id, points]).toEqual([account_id, own.map((p) => ({ date: p.date, balance: p.value, kind: p.estimated ? 'estimated' : 'recorded' }))]);
    }
  });

  test('a manual account that can’t be read is named, never listed as one since removed, and its balances stay', async () => {
    await fake.hset(ctxKey('manual:accounts'), {
      manual_house: 'garbage-ciphertext',
      manual_boat: await encrypt(JSON.stringify({ not: 'an account' })),
      manual_cash: await enc({ account_id: 'manual_cash', name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: 'cash', balance: 40, updated_at: '2026-09-30T10:00:00.000Z' }),
    });
    await fake.hset(ctxKey('history:accounts'), { '2026-01-02': await enc({ acc_chk: 1600.5, acc_card: 500, manual_house: 400000 }) });
    const doc = await download();
    expect(doc.manual_accounts.map((m) => m.account_id)).toEqual(['manual_cash']);
    expect(doc.problems).toEqual([
      { section: 'manual_accounts', problem: 'unreadable', ids: ['manual_house'] },
      { section: 'manual_accounts', problem: 'unrecognised', ids: ['manual_boat'] },
    ]);
    // Still a manual account, not an account "since removed" known only from its history.
    expect(doc.accounts.map((a) => a.account_id)).not.toContain('manual_house');
    // Its balances read, so they are in the file, under its id.
    expect(doc.account_history.find((s) => s.account_id === 'manual_house')?.points).toEqual([{ date: '2026-01-02', balance: 400000, kind: 'recorded' }]);
    expect(doc.notes[0]).toBe(
      `Not all of your manual accounts could be read, so this file is missing 1 account whose stored data is damaged and 1 account saved in a form this version of Nya does not know. Any balance history they have is still in account_history, under their ids. The JSON file lists them under problems. ${unchanged}`
    );
    // Counted for the deletion receipt: they are stored, and deleted with the rest.
    expect(countAccounts(await collectUserData({ ctx, userId: 'user_me' }))).toEqual({ accounts: 6, earlier: 0 });
  });

  // One value each, which no other part of the file is read against: with
  // nothing in the app to clear them, they must never stop the download.
  test('budgets or goals that can’t be used are null and named, and the rest is in the file', async () => {
    await fake.set(ctxKey('budgets'), DAMAGED);
    await fake.set(ctxKey('goals'), await enc({ not: 'goals' }));
    const doc = await download();
    expect(doc['budgets']).toBeNull();
    expect(doc['goals']).toBeNull();
    expect(doc.problems).toEqual([
      { section: 'budgets', problem: 'unreadable' },
      { section: 'goals', problem: 'unrecognised' },
    ]);
    expect(doc.notes).toEqual([
      `Your budgets could not be read (the stored data is damaged), so this file does not have them. ${unchanged}`,
      `Your goals could not be read (they were saved in a form this version of Nya does not know), so this file does not have them. ${unchanged}`,
    ]);
    // The goal's account is still listed: it is known from the rest.
    expect(doc.accounts.map((a) => a.account_id)).toContain('acc_chk');
    expect(doc.transactions.length).toBeGreaterThan(0);
    // Neither is in a CSV: only the JSON file is missing them.
    expect(exportFile(doc, 'json').incomplete).toEqual(['budgets', 'goals']);
    expect(exportFile(doc, 'transactions-csv').incomplete).toEqual([]);
    expect(exportFile(doc, 'balances-csv').incomplete).toEqual([]);
  });

  test('sharing names its own problems once each, beside the marks it makes where each record belongs', async () => {
    await fake.hset(ctxKey('sharing-access-log'), { [LOG_ID]: DAMAGED });
    await fake.hset(testKey('containers'), { [FRIEND.container]: JSON.stringify({ status: 'restoring', primary: false, created_at: '2026-01-01T00:00:00.000Z' }) });
    const doc = await download();
    expect((doc.sharing as any).connections[0]).toMatchObject({ shown_to_them_problem: 'unreadable', shown_to_me_problem: 'unavailable' });
    expect(doc.problems).toEqual([
      { section: 'sharing', problem: 'unavailable' },
      { section: 'sharing', problem: 'unreadable' },
    ]);
    expect(doc.notes).toEqual([
      'Some records of when shared accounts were shown could not be read or reached, so they are not in this file: each one is marked where it belongs, under sharing, with why.',
    ]);
    // A connection whose record id can't be read.
    await fake.hset(testKey('containers'), { [FRIEND.container]: JSON.stringify({ status: 'active', primary: false, created_at: '2026-01-01T00:00:00.000Z' }) });
    await fake.hset(testKey('connections'), { [`${CONN}|log`]: 'not json' });
    expect((await download()).problems).toEqual([
      { section: 'sharing', problem: 'record_id_unreadable' },
      { section: 'sharing', problem: 'unreadable' },
    ]);
  });

  test('each file says it is incomplete only when a part it is made from is', async () => {
    const { noticesStore } = await import('@/lib/connection-records');
    await fake.hset(ctxKey('connection-notices'), { item_chase: DAMAGED });
    await fake.hset(ctxKey('history:net-worth'), { '2026-01-02': 'garbage-ciphertext' });
    await fake.set(ctxKey('txns-unsaved:item_a'), '2026-10-01T00:00:00.000Z');
    expect((await noticesStore.getAllReport(ctx)).unreadable).toEqual(['item_chase']);
    const doc = await download();
    const caveat = doc.notes[0];
    expect(caveat).toContain('Chase');
    const [history, notices] = doc.notes.slice(1);
    expect(history).toStartWith('Not all of your net worth history could be read');
    expect(notices).toStartWith('Not all of your connection notices could be read, so this file is missing 1 entry whose stored data is damaged.');
    // The JSON file has every part.
    expect(exportFile(doc, 'json')).toMatchObject({ incomplete: ['net_worth_history', 'connection-notices'], notes: doc.notes });
    // The balances CSV is made from the history: its own note, pointing to the
    // JSON download for the list, and the caveat as ever.
    expect(exportFile(doc, 'balances-csv')).toMatchObject({
      incomplete: ['net_worth_history'],
      notes: [caveat, history.replace('The JSON file lists them', 'The JSON download lists them')],
    });
    // The transactions CSV is made from neither.
    expect(exportFile(doc, 'transactions-csv')).toMatchObject({ incomplete: [], notes: [caveat] });
  });
});

describe('caveats', () => {
  test('a transaction store behind what the app showed is noted', async () => {
    await fake.set(ctxKey('txns-unsaved:item_a'), '2026-10-01T00:00:00.000Z');
    const doc = await download();
    expect(doc.notes).toHaveLength(1);
    expect(doc.notes[0]).toContain('Chase');
  });

  test('two connections to the same bank, both behind, are one caveat', async () => {
    await fake.hset(ctxKey('plaid:items'), {
      item_c: JSON.stringify({ item_id: 'item_c', institution_name: 'Chase', institution_id: 'ins_3', encrypted_access_token: await encrypt('t') }),
    });
    await fake.set(ctxKey('txns-unsaved:item_a'), '2026-10-01T00:00:00.000Z');
    await fake.set(ctxKey('txns-blocked:item_c'), JSON.stringify({ at: '2026-10-01T00:00:00.000Z', chars: 9e9 }));
    expect((await download()).notes).toHaveLength(1);
  });

  test('a part named like a core one can’t replace it', async () => {
    const data = await collectUserData({ ctx, userId: 'user_me' });
    expect(() => buildUserExport({ ...data, sections: [['accounts', []]] }, NOW)).toThrow('called accounts');
  });
});

describe('stores built on the storage seam', () => {
  // Declared here the way the app declares its stores, and forgotten after, so
  // no other test sees them.
  type Plan = { name: string; target: number };
  const isPlan = (v: unknown): v is Plan =>
    typeof v === 'object' && v !== null && typeof (v as Plan).name === 'string' && Number.isFinite((v as Plan).target);
  const isPlans = (v: unknown): v is Plan[] => Array.isArray(v) && v.every(isPlan);
  let plans: ReturnType<typeof defineMapStore<Plan>>;
  let settings: ReturnType<typeof defineValueStore<Plan[]>>;
  let secrets: ReturnType<typeof defineMapStore<Plan>>;
  beforeAll(() => {
    plans = defineMapStore<Plan>('export-test-plans', { what: 'test plans', isValid: isPlan, exportable: true });
    settings = defineValueStore<Plan[]>('export-test-settings', { what: 'test settings', isValid: isPlans, exportable: true });
    secrets = defineMapStore<Plan>('export-test-secrets', { what: 'test secrets', isValid: isPlan, exportable: false });
  });
  afterAll(() => ['export-test-plans', 'export-test-settings', 'export-test-secrets'].forEach(forgetDeclaredStore));

  test('each one declared exportable is a section of its own, after the others, in name order; the rest are left out', async () => {
    await plans.setMany(ctx, [
      ['p2', { name: 'Retire at 55', target: 2_000_000 }],
      ['p1', { name: 'House', target: 120_000 }],
    ]);
    await settings.set(ctx, [{ name: 'Trip', target: 3000 }]);
    await secrets.set(ctx, 's1', { name: 'SECRET-NOT-EXPORTED', target: 1 });
    await plans.set(OTHER, 'o1', { name: 'OTHER-PERSON-PLAN', target: 1 });
    const doc = await download();
    const keys = Object.keys(doc);
    // With the app's own exportable stores (lib/stores.ts) among them, in name order.
    // Not the records of showings: "sharing" has them (covers).
    expect(keys.slice(keys.indexOf('sharing') + 1)).toEqual([
      'allocation-settings',
      'carried-annotations',
      'connection-notices',
      'connection-syncs',
      'connection-warnings',
      'export-test-plans',
      'export-test-settings',
      'fire-plan',
      'holdings:history',
      'import-settings',
      'imports',
      'manual-transactions',
      'planned-items',
      'transaction-annotations',
    ]);
    // A map store's entries in id order, a value store's value, as stored.
    expect(doc['export-test-plans']).toEqual([
      { id: 'p1', value: { name: 'House', target: 120_000 } },
      { id: 'p2', value: { name: 'Retire at 55', target: 2_000_000 } },
    ]);
    expect(doc['export-test-settings']).toEqual([{ name: 'Trip', target: 3000 }]);
    const text = JSON.stringify(doc);
    expect(text).not.toContain('SECRET-NOT-EXPORTED');
    expect(text).not.toContain('OTHER-PERSON-PLAN');
    // The download limit's own counter is bookkeeping, never part of it, and
    // so is the holdings history's index (each month names itself).
    expect(keys).not.toContain('download-count');
    expect(keys).not.toContain('import-requests');
    expect(keys).not.toContain('import-reads');
    // Each import's summary is its entry without the records, which `imports` has whole.
    expect(keys).not.toContain('import-summaries');
    expect(keys).not.toContain('holdings:history:index');
    // In the file as written, too, one entry per line.
    const written = [...exportFile(doc, 'json').pieces()].join('');
    expect(JSON.parse(written)['export-test-plans']).toEqual(doc['export-test-plans']);
    expect(written).toContain('\n    {"id":"p1","value":{"name":"House","target":120000}},\n');
  });

  test('never saved is an empty section, not a missing one', async () => {
    const doc = await download();
    expect(doc['export-test-plans']).toEqual([]);
    expect(doc['export-test-settings']).toBeNull();
  });

  test('an entry that can’t be read or isn’t recognised is named under problems; the rest of the store is in the file', async () => {
    await plans.setMany(ctx, [
      ['p1', { name: 'House', target: 120_000 }],
      ['p4', { name: 'Trip', target: 3000 }],
    ]);
    // Damaged bytes, and an entry intact but in a shape this code doesn't know.
    await fake.hset(ctxKey('export-test-plans'), { p2: DAMAGED, p3: await encrypt(JSON.stringify({ not: 'a plan' })) });
    // A value store's one value, saved by a version this one doesn't know.
    await fake.set(ctxKey('export-test-settings'), await encrypt(JSON.stringify({ not: 'plans' })));
    const before = JSON.stringify([...fake.strings, ...[...fake.hashes].map(([k, h]) => [k, [...h]])]);
    const doc = await download();
    // Every entry that reads, in id order.
    expect(doc['export-test-plans']).toEqual([
      { id: 'p1', value: { name: 'House', target: 120_000 } },
      { id: 'p4', value: { name: 'Trip', target: 3000 } },
    ]);
    // Null, and named: never passed off as never saved.
    expect(doc['export-test-settings']).toBeNull();
    expect(doc.problems).toEqual([
      { section: 'export-test-plans', problem: 'unreadable', ids: ['p2'] },
      { section: 'export-test-plans', problem: 'unrecognised', ids: ['p3'] },
      { section: 'export-test-settings', problem: 'unrecognised' },
    ]);
    // Said in words too, after any caveat, one note per part.
    expect(doc.notes).toEqual([
      'Not all of your test plans could be read, so this file is missing 1 entry whose stored data is damaged and 1 entry saved in a form this version of Nya does not know. The JSON file lists them under problems. Nothing was changed: what could not be read is still stored as it was.',
      'Your test settings could not be read (they were saved in a form this version of Nya does not know), so this file does not have them. Nothing was changed: what could not be read is still stored as it was.',
    ]);
    // Only reported: nothing is removed or rewritten.
    expect(JSON.stringify([...fake.strings, ...[...fake.hashes].map(([k, h]) => [k, [...h]])])).toBe(before);
    // In the file as written, right after the notes.
    const written = JSON.parse([...exportFile(doc, 'json').pieces()].join(''));
    expect(Object.keys(written).slice(5, 7)).toEqual(['notes', 'problems']);
    expect(written.problems).toEqual(doc.problems);
  });

  test('a store that can’t be reached still fails the download, naming it: never a file that looks complete', async () => {
    await plans.set(ctx, 'p1', { name: 'House', target: 120_000 });
    const real = fake.hgetall.bind(fake);
    (fake as any).hgetall = async (key: string) => {
      if (key === ctxKey('export-test-plans')) throw new Error('FakeRedis: out of reach');
      return real(key);
    };
    try {
      const err = await collectUserData({ ctx, userId: 'user_me' }).catch((e) => e);
      expect(err).toBeInstanceOf(ExportReadError);
      expect(err.what).toBe('test plans');
      expect(err.message).toStartWith('Your test plans could not be read, so nothing was downloaded');
      expect(err.cause).not.toBeInstanceOf(UnreadableEntriesError);
    } finally {
      (fake as any).hgetall = real;
    }
    // And a value store's: the same.
    await settings.set(ctx, [{ name: 'Trip', target: 3000 }]);
    const realGet = fake.get.bind(fake);
    (fake as any).get = async (key: string) => {
      if (key === ctxKey('export-test-settings')) throw new Error('FakeRedis: out of reach');
      return realGet(key);
    };
    try {
      const err = await collectUserData({ ctx, userId: 'user_me' }).catch((e) => e);
      expect(err).toBeInstanceOf(ExportReadError);
      expect(err.what).toBe('test settings');
      expect(err.cause).not.toBeInstanceOf(UnreadableValueError);
    } finally {
      (fake as any).get = realGet;
    }
  });

  test('a store that isn’t exportable is never read for it, so it can’t fail a download either', async () => {
    await fake.hset(ctxKey('export-test-secrets'), { s1: 'not-ciphertext-but-long-enough-to-be-tried' });
    expect((await download())['export-test-secrets']).toBeUndefined();
  });

  // The first store the app itself declares on the seam: in the download by
  // being declared exportable, under its own name, as saved.
  test('the Plan tab’s saved assumptions are a section of their own, "fire-plan"', async () => {
    const { firePlanStore } = await import('@/lib/fire-plan');
    const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
    expect(declaredSections().map((s) => s.key)).toContain('fire-plan');
    expect((await download())['fire-plan']).toBeNull(); // never saved
    const plan = { ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 52_000, planFunding: [{ account_id: 'acc_solo', paidFrom: 'bank' as const }] };
    await firePlanStore.set(ctx, plan);
    const doc = await download();
    expect(doc['fire-plan']).toEqual(plan);
    const written = JSON.parse([...exportFile(doc, 'json').pieces()].join(''));
    expect(written['fire-plan']).toEqual(plan);
    // Saved before the three-way switch, with the two-way one's list: as the
    // tab reads it, those plans paid from the bank.
    const { planFunding: _, ...older } = plan;
    await fake.set(ctxKey('fire-plan'), await encrypt(JSON.stringify({ ...older, bankFunded: ['acc_solo'] })));
    expect((await download())['fire-plan']).toEqual(plan);
  });

  // The allocation settings: the person's own choices (buckets, splits, a
  // target), so a section of the download as saved.
  test('the allocation settings are a section of their own, "allocation-settings"', async () => {
    const { allocationSettingsStore } = await import('@/lib/allocation-settings');
    expect(declaredSections().map((s) => s.key)).toContain('allocation-settings');
    expect((await download())['allocation-settings']).toBeNull(); // never saved
    const settings = {
      v: 1 as const,
      buckets: [{ account_id: 'acc_401k', bucket: 'roth' as const }],
      funds: [{ ticker: 'VFIFX', split: { 'us-stocks': 54, 'intl-stocks': 36, bonds: 10 } }],
      accounts: [{ account_id: 'manual_1', split: { cash: 100 } }],
      target: { stocks: 80, bonds: 20 },
    };
    await allocationSettingsStore.set(ctx, settings);
    await allocationSettingsStore.set(OTHER, { ...settings, funds: [{ ticker: 'OTHERPERSON', split: { stocks: 100 } }] });
    const doc = await download();
    expect(doc['allocation-settings']).toEqual(settings);
    expect(JSON.stringify(doc)).not.toContain('OTHERPERSON');
    const written = JSON.parse([...exportFile(doc, 'json').pieces()].join(''));
    expect(written['allocation-settings']).toEqual(settings);
  });

  // The recurring forecast's planned items: what the person typed and the
  // series they dismissed, a value store like the Plan tab's. Its request
  // counts per API token (a count per id) are bookkeeping, as a counter is.
  test('the forecast’s planned items are a section of their own, "planned-items", and one that can’t be read is named', async () => {
    const { plannedStore } = await import('@/lib/planned-store');
    const { EMPTY_PLANNED } = await import('@/lib/planned');
    const { apiRequestCount } = await import('@/lib/api-token-store');
    expect((await download())['planned-items']).toBeNull(); // never saved
    const planned = { ...EMPTY_PLANNED, dismissed: ['group:rent|1500'], threshold: { amount: 250, currency: 'USD' } };
    await plannedStore.set(ctx, planned as any);
    await apiRequestCount.take(ctx, 'tok_1');
    const doc = await download();
    expect(doc['planned-items']).toEqual(planned);
    expect(Object.keys(doc)).not.toContain('api-requests');
    expect(declaredSections().map((s) => s.key)).not.toContain('api-requests');
    expect(doc.problems).toEqual([]);

    await fake.set(ctxKey('planned-items'), DAMAGED);
    const damaged = await download();
    expect(damaged['planned-items']).toBeNull();
    expect(damaged.problems).toEqual([{ section: 'planned-items', problem: 'unreadable' }]);
    expect(damaged.notes).toContain(
      'Your planned items could not be read (the stored data is damaged), so this file does not have them. Nothing was changed: what could not be read is still stored as it was.'
    );
  });

  // Review: the record of the emails Nya sent about the person's own bank
  // connections, Plaid's warnings about them and when each last answered are
  // about that person, and /privacy names them, so they are in the download.
  test('how each bank connection is doing is in it: the notices, the warnings and the last syncs', async () => {
    const { noticesStore, warningsStore, syncsStore } = await import('@/lib/connection-records');
    const notice = { episode: 'e1', since: '2026-10-01T13:00:00.000Z', state: 'needs_reauth' as const, side: 'you' as const, notified_at: '2026-10-01T13:00:00.000Z', reminded_at: null, told: ['needs_reauth' as const] };
    const warning = { kind: 'pending_disconnect' as const, received_at: '2026-10-02T00:00:00.000Z', ends_at: '2026-10-09T00:00:00.000Z', ends_estimated: true, reason: 'INSTITUTION_MIGRATION' };
    await noticesStore.set(ctx, 'item_chase', notice);
    await warningsStore.set(ctx, 'item_amex', warning);
    await syncsStore.set(ctx, 'item_amex', { at: '2026-10-08T13:00:00.000Z' });
    await noticesStore.set(OTHER, 'item_other', { ...notice, episode: 'OTHER-PERSON-EPISODE' });
    const doc = await download();
    expect(doc['connection-notices']).toEqual([{ id: 'item_chase', value: notice }]);
    expect(doc['connection-warnings']).toEqual([{ id: 'item_amex', value: warning }]);
    expect(doc['connection-syncs']).toEqual([{ id: 'item_amex', value: { at: '2026-10-08T13:00:00.000Z' } }]);
    expect(JSON.stringify(doc)).not.toContain('OTHER-PERSON-EPISODE');
    expect(doc.not_included.join(' ')).not.toContain('how each bank connection is doing');
  });

  test('no store on the seam is named like a part of the file already there', async () => {
    // With every store the app declares loaded (lib/stores.ts), as when it runs.
    const data = await collectUserData({ ctx, userId: 'user_me' });
    const core = new Set([...Object.keys(buildUserExport({ ...data, sections: [] }, NOW)), ...SECTIONS.map((s) => s.key)]);
    expect(declaredSections().filter((s) => core.has(s.key)).map((s) => s.key)).toEqual([]);
    expect(declaredStores().some((s) => s.name === 'download-count' && !s.exportable)).toBe(true);
  });
});

describe('accounts as the person counts them, for the deletion receipt', () => {
  const counted = async () => countAccounts(await collectUserData({ ctx, userId: 'user_me' }));

  test('each connected bank’s accounts and each manual one, hidden or not; an id seen only in history isn’t one', async () => {
    // Checking, the hidden card, the brokerage and the house. The old checking
    // of a disconnected bank is linked to today’s: the same account, counted
    // once. acc_ghost has only balance history.
    expect(await counted()).toEqual({ accounts: 4, earlier: 0 });
  });

  test('an account of a disconnected bank, linked to nothing, is an earlier account, counted apart', async () => {
    await fake.hdel(ctxKey('account-links'), 'acc_old');
    expect(await counted()).toEqual({ accounts: 4, earlier: 1 });
  });

  test('two ids of one connected account, linked, count once', async () => {
    // A closed card the store still names, linked to its replacement.
    const stored = await collectUserData({ ctx, userId: 'user_me' });
    const store = stored.stores.find((s) => s.item_id === 'item_a')!;
    const data = {
      ...stored,
      stores: [{ ...store, accounts: { ...store.accounts, acc_card_old: store.accounts.acc_card } }],
      links: new Map([...stored.links, ['acc_card_old', { to: 'acc_card', linked_at: '2026-02-01T00:00:00.000Z', evidence: {} }]]),
    };
    expect(countAccounts(data)).toEqual({ accounts: 4, earlier: 0 });
    // Unlinked, it is an account of its own.
    expect(countAccounts({ ...data, links: stored.links })).toEqual({ accounts: 5, earlier: 0 });
  });

  test('a manual account that was removed isn’t counted, though its balance history stays', async () => {
    await fake.hset(ctxKey('history:accounts'), { '2026-01-02': await enc({ acc_chk: 1600.5, acc_card: 500, manual_boat: 9000 }) });
    expect(await counted()).toEqual({ accounts: 4, earlier: 0 });
  });
});

describe('writing it out', () => {
  test('JSON a piece at a time, fully laid out, is exactly JSON.stringify’s', async () => {
    const doc = await download();
    expect([...jsonPieces(doc)].join('')).toBe(JSON.stringify(doc, null, 2));
    for (const odd of [[], {}, [[]], { a: undefined, b: [undefined, 1] }, null, 'x', 0, [{ a: { b: [] } }]]) {
      expect([...jsonPieces(odd)].join('')).toBe(JSON.stringify(odd, null, 2));
      // Any layout reads back as the same value.
      expect(JSON.parse([...jsonPieces(odd, ONE_RECORD_PER_LINE)].join(''))).toEqual(JSON.parse(JSON.stringify(odd)));
    }
  });

  test('the JSON file: one record per line, and it reads back whole', async () => {
    const doc = await download();
    const file = exportFile(doc, 'json');
    expect(file.filename).toBe('nya-data-2026-10-06.json');
    expect(file.contentType).toBe('application/json; charset=utf-8');
    const text = [...file.pieces()].join('');
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(doc)));
    const lines = text.split('\n');
    // The document and its sections are laid out, a field per line.
    expect(lines[0]).toBe('{');
    expect(lines).toContain('  "format": "nya-export",');
    expect(lines).toContain('  "transactions": [');
    // Each record takes one line of its own: a transaction, an account, a day's total.
    for (const t of doc.transactions) expect(lines).toContain(`    ${JSON.stringify(t)}${t === doc.transactions.at(-1) ? '' : ','}`);
    for (const a of doc.accounts) expect(lines.some((l) => l.trim().replace(/,$/, '') === JSON.stringify(a))).toBe(true);
    expect(lines).toContain(`      ${JSON.stringify(doc.net_worth_history.points[0])},`);
    // One account's history is laid out too, its days one per line.
    const chk = doc.account_history.find((h) => h.account_id === 'acc_chk')!;
    expect(lines).toContain(`      "account_id": "acc_chk",`);
    expect(lines).toContain(`        ${JSON.stringify(chk.points[0])},`);
    expect(text.endsWith('}\n')).toBe(true);
  });

  test('the size is counted from a pass that keeps nothing, and the pass streamed after writes exactly that', async () => {
    const doc = await download();
    for (const format of ['json', 'transactions-csv', 'balances-csv'] as const) {
      const file = exportFile(doc, format);
      const announced = fileByteLength(file);
      const first = Buffer.concat([...fileChunks(file)]);
      const second = Buffer.concat([...fileChunks(file)]);
      expect(first.byteLength).toBe(announced);
      // Byte for byte the same file, however many times it is written.
      expect(second.equals(first)).toBe(true);
      // ignoreBOM keeps the CSVs' byte order mark, which a default decoder drops.
      expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(first)).toBe([...file.pieces()].join(''));
    }
  });

  test('transactions.csv: one row per stored transaction, guarded against formulas', async () => {
    const doc = await download();
    const file = exportFile(doc, 'transactions-csv');
    expect(file.filename).toBe('nya-transactions-2026-10-06.csv');
    const text = [...file.pieces()].join('');
    // A byte order mark first, so Excel reads it as UTF-8.
    expect(text.startsWith('\uFEFFdate,account_name,')).toBe(true);
    const [header, ...rows] = parseCsv(text);
    expect(header).toEqual([...TRANSACTION_COLUMNS]);
    expect(rows).toHaveLength(doc.transactions.length);
    const col = (row: string[], name: (typeof TRANSACTION_COLUMNS)[number]) => row[TRANSACTION_COLUMNS.indexOf(name)];
    const evil = rows.find((r) => col(r, 'transaction_id') === 't_evil')!;
    expect(col(evil, 'merchant_name')).toBe('\'=HYPERLINK("http://evil.example","click")');
    expect(col(evil, 'name')).toBe("'@SUM(1+1)");
    // A negative amount stays a number.
    expect(col(evil, 'amount')).toBe('-1200');
    const coffee = rows.find((r) => col(r, 'transaction_id') === 't_coffee')!;
    expect(col(coffee, 'your_category')).toBe('Treats');
    expect(col(coffee, 'your_merchant_name')).toBe('BB Coffee');
    expect(col(coffee, 'category_detailed')).toBe('FOOD_AND_DRINK_COFFEE');
    expect(col(coffee, 'location_city')).toBe('Oakland');
    expect(col(coffee, 'location_lon')).toBe('-122.27');
    expect(col(coffee, 'counterparties')).toBe('Blue Bottle (merchant)');
    expect(col(coffee, 'payment_processor')).toBe('Square');
    expect(col(rows.find((r) => col(r, 'transaction_id') === 't_pending')!, 'superseded_by_posted')).toBe('true');
    expect(col(rows.find((r) => col(r, 'transaction_id') === 't_card')!, 'account_hidden')).toBe('true');
  });

  test('transactions.csv: the rows of manual accounts too, entered by hand or imported, in the same columns, with their account, source and currency', async () => {
    const { manualTxnStore } = await import('@/lib/manual-txns');
    const at = '2026-09-30T10:00:00.000Z';
    const typed = 'manual-txn:00000000-0000-4000-8000-000000000001';
    const imported = 'manual-txn:00000000-0000-4000-8000-000000000002';
    const row = (over: Record<string, unknown>) => ({
      id: typed,
      account_id: 'manual_house',
      date: '2026-01-04',
      amount: 12.5,
      currency: 'EUR',
      name: 'Bakery',
      category: 'food',
      note: 'croissants, for the office',
      source: 'manual',
      source_id: null,
      created_at: at,
      updated_at: at,
      ...over,
    });
    await manualTxnStore.set(ctx, 'manual_house', {
      version: 1,
      rows: [
        row({}),
        // From a file: a payee that would run as a formula, money in, an ATM.
        row({ id: imported, date: '2026-01-03', amount: -40, currency: 'USD', name: '=HYPERLINK("http://evil.example","x")', category: null, note: null, source: 'import:ofx', source_id: 'FITID-1', import_id: 'import:0f1e2d3c-aaaa', transaction_code: 'atm' }),
      ],
    } as any);
    // A hidden manual account's rows are there, marked, as a bank's are.
    await fake.hset(ctxKey('hidden:accounts'), { manual_house: await enc({ type: 'other', hidden_at: '2026-03-01T00:00:00.000Z' }) });
    const doc = await download();
    // The JSON keeps them where they are stored, apart from the bank's.
    expect(doc.transactions.map((t) => t.transaction_id)).not.toContain(typed);
    const file = exportFile(doc, 'transactions-csv');
    const [header, ...rows] = parseCsv([...file.pieces()].join(''));
    expect(header).toEqual([...TRANSACTION_COLUMNS]);
    expect(header.slice(-2)).toEqual(['source', 'note']);
    const col = (r: string[], name: (typeof TRANSACTION_COLUMNS)[number]) => r[TRANSACTION_COLUMNS.indexOf(name)];
    // Newest first, among the bank's rows; on a day, after the rows with a time.
    expect(rows.map((r) => col(r, 'transaction_id'))).toEqual(['t_evil', 't_posted', typed, 't_card', 't_pending', imported, 't_coffee', 't_bakery']);
    const byId = Object.fromEntries(rows.map((r) => [col(r, 'transaction_id'), r]));
    const cells = (id: string, names: (typeof TRANSACTION_COLUMNS)[number][]) => Object.fromEntries(names.map((n) => [n, col(byId[id], n)]));
    const shown = ['date', 'account_name', 'institution_name', 'name', 'merchant_name', 'amount', 'iso_currency_code', 'category', 'your_category', 'pending', 'superseded_by_posted', 'account_hidden', 'transaction_code', 'account_id', 'item_id', 'vendor_key', 'source', 'note'] as const;
    expect(cells(typed, [...shown])).toEqual({
      date: '2026-01-04',
      account_name: 'House',
      institution_name: 'Zillow estimate',
      name: 'Bakery',
      merchant_name: '',
      amount: '12.5',
      iso_currency_code: 'EUR',
      category: 'food',
      your_category: '',
      pending: 'false',
      superseded_by_posted: 'false',
      account_hidden: 'true',
      transaction_code: '',
      account_id: 'manual_house',
      item_id: '',
      vendor_key: '',
      source: 'manual',
      note: 'croissants, for the office',
    });
    expect(cells(imported, ['name', 'amount', 'iso_currency_code', 'category', 'transaction_code', 'source', 'note'])).toEqual({
      // The guard, as on a bank's row; a negative amount stays a number.
      name: '\'=HYPERLINK("http://evil.example","x")',
      amount: '-40',
      iso_currency_code: 'USD',
      category: '',
      transaction_code: 'atm',
      source: 'import:ofx',
      note: '',
    });
    // A bank's row says so.
    expect(cells('t_coffee', ['source', 'note'])).toEqual({ source: 'plaid', note: '' });
    expect(file).toMatchObject({ incomplete: [], notes: [] });
  });

  test('transactions.csv: a manual account’s book that can’t be read leaves the rest in, and the file says it is incomplete', async () => {
    const { manualTxnStore } = await import('@/lib/manual-txns');
    const at = '2026-09-30T10:00:00.000Z';
    const id = 'manual-txn:00000000-0000-4000-8000-000000000003';
    await manualTxnStore.set(ctx, 'manual_house', {
      version: 1,
      rows: [{ id, account_id: 'manual_house', date: '2026-01-02', amount: 3, currency: 'USD', name: 'Tea', category: null, note: null, source: 'manual', source_id: null, created_at: at, updated_at: at }],
    });
    await fake.hset(ctxKey('manual-transactions'), { manual_gone: DAMAGED });
    const doc = await download();
    const file = exportFile(doc, 'transactions-csv');
    const [, ...rows] = parseCsv([...file.pieces()].join(''));
    expect(rows.map((r) => r[TRANSACTION_COLUMNS.indexOf('transaction_id')])).toContain(id);
    expect(file.incomplete).toEqual(['manual-transactions']);
    expect(file.notes).toEqual([
      'Not all of your manual transactions could be read, so this file is missing the transactions of 1 account whose stored data is damaged. The JSON download lists them under problems. Nothing was changed: what could not be read is still stored as it was.',
    ]);
    // The balances CSV isn't made from them.
    expect(exportFile(doc, 'balances-csv')).toMatchObject({ incomplete: [], notes: [] });
  });

  test('balances.csv: the total and each account by day, oldest first, recorded and estimated marked', async () => {
    const doc = await download();
    const file = exportFile(doc, 'balances-csv');
    expect(file.filename).toBe('nya-balances-2026-10-06.csv');
    const text = [...file.pieces()].join('');
    expect(text.startsWith('\uFEFFdate,record,')).toBe(true);
    const [header, ...rows] = parseCsv(text);
    expect(header).toEqual([...BALANCE_COLUMNS]);
    const totals = rows.filter((r) => r[1] === 'net_worth');
    expect(totals.map((r) => [r[0], r[6], r[8]])).toEqual([
      ['2025-12-30', '900', 'estimated'],
      ['2025-12-31', '950', 'estimated'],
      ['2026-01-01', '1000', 'recorded'],
      ['2026-01-02', '1100.5', 'recorded'],
      ['2026-01-03', '1050', 'recorded'],
    ]);
    const card = rows.find((r) => r[1] === 'account' && r[2] === 'acc_card' && r[0] === '2026-01-01')!;
    expect(card).toEqual(['2026-01-01', 'account', 'acc_card', 'Sapphire', 'Chase', 'credit', '500', 'USD', 'recorded', 'true']);
    // Oldest day first, and on each day the total before the accounts.
    const dates = rows.map((r) => r[0]);
    expect(dates).toEqual([...dates].sort());
    const first0101 = rows.findIndex((r) => r[0] === '2026-01-01');
    expect(rows[first0101][1]).toBe('net_worth');
    expect(rows.length).toBe(totals.length + doc.account_history.reduce((n, s) => n + s.points.length, 0));
  });

  // In neither accounts nor manual_accounts, but hidden_accounts still knows
  // its type and that it is hidden, as transactions.csv reads it. The notes
  // say what the CSVs lack: the name, never account_history, which is the
  // JSON file's.
  test('both CSVs: a manual account that can’t be read keeps its rows, hidden and typed where that is known, and the notes say what is missing', async () => {
    const { manualTxnStore } = await import('@/lib/manual-txns');
    const at = '2026-09-30T10:00:00.000Z';
    await fake.hset(ctxKey('manual:accounts'), { manual_house: DAMAGED });
    await fake.hset(ctxKey('hidden:accounts'), { manual_house: await enc({ type: 'other', hidden_at: '2026-03-01T00:00:00.000Z' }) });
    await fake.hset(ctxKey('history:accounts'), { '2026-01-05': await enc({ manual_house: 400000 }) });
    await manualTxnStore.set(ctx, 'manual_house', {
      version: 1,
      rows: [{ id: 'manual-txn:00000000-0000-4000-8000-000000000009', account_id: 'manual_house', date: '2026-01-05', amount: 12, currency: 'USD', name: 'Paint', category: null, note: null, source: 'manual', source_id: null, created_at: at, updated_at: at }],
    });
    const doc = await download();
    const balances = exportFile(doc, 'balances-csv');
    const [header, ...rows] = parseCsv([...balances.pieces()].join(''));
    const house = rows.filter((r) => r[2] === 'manual_house').map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
    expect(house).toEqual([
      { date: '2026-01-05', record: 'account', account_id: 'manual_house', account_name: '', institution_name: '', account_type: 'other', balance: '400000', currency: '', kind: 'recorded', account_hidden: 'true' },
    ]);
    const suffix = 'The JSON download lists them under problems. Nothing was changed: what could not be read is still stored as it was.';
    const said = `Not all of your manual accounts could be read: 1 account whose stored data is damaged. Their rows in this file are under their account ids, with no account name. ${suffix}`;
    expect(balances).toMatchObject({ incomplete: ['manual_accounts'], notes: [said] });
    const txns = exportFile(doc, 'transactions-csv');
    const [txHeader, ...txRows] = parseCsv([...txns.pieces()].join(''));
    const paint = txRows.find((r) => r[txHeader.indexOf('account_id')] === 'manual_house')!;
    expect([paint[txHeader.indexOf('name')], paint[txHeader.indexOf('account_name')], paint[txHeader.indexOf('account_hidden')]]).toEqual(['Paint', '', 'true']);
    expect(txns).toMatchObject({ incomplete: ['manual_accounts'], notes: [said] });
    // The JSON file's own note names account_history, which it has.
    expect(exportFile(doc, 'json').notes[0]).toContain('still in account_history');
  });
});

describe('the inventory', () => {
  // Every key the code builds inside a container, read from the source, as
  // test/move.test.ts reads it: each must say what the download does with it.
  const libDir = join(import.meta.dir, '..', 'lib');
  const built = new Set<string>();
  for (const f of readdirSync(libDir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(libDir, f), 'utf8');
    for (const m of src.matchAll(/\bkc\(\s*\w+\s*,\s*(['`])([^'`$]*)(\$\{)?/g)) built.add(m[2]);
  }

  test('every key a container can hold is in the download or left out on purpose', () => {
    expect(built.size).toBeGreaterThan(20);
    expect([...built].filter((key) => !storedKeyListed(key))).toEqual([]);
  });

  test('and the list names nothing the code no longer builds', () => {
    const stale = STORED_KEYS.map(([k]) => k).filter((k) => !built.has(k) && !(k.endsWith(':') && [...built].some((b) => b.startsWith(k))));
    expect(stale).toEqual([]);
  });
});
