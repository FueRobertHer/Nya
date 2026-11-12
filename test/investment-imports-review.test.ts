import { describe, expect, test } from 'bun:test';
import { afterUndo, type AccountImport, type ImportedRow, type InvestmentImport } from '@/lib/investment-imports';
import { effectOf, REVIEW_ID } from '@/lib/investment-imports-review';
import type { InvestmentTxn } from '@/lib/investments';
import type { InvSync } from '@/lib/invstore';

// What importing Vanguard's transactions download would do to one account,
// for the review (lib/investment-imports-review.ts effectOf): the days it
// would decide, its rows and those there now, deposits & withdrawals over
// those days each way and by month, nothing counted where Nya has no activity
// yet, the twins at its edges, and days that don't reach Nya's activity. Then
// what an Undo hands each of an import's days back to (lib/investment-
// imports.ts afterUndo).

const plaidRow = (id: string, date: string, amount: number, over: Partial<InvestmentTxn> = {}): InvestmentTxn => ({
  investment_transaction_id: id,
  account_id: 'inv',
  date,
  name: 'Funds Received',
  type: 'cash',
  subtype: 'deposit',
  quantity: 0,
  price: 0,
  amount,
  fees: 0,
  currency: 'USD',
  security: null,
  ...over,
});
const fileRow = (date: string, amount: number, over: Partial<ImportedRow> = {}): ImportedRow => ({
  date,
  name: 'Funds Received',
  type: 'cash',
  subtype: 'deposit',
  quantity: 0,
  price: 0,
  amount,
  fees: 0,
  currency: 'USD',
  security: null,
  ...over,
});
const file = (from: string, to: string, rows: ImportedRow[]): InvestmentImport => ({
  source: 'vanguard-csv',
  file_name: 'OfxDownload.csv',
  imported_at: '2026-11-12T12:00:00.000Z',
  covers: { from, to },
  currency: 'USD',
  rows,
});
const stored = (import_id: string, f: InvestmentImport, over: Partial<AccountImport> = {}): AccountImport => ({ ...f, imported_at: '2026-08-03T12:00:00.000Z', account_id: 'inv', import_id, ...over });
const syncOf = (rows: InvestmentTxn[], coverage: InvSync['coverage'] = { inv: { from: '2025-01-01', through: '2026-11-10' } }): InvSync => ({
  rows,
  coverage,
  note: null,
  pending: false,
  storeNote: null,
  unconfirmed: {},
  unconfirmedIds: [],
  busy: false,
});

/** Plaid's rows: $100 in on the 10th of each month, Jan to Oct 2026. */
const PLAID = Array.from({ length: 10 }, (_, m) => plaidRow(`p${m + 1}`, `2026-${String(m + 1).padStart(2, '0')}-10`, -100));

describe('what an import would do', () => {
  test('its days, its rows in place of those there now, and deposits & withdrawals each way, by month where they differ', () => {
    const f = file('2026-05-01', '2026-07-31', [fileRow('2026-05-10', -100), fileRow('2026-06-15', -500), fileRow('2026-07-10', -100)]);
    const out = effectOf(syncOf(PLAID), 'inv', [], f);
    expect(out).toEqual({
      kind: 'takes',
      days: [{ from: '2026-05-01', to: '2026-07-31' }],
      rows: 3,
      now_rows: 3,
      flows: { file: 700, now: 300 },
      savings: { file: 700, now: 300 },
      months: [{ month: '2026-06', now: 100, file: 500 }],
      twins: [],
    });
  });

  test('a QFX’s money in, which never says it was a contribution: the same deposits & withdrawals, less new savings', () => {
    const f = { ...file('2026-05-01', '2026-07-31', [fileRow('2026-05-10', -100, { subtype: 'unlabeled', name: 'Money in' }), fileRow('2026-06-10', -100, { subtype: 'unlabeled', name: 'Money in' }), fileRow('2026-07-10', -100, { subtype: 'unlabeled', name: 'Money in' })]), source: 'vanguard-qfx' as const };
    const out = effectOf(syncOf(PLAID), 'inv', [], f);
    expect(out).toMatchObject({ kind: 'takes', flows: { file: 300, now: 300 }, savings: { file: 0, now: 300 }, months: [] });
  });

  test('new savings now only over days that count now', () => {
    const rows = PLAID.filter((t) => t.date >= '2026-03-01');
    const f = file('2026-01-01', '2026-03-31', [fileRow('2026-01-05', -50), fileRow('2026-03-10', -100)]);
    const out = effectOf(syncOf(rows, { inv: { from: '2026-03-01', through: '2026-11-10' } }), 'inv', [], f);
    expect(out).toMatchObject({ savings: { file: 150, now: 100 } });
  });

  test('what counts now is what an earlier import decides, where it does', () => {
    const older = stored('old-import', file('2026-06-01', '2026-06-30', [fileRow('2026-06-15', -300), fileRow('2026-06-20', -1)]));
    const f = file('2026-06-01', '2026-06-30', [fileRow('2026-06-15', -500)]);
    const out = effectOf(syncOf(PLAID), 'inv', [older], f);
    expect(out).toMatchObject({ kind: 'takes', rows: 1, now_rows: 2, flows: { file: 500, now: 301 }, months: [{ month: '2026-06', now: 301, file: 500 }] });
  });

  test('days before Nya’s activity: nothing counted there now, said as none rather than $0.00', () => {
    const rows = PLAID.filter((t) => t.date >= '2026-03-01');
    const f = file('2026-01-01', '2026-03-31', [fileRow('2026-01-05', -50), fileRow('2026-03-10', -100)]);
    const out = effectOf(syncOf(rows, { inv: { from: '2026-03-01', through: '2026-11-10' } }), 'inv', [], f);
    expect(out).toMatchObject({ kind: 'takes', flows: { file: 150, now: 100 }, months: [{ month: '2026-01', now: null, file: 50 }] });
  });

  test('a row Nya has just outside its days that is one of the file’s, dated differently: counted once, as the file’s', () => {
    const f = file('2026-05-01', '2026-07-31', [fileRow('2026-07-30', -250, { type: 'buy', subtype: 'buy', name: 'Buy' })]);
    const out = effectOf(syncOf([...PLAID, plaidRow('settled', '2026-08-02', -250, { type: 'buy', subtype: 'buy', name: 'Buy' })]), 'inv', [], f);
    expect(out.kind === 'takes' && out.twins).toEqual([{ date: '2026-08-02', file_date: '2026-07-30', name: 'Buy', type: 'buy', subtype: 'buy', amount: -250 }]);
  });

  test('a deposit Nya dates after the file’s last day, the file’s own last row: what it counts now is said in the file row’s month, so nothing seems to change', () => {
    const f = file('2026-10-01', '2026-11-03', [fileRow('2026-10-10', -100), fileRow('2026-11-03', -500)]);
    const out = effectOf(syncOf([plaidRow('oct', '2026-10-10', -100), plaidRow('settled', '2026-11-05', -500)]), 'inv', [], f);
    expect(out).toMatchObject({ kind: 'takes', rows: 2, now_rows: 1, flows: { file: 600, now: 600 }, months: [] });
    expect(out.kind === 'takes' && out.twins.map((t) => [t.date, t.file_date])).toEqual([['2026-11-05', '2026-11-03']]);
  });

  test('an earlier import’s twins aren’t the file’s', () => {
    const older = stored('old-import', file('2026-01-01', '2026-01-31', [fileRow('2026-01-30', -250, { type: 'buy', subtype: 'buy' })]));
    const rows = [...PLAID, plaidRow('settled', '2026-02-02', -250, { type: 'buy', subtype: 'buy' })];
    const out = effectOf(syncOf(rows), 'inv', [older], file('2026-05-01', '2026-05-31', [fileRow('2026-05-12', -100)]));
    expect(out.kind === 'takes' && out.twins).toEqual([]);
  });

  test('days that don’t reach Nya’s activity: it would never be used, said with both spans', () => {
    const out = effectOf(syncOf(PLAID), 'inv', [], file('2024-01-01', '2024-02-01', [fileRow('2024-01-05', -50)]));
    expect(out).toEqual({ kind: 'unreached', covers: { from: '2024-01-01', to: '2024-02-01' }, activity: { from: '2025-01-01', through: '2026-11-10' } });
    expect(effectOf(syncOf([], {}), 'inv', [], file('2026-01-01', '2026-02-01', [fileRow('2026-01-05', -50)]))).toEqual({
      kind: 'unreached',
      covers: { from: '2026-01-01', to: '2026-02-01' },
      activity: null,
    });
  });

  test('the review’s id is never a stored import’s', () => {
    expect(REVIEW_ID).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe('what an undo hands back', () => {
  const at = (import_id: string, from: string, to: string, over: Partial<AccountImport> = {}) => stored(import_id, file(from, to, [fileRow(from, -1)]), over);

  test('no other import: every day to what Vanguard gave Nya', () => {
    expect(afterUndo([{ from: '2025-06-01', to: '2026-11-10' }], [])).toEqual([{ from: '2025-06-01', to: '2026-11-10', by: null }]);
  });

  test('an older download covering some of its days takes those; the rest go back to Vanguard’s', () => {
    expect(afterUndo([{ from: '2025-06-01', to: '2026-11-10' }], [at('older', '2025-02-03', '2026-08-01')])).toEqual([
      { from: '2025-06-01', to: '2026-08-01', by: 'older' },
      { from: '2026-08-02', to: '2026-11-10', by: null },
    ]);
  });

  test('by the same rule as every read: a CSV before a QFX, then the newer', () => {
    const csv = at('csv-old', '2026-01-01', '2026-06-30', { imported_at: '2026-01-02T00:00:00.000Z' });
    const qfx = at('qfx-new', '2026-01-01', '2026-12-31', { source: 'vanguard-qfx', imported_at: '2026-10-02T00:00:00.000Z' });
    const csvNewer = at('csv-new', '2026-03-01', '2026-04-30', { imported_at: '2026-05-02T00:00:00.000Z' });
    expect(afterUndo([{ from: '2026-01-01', to: '2026-08-31' }], [qfx, csv, csvNewer])).toEqual([
      { from: '2026-01-01', to: '2026-02-28', by: 'csv-old' },
      { from: '2026-03-01', to: '2026-04-30', by: 'csv-new' },
      { from: '2026-05-01', to: '2026-06-30', by: 'csv-old' },
      { from: '2026-07-01', to: '2026-08-31', by: 'qfx-new' },
    ]);
  });

  test('two stretches it decides, each handed back, joined where they meet', () => {
    expect(
      afterUndo(
        [
          { from: '2026-01-01', to: '2026-01-31' },
          { from: '2026-03-01', to: '2026-03-31' },
        ],
        []
      )
    ).toEqual([
      { from: '2026-01-01', to: '2026-01-31', by: null },
      { from: '2026-03-01', to: '2026-03-31', by: null },
    ]);
    expect(afterUndo([{ from: '2026-01-01', to: '2026-01-31' }, { from: '2026-02-01', to: '2026-02-10' }], [])).toEqual([{ from: '2026-01-01', to: '2026-02-10', by: null }]);
  });
});
