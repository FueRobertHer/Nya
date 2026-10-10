import { describe, expect, test } from 'bun:test';
import {
  bankKey,
  confidenceOf,
  couldBe,
  daysApart,
  MATCH_DAYS,
  pairUp,
  similarity,
  supersede,
  unclaimed,
  type BankRow,
  type FileRow,
  type HeldRow,
} from '@/lib/history-import/match';

// Matching a file's rows against a linked account's own (lib/history-import/
// match.ts): the bank's rows by exact amount and a date within a few days,
// the description only a tiebreak, one to one, never a pending row; and which
// kept rows a later sync's rows supersede.

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
    expect(pairs.get(0)?.bank.transaction_id).toBe('thu');
    expect(pairs.get(1)?.bank.transaction_id).toBe('mon');
    expect(pairs.get(0)?.days).toBe(0);
  });

  test('two in the file and one at the bank: one pairs, the other is left for the person to see as new', () => {
    const pairs = pairUp([row(0, { date: '2025-03-10' }), row(1, { date: '2025-03-12' })], [bank({ transaction_id: 'only', date: '2025-03-11' })]);
    expect(pairs.size).toBe(1);
    // A tie on days goes to the more alike description, then to file order.
    expect(pairs.get(0)?.bank.transaction_id).toBe('only');
  });

  test('the description breaks a tie between two bank rows the same days away', () => {
    const banks = [
      bank({ transaction_id: 'gym', date: '2025-03-09', name: 'PLANET FITNESS', merchant_name: 'Planet Fitness' }),
      bank({ transaction_id: 'coffee', date: '2025-03-11' }),
    ];
    expect(pairUp([row(0, { date: '2025-03-10' })], banks).get(0)?.bank.transaction_id).toBe('coffee');
  });

  test('a pair the person said is not one is left out', () => {
    const b = bank({ transaction_id: 't' });
    expect(pairUp([row(0)], [b], (_, x) => x === b).size).toBe(0);
  });
});

describe('the bank rows decisions have taken', () => {
  test('a duplicate claims its bank row and a row kept apart marks it, one each, by key', () => {
    const twins = [bank({ transaction_id: 'a' }), bank({ transaction_id: 'b' }), bank({ transaction_id: 'c', amount: 3 })];
    const key = bankKey(twins[0]);
    expect(unclaimed(twins, []).map((b) => b.transaction_id)).toEqual(['a', 'b', 'c']);
    expect(unclaimed(twins, [held('r1', { same_as: key })]).map((b) => b.transaction_id)).toEqual(['b', 'c']);
    expect(unclaimed(twins, [held('r1', { same_as: key }), held('r2', { distinct_from: [key] })]).map((b) => b.transaction_id)).toEqual(['c']);
  });
});

describe('a later sync superseding imported rows', () => {
  test('a counted row the bank now has supersedes; a duplicate is never counted, so never superseded', () => {
    const b = bank({ transaction_id: 'posted', date: '2025-03-11' });
    const out = supersede([held('r1'), held('r2', { amount: 99 })], [b], ['history-import:a']);
    expect([...out.keys()]).toEqual(['r1']);
    expect(out.get('r1')?.transaction_id).toBe('posted');
  });

  test('a bank row claimed by a duplicate is not free: two coffees, one already the bank’s, the other stays', () => {
    const mon = bank({ transaction_id: 'mon', date: '2025-03-10' });
    const rows = [held('dup', { same_as: bankKey(mon) }), held('wed', { date: '2025-03-12' })];
    expect(supersede(rows, [mon], ['history-import:a']).size).toBe(0);
  });

  test('a row kept apart from a bank row is never superseded by it, nor is any other row', () => {
    const b = bank({ transaction_id: 't' });
    const rows = [held('kept', { distinct_from: [bankKey(b)] }), held('other', { date: '2025-03-11' })];
    expect(supersede(rows, [b], ['history-import:a']).size).toBe(0);
  });

  test('earlier imports are matched first, so a later one never takes their bank row', () => {
    const b = bank({ transaction_id: 't', date: '2025-03-11' });
    const rows = [held('later', { import_id: 'history-import:b', date: '2025-03-11' }), held('earlier', { import_id: 'history-import:a', date: '2025-03-10' })];
    const out = supersede(rows, [b], ['history-import:a', 'history-import:b']);
    expect([...out.keys()]).toEqual(['earlier']);
  });

  test('pending bank rows supersede nothing', () => {
    expect(supersede([held('r')], [bank({ transaction_id: 'p', pending: true })], []).size).toBe(0);
  });
});
