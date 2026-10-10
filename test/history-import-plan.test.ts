import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planHistoryImport, type PlanHeld } from '@/lib/history-import/plan';
import { bankKey, type BankRow } from '@/lib/history-import/match';
import { normalizeRecords } from '@/lib/import/normalize';
import { readImport } from '@/lib/import/read';
import type { RawRecord } from '@/lib/import/record';

// What importing a file into a linked account would do (lib/history-import/
// plan.ts): rows an earlier import kept are found exactly (an OFX file
// imported again adds nothing), rows like the bank's own are proposals with
// a confidence and never merged without an answer, and the review's key
// changes when anything it showed would.

const TODAY = '2026-10-09';
const rec = (over: Partial<RawRecord>): RawRecord => ({ source: 'csv', date: '2026-09-01', amount: 1, description: 'X', raw: [], line: 2, ...over });
const rows = (records: RawRecord[], currency = 'USD') => normalizeRecords(records, { today: TODAY, currency });
const bank = (over: Partial<BankRow> & { transaction_id: string }): BankRow => ({
  account_id: 'acct_chk',
  date: '2026-09-01',
  amount: 1,
  currency: 'USD',
  name: 'X',
  merchant_name: null,
  pending: false,
  ...over,
});

/** The rows an import kept, as stored rows, from a plan's adds. */
function keptFrom(plan: ReturnType<typeof planHistoryImport>, import_id: string): PlanHeld[] {
  const out: PlanHeld[] = [];
  plan.rows.forEach((r, i) => {
    const action = plan.actions[i];
    if (action !== 'add' && action !== 'duplicate') return;
    const pair = plan.pairs.get(i);
    out.push({
      id: `imported-txn:${import_id}-${i}`,
      import_id,
      date: r.row.date,
      amount: r.row.amount,
      currency: r.row.currency,
      name: r.row.name,
      source: r.row.source,
      source_id: r.row.source_id,
      ...(r.row.source_key ? { source_key: r.row.source_key } : {}),
      ...(pair && action === 'duplicate' ? { same_as: bankKey(pair.bank) } : {}),
      ...(pair && action === 'add' ? { distinct_from: [bankKey(pair.bank)] } : {}),
    });
  });
  return out;
}

const plan = (input: { records: RawRecord[]; held?: PlanHeld[]; banks?: BankRow[]; choices?: Parameters<typeof planHistoryImport>[0]['choices']; bankFrom?: string | null }) => {
  const { rows: normalized, problems } = rows(input.records);
  return planHistoryImport({
    rows: normalized,
    problems,
    held: input.held ?? [],
    banks: input.banks ?? [],
    order: ['history-import:a', 'history-import:b'],
    bankFrom: input.bankFrom ?? null,
    choices: input.choices,
  });
};

describe('against an earlier import of the same account', () => {
  test('an OFX file imported again is exactly what is there, by FITID: nothing is added', () => {
    const ofx = readFileSync(join(import.meta.dir, 'fixtures', 'import', 'checking-ofx102.ofx'), 'latin1');
    const read = readImport(ofx, { options: {}, thisYear: 2026 });
    if (read.status !== 'ready') throw new Error(read.status);
    const first = planHistoryImport({ ...rows(read.records), held: [], banks: [], order: [], bankFrom: null });
    expect(first.counts.new).toBeGreaterThan(0);
    const kept = keptFrom(first, 'a');
    const again = planHistoryImport({ ...rows(read.records), held: kept, banks: [], order: ['history-import:a'], bankFrom: null });
    expect(again.counts).toMatchObject({ new: 0, duplicates: 0, present: first.counts.new + first.counts.duplicates });
    expect(again.actions.every((a) => a === 'none')).toBe(true);
  });

  test('so is a row the earlier import kept as the bank’s duplicate: it is found, not proposed again', () => {
    const banks = [bank({ transaction_id: 'b1', date: '2026-09-02', amount: 40 })];
    const records = [rec({ source: 'ofx', source_id: 'F1', amount: 40, date: '2026-09-01' })];
    const first = plan({ records, banks });
    expect(first.actions).toEqual(['duplicate']);
    const again = plan({ records, banks, held: keptFrom(first, 'a') });
    expect(again.counts).toMatchObject({ present: 1, duplicates: 0, new: 0 });
    expect(again.proposals).toEqual([]);
  });

  test('a FITID on another transaction is a conflict to answer: new or skip, suggested new only when nothing else is alike', () => {
    const held: PlanHeld[] = [
      { id: 'imported-txn:1', import_id: 'history-import:a', date: '2026-01-01', amount: 5, currency: 'USD', name: 'Alpha', source: 'import:ofx', source_id: '1' },
    ];
    const records = [rec({ source: 'ofx', source_id: '1', amount: 70, date: '2026-09-01', description: 'Beta' })];
    const first = plan({ records, held });
    expect(first.conflicts).toEqual([expect.objectContaining({ row_id: 'imported-txn:1', suggested: 'new', choice: 'new' })]);
    expect(first.actions).toEqual(['add']);
    const skipped = plan({ records, held, choices: { conflicts: { all: 'skip' } } });
    expect(skipped.actions).toEqual(['none']);
    expect(skipped.counts.skipped).toBe(1);
    // Only the amount differs: no suggestion, and the import waits for it.
    const alike = plan({ records: [rec({ source: 'ofx', source_id: '1', amount: 70, date: '2026-01-01', description: 'Alpha' })], held });
    expect(alike.actions).toEqual(['ask']);
    expect(alike.counts.conflicts).toBe(1);
  });
});

describe('against the bank’s own rows', () => {
  test('a CSV overlapping the bank’s window gives proposals with the bank’s row beside each, never a silent merge', () => {
    const banks = [
      bank({ transaction_id: 'rent', date: '2026-09-01', amount: 1850, name: 'ZELLE TO LANDLORD', merchant_name: null }),
      bank({ transaction_id: 'coffee', date: '2026-09-05', amount: 4.5, name: 'SQ *BLUE BOTTLE', merchant_name: 'Blue Bottle Coffee' }),
    ];
    const p = plan({
      bankFrom: '2026-08-01',
      banks,
      records: [
        rec({ date: '2026-09-01', amount: 1850, description: 'Online transfer to landlord', line: 2 }),
        rec({ date: '2026-09-03', amount: 4.5, description: 'BLUE BOTTLE COFFEE OAKLAND', line: 3 }),
        rec({ date: '2026-07-15', amount: 22, description: 'Old purchase', line: 4 }),
      ],
    });
    expect(p.proposals.map((x) => [x.index, x.bank.transaction_id, x.days, x.confidence, x.choice])).toEqual([
      [0, 'rent', 0, 'high', 'same'],
      [1, 'coffee', 2, 'high', 'same'],
    ]);
    expect(p.proposals[1].bank).toMatchObject({ name: 'Blue Bottle Coffee', descriptor: 'SQ *BLUE BOTTLE', date: '2026-09-05', amount: 4.5 });
    expect(p.actions).toEqual(['duplicate', 'duplicate', 'add']);
    expect(p.counts).toMatchObject({ new: 1, duplicates: 2 });
    expect([p.before_bank, p.within_bank]).toEqual([1, 0]);
  });

  test('a low-confidence proposal has no answer until the person gives it, and the import waits', () => {
    const banks = [bank({ transaction_id: 'b', date: '2026-09-06', amount: 60, name: 'SHELL OIL 5544' })];
    const records = [rec({ date: '2026-09-01', amount: 60, description: 'GROCERY OUTLET' })];
    const p = plan({ records, banks });
    expect(p.proposals).toEqual([expect.objectContaining({ confidence: 'low', choice: null })]);
    expect(p.actions).toEqual(['ask']);
    expect(p.counts.unanswered).toBe(1);
    const answered = plan({ records, banks, choices: { proposals: { each: { '0': 'new' } } } });
    expect(answered.actions).toEqual(['add']);
    expect(plan({ records, banks, choices: { proposals: { all: 'same' } } }).actions).toEqual(['duplicate']);
  });

  test('a choice for one proposal never changes another, nor the review’s key', () => {
    const banks = [bank({ transaction_id: 'a', amount: 10 }), bank({ transaction_id: 'b', amount: 20 })];
    const records = [rec({ amount: 10 }), rec({ amount: 20, line: 3 })];
    const base = plan({ records, banks });
    const chosen = plan({ records, banks, choices: { proposals: { each: { '0': 'new' } } } });
    expect(chosen.actions).toEqual(['add', 'duplicate']);
    expect(chosen.review).toBe(base.review);
  });

  test('the review’s key changes when the bank sends a row the review didn’t see', () => {
    const records = [rec({ amount: 10 })];
    const before = plan({ records, banks: [] });
    const after = plan({ records, banks: [bank({ transaction_id: 'arrived', amount: 10 })] });
    expect(after.review).not.toBe(before.review);
  });

  test('a bank row an earlier import already claimed, or that already supersedes one of its rows, is no proposal', () => {
    const b = bank({ transaction_id: 'b', amount: 10 });
    const claimed: PlanHeld = { id: 'imported-txn:c', import_id: 'history-import:a', date: '2026-09-01', amount: 10, currency: 'USD', name: 'Claims it', source: 'import:csv', source_id: 'k1', same_as: bankKey(b) };
    expect(plan({ records: [rec({ amount: 10, description: 'Other words' })], banks: [b], held: [claimed] }).proposals).toEqual([]);
    const superseded: PlanHeld = { ...claimed, same_as: undefined, source_id: 'k2' };
    expect(plan({ records: [rec({ amount: 10, description: 'Other words' })], banks: [b], held: [superseded] }).proposals).toEqual([]);
  });

  test('a row whose only look-alike at the bank is pending is new, and said so', () => {
    const p = plan({ records: [rec({ amount: 33 })], banks: [bank({ transaction_id: 'p', amount: 33, pending: true })] });
    expect(p.actions).toEqual(['add']);
    expect(p.pending_alike).toBe(1);
    expect(p.proposals).toEqual([]);
  });
});

describe('signs and days, as each format writes them', () => {
  test('a card statement’s purchases are negative in OFX and money out in Plaid’s sign: they match the card’s own rows', () => {
    const ofx = readFileSync(join(import.meta.dir, 'fixtures', 'import', 'card-ofx220.ofx'), 'utf8');
    const read = readImport(ofx, { options: {}, thisYear: 2026 });
    if (read.status !== 'ready') throw new Error(read.status);
    const { rows: normalized, problems } = rows(read.records);
    const joe = normalized.find((r) => r.row.name.startsWith('TRADER JOE'))!;
    expect(joe.row.amount).toBe(87.2);
    const payment = normalized.find((r) => r.row.name.startsWith('PAYMENT'))!;
    expect(payment.row.amount).toBe(-500);
    const banks = [
      bank({ transaction_id: 'tj', account_id: 'acct_card', date: '2026-09-02', amount: 87.2, name: "TRADER JOE'S #123" }),
      bank({ transaction_id: 'pay', account_id: 'acct_card', date: '2026-09-15', amount: -500, name: 'PAYMENT THANK YOU' }),
    ];
    const p = planHistoryImport({ rows: normalized, problems, held: [], banks, order: [], bankFrom: '2026-01-01' });
    expect(p.proposals.map((x) => [x.bank.transaction_id, x.days, x.confidence]).sort()).toEqual([
      ['pay', 0, 'high'],
      ['tj', 0, 'high'],
    ]);
  });

  test('a CSV that writes money out as negative reads in Plaid’s sign, and matches the bank’s row', () => {
    const csv = 'Date,Description,Amount\n2026-09-03,COSTCO WHSE #0012,-123.45\n2026-09-04,PAYROLL,2500.00\n';
    const read = readImport(csv, { options: { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' } }, thisYear: 2026 });
    if (read.status !== 'ready') throw new Error(read.status);
    const { rows: normalized, problems } = rows(read.records);
    expect(normalized.map((r) => r.row.amount)).toEqual([123.45, -2500]);
    const banks = [bank({ transaction_id: 'costco', date: '2026-09-05', amount: 123.45, name: 'COSTCO WHSE #0012' }), bank({ transaction_id: 'pay', date: '2026-09-04', amount: -2500, name: 'ACME PAYROLL' })];
    const p = planHistoryImport({ rows: normalized, problems, held: [], banks, order: [], bankFrom: '2026-01-01' });
    expect(p.actions).toEqual(['duplicate', 'duplicate']);
  });

  test('a QIF file writes money out as negative, on a bank account and a card alike: both read in Plaid’s sign and match the bank’s rows', () => {
    for (const [type, account_id, credit] of [
      ['Bank', 'acct_chk', 'PAYROLL'],
      ['CCard', 'acct_card', 'PAYMENT THANK YOU'],
    ] as const) {
      const qif = `!Type:${type}\nD09/03/2026\nT-87.20\nPTRADER JOES #123\n^\nD09/15/2026\nT500.00\nP${credit}\n^\n`;
      const read = readImport(qif, { options: { date_order: 'mdy' }, thisYear: 2026 });
      if (read.status !== 'ready') throw new Error(read.status);
      const { rows: normalized, problems } = rows(read.records);
      expect(normalized.map((r) => r.row.amount)).toEqual([87.2, -500]);
      const banks = [
        bank({ transaction_id: `${type}-tj`, account_id, date: '2026-09-04', amount: 87.2, name: "TRADER JOE'S #123" }),
        bank({ transaction_id: `${type}-in`, account_id, date: '2026-09-15', amount: -500, name: credit }),
      ];
      const p = planHistoryImport({ rows: normalized, problems, held: [], banks, order: [], bankFrom: '2026-01-01' });
      expect(p.proposals.map((x) => [x.bank.transaction_id, x.days, x.confidence]).sort()).toEqual([
        [`${type}-in`, 0, 'high'],
        [`${type}-tj`, 1, 'high'],
      ]);
    }
  });

  test('an OFX time late in the evening is still that day at the bank: no time zone moves it', () => {
    const ofx = `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>1</BANKID><ACCTID>9</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260105230000[-5:EST]</DTPOSTED><TRNAMT>-9.99</TRNAMT><FITID>Z1</FITID><NAME>LATE NIGHT</NAME></STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const read = readImport(ofx, { options: {}, thisYear: 2026 });
    if (read.status !== 'ready') throw new Error(read.status);
    const { rows: normalized, problems } = rows(read.records);
    expect(normalized[0].row.date).toBe('2026-01-05');
    const p = planHistoryImport({ rows: normalized, problems, held: [], banks: [bank({ transaction_id: 'b', date: '2026-01-05', amount: 9.99 })], order: [], bankFrom: null });
    expect(p.proposals[0]).toMatchObject({ days: 0, confidence: 'high' });
  });
});

describe('what the review sums', () => {
  test('money out and in of the rows to be added, the days covered, and what can’t be read', () => {
    const p = plan({
      records: [rec({ amount: 12.5, date: '2026-09-03' }), rec({ amount: -100, date: '2026-09-01', description: 'Pay', line: 3 }), rec({ amount: 0, line: 4 })],
    });
    expect(p.totals).toEqual({ out: 12.5, in: 100 });
    expect([p.first_date, p.last_date, p.currency]).toEqual(['2026-09-01', '2026-09-03', 'USD']);
    expect(p.counts.unreadable).toBe(1);
  });
});
