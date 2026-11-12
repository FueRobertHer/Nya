import { describe, expect, test } from 'bun:test';
import {
  byDeciding,
  isInvestmentImport,
  keyParts,
  MAX_ACCOUNTS_PER_IMPORT,
  parseImportsChange,
  withImportedRows,
  type AccountImport,
  type ImportedRow,
} from '@/lib/investment-imports';
import { countedTrades, type InvestmentTxn } from '@/lib/investments';
import { activityFromSync, activityWithImports, hasCurrentImports, IMPORTS_UNREADABLE } from '@/lib/investment-activity';
import type { InvSync } from '@/lib/invstore';
import { MANY_AT_ONCE } from '@/lib/repo';

// The seam joining the transactions imported for an investment account to
// the rows Plaid sent (lib/investment-imports.ts withImportedRows): the
// import that decides each day (the newest CSV, else the newest QFX), Plaid's
// rows everywhere else and again once an import is gone, the coverage joined
// only where the imports touch it, the twins at the edges, and the counted
// trades judged over each source's own rows. Then the stored shape, closed,
// and the request, every field checked.

const plaidRow = (id: string, date: string, amount: number, over: Partial<InvestmentTxn> = {}): InvestmentTxn => ({
  investment_transaction_id: id,
  account_id: 'inv',
  date,
  name: 'Plaid row',
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
const imported = (import_id: string, from: string, to: string, rows: ImportedRow[], over: Partial<AccountImport> = {}): AccountImport => ({
  account_id: 'inv',
  import_id,
  source: 'vanguard-csv',
  file_name: 'OfxDownload.csv',
  imported_at: '2026-11-11T12:00:00.000Z',
  covers: { from, to },
  currency: 'USD',
  rows,
  ...over,
});
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
const ids = (rows: InvestmentTxn[]) => rows.filter((t) => t.account_id === 'inv').map((t) => t.investment_transaction_id).sort();

/** Plaid's rows: one a month on the 10th, Jan to Oct 2026, $100 in each,
 *  and another account's row that nothing touches. */
const PLAID = [
  ...Array.from({ length: 10 }, (_, m) => plaidRow(`p${m + 1}`, `2026-${String(m + 1).padStart(2, '0')}-10`, -100)),
  plaidRow('other', '2026-06-10', -999, { account_id: 'k2' }),
];

describe('the day an import decides', () => {
  test('no imports: the sync as it was, its counted trades judged over Plaid’s rows', () => {
    const sync = syncOf(PLAID);
    const out = withImportedRows(sync, 'inv', []);
    expect(out.sync).toBe(sync);
    expect(out.counted).toEqual(countedTrades(PLAID.filter((t) => t.account_id === 'inv')));
    expect(out).toMatchObject({ decided: [], unused: [], replaced: [], twins: [] });
  });

  test('inside its days the file’s rows count and Plaid’s don’t; outside them, Plaid’s; another account’s rows as they were', () => {
    const csv = imported('csv-a', '2026-05-01', '2026-07-31', [fileRow('2026-05-12', -150), fileRow('2026-07-01', -40)]);
    const out = withImportedRows(syncOf(PLAID), 'inv', [csv]);
    expect(ids(out.sync.rows)).toEqual(['csv-a:0', 'csv-a:1', 'p1', 'p10', 'p2', 'p3', 'p4', 'p8', 'p9'].sort());
    expect(out.replaced.map((t) => t.investment_transaction_id)).toEqual(['p5', 'p6', 'p7']);
    expect(out.sync.rows.find((t) => t.investment_transaction_id === 'other')).toBe(PLAID[10]);
    expect(out.decided).toEqual([{ import_id: 'csv-a', from: '2026-05-01', to: '2026-07-31' }]);
    // The file's rows take the account's id and their own.
    expect(out.sync.rows.find((t) => t.investment_transaction_id === 'csv-a:1')).toEqual({ ...fileRow('2026-07-01', -40), investment_transaction_id: 'csv-a:1', account_id: 'inv' });
  });

  test('of two CSVs, the newer decides the days both cover, the older the rest of its own', () => {
    const older = imported('csv-old', '2026-03-01', '2026-06-30', [fileRow('2026-03-05', -1), fileRow('2026-05-05', -2)], { imported_at: '2026-10-01T00:00:00.000Z' });
    const newer = imported('csv-new', '2026-05-01', '2026-08-31', [fileRow('2026-05-06', -3), fileRow('2026-08-06', -4)]);
    for (const order of [[older, newer], [newer, older]]) {
      const out = withImportedRows(syncOf(PLAID), 'inv', order);
      expect(out.decided).toEqual([
        { import_id: 'csv-old', from: '2026-03-01', to: '2026-04-30' },
        { import_id: 'csv-new', from: '2026-05-01', to: '2026-08-31' },
      ]);
      expect(ids(out.sync.rows)).toEqual(['csv-new:0', 'csv-new:1', 'csv-old:0', 'p1', 'p10', 'p2', 'p9'].sort());
    }
  });

  test('a CSV decides over a QFX whichever is newer; the QFX only the days no CSV covers', () => {
    const csv = imported('csv-a', '2026-05-01', '2026-07-31', [fileRow('2026-05-12', -150)], { imported_at: '2026-10-01T00:00:00.000Z' });
    const qfx = imported('qfx-b', '2026-04-01', '2026-09-30', [fileRow('2026-04-12', -7), fileRow('2026-05-12', -8), fileRow('2026-09-12', -9)], { source: 'vanguard-qfx' });
    const out = withImportedRows(syncOf(PLAID), 'inv', [qfx, csv]);
    expect(out.decided).toEqual([
      { import_id: 'qfx-b', from: '2026-04-01', to: '2026-04-30' },
      { import_id: 'csv-a', from: '2026-05-01', to: '2026-07-31' },
      { import_id: 'qfx-b', from: '2026-08-01', to: '2026-09-30' },
    ]);
    expect(ids(out.sync.rows)).toEqual(['csv-a:0', 'p1', 'p10', 'p2', 'p3', 'qfx-b:0', 'qfx-b:2'].sort());
  });

  test('the order is fixed: a CSV first, then the newer, then the higher id', () => {
    const a = imported('a', '2026-01-01', '2026-01-02', [], { source: 'vanguard-qfx', imported_at: '2026-11-12T00:00:00.000Z' });
    const b = imported('b', '2026-01-01', '2026-01-02', [], { imported_at: '2026-11-01T00:00:00.000Z' });
    const c = imported('c', '2026-01-01', '2026-01-02', [], { imported_at: '2026-11-01T00:00:00.000Z' });
    const d = imported('d', '2026-01-01', '2026-01-02', [], { imported_at: '2026-11-05T00:00:00.000Z' });
    expect([a, b, c, d].sort(byDeciding).map((i) => i.import_id)).toEqual(['d', 'c', 'b', 'a']);
  });

  test('once an import is gone, Plaid’s rows count again in its days, exactly as before it', () => {
    const csv = imported('csv-a', '2026-05-01', '2026-07-31', [fileRow('2026-05-12', -150)]);
    const sync = syncOf(PLAID);
    const before = activityFromSync(sync, 'inv');
    expect(activityWithImports(sync, 'inv', [csv], 'f1').payload.flows).not.toEqual(before.flows);
    const after = activityWithImports(sync, 'inv', [], 'f2');
    expect(after).toEqual({ payload: { ...before, imported_days: [], imports_unused: [], imports_fingerprint: 'f2' }, cacheable: true });
  });

});

describe('the coverage', () => {
  test('joined where the imports touch it, reaching back and forward', () => {
    const back = imported('back', '2024-06-01', '2024-12-31', [fileRow('2024-06-03', -500)]);
    const fwd = imported('fwd', '2026-10-01', '2026-11-11', [fileRow('2026-11-11', -5)]);
    const out = withImportedRows(syncOf(PLAID), 'inv', [back, fwd]);
    expect(out.sync.coverage.inv).toEqual({ from: '2024-06-01', through: '2026-11-11' });
    expect(out.unused).toEqual([]);
    const activity = activityFromSync(out.sync, 'inv', out.counted);
    // From the oldest row, as for Plaid's (activityFromSync).
    expect(activity.flows_from).toBe('2024-06-03');
    expect(activity.flows_to).toBe('2026-11-11');
    expect(activity.flows?.[0]).toEqual({ date: '2024-06-03', amount: 500 });
  });

  test('an import whose days don’t reach Nya’s activity is said and not used, unless another bridges the gap', () => {
    const far = imported('far', '2023-01-01', '2023-12-31', [fileRow('2023-03-01', -10)]);
    const out = withImportedRows(syncOf(PLAID), 'inv', [far]);
    expect(out.unused).toEqual(['far']);
    expect(out.sync).toEqual(syncOf(PLAID));
    const bridge = imported('bridge', '2024-01-01', '2025-01-05', [fileRow('2024-02-01', -20)]);
    const joined = withImportedRows(syncOf(PLAID), 'inv', [far, bridge]);
    expect(joined.unused).toEqual([]);
    expect(joined.sync.coverage.inv).toEqual({ from: '2023-01-01', through: '2026-11-10' });
  });

  test('with no verified days for the account, nothing is used', () => {
    const csv = imported('csv-a', '2026-05-01', '2026-07-31', [fileRow('2026-05-12', -150)]);
    const sync = syncOf(PLAID, {});
    const out = withImportedRows(sync, 'inv', [csv]);
    expect(out.sync).toBe(sync);
    expect(out.unused).toEqual(['csv-a']);
  });
});

describe('the twins at the edges', () => {
  const csv = imported('csv-a', '2026-05-01', '2026-07-31', [fileRow('2026-07-30', -250), fileRow('2026-05-02', -75)]);

  test('a Plaid row up to five days outside, of the same kind and amount, is the same event: left out, one for one', () => {
    const rows = [
      ...PLAID,
      plaidRow('settled', '2026-08-03', -250), // 4 days after the file's row
      plaidRow('again', '2026-08-04', -250), // the file's row is matched already
      plaidRow('early', '2026-04-27', -75), // 5 days before
    ];
    const out = withImportedRows(syncOf(rows), 'inv', [csv]);
    expect(out.twins.map((t) => t.investment_transaction_id)).toEqual(['early', 'settled']);
    // Each with the file row it was taken for, which the review shows.
    expect(out.pairs.map((p) => [p.plaid.investment_transaction_id, p.file.investment_transaction_id])).toEqual([
      ['early', 'csv-a:1'],
      ['settled', 'csv-a:0'],
    ]);
    expect(ids(out.sync.rows)).toContain('again');
  });

  test('the nearest pairs first: of two Plaid rows near one file row, the nearer is its twin', () => {
    const one = imported('csv-a', '2026-05-01', '2026-07-31', [fileRow('2026-05-01', -75)]);
    const out = withImportedRows(syncOf([...PLAID, plaidRow('far', '2026-04-26', -75), plaidRow('near', '2026-04-30', -75)]), 'inv', [one]);
    expect(out.twins.map((t) => t.investment_transaction_id)).toEqual(['near']);
    expect(ids(out.sync.rows)).toContain('far');
  });

  test('money crossing is matched by its flow, whatever each source calls it; anything else by its type, subtype and amount', () => {
    const file = imported('csv-a', '2026-05-01', '2026-07-31', [
      fileRow('2026-07-30', -500, { subtype: 'contribution' }),
      fileRow('2026-07-29', -12.34, { subtype: 'deposit' }),
      fileRow('2026-07-28', 300, { type: 'buy', subtype: 'buy', quantity: 3, price: 100 }),
    ]);
    const rows = [
      // A paycheck Plaid books as a lone buy: the same money in as the file's cash row.
      plaidRow('paycheck', '2026-08-02', 500, { type: 'buy', subtype: 'contribution', quantity: 5, price: 100 }),
      // A dividend of the same amount as a file deposit: not the same event.
      plaidRow('dividend', '2026-08-01', -12.34, { subtype: 'dividend' }),
      // A contribution bought as shares beside the file's ordinary buy of the same amount.
      plaidRow('bought', '2026-08-01', 300, { type: 'buy', subtype: 'contribution', quantity: 3, price: 100 }),
    ];
    const out = withImportedRows(syncOf(rows), 'inv', [file]);
    expect(out.twins.map((t) => t.investment_transaction_id)).toEqual(['paycheck']);
    expect(ids(out.sync.rows)).toEqual(expect.arrayContaining(['dividend', 'bought']));
  });

  test('six days apart, another amount or another kind: kept', () => {
    const rows = [...PLAID, plaidRow('late', '2026-08-05', -250), plaidRow('cents', '2026-08-01', -250.01), plaidRow('buy', '2026-08-01', -250, { type: 'buy', subtype: 'buy' })];
    const out = withImportedRows(syncOf(rows), 'inv', [csv]);
    expect(out.twins).toEqual([]);
    expect(ids(out.sync.rows)).toEqual(expect.arrayContaining(['late', 'cents', 'buy']));
  });
});

describe('counted trades, judged over each source’s own rows', () => {
  test('a Plaid trade just outside a file’s days keeps the evidence of Plaid’s cash row the file replaces', () => {
    const cash = plaidRow('cash', '2026-06-20', -500, { subtype: 'contribution' });
    const trade = plaidRow('trade', '2026-08-01', 500, { type: 'buy', subtype: 'contribution', quantity: 5, price: 100 });
    const csv = imported('csv-a', '2026-05-01', '2026-07-31', [fileRow('2026-06-20', -500)]);
    const out = withImportedRows(syncOf([cash, trade]), 'inv', [csv]);
    const kept = out.sync.rows.find((t) => t.investment_transaction_id === 'trade')!;
    expect(kept).toBe(trade);
    // Judged over the merged rows alone, the trade would count: its cash row is gone.
    expect(countedTrades(out.sync.rows).has(kept)).toBe(true);
    expect(out.counted.has(kept)).toBe(false);
  });

  test('a file’s trade is judged over the file’s rows, not Plaid’s', () => {
    const cash = plaidRow('cash', '2026-08-10', -500, { subtype: 'contribution' });
    const csv = imported('csv-a', '2026-05-01', '2026-07-31', [fileRow('2026-07-25', 500, { type: 'buy', subtype: 'contribution', quantity: 5, price: 100 })]);
    const out = withImportedRows(syncOf([cash]), 'inv', [csv]);
    const fileTrade = out.sync.rows.find((t) => t.investment_transaction_id === 'csv-a:0')!;
    expect(out.counted.has(fileTrade)).toBe(true);
    expect(activityFromSync(out.sync, 'inv', out.counted).flows).toEqual([
      { date: '2026-07-25', amount: 500 },
      { date: '2026-08-10', amount: 500 },
    ]);
  });
});

describe('the activity both routes answer', () => {
  test('imports that can’t be read: Plaid’s activity alone, said, and not cached', () => {
    const sync = syncOf(PLAID);
    const out = activityWithImports(sync, 'inv', null, 'f1');
    expect(out.cacheable).toBe(false);
    expect(out.payload.note).toBe(IMPORTS_UNREADABLE);
    expect(out.payload.flows).toEqual(activityFromSync(sync, 'inv').flows);
  });

  test('a cached copy counts only under the same imports', () => {
    expect(hasCurrentImports({ imports_fingerprint: 'f1' }, 'f1')).toBe(true);
    expect(hasCurrentImports({ imports_fingerprint: 'f1' }, 'f2')).toBe(false);
    expect(hasCurrentImports({}, 'none')).toBe(false);
  });

  test('what decides, and what isn’t used, are said', () => {
    const csv = imported('csv-a', '2026-05-01', '2026-07-31', []);
    const far = imported('far', '2020-01-01', '2020-01-31', []);
    expect(activityWithImports(syncOf(PLAID), 'inv', [csv, far], 'f1').payload).toMatchObject({
      imported_days: [{ import_id: 'csv-a', from: '2026-05-01', to: '2026-07-31' }],
      imports_unused: ['far'],
      imports_fingerprint: 'f1',
    });
  });
});

describe('the stored shape, closed', () => {
  const { account_id: _a, import_id: _i, ...stored } = imported('x', '2026-05-01', '2026-07-31', [fileRow('2026-05-12', -150)]);

  test('an import as written', () => {
    expect(isInvestmentImport(stored)).toBe(true);
    expect(isInvestmentImport({ ...stored, source: 'vanguard-qfx', file_name: null, currency: null })).toBe(true);
  });

  const refused: [string, unknown][] = [
    ['a field it doesn’t know', { ...stored, basis: 1 }],
    ['no rows: a restore would never bring it back', { ...stored, rows: [] }],
    ['a field missing', { ...stored, currency: undefined }],
    ['another source', { ...stored, source: 'fidelity-csv' }],
    ['days the wrong way round', { ...stored, covers: { from: '2026-08-01', to: '2026-07-31' } }],
    ['a day that isn’t one', { ...stored, covers: { from: '2026-02-30', to: '2026-07-31' } }],
    ['a row outside its days', { ...stored, rows: [fileRow('2026-08-01', -1)] }],
    ['a row with a field it doesn’t know', { ...stored, rows: [{ ...fileRow('2026-05-12', -1), line: 3 }] }],
    ['a row of another type', { ...stored, rows: [fileRow('2026-05-12', -1, { type: 'cancel' })] }],
    ['a row with no amount', { ...stored, rows: [fileRow('2026-05-12', Number.NaN)] }],
    ['an instant that isn’t one', { ...stored, imported_at: 'yesterday' }],
    ['an instant not written as Nya writes one', { ...stored, imported_at: 'Wed, 11 Nov 2026 12:00:00 GMT' }],
  ];
  for (const [what, value] of refused) test(`refused: ${what}`, () => expect(isInvestmentImport(value)).toBe(false));

  test('a key is an account’s and an import’s, split at its last colon', () => {
    expect(keyParts('acc_1:3f2c')).toEqual({ account_id: 'acc_1', import_id: '3f2c' });
    expect(keyParts('a:b:c')).toEqual({ account_id: 'a:b', import_id: 'c' });
    expect(keyParts('nocolon')).toBeNull();
    expect(keyParts(':x')).toBeNull();
    expect(keyParts('x:')).toBeNull();
  });

  test('one import’s accounts fit one atomic write', () => {
    expect(MAX_ACCOUNTS_PER_IMPORT).toBe(MANY_AT_ONCE);
  });
});

describe('the request', () => {
  const body = (over: Record<string, unknown> = {}) => ({ action: 'import' as const, account_id: 'inv', file_name: 'OfxDownload.csv', text: 'x', today: '2026-11-12', take: [{ account_id: 'inv', mask: '4421' }], counting: 'none', ...over });

  test('a review, an import and an undo, as sent', () => {
    const review = { action: 'review' as const, account_id: 'inv', file_name: 'OfxDownload.csv', text: 'x', today: '2026-11-12' };
    expect(parseImportsChange(review)).toEqual(review);
    expect(parseImportsChange({ ...review, take: [] })).toMatch(/take isn’t part of a review/);
    expect(parseImportsChange(body())).toEqual(body());
    expect(parseImportsChange({ action: 'undo', account_id: 'inv', import_id: 'abcdefgh-1' })).toEqual({ action: 'undo', account_id: 'inv', import_id: 'abcdefgh-1' });
  });

  const cases: [string, unknown, RegExp][] = [
    ['an array', [], /JSON/],
    ['no account', { action: 'undo', import_id: 'abcdefgh' }, /account id/],
    ['__proto__', body({ account_id: '__proto__' }), /account id/],
    ['no action', { account_id: 'inv' }, /import or undo/],
    ['an extra field', body({ rows: [] }), /rows isn’t part of an import/],
    ['no text', body({ text: '' }), /file’s text/],
    ['today not a day', body({ today: '2026-11-31' }), /today/],
    ['no accounts', body({ take: [] }), /at least one account/],
    ['too many accounts', body({ take: Array.from({ length: 17 }, (_, n) => ({ account_id: `a${n}`, mask: String(1000 + n) })) }), /At most 16/],
    ['an account twice', body({ take: [{ account_id: 'inv', mask: '4421' }, { account_id: 'inv', mask: '3307' }] }), /Each account once/],
    ['a mask twice', body({ take: [{ account_id: 'inv', mask: '4421' }, { account_id: 'roth', mask: '4421' }] }), /file’s accounts once/],
    ['a mask that isn’t four digits', body({ take: [{ account_id: 'inv', mask: '442' }] }), /last four digits/],
    ['an account with more', body({ take: [{ account_id: 'inv', mask: '4421', name: 'x' }] }), /its id and the last four digits/],
    ['no fingerprint', body({ counting: null }), /checked against/],
    ['an undo with more', { action: 'undo', account_id: 'inv', import_id: 'abcdefgh', text: 'x' }, /alone/],
    ['an undo id that isn’t one', { action: 'undo', account_id: 'inv', import_id: 'a b' }, /import id/],
  ];
  for (const [what, value, words] of cases) {
    test(`refused: ${what}`, () => {
      const out = parseImportsChange(value);
      expect(typeof out).toBe('string');
      expect(out as string).toMatch(words);
    });
  }
});
