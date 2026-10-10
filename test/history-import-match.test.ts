import { describe, expect, test } from 'bun:test';
import {
  bankKey,
  confidenceOf,
  couldBe,
  daysApart,
  MATCH_DAYS,
  pairUp,
  settle,
  similarity,
  type BankRow,
  type FileRow,
  type HeldRow,
} from '@/lib/history-import/match';

// Matching a file's rows against a linked account's own (lib/history-import/
// match.ts): the bank's rows by exact amount and a date within a few days,
// the description only a tiebreak, one to one and as many as can be, never a
// pending row; and which kept rows count (settle): a duplicate only while its
// twin is there, a row a later sync's row supersedes not at all.

const bank = (over: Partial<BankRow> & { transaction_id: string }): BankRow => ({
  account_id: 'acct_chk',
  date: '2025-03-10',
  amount: 12.5,
  currency: 'USD',
  name: 'SQ *BLUE BOTTLE 1234 OAKLAND CA',
  merchant_name: 'Blue Bottle Coffee',
  pending: false,
  ...over,
});
const row = (index: number, over: Partial<FileRow> = {}): FileRow => ({ index, date: '2025-03-10', amount: 12.5, currency: 'USD', name: 'BLUE BOTTLE COFFEE OAKLAND', ...over });
const held = (id: string, over: Partial<HeldRow> = {}): HeldRow => ({ id, import_id: 'history-import:a', date: '2025-03-10', amount: 12.5, currency: 'USD', name: 'BLUE BOTTLE', ...over });

describe('a bank row’s key', () => {
  test('is the day, the amount and the bank’s own descriptor, without the account: the same across a re-link', () => {
    const before = bank({ transaction_id: 'old', account_id: 'acct_old' });
    const after = bank({ transaction_id: 'new', account_id: 'acct_new', merchant_name: 'Blue Bottle' });
    expect(bankKey(before)).toBe(bankKey(after));
    expect(bankKey(before)).toBe('2025-03-10|12500|sq blue bottle 1234 oakland ca');
    expect(bankKey(bank({ transaction_id: 'x', amount: 12.51 }))).not.toBe(bankKey(before));
  });
});

describe('what could be the same transaction', () => {
  test('the same amount in the same currency, dated within MATCH_DAYS either way', () => {
    expect(couldBe(row(0), bank({ transaction_id: 't' }))).toBe(true);
    expect(couldBe(row(0, { date: '2025-03-15' }), bank({ transaction_id: 't' }))).toBe(true);
    expect(couldBe(row(0, { date: '2025-03-05' }), bank({ transaction_id: 't' }))).toBe(true);
    expect(MATCH_DAYS).toBe(5);
    expect(couldBe(row(0, { date: '2025-03-16' }), bank({ transaction_id: 't' }))).toBe(false);
    expect(couldBe(row(0, { amount: 12.51 }), bank({ transaction_id: 't' }))).toBe(false);
    // Money in never matches money out of the same size: the sign is part of it.
    expect(couldBe(row(0, { amount: -12.5 }), bank({ transaction_id: 't' }))).toBe(false);
  });

  test('a pending row never: its amount can still change, and its posted row is the match', () => {
    expect(couldBe(row(0), bank({ transaction_id: 't', pending: true }))).toBe(false);
  });

  test('another currency never; a bank row that names none is taken to be in the row’s', () => {
    expect(couldBe(row(0), bank({ transaction_id: 't', currency: 'EUR' }))).toBe(false);
    expect(couldBe(row(0), bank({ transaction_id: 't', currency: null }))).toBe(true);
  });

  test('amounts compare in the currency’s minor unit, never as floats', () => {
    expect(couldBe(row(0, { amount: 0.1 + 0.2 }), bank({ transaction_id: 't', amount: 0.3 }))).toBe(true);
    expect(couldBe(row(0, { amount: 1200, currency: 'JPY' }), bank({ transaction_id: 't', amount: 1200, currency: 'JPY' }))).toBe(true);
  });

  test('days apart are calendar days, across months and years', () => {
    expect(daysApart('2024-12-30', '2025-01-02')).toBe(3);
    expect(daysApart('2024-02-28', '2024-03-01')).toBe(2);
  });
});

describe('how alike two descriptions are', () => {
  test('words that say who count; card numbers, places of no help and payment words don’t', () => {
    expect(similarity('SQ *BLUE BOTTLE 1234 OAKLAND CA', 'Blue Bottle Coffee')).toBeGreaterThan(0.5);
    expect(similarity('POS PURCHASE 4411', 'DEBIT CARD 9922')).toBe(0);
    expect(similarity('STARBUCKS STORE 00123', 'Starbuck')).toBeGreaterThan(0.6);
    expect(similarity('', 'anything')).toBe(0);
  });
});

describe('confidence', () => {
  test('high a day apart, or up to three with a shared word; medium up to three, or further with one; low otherwise', () => {
    expect(confidenceOf(0, 0)).toBe('high');
    expect(confidenceOf(1, 0)).toBe('high');
    expect(confidenceOf(3, 0.5)).toBe('high');
    expect(confidenceOf(2, 0)).toBe('medium');
    expect(confidenceOf(5, 0.5)).toBe('medium');
    expect(confidenceOf(4, 0)).toBe('low');
    expect(confidenceOf(5, 0.2)).toBe('low');
  });
});

describe('pairing rows with the bank’s, one to one', () => {
  test('the same amount twice in a week is two transactions both ways: each pairs with the nearest', () => {
    const banks = [bank({ transaction_id: 'mon', date: '2025-03-10' }), bank({ transaction_id: 'thu', date: '2025-03-13' })];
    const pairs = pairUp([row(0, { date: '2025-03-13' }), row(1, { date: '2025-03-10' })], banks);
    expect(pairs.get(0)?.twin.transaction_id).toBe('thu');
    expect(pairs.get(1)?.twin.transaction_id).toBe('mon');
    expect(pairs.get(0)?.days).toBe(0);
  });

  test('two in the file and one at the bank: one pairs, the other is left for the person to see as new', () => {
    const pairs = pairUp([row(0, { date: '2025-03-10' }), row(1, { date: '2025-03-12' })], [bank({ transaction_id: 'only', date: '2025-03-11' })]);
    expect(pairs.size).toBe(1);
    // A tie on days goes to the more alike description, then to file order.
    expect(pairs.get(0)?.twin.transaction_id).toBe('only');
  });

  test('the description breaks a tie between two bank rows the same days away', () => {
    const banks = [
      bank({ transaction_id: 'gym', date: '2025-03-09', name: 'PLANET FITNESS', merchant_name: 'Planet Fitness' }),
      bank({ transaction_id: 'coffee', date: '2025-03-11' }),
    ];
    expect(pairUp([row(0, { date: '2025-03-10' })], banks).get(0)?.twin.transaction_id).toBe('coffee');
  });

  test('a pair the person said is not one is left out', () => {
    const b = bank({ transaction_id: 't' });
    expect(pairUp([row(0)], [b], (_, x) => x === b).size).toBe(0);
  });
});

describe('which kept rows count', () => {
  const order = ['history-import:a', 'history-import:b'];
  const counted = (rows: HeldRow[], banks: BankRow[], bankFrom: string | null = '2025-01-01') => settle(rows, banks, order, { bankFrom }).counted.map((r) => r.id);

  test('a duplicate stands for its bank row while the bank holds it, and counts again once it doesn’t', () => {
    const b = bank({ transaction_id: 'rent', amount: 1850, name: 'ZELLE TO LANDLORD' });
    const dup = held('dup', { amount: 1850, same_as: bankKey(b) });
    expect(counted([dup], [b])).toEqual([]);
    expect(settle([dup], [b], order, { bankFrom: '2025-01-01' }).standing.get('dup')).toEqual({ bank: b });
    // A re-link whose window starts later: the bank no longer has the rent.
    expect(counted([dup], [], '2025-06-01')).toEqual(['dup']);
  });

  test('a duplicate whose bank row the bank renamed is matched again, never counted twice', () => {
    const before = bank({ transaction_id: 'old', name: 'SQ *BLUE BOTTLE 1234' });
    const after = bank({ transaction_id: 'new', name: 'SQUARE BLUE BOTTLE' });
    const dup = held('dup', { same_as: bankKey(before) });
    const out = settle([dup], [after], order, { bankFrom: '2025-01-01' });
    expect(out.counted).toEqual([]);
    expect(out.superseded.get('dup')?.transaction_id).toBe('new');
  });

  test('two identical bank rows on a day hold two duplicates; one taken back leaves one counted', () => {
    const one = bank({ transaction_id: 'c1' });
    const two = bank({ transaction_id: 'c2' });
    const rows = [held('d1', { same_as: bankKey(one) }), held('d2', { same_as: bankKey(two) })];
    expect(counted(rows, [one, two])).toEqual([]);
    // The bank took one back and nothing else of that amount is near: the
    // other coffee counts again.
    expect(counted(rows, [one]).length).toBe(1);
  });

  test('a duplicate of an earlier import’s row stands while that row is kept, and counts when it is undone', () => {
    const csv = held('csv', { import_id: 'history-import:a', name: 'SQ *COFFEE 1234 SEATTLE WA' });
    const ofx = held('ofx', { import_id: 'history-import:b', name: 'SQ *COFFEE 1234', same_as_row: 'csv' });
    expect(counted([csv, ofx], [])).toEqual(['csv']);
    expect(counted([ofx], [])).toEqual(['ofx']);
    // Never a later import's row: no chain of names goes round. (Here the
    // OFX row's twin is gone too, so both count.)
    const back = held('back', { import_id: 'history-import:a', same_as_row: 'ofx' });
    expect(counted([back, ofx], []).sort()).toEqual(['back', 'ofx']);
  });

  test('a counted row the bank now has is superseded; earlier imports are matched first', () => {
    const b = bank({ transaction_id: 'posted', date: '2025-03-11' });
    const rows = [held('later', { import_id: 'history-import:b', date: '2025-03-11' }), held('earlier', { import_id: 'history-import:a', date: '2025-03-10' })];
    const out = settle(rows, [b], order, { bankFrom: '2025-01-01' });
    expect([...out.superseded.keys()]).toEqual(['earlier']);
    expect(out.counted.map((r) => r.id)).toEqual(['later']);
  });

  test('a row kept apart from a bank row is never superseded by it, and leaves it free for its real twin', () => {
    const b = bank({ transaction_id: 't', date: '2025-03-13' });
    const kept = held('kept', { date: '2025-03-10', distinct_from: [bankKey(b)] });
    const twin = held('twin', { import_id: 'history-import:b', date: '2025-03-13' });
    const out = settle([kept, twin], [b], order, { bankFrom: '2025-01-01' });
    expect(out.superseded.get('twin')?.transaction_id).toBe('t');
    expect(out.counted.map((r) => r.id)).toEqual(['kept']);
  });

  test('pending bank rows supersede nothing, but stand in for a row like them in what is shown', () => {
    const p = bank({ transaction_id: 'p', pending: true });
    expect(settle([held('r')], [p], order, { bankFrom: '2025-01-01' }).counted.length).toBe(1);
    const shown = settle([held('r')], [p], order, { bankFrom: '2025-01-01', pending: true });
    expect(shown.counted).toEqual([]);
    expect(shown.pendingStood.get('r')?.transaction_id).toBe('p');
  });

  test('a row dated by posting (OFX) is never superseded across the bank’s window edge; others may be, by a posting lag', () => {
    const b = bank({ transaction_id: 'first', date: '2025-02-01' });
    const ofxRow = held('ofx', { date: '2025-01-30', source: 'import:ofx' });
    const csvRow = held('csv', { date: '2025-01-30', source: 'import:csv' });
    expect(counted([ofxRow], [b], '2025-02-01')).toEqual(['ofx']);
    expect(counted([csvRow], [b], '2025-02-01')).toEqual([]);
    // Nor by a bank row after the period its file covers.
    const covers = new Map([['history-import:a', { from: '2025-01-01', to: '2025-01-31' }]]);
    const inside = held('in', { date: '2025-01-31', source: 'import:ofx' });
    expect(settle([inside], [bank({ transaction_id: 'feb', date: '2025-02-02' })], order, { bankFrom: '2025-01-01', covers }).counted.map((r) => r.id)).toEqual(['in']);
  });
});

describe('as many pairs as can be', () => {
  const day = (n: number) => new Date(Date.UTC(2025, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);

  test('a daily fare dated by purchase in the file and two days later by posting: every bank fare finds its own, none counted twice', () => {
    const file = Array.from({ length: 21 }, (_, i) => row(i, { date: day(i), amount: 2.75, name: 'MTA SUBWAY' }));
    // The bank's window starts on day 10: the fares made on days 8 to 20.
    const banks = Array.from({ length: 13 }, (_, i) => bank({ transaction_id: `b${i}`, date: day(10 + i), amount: 2.75, name: 'MTA*NYCT PAYGO', merchant_name: 'MTA' }));
    const pairs = pairUp(file, banks);
    expect(pairs.size).toBe(13);
    expect([...pairs.values()].every((p) => p.days === 2)).toBe(true);
    // Through the later sync too: 8 of the file's fares are the bank's only ones.
    const rows = file.map((r) => held(`r${r.index}`, { date: r.date, amount: 2.75, name: r.name }));
    const out = settle(rows, banks, ['history-import:a'], { bankFrom: day(10) });
    expect(out.counted.length + banks.length).toBe(21);
  });

  test('the closest pairing among the fullest: a gap never pairs a row with its neighbour’s twin', () => {
    const file = [row(0, { date: '2025-03-10' }), row(1, { date: '2025-03-12' })];
    const banks = [bank({ transaction_id: 'a', date: '2025-03-10' }), bank({ transaction_id: 'b', date: '2025-03-12' })];
    const pairs = pairUp(file, banks);
    expect([pairs.get(0)?.twin.transaction_id, pairs.get(1)?.twin.transaction_id]).toEqual(['a', 'b']);
    expect(pairs.get(0)?.days).toBe(0);
  });

  test('years of one amount every day still pair quickly', () => {
    const file = Array.from({ length: 1460 }, (_, i) => row(i, { date: day(i), amount: 2.75 }));
    const banks = Array.from({ length: 730 }, (_, i) => bank({ transaction_id: `b${i}`, date: day(730 + i), amount: 2.75 }));
    const started = performance.now();
    expect(pairUp(file, banks).size).toBe(730);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
