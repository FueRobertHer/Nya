import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The stores a restore keeps (lib/user-restore/store.ts): their ids, their
// closed shapes, and a round trip through the seam.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const S = await import('@/lib/user-restore/store');
const { bankFieldsOf, isBankRecord, isId, BANK_FIELDS } = await import('@/lib/user-restore/records');
const ctx = TEST_CTX;

beforeEach(async () => {
  fake.reset();
  await registerTestContainer(fake);
});

const ID = 'user-restore:0f8fad5b-d9cb-469f-a165-70867728950e';
const DIGEST = 'a'.repeat(64);

const BANK = bankFieldsOf({
  transaction_id: 'txn1',
  account_id: 'acc1',
  amount: 12.34,
  iso_currency_code: 'USD',
  date: '2026-03-02',
  name: 'COFFEE SHOP 123',
  merchant_name: 'Coffee Shop',
  pending: false,
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE', confidence_level: 'HIGH' },
  location: { city: 'Seattle', region: 'WA', lat: 47.6, lon: -122.3 },
  counterparties: [{ name: 'Coffee Shop', type: 'merchant', confidence_level: 'HIGH' }],
  category: 'food and drink',
  account_name: 'Checking',
  institution_name: 'Chase',
});

const RECORD: import('@/lib/user-restore/store').UserRestoreRecord = {
  version: 1,
  id: ID,
  status: 'writing',
  started_at: '2026-10-17T10:00:00.000Z',
  finished_at: null,
  undo_until: null,
  last_batch_at: null,
  source: { exported_at: '2026-10-10T08:00:00.000Z', version: 2, bytes: 1234, protected: false },
  plan: { digest: DIGEST, batches: [{ part: 'categories', count: 1, digest: DIGEST }] },
  done: 0,
  brought: { transactions: 2 },
  left_out: { pending: 1 },
  without: {},
  history: { first: '2021-03-02', last: '2026-10-10' },
  earlier: [],
};

describe('restored ids', () => {
  test('the imported rows’ prefix and the bank’s own id, both ways', () => {
    expect(S.restoredId('lPNjeW1nR6CDn5okmGQ6hEpMo4lLNoSrzqDje')).toBe('imported-txn:restored.lPNjeW1nR6CDn5okmGQ6hEpMo4lLNoSrzqDje');
    expect(S.bankIdOf('imported-txn:restored.abc')).toBe('abc');
    expect(S.isRestoredId('imported-txn:restored.abc')).toBe(true);
    // An imported row's id is not a restored one.
    expect(S.isRestoredId('imported-txn:0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(false);
    expect(S.bankIdOf('imported-txn:x')).toBeNull();
  });

  test('every pruner leaves it alone: it has the prefix they skip', async () => {
    const { IMPORTED_TXN_PREFIX } = await import('@/lib/history-import/view');
    expect(S.restoredId('x1').startsWith(IMPORTED_TXN_PREFIX)).toBe(true);
  });

  test('a bank id that isn’t one is refused, never built into an id', () => {
    for (const bad of ['', 'has space', 'x'.repeat(151), 'semi;colon']) expect(() => S.restoredId(bad)).toThrow(TypeError);
  });

  test('an id the seam takes, at the longest bank id', () => {
    expect(isId(S.restoredId('x'.repeat(150)))).toBe(true);
  });
});

describe('the record', () => {
  test('a whole record reads', () => {
    expect(S.isUserRestoreRecord(RECORD)).toBe(true);
    expect(S.isUserRestoreRecord({ ...RECORD, status: 'finished', finished_at: '2026-10-17T10:05:00.000Z', undo_until: '2026-10-24T10:05:00.000Z', done: 1 })).toBe(true);
  });

  test('closed: an unknown field, a status of the operator’s restore, or more done than planned is unrecognised', () => {
    expect(S.isUserRestoreRecord({ ...RECORD, extra: 1 })).toBe(false);
    expect(S.isUserRestoreRecord({ ...RECORD, status: 'restoring' })).toBe(false);
    expect(S.isUserRestoreRecord({ ...RECORD, done: 2 })).toBe(false);
    expect(S.isUserRestoreRecord({ ...RECORD, source: { ...RECORD.source, name: 'x.json' } })).toBe(false);
    expect(S.isUserRestoreRecord({ ...RECORD, plan: { digest: DIGEST, batches: [] } })).toBe(false);
    expect(S.isUserRestoreRecord({ ...RECORD, id: 'restore:x' })).toBe(false);
  });

  test('round trip through the seam, encrypted', async () => {
    await S.userRestoreStore.set(ctx, RECORD);
    expect(await S.userRestoreStore.get(ctx)).toEqual(RECORD);
  });

  test('a new id is one the record takes', () => {
    expect(S.isUserRestoreId(S.newUserRestoreId())).toBe(true);
  });
});

describe('restored rows', () => {
  const row = (id = 'txn1', over: Record<string, unknown> = {}) => ({
    id: S.restoredId(id),
    account_id: 'acc1',
    import_id: ID,
    bank: { ...BANK, transaction_id: id, ...over },
    created_at: '2026-10-17T10:00:00.000Z',
  });

  test('the bank record keeps every field the bank store keeps, no more', () => {
    expect(Object.keys(BANK).sort()).toEqual([...BANK_FIELDS].sort());
    expect(isBankRecord(BANK)).toBe(true);
    expect(isBankRecord({ ...BANK, nya_category: 'x' })).toBe(false);
    expect(isBankRecord({ ...BANK, nya_category: 'x' }, { extra: ['nya_category'] })).toBe(true);
    // Plaid's own objects are open: a field Plaid adds is kept.
    expect(isBankRecord({ ...BANK, location: { ...BANK.location, plus_code: 'x' } })).toBe(true);
    expect(isBankRecord({ ...BANK, location: { city: 5 } })).toBe(false);
    expect(isBankRecord({ ...BANK, amount: Number.NaN })).toBe(false);
    expect(isBankRecord({ ...BANK, date: '2026-02-30' })).toBe(false);
  });

  test('a book of one account and part, each id once, at most BOOK_ROWS', () => {
    const book = { version: 1, account_id: 'acc1', part: 1, rows: [row('t1'), row('t2')] };
    expect(S.isRestoredBook(book)).toBe(true);
    expect(S.isRestoredBook({ ...book, rows: [row('t1'), row('t1')] })).toBe(false);
    expect(S.isRestoredBook({ ...book, rows: [{ ...row('t1'), account_id: 'acc2', bank: { ...BANK, transaction_id: 't1', account_id: 'acc2' } }] })).toBe(false);
    expect(S.isRestoredBook({ ...book, part: 0 })).toBe(false);
    expect(S.isRestoredBook({ ...book, extra: 1 })).toBe(false);
    // A row whose id isn't its bank row's, or with a field missing.
    expect(S.isRestoredBook({ ...book, rows: [{ ...row('t1'), id: S.restoredId('other') }] })).toBe(false);
    const { website, ...missing } = BANK;
    void website;
    expect(S.isRestoredBook({ ...book, rows: [{ ...row('t1'), bank: { ...missing, transaction_id: 't1' } }] })).toBe(false);
  });

  test('round trip through the seam, compressed', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(`t${i}`));
    const book = { version: 1 as const, account_id: 'acc1', part: 1, rows };
    await S.restoredTxnStore.set(ctx, S.restoredBookId('acc1', 1), book);
    expect(await S.restoredTxnStore.get(ctx, 'acc1.1')).toEqual(book);
  });
});

describe('restored accounts and investments', () => {
  const account = {
    version: 1,
    restore_id: ID,
    item_id: 'item1',
    institution_id: 'ins_3',
    institution_name: 'Chase',
    name: 'Checking',
    mask: '4821',
    type: 'depository',
    subtype: 'checking',
    currency: 'USD',
    rows: { first: '2021-03-02', last: '2026-10-09', count: 4210, books: 1 },
    downloaded: '2026-10-10',
    restored_at: '2026-10-17T10:00:00.000Z',
  };

  test('an account reads; an unknown field doesn’t', () => {
    expect(S.isRestoredAccount(account)).toBe(true);
    expect(S.isRestoredAccount({ ...account, rows: null })).toBe(true);
    expect(S.isRestoredAccount({ ...account, balance: 5 })).toBe(false);
    expect(S.isRestoredAccount({ ...account, rows: { first: '2026-10-09', last: '2021-03-02', count: 1, books: 1 } })).toBe(false);
    // More rows than its books can hold.
    expect(S.isRestoredAccount({ ...account, rows: { ...account.rows, count: 5_001 } })).toBe(false);
    expect(S.isRestoredAccount({ ...account, rows: { ...account.rows, count: 5_001, books: 2 } })).toBe(true);
    expect(S.isRestoredAccount({ ...account, downloaded: 'yesterday' })).toBe(false);
  });

  test('investment rows and coverage', () => {
    const inv = { investment_transaction_id: 'inv1', account_id: 'acc9', item_id: 'item1', date: '2026-01-02', name: 'BUY VTI', quantity: 1, price: 250, amount: 250, fees: 0, type: 'buy', subtype: 'buy', security: { name: 'Vanguard', ticker_symbol: 'VTI' }, seen_at: '2026-10-09', missing_since: null, excluded: false, cancelled: false };
    expect(S.isRestoredInvestments({ version: 1, kind: 'rows', item_id: 'item1', part: 1, rows: [inv] })).toBe(true);
    expect(S.isRestoredInvestments({ version: 1, kind: 'rows', item_id: 'item2', part: 1, rows: [inv] })).toBe(false);
    expect(S.isRestoredInvestments({ version: 1, kind: 'coverage', item_id: 'item1', coverage: [{ account_id: 'acc9', from: '2025-01-01', through: '2026-10-09' }] })).toBe(true);
    expect(S.isRestoredInvestments({ version: 1, kind: 'other', item_id: 'item1' })).toBe(false);
  });
});
