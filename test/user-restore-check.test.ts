import { describe, expect, test, mock } from 'bun:test';
import { FakeRedis, storageMock } from './fake-redis';

// The server's check of a restore's batches (lib/user-restore/check.ts): every
// record as it will be stored, by the store's own check, closed.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { checkBatch, unknownField, BatchRefused, isPartName } = await import('@/lib/user-restore/check');
const { declaredStore: declared } = await import('@/lib/stores');
type Checked = { check(v: unknown): unknown | null };
const declaredStore = (name: string) => declared(name) as unknown as (Checked & { name: string }) | null;

const env = { exported: '2026-10-10', today: '2026-10-18' };
const refused = (body: unknown): string => {
  try {
    checkBatch(body, env);
  } catch (err) {
    if (err instanceof BatchRefused) return err.problem;
    throw err;
  }
  return 'passed';
};

const importedRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  account_id: 'acc_chk',
  date: '2026-01-02',
  amount: 4.5,
  currency: 'USD',
  name: 'COFFEE',
  category: null,
  note: null,
  source: 'import:csv',
  source_id: 'k1',
  import_id: 'history-import:1',
  created_at: '2026-02-01T00:00:00.000Z',
  ...over,
});
const book = (rows: unknown[]) => ({ version: 1, rows });

describe('closed by the store’s own check', () => {
  const store = declaredStore('imported-transactions')!;
  test('a field the store keeps for a later release, but this one doesn’t check, is unknown', () => {
    const check = (v: unknown) => store.check(v);
    expect(unknownField(check, book([importedRow('imported-txn:00000000-0000-4000-8000-000000000001')]), {})).toBeNull();
    // The store keeps it (its reads are open for a rollback) ...
    const later = book([importedRow('imported-txn:00000000-0000-4000-8000-000000000001', { later_field: 1 })]);
    expect(store.check(later)).not.toBeNull();
    // ... but a file can't be read for what this release can't know.
    expect(unknownField(check, later, {})).toBe('rows[].later_field');
  });

  test('each kind of row is looked at once, on a book of that one row', () => {
    let calls = 0;
    const check = (v: unknown) => {
      calls++;
      return store.check(v);
    };
    const rows = Array.from({ length: 2000 }, (_, i) => importedRow(`imported-txn:00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
    expect(unknownField(check, book(rows), {})).toBeNull();
    expect(calls).toBeLessThan(60);
  });

  test('what the store keeps as the outside world gave it is taken as it is', () => {
    const entry = declaredStore('history-imports')!;
    const e = {
      version: 1,
      account_id: 'acc_chk',
      format: 'csv',
      source: 'import:csv',
      file_name: 'chase.csv',
      file_bytes: 10,
      encoding: 'utf-8',
      imported_at: '2026-02-01T00:00:00.000Z',
      currency: 'USD',
      first_date: '2026-01-02',
      last_date: '2026-01-02',
      covers: { from: '2026-01-02', to: '2026-01-02', stated: false },
      bank_from: null,
      counts: { imported: 1, duplicates: 0, already: 0, present: 0, repeated: 0, skipped: 0, unreadable: 0 },
      read: { delimiter: ',', anything: { nested: true } },
      statement: null,
      columns: ['Date', 'Amount'],
      records: [{ line: 2, outcome: 'imported', row_id: 'imported-txn:x', raw: { Date: '1/2/2026', Whatever: 'kept' } }],
    };
    expect(entry.check(e)).not.toBeNull();
    expect(refused({ part: 'store:history-imports', records: [{ id: 'history-import:1', value: e }] })).toBe('passed');
    // Its statement is closed here, though the store checks only that it is one.
    const withStatement = { ...e, statement: { kind: 'bank', label: 'Chase', bank_id: null, mask: '1111', type: null, currency: 'USD', start: null, end: null, ledger: null, extra: 1 } };
    expect(refused({ part: 'store:history-imports', records: [{ id: 'history-import:1', value: withStatement }] })).toContain('statement.extra');
    // A field of the entry itself is not taken.
    expect(refused({ part: 'store:history-imports', records: [{ id: 'history-import:1', value: { ...e, newer: true } }] })).toContain('newer: is a field this version of Nya doesn’t know');
  });
});

describe('batches', () => {
  test('only the parts a plan names', () => {
    expect(isPartName('store:rules')).toBe(true);
    expect(isPartName('store:api-tokens')).toBe(false); // never exported
    expect(isPartName('store:connection-notices')).toBe(false); // never brought back
    expect(isPartName('store:user-restore')).toBe(false); // kept inside the record
    expect(isPartName('history:accounts:partial')).toBe(true);
    expect(isPartName('history:snapshot:taken')).toBe(false);
    expect(isPartName('directory')).toBe(true);
    expect(refused({ part: 'store:api-tokens', records: [{ id: 'x', value: {} }] })).toContain('doesn’t write');
    expect(refused({ part: 'rules', records: [] })).toContain('doesn’t write');
    expect(refused({ part: 'store:rules', records: [], extra: 1 })).toContain('{ part, records }');
  });

  test('a value store is written whole, in one record, checked as stored', () => {
    expect(refused({ part: 'store:report-settings', records: [{ value: { v: 1, marked: ['groceries'] } }] })).toBe('passed');
    expect(refused({ part: 'store:report-settings', records: [{ value: { v: 1, marked: [] } }, { value: { v: 1, marked: [] } }] })).toContain('whole, in one record');
    expect(refused({ part: 'store:report-settings', records: [{ value: { v: 1, marked: [], more: 1 } }] })).toContain('isn’t report settings');
  });

  test('a recorded day after the download can’t be a measurement; an estimated one is taken', () => {
    expect(refused({ part: 'history:net-worth', records: [{ date: '2026-10-09', value: 1000 }] })).toBe('passed');
    expect(refused({ part: 'history:net-worth', records: [{ date: '2026-10-11', value: 1000 }] })).toContain('after the download');
    expect(refused({ part: 'history:accounts', records: [{ date: '2026-10-09', value: { acc_chk: 5, acc_card: 'x' } }] })).toContain('balances by account');
    expect(refused({ part: 'history:net-worth', records: [{ date: '2026-02-30', value: 1 }] })).toContain('must be a day');
    expect(refused({ part: 'history:net-worth:est', records: [{ date: '2026-10-12', value: 1000 }] })).toBe('passed');
  });

  test('a book’s rows are their account’s, and a restored book is kept under its own id', () => {
    const row = importedRow('imported-txn:00000000-0000-4000-8000-000000000009');
    expect(refused({ part: 'store:imported-transactions', records: [{ id: 'acc_chk', from: 0, value: book([row]) }] })).toBe('passed');
    expect(refused({ part: 'store:imported-transactions', records: [{ id: 'acc_other', value: book([row]) }] })).toContain('rows’ account');
    expect(refused({ part: 'store:imported-transactions', records: [{ id: 'acc_chk', from: -1, value: book([row]) }] })).toContain('whole number');
    expect(refused({ part: 'store:rules', records: [{ id: 'x', from: 0, value: null }] })).toContain('whole, in one record');
  });

  test('an id that would set an object’s prototype is never one', () => {
    expect(refused({ part: 'overrides', records: [{ id: '__proto__', value: 'Food' }] })).toContain('must be an id');
  });
});
