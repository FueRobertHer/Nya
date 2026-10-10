import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planHistoryImport, type PlanHeld } from '@/lib/history-import/plan';
import { bankKey, settle, type BankRow } from '@/lib/history-import/match';
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
      ...(pair && action === 'duplicate' ? ('key' in pair.twin.names ? { same_as: pair.twin.names.key } : { same_as_row: pair.twin.names.row }) : {}),
      ...(pair && action === 'add' && pair.twin.kind === 'bank' ? { distinct_from: [bankKey(pair.twin)] } : {}),
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
    expect(p.proposals.map((x) => [x.index, x.twin.id, x.days, x.confidence, x.choice])).toEqual([
      [0, 'rent', 0, 'high', 'same'],
      [1, 'coffee', 2, 'high', 'same'],
    ]);
    expect(p.proposals[1].twin).toMatchObject({ name: 'Blue Bottle Coffee', descriptor: 'SQ *BLUE BOTTLE', date: '2026-09-05', amount: 4.5 });
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

  test('a bank row an earlier import already stands on is still proposed, and the same names that row: one claim on it, never two', () => {
    const b = bank({ transaction_id: 'b', amount: 10 });
    const claimed: PlanHeld = { id: 'imported-txn:c', import_id: 'history-import:a', date: '2026-09-01', amount: 10, currency: 'USD', name: 'Claims it', source: 'import:csv', source_id: 'k1', same_as: bankKey(b) };
    const p = plan({ records: [rec({ amount: 10, description: 'Other words' })], banks: [b], held: [claimed] });
    expect(p.proposals.map((x) => [x.twin.kind, x.twin.id])).toEqual([['bank', 'b']]);
    expect(p.pairs.get(0)?.twin.names).toEqual({ row: 'imported-txn:c' });
    // A bank row that superseded an earlier import's row is named by that row.
    const superseded: PlanHeld = { ...claimed, same_as: undefined, source_id: 'k2' };
    const q = plan({ records: [rec({ amount: 10, description: 'Other words' })], banks: [b], held: [superseded], bankFrom: '2026-01-01' });
    expect(q.pairs.get(0)?.twin.names).toEqual({ row: 'imported-txn:c' });
    // A free one by its key.
    expect(plan({ records: [rec({ amount: 10 })], banks: [b] }).pairs.get(0)?.twin.names).toEqual({ key: bankKey(b) });
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
    expect(p.proposals.map((x) => [x.twin.id, x.days, x.confidence]).sort()).toEqual([
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
      expect(p.proposals.map((x) => [x.twin.id, x.days, x.confidence]).sort()).toEqual([
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

describe('what earlier imports and the edges of each side’s days change', () => {
  const day = (n: number) => new Date(Date.UTC(2025, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
  const fare = (index: number, date: string, source: 'csv' | 'ofx' = 'csv', id?: string) =>
    rec({ source, ...(source === 'ofx' ? { source_id: id ?? `F${index}` } : {}), date, amount: 2.75, description: 'MTA NYCT PAYGO', line: index + 2 });
  const bankFare = (d: number) => bank({ transaction_id: `b${d}`, date: day(d), amount: 2.75, name: 'MTA*NYCT PAYGO', merchant_name: 'MTA' });

  test('a bank’s CSV and then its OFX of the same days: each OFX row is proposed as the CSV’s, and the same counts it once', () => {
    const csv = plan({
      records: [
        rec({ date: day(10), amount: 54.12, description: 'SQ *COFFEE 1234 SEATTLE WA' }),
        rec({ date: day(11), amount: 1850, description: 'ONLINE TRANSFER TO LANDLORD REF 99812', line: 3 }),
        rec({ date: day(12), amount: 4.5, description: 'BLUE BOTTLE COFFEE #12 OAKLAND CA', line: 4 }),
      ],
      bankFrom: day(30),
    });
    const kept = keptFrom(csv, 'a').map((r) => ({ ...r, import_id: 'history-import:a' }));
    const ofx = plan({
      records: [
        rec({ source: 'ofx', source_id: 'FIT0', date: day(10), amount: 54.12, description: 'SQ *COFFEE 1234' }),
        rec({ source: 'ofx', source_id: 'FIT1', date: day(11), amount: 1850, description: 'ONLINE TRANSFER TO LANDLORD', line: 3 }),
        rec({ source: 'ofx', source_id: 'FIT2', date: day(12), amount: 4.5, description: 'BLUE BOTTLE COFFEE #12', line: 4 }),
      ],
      held: kept,
      bankFrom: day(30),
    });
    expect(ofx.proposals.map((p) => [p.twin.kind, p.days, p.confidence, p.choice])).toEqual([
      ['imported', 0, 'high', 'same'],
      ['imported', 0, 'high', 'same'],
      ['imported', 0, 'high', 'same'],
    ]);
    expect(ofx.counts).toMatchObject({ new: 0, already: 3, duplicates: 0 });
    // Stored as duplicates of the CSV's rows: the three count once.
    const both = [...kept, ...keptFrom(ofx, 'b').map((r) => ({ ...r, import_id: 'history-import:b' }))];
    expect(settle(both, [], ['history-import:a', 'history-import:b'], { bankFrom: day(30) }).counted.length).toBe(3);
    // The CSV undone, the OFX's count instead.
    expect(settle(both.filter((r) => r.import_id === 'history-import:b'), [], ['history-import:b'], { bankFrom: day(30) }).counted.length).toBe(3);
  });

  test('a row said to be its own leaves the bank’s row free: the next statement’s real twin of it is proposed, and counted once', () => {
    const banks = [25, 27, 30, 32].map(bankFare);
    // Statement 1: the fare on day 29 the bank never sent pairs with its day 32
    // fare; the person says it is its own.
    const s1 = [25, 27, 29, 30].map((d, i) => fare(i, day(d), 'ofx', `S1-${d}`));
    const first = plan({ records: s1, banks, bankFrom: day(25) });
    const at29 = first.proposals.find((p) => p.file.date === day(29))!;
    const answered = plan({ records: s1, banks, bankFrom: day(25), choices: { proposals: { each: { [at29.index]: 'new' } } } });
    const kept = keptFrom(answered, 'a').map((r) => ({ ...r, import_id: 'history-import:a' }));
    // Statement 2 holds the day-32 fare: the bank's day 32 is this one.
    const s2 = plan({ records: [fare(0, day(32), 'ofx', 'S2-32')], banks, held: kept, bankFrom: day(25) });
    expect(s2.proposals.map((p) => [p.twin.id, p.days, p.choice])).toEqual([['b32', 0, 'same']]);
    expect(s2.counts).toMatchObject({ new: 0, duplicates: 1 });
    const all = [...kept, ...keptFrom(s2, 'b').map((r) => ({ ...r, import_id: 'history-import:b' }))];
    const counted = settle(all, banks, ['history-import:a', 'history-import:b'], { bankFrom: day(25) }).counted;
    expect(counted.filter((r) => r.date === day(32)).length).toBe(0);
    expect(counted.map((r) => r.date)).toEqual([day(29)]);
  });

  test('a pair across the bank’s first day is possibly the same, says why, and waits for an answer; for an OFX file it isn’t made', () => {
    const banks = [30, 31, 32, 33, 34].map(bankFare);
    // A CSV dated by purchase, exported up to the bank's first day.
    const csv = plan({ records: [25, 26, 27, 28, 29, 30].map((d, i) => fare(i, day(d))), banks, bankFrom: day(30) });
    const across = csv.proposals.filter((p) => p.file.date < day(30));
    expect(across.length).toBeGreaterThan(0);
    for (const p of across) expect(p).toMatchObject({ confidence: 'low', choice: null, edge: { kind: 'before-bank', day: day(30) } });
    expect(csv.counts.unanswered).toBe(across.length);
    // The same days in an OFX file, dated by posting: only day 30 is the bank's.
    const ofx = plan({ records: [25, 26, 27, 28, 29, 30].map((d, i) => fare(i, day(d), 'ofx')), banks, bankFrom: day(30) });
    expect(ofx.proposals.map((p) => [p.file.date, p.twin.id, p.days, p.edge])).toEqual([[day(30), 'b30', 0, null]]);
    expect(ofx.counts).toMatchObject({ new: 5, duplicates: 1, unanswered: 0 });
  });

  test('a bank row after the period the file covers is one only through a lag', () => {
    const banks = [bankFare(31)];
    const p = planHistoryImport({ ...rows([fare(0, day(30))]), held: [], banks, order: [], bankFrom: day(1), covers: { from: day(1), to: day(30) } });
    expect(p.proposals[0]).toMatchObject({ confidence: 'low', choice: null, edge: { kind: 'outside-file', from: day(1), to: day(30) } });
  });

  test('a daily fare dated two days before the bank posts it: every one of the bank’s is proposed with its own', () => {
    const banks = Array.from({ length: 13 }, (_, i) => bankFare(10 + i));
    const p = plan({ records: Array.from({ length: 21 }, (_, i) => fare(i, day(i))), banks, bankFrom: day(10) });
    expect(p.proposals.length).toBe(13);
    expect(p.proposals.every((x) => x.days === 2)).toBe(true);
    expect(p.counts.new + p.counts.unanswered + p.counts.duplicates).toBe(21);
  });

  test('the review’s key holds what each row says and the period: another file of as many rows is another review', () => {
    const a = planHistoryImport({ ...rows([rec({ amount: 10 })]), held: [], banks: [], order: [], bankFrom: null, covers: { from: '2026-09-01', to: '2026-09-01' } });
    const b = planHistoryImport({ ...rows([rec({ amount: 11 })]), held: [], banks: [], order: [], bankFrom: null, covers: { from: '2026-09-01', to: '2026-09-01' } });
    const wider = planHistoryImport({ ...rows([rec({ amount: 10 })]), held: [], banks: [], order: [], bankFrom: null, covers: { from: '2026-08-01', to: '2026-09-01' } });
    expect(a.review).not.toBe(b.review);
    expect(a.review).not.toBe(wider.review);
  });
});
