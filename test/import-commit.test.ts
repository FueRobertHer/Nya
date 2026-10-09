import { describe, expect, test } from 'bun:test';
import { accountMismatch, planImport, statementBalance } from '@/lib/import/commit';
import { isImportEntry, isImportId, isImportSettings, isImportSummary, newImportId, summaryOf, type ImportEntry } from '@/lib/import/store';
import { normalizeRecords } from '@/lib/import/normalize';
import type { ManualTxnBook } from '@/lib/manual-txns';
import { readImport } from '@/lib/import/read';
import { MAX_FILE_BYTES } from '@/lib/import/record';
import type { StatementInfo } from '@/lib/import/read';
import type { RawRecord } from '@/lib/import/record';

// The commit stage's pure parts (lib/import/commit.ts): what an import would
// do against a book, when a statement's balance may be set, a statement for
// another account, and the shapes the import stores keep
// (lib/import/store.ts). The writes themselves are test/import-routes.test.ts.

const statement = (over: Partial<StatementInfo> = {}): StatementInfo => ({
  index: 0,
  label: 'Checking ending 4567',
  kind: 'bank',
  account: { bank_id: '325081403', mask: '4567', type: 'CHECKING' },
  currency: 'USD',
  start: '2026-09-01',
  end: '2026-09-30',
  count: 3,
  ledger: { amount: 1946.05, as_of: '2026-10-08' },
  ...over,
});
const TODAY = '2026-10-09';
const rec = (over: Partial<RawRecord>): RawRecord => ({ source: 'csv', date: '2026-09-01', amount: 1, description: 'X', raw: [], line: 2, ...over });
const checking = { type: 'depository' as const, balance: 1000 };
const card = { type: 'credit' as const, balance: 500 };

describe('a statement’s balance', () => {
  test('offered for a statement dated today, yesterday or tomorrow, from the balance the account has now', () => {
    for (const as_of of ['2026-10-08', '2026-10-09', '2026-10-10']) {
      expect(statementBalance(checking, statement({ ledger: { amount: 1946.05, as_of } }), TODAY)).toEqual({ amount: 1946.05, as_of, from: 1000, refusal: null });
    }
  });

  test('only shown otherwise, with the reason: older, further ahead, undated, another currency, the other kind of account', () => {
    const refusal = (acct: typeof checking | typeof card, s: Partial<StatementInfo>) => statementBalance(acct, statement(s), TODAY)?.refusal;
    expect(refusal(checking, { ledger: { amount: 1, as_of: '2026-10-07' } })).toBe('past');
    expect(refusal(checking, { ledger: { amount: 1, as_of: '2026-10-11' } })).toBe('ahead');
    expect(refusal(checking, { ledger: { amount: 1, as_of: null } })).toBe('undated');
    expect(refusal(checking, { currency: 'EUR' })).toBe('currency');
    expect(refusal(checking, { kind: 'creditcard' })).toBe('kind');
    expect(refusal(card, {})).toBe('kind');
    expect(refusal({ type: 'investment', balance: 0 } as never, {})).toBe('kind');
    expect(refusal(checking, { ledger: { amount: 2e12, as_of: TODAY } })).toBe('too-large');
    expect(statementBalance(checking, statement({ ledger: null }), TODAY)).toBeNull();
    expect(statementBalance(checking, null, TODAY)).toBeNull();
  });

  test('a card’s balance is negative while money is owed, and the account keeps what is owed as a positive amount', () => {
    const owed = statement({ kind: 'creditcard', account: { bank_id: null, mask: '4321', type: null }, ledger: { amount: -1234.56, as_of: TODAY } });
    expect(statementBalance(card, owed, TODAY)).toEqual({ amount: 1234.56, as_of: TODAY, from: 500, refusal: null });
    // A card in credit would be a negative amount owed, which counts as money held.
    const credit = statement({ kind: 'creditcard', ledger: { amount: 25, as_of: TODAY } });
    expect(statementBalance(card, credit, TODAY)).toMatchObject({ amount: -25, refusal: 'owed-negative' });
    // Paid off exactly: zero owed, never "-0".
    expect(Object.is(statementBalance(card, statement({ kind: 'creditcard', ledger: { amount: 0, as_of: TODAY } }), TODAY)!.amount, 0)).toBe(true);
  });
});

describe('a statement for another account', () => {
  const remembered = { kind: 'bank' as const, bank_id: '325081403', mask: '4567', type: 'CHECKING' };

  test('the same bank, kind, type and last four is the same account; anything else is named', () => {
    expect(accountMismatch(remembered, statement())).toBeNull();
    expect(accountMismatch(remembered, statement({ account: { bank_id: '325081403', mask: '9999', type: 'CHECKING' } }))).toEqual({
      expected: 'an account ending 4567 at bank 325081403',
      found: 'an account ending 9999 at bank 325081403',
    });
    expect(accountMismatch(remembered, statement({ kind: 'creditcard', account: { bank_id: null, mask: '4567', type: null } }))?.found).toBe('a credit card ending 4567');
    expect(accountMismatch(remembered, statement({ account: { ...remembered, type: 'SAVINGS' } }))).not.toBeNull();
  });

  test('nothing to compare with is no mismatch: a first import, or a file without an account', () => {
    expect(accountMismatch(null, statement())).toBeNull();
    expect(accountMismatch(undefined, statement())).toBeNull();
    expect(accountMismatch(remembered, statement({ account: null }))).toBeNull();
    expect(accountMismatch(remembered, null)).toBeNull();
  });
});

describe('planning an import', () => {

  test('counts, the days covered, the main currency, and the new rows’ money out and in, in it', () => {
    const { rows, problems } = normalizeRecords(
      [
        rec({ amount: 12.5, date: '2026-09-03', line: 2 }),
        rec({ amount: -100, date: '2026-09-01', description: 'Pay', line: 3 }),
        rec({ amount: 7, currency: 'EUR', date: '2026-09-09', line: 4 }),
        rec({ amount: 0.1, line: 5, description: 'Y' }),
        rec({ amount: 0.2, line: 6, description: 'Z' }),
        rec({ amount: 0, line: 7 }),
      ],
      { today: '2026-10-09', currency: 'USD' }
    );
    const plan = planImport(rows, problems, null);
    expect(plan.counts).toEqual({ new: 5, present: 0, repeated: 0, replaced: 0, skipped: 0, conflicts: 0, unreadable: 1 });
    expect(plan).toMatchObject({ first_date: '2026-09-01', last_date: '2026-09-09', currency: 'USD', others: [{ currency: 'EUR', count: 1 }] });
    // Summed to the cent, never 12.799999...
    expect(plan.totals).toEqual({ out: 12.8, in: 100 });
    expect(plan.problems).toEqual([{ line: 7, reason: 'Its amount is zero.', raw: [] }]);
  });

  test('nothing read is nothing to plan', () => {
    expect(planImport([], [], null)).toMatchObject({ counts: { new: 0, present: 0, repeated: 0, unreadable: 0 }, first_date: null, currency: null });
  });

  test('totals are rounded to their currency’s own minor unit: three decimals in dinars, none in yen', () => {
    const plan = (currency: string, amounts: number[]) =>
      planImport(normalizeRecords(amounts.map((amount, i) => ({ ...rec({ amount, currency, line: i + 2 }), description: `R${i}` })), { today: '2026-10-09', currency }).rows, [], null).totals;
    expect(plan('KWD', [1.001, 2.002, -0.333])).toEqual({ out: 3.003, in: 0.333 });
    expect(plan('JPY', [1200, 34])).toEqual({ out: 1234, in: 0 });
    expect(plan('USD', [0.1, 0.2])).toEqual({ out: 0.3, in: 0 });
  });

  test('what the file marks as a transfer, a payment, cash out or a bank fee is counted, for the preview to say', () => {
    const { rows } = normalizeRecords(
      [
        rec({ source: 'ofx', source_id: 'A', description: 'To savings', category: 'transfer out', line: 2 }),
        rec({ source: 'ofx', source_id: 'B', description: 'ATM', category: 'transfer out', transaction_code: 'atm', line: 3 }),
        rec({ source: 'ofx', source_id: 'C', description: 'Card payment', amount: -100, category: 'loan payments', line: 4 }),
        rec({ source: 'ofx', source_id: 'D', description: 'Fee', amount: 3, category: 'bank fees', line: 5 }),
        rec({ source: 'ofx', source_id: 'E', description: 'Coffee', line: 6 }),
      ],
      { today: '2026-10-09', currency: 'USD' }
    );
    expect(planImport(rows, [], null).kinds).toEqual({ transfers: 1, atm: 1, payments: 1, fees: 1 });
  });
});

describe('conflicts: a FITID on another stored transaction', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const ofxRow = (source_id: string, date: string, amount: number, description: string, line: number) => rec({ source: 'ofx', source_id, date, amount, description, line });
  /** A book holding one row imported from an OFX file, under FITID P1. */
  const book: ManualTxnBook = {
    version: 1,
    rows: [{ id: 'manual-txn:stored-1', account_id: 'manual_a', date: '2026-09-01', amount: 50, currency: 'USD', name: 'BISTRO', category: null, note: null, source: 'import:ofx', source_id: 'P1', created_at: at, updated_at: at }],
  };
  const incoming = (amount: number, date = '2026-09-03', description = 'BISTRO') => normalizeRecords([ofxRow('P1', date, amount, description, 7)], { today: '2026-10-09', currency: 'USD' }).rows;

  test('listed with both versions and what differs; one without an answer waits for one', () => {
    const plan = planImport(incoming(60), [], book);
    expect(plan.counts).toEqual({ new: 0, present: 0, repeated: 0, replaced: 0, skipped: 0, conflicts: 1, unreadable: 0 });
    expect(plan.actions).toEqual(['ask']);
    expect(plan.conflicts).toEqual([
      {
        index: 0,
        line: 7,
        row_id: 'manual-txn:stored-1',
        differs: { name: false, amount: true, date: true },
        suggested: null,
        choice: null,
        file: { date: '2026-09-03', name: 'BISTRO', amount: 60, currency: 'USD' },
        stored: { date: '2026-09-01', name: 'BISTRO', amount: 50, currency: 'USD' },
      },
    ]);
  });

  test('the answer for every conflict, or one for each by its place, which wins', () => {
    expect(planImport(incoming(60), [], book, { all: 'new' })).toMatchObject({ counts: { new: 1, conflicts: 0 }, actions: ['add'] });
    expect(planImport(incoming(60), [], book, { all: 'replace' })).toMatchObject({ counts: { replaced: 1, conflicts: 0 }, actions: ['replace'] });
    expect(planImport(incoming(60), [], book, { all: 'new', each: { '0': 'skip' } })).toMatchObject({ counts: { new: 0, skipped: 1, conflicts: 0 }, actions: ['none'] });
    // A choice for a row that isn't a conflict changes nothing.
    expect(planImport(incoming(50, '2026-09-02'), [], book, { each: { '0': 'new' } })).toMatchObject({ counts: { present: 1, new: 0 }, actions: ['none'] });
  });

  test('nothing alike but the FITID: imported as new unless the person says otherwise', () => {
    const plan = planImport(incoming(9.99, '2026-09-20', 'NETFLIX'), [], book);
    expect(plan.conflicts[0]).toMatchObject({ suggested: 'new', choice: 'new' });
    expect(plan.counts).toMatchObject({ new: 1, conflicts: 0 });
    expect(planImport(incoming(9.99, '2026-09-20', 'NETFLIX'), [], book, { all: 'skip' }).counts).toMatchObject({ new: 0, skipped: 1 });
  });
});

describe('what the import stores keep', () => {
  const entry = {
    version: 1,
    account_id: 'manual_a',
    format: 'csv',
    source: 'import:csv',
    file_name: null,
    file_bytes: 120,
    encoding: 'utf-8',
    imported_at: '2026-10-09T12:00:00.000Z',
    currency: 'USD',
    first_date: '2026-09-01',
    last_date: '2026-09-02',
    counts: { imported: 1, present: 0, repeated: 0, unreadable: 1 },
    read: { options: {} },
    statement: null,
    columns: ['Date', 'Description', 'Amount'],
    records: [
      { line: 2, outcome: 'imported', row_id: 'manual-txn:x', raw: ['2026-09-01', 'A', '-1'] },
      { line: 3, outcome: 'unreadable', reason: 'It has no date.', raw: ['', 'B', '-2'] },
    ],
  };

  test('an entry reads in the shape written, and with fields a later release adds', () => {
    expect(isImportEntry(entry)).toBe(true);
    expect(isImportEntry({ ...entry, added_later: { x: 1 } })).toBe(true);
    expect(isImportEntry({ ...entry, balance_update: { from: 1, to: 2, as_of: '2026-10-09' } })).toBe(true);
  });

  test('a replaced row keeps how it was before; a skipped row the stored row it was skipped beside', () => {
    const before = { date: '2026-09-01', amount: 50, currency: 'USD', name: 'BISTRO', category: null, note: null, transaction_code: null };
    expect(isImportEntry({ ...entry, counts: { ...entry.counts, replaced: 1, skipped: 1 }, records: [...entry.records, { line: 4, outcome: 'replaced', row_id: 'manual-txn:y', before, raw: [] }, { line: 5, outcome: 'skipped', row_id: 'manual-txn:z', reason: 'Skipped.', raw: [] }] })).toBe(true);
    // Replaced without what it was is no record anyone could undo.
    expect(isImportEntry({ ...entry, records: [{ line: 4, outcome: 'replaced', row_id: 'manual-txn:y', raw: [] }] })).toBe(false);
    expect(isImportEntry({ ...entry, records: [{ line: 4, outcome: 'replaced', row_id: 'manual-txn:y', before: { ...before, amount: 'fifty' }, raw: [] }] })).toBe(false);
  });

  test('an entry’s summary: what the list shows, without the records', () => {
    const summary = summaryOf(entry as ImportEntry);
    expect(summary).toEqual({
      version: 1,
      account_id: 'manual_a',
      format: 'csv',
      file_name: null,
      imported_at: '2026-10-09T12:00:00.000Z',
      currency: 'USD',
      first_date: '2026-09-01',
      last_date: '2026-09-02',
      counts: { imported: 1, present: 0, repeated: 0, unreadable: 1 },
      statement: null,
      balance_update: null,
    });
    expect(isImportSummary(summary)).toBe(true);
    expect(isImportSummary({ ...summary, taken_over: 2 })).toBe(true);
    expect(summaryOf(entry as ImportEntry, 3).taken_over).toBe(3);
    for (const bad of [{ ...summary, version: 2 }, { ...summary, counts: { imported: 1 } }, { ...summary, taken_over: -1 }, { ...summary, imported_at: 'soon' }]) expect(isImportSummary(bad)).toBe(false);
  });

  test('anything else is unrecognised, never read as an import', () => {
    for (const bad of [
      { ...entry, version: 2 },
      { ...entry, format: 'xls' },
      { ...entry, counts: { imported: -1, present: 0, repeated: 0, unreadable: 0 } },
      { ...entry, records: [{ line: 2, outcome: 'maybe', raw: [] }] },
      { ...entry, records: [{ line: 2, outcome: 'imported' }] },
      { ...entry, imported_at: 'yesterday' },
      { ...entry, columns: [1] },
      null,
      [],
    ]) {
      expect(isImportEntry(bad), JSON.stringify(bad)?.slice(0, 80)).toBe(false);
    }
  });

  test('settings: each format’s part optional, and checked when there', () => {
    const at = '2026-10-09T12:00:00.000Z';
    expect(isImportSettings({ version: 1, updated_at: at })).toBe(true);
    expect(
      isImportSettings({
        version: 1,
        updated_at: at,
        csv: { columns: { date: 'Date' }, sign: 'negative-out', decimal: null, date_order: 'dmy', delimiter: ';', currency: 'EUR' },
        ofx: { statement: { kind: 'bank', bank_id: null, mask: '1234', type: 'CHECKING' }, flip: false },
        qif: { date_order: null, decimal: '.', flip: true, currency: 'USD' },
      })
    ).toBe(true);
    expect(isImportSettings({ version: 1, updated_at: at, csv: { columns: { date: 3 }, sign: 'negative-out', decimal: null, date_order: null, delimiter: ',', currency: 'USD' } })).toBe(false);
    expect(isImportSettings({ version: 1, updated_at: at, ofx: { statement: null, flip: 'no' } })).toBe(false);
    expect(isImportSettings({ version: 1 })).toBe(false);
  });

  test('ids are random and say nothing about the file', () => {
    const a = newImportId();
    expect(isImportId(a)).toBe(true);
    expect(a).not.toBe(newImportId());
    expect(isImportId('import:../../etc')).toBe(false);
    expect(isImportId('manual_x')).toBe(false);
  });
});

describe('the largest records a file can make', () => {
  test('a 3 MB file of control characters, which JSON writes six times over, still keeps its records within the ceiling', async () => {
    process.env.PLAID_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const { encodeJsonText, maxBlobChars } = await import('@/lib/blob');
    const day = (i: number) => new Date(Date.UTC(2023, 0, 1) + Math.floor(i / 7) * 86_400_000).toISOString().slice(0, 10);
    let seed = 7;
    const control = (n: number) => {
      let s = '';
      for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const c = seed % 32;
        s += String.fromCharCode(c === 10 || c === 13 ? 1 : c);
      }
      return s;
    };
    const per = Math.floor((MAX_FILE_BYTES - 1000) / 10_000);
    let csv = 'Date,Description,Amount,Junk\n';
    for (let i = 0; i < 10_000; i++) csv += `${day(i)},R${i},-1.00,${control(per - 30)}\n`;
    const r = readImport(csv.slice(0, MAX_FILE_BYTES), { options: { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' } }, thisYear: 2026 });
    if (r.status !== 'ready') throw new Error(r.status);
    const { rows } = normalizeRecords(r.records, { today: TODAY, currency: 'USD' });
    expect(rows.length).toBeGreaterThan(9_000);
    // As the entry keeps them: every record's raw cells, with its row id.
    const json = JSON.stringify({ version: 1, records: rows.map((x) => ({ line: x.line, outcome: 'imported', row_id: `manual-txn:${crypto.randomUUID()}`, raw: x.record.raw })) });
    expect(json.length).toBeGreaterThan(15_000_000);
    expect((await encodeJsonText(json)).length).toBeLessThan(maxBlobChars());
  });
});
