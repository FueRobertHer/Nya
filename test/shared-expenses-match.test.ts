import { describe, expect, test } from 'bun:test';
import { proposals, appOf, namesPerson, type MatchPerson, type MatchRow } from '@/lib/shared-expenses/match';
import { itemsOf, itemState, paidOf } from '@/lib/shared-expenses/balances';
import type { Iou, Share, PaymentRequest } from '@/lib/shared-expenses/model';

// Settlement detection (lib/shared-expenses/match.ts): proposals ranked in
// tiers, never facts. The bank descriptors here ("VENMO CASHOUT", "Zelle
// payment from ...") are examples of what payment apps leave on bank rows,
// recalled, not documented by any bank.

const AT = '2026-10-03T12:00:00.000Z';
const share = (id: string, person: string, amount: number, date = '2026-10-03'): [string, Share] => [
  `t-${id}`,
  { version: 1, account_id: 'acc', amount_was: amount * 2, currency: 'USD', date, what: id, entries: [{ id, person, amount }], created_at: AT, updated_at: AT },
];
const iou = (over: Partial<Iou>): Iou => ({ version: 1, person: 'alex', direction: 'by_you', amount: 25, currency: 'USD', date: '2026-10-05', what: 'Groceries', created_at: AT, updated_at: AT, ...over });

function states(shares: [string, Share][], ious: [string, Iou][] = []) {
  const items = itemsOf(new Map(shares), new Map(ious));
  const paid = paidOf(new Map(), items);
  return [...items.values()].map((i) => itemState(i, paid));
}

const person = (id: string, name: string, over: Partial<MatchPerson> = {}): MatchPerson => ({ id, name, requests: [], archived: false, ...over });
const request = (amount: number, at: string, items: string[]): PaymentRequest => ({ id: 'r1', at, direction: 'to_you', amount, currency: 'USD', via: 'venmo', items });

function rowOf(id: string, amount: number, over: Partial<MatchRow> = {}): MatchRow {
  return { transaction_id: id, date: '2026-10-09', amount, pending: false, name: 'VENMO CASHOUT', iso_currency_code: 'USD', category_kind: 'transfer', transaction_code: 'transfer', category: 'transfer in', ...over };
}

const alex = person('alex', 'Alex Smith', { app: 'venmo' });
const sam = person('sam', 'Sam');

describe('tiers', () => {
  test('the balance with the app is strong and preselected; the same amount alone is only possible', () => {
    const items = states([share('e1', 'alex', 60)]);
    const strong = proposals([rowOf('v', -60)], [alex], items);
    expect(strong.map((p) => [p.row, p.tier, p.fit, p.app, p.their_app, p.preselect])).toEqual([['v', 'strong', 'balance', 'venmo', true, true]]);
    expect(strong[0].allocations).toEqual([{ item: 'e1', amount: 60 }]);
    const alone = proposals([rowOf('d', -60, { name: 'DEPOSIT' })], [alex], items);
    expect(alone.map((p) => [p.tier, p.preselect])).toEqual([['possible', false]]);
  });

  test('a store’s refund of the amount you asked for is never above possible', () => {
    const items = states([share('e1', 'alex', 35)]);
    const asked = { ...alex, requests: [request(35, '2026-10-06T10:00:00Z', ['e1'])] };
    const refund = rowOf('r', -35, { name: 'Target', category_kind: 'expense', category: 'general merchandise', transaction_code: null, date: '2026-10-08' });
    expect(proposals([refund], [asked], items).map((p) => [p.tier, p.fit, p.preselect])).toEqual([['possible', 'requested', false]]);
    // The same through Venmo: strong.
    expect(proposals([rowOf('v', -35, { date: '2026-10-08' })], [asked], items).map((p) => [p.tier, p.fit, p.days])).toEqual([['strong', 'requested', 2]]);
  });

  test('the name, as whole words, with less or more than the balance is likely', () => {
    const items = states([share('e1', 'alex', 60)]);
    const zelle = rowOf('z', -40, { name: 'Zelle payment from ALEX SMITH 1234' });
    expect(proposals([zelle], [alex], items).map((p) => [p.tier, p.fit, p.named])).toEqual([['likely', 'part', true]]);
    // A two-letter name inside a word isn't a name.
    const al = person('al', 'Al', { app: 'venmo' });
    expect(namesPerson({ name: 'WALMART SUPERCENTER' }, al)).toBe(false);
    expect(namesPerson({ name: 'Zelle from AL BROWN' }, al)).toBe(true);
    expect(appOf({ name: 'Square Cash  *ALEX' })).toBe('cashapp');
    expect(appOf({ name: 'VENMOUTH DINER' })).toBeNull();
  });
});

describe('amounts', () => {
  test('a set of items, the oldest first, saying when another set has the same sum', () => {
    const items = states([share('a', 'alex', 10, '2026-09-01'), share('b', 'alex', 20, '2026-09-02'), share('c', 'alex', 30, '2026-09-03'), share('d', 'alex', 40, '2026-09-04')]);
    const [p] = proposals([rowOf('v', -50)], [alex], items);
    expect(p.fit).toBe('items');
    // 10+40 and 20+30 both make 50: the oldest is taken first.
    expect(p.allocations.map((a) => a.item)).toEqual(['a', 'd']);
    expect(p.choice).toBe(true);
  });

  test('partly paid back: the oldest first, the last in part; more than owed: every item, the rest the row’s', () => {
    const items = states([share('a', 'alex', 30, '2026-09-01'), share('b', 'alex', 30, '2026-09-02')]);
    const named = { name: 'Venmo from Alex Smith' };
    expect(proposals([rowOf('v', -45, named)], [alex], items)[0].allocations).toEqual([
      { item: 'a', amount: 30 },
      { item: 'b', amount: 15 },
    ]);
    const over = proposals([rowOf('w', -80, named)], [alex], items)[0];
    expect([over.fit, over.tier]).toEqual(['over', 'likely']);
    expect(over.allocations).toEqual([
      { item: 'a', amount: 30 },
      { item: 'b', amount: 30 },
    ]);
  });

  test('a net balance: one payment closes items both ways', () => {
    const items = states([share('e1', 'alex', 60)], [['i1', iou({ category_id: 'groceries' })]]);
    const [p] = proposals([rowOf('v', -35)], [alex], items);
    expect([p.fit, p.tier]).toEqual(['balance', 'strong']);
    expect(p.allocations).toEqual([
      { item: 'e1', amount: 60 },
      { item: 'i1', amount: 25 },
    ]);
    // What you owe is paid by money out.
    const owe = states([], [['i2', iou({ amount: 800, what: 'Rent' })]]);
    expect(proposals([rowOf('o', 800, { name: 'VENMO PAYMENT' })], [alex], owe).map((x) => [x.fit, x.tier])).toEqual([['balance', 'strong']]);
    expect(proposals([rowOf('o', -800)], [alex], owe)).toEqual([]);
  });

  test('a batched cashout equal to two people’s balances with the app is possible, and preselects nothing', () => {
    const items = states([share('a', 'alex', 35), share('s', 'sam', 20)]);
    const [p] = proposals([rowOf('v', -55)], [alex, sam], items);
    expect([p.fit, p.tier, p.preselect, p.several]).toEqual(['several', 'possible', false, ['alex', 'sam']]);
    expect(p.allocations).toEqual([{ item: 'a', amount: 35 }, { item: 's', amount: 20 }]);
  });

  test('a batched cashout offers only what is open: an item closed past its amount is left out, as Confirm would refuse it', () => {
    const items = itemsOf(new Map([share('a', 'alex', 35), share('a2', 'alex', 10, '2026-10-04'), share('s', 'sam', 20)]), new Map());
    // Two payments of $10 each closed a2, $10 past what it was: Alex's
    // balance is $25.
    const payment = (row: string) => [row, { version: 1, account_id: 'chk', row: { amount: -10, currency: 'USD', date: '2026-10-06' }, allocations: [{ item: 'a2', amount: 10 }], confirmed_at: AT }] as const;
    const paid = paidOf(new Map([payment('v1'), payment('v2')] as never), items);
    const states_ = [...items.values()].map((i) => itemState(i, paid));
    expect(states_.find((i) => i.id === 'a2')!.open).toBe(-10);
    const [p] = proposals([rowOf('v', -45)], [alex, sam], states_);
    expect([p.fit, p.several]).toEqual(['several', ['alex', 'sam']]);
    // Never a2, and never more than the row: $25 of the $35, and Sam's $20.
    expect(p.allocations).toEqual([{ item: 'a', amount: 25 }, { item: 's', amount: 20 }]);
    // Alex alone paying the balance: the same, as Confirm takes it.
    const [one] = proposals([rowOf('v', -25, { name: 'VENMO CASHOUT ALEX SMITH' })], [alex], states_);
    expect([one.fit, one.allocations]).toEqual(['balance', [{ item: 'a', amount: 25 }]]);
  });
});

describe('what is never proposed, and ambiguity', () => {
  const items = states([share('a', 'alex', 20), share('s', 'sam', 20)]);

  test('one row that fits two people in one tier says so and preselects neither', () => {
    const list = proposals([rowOf('v', -20)], [alex, { ...sam, app: 'venmo' }], items);
    expect(list.map((p) => [p.person, p.tier, p.preselect, p.also])).toEqual([
      ['alex', 'strong', false, ['sam']],
      ['sam', 'strong', false, ['alex']],
    ]);
  });

  test('pending, another currency, dismissed, already a payment, shared, before the oldest item, past the window; an archived person with something open is matched', () => {
    const v = (over: Partial<MatchRow>) => rowOf('v', -20, over);
    const only = [alex];
    expect(proposals([v({ pending: true })], only, items)).toEqual([]);
    expect(proposals([v({ iso_currency_code: 'EUR' })], only, items)).toEqual([]);
    expect(proposals([v({})], only, items, { dismissed: new Set(['v']) })).toEqual([]);
    expect(proposals([v({})], only, items, { paying: new Set(['v']) })).toEqual([]);
    expect(proposals([v({ shared: {} })], only, items)).toEqual([]);
    expect(proposals([v({ date: '2026-10-01' })], only, items)).toEqual([]);
    expect(proposals([v({ date: '2026-12-01' })], only, items)).toEqual([]);
    // Archived, with something open all the same (archived on one device as
    // something was shared on another): matched as anyone is.
    expect(proposals([v({})], [{ ...alex, archived: true }], items).length).toBeGreaterThan(0);
  });

  test('ranked the same on every device', () => {
    const many = states([share('a', 'alex', 20), share('b', 'alex', 15, '2026-10-04')]);
    const rows = [rowOf('z2', -20), rowOf('z1', -20), rowOf('y', -15, { name: 'DEPOSIT' })];
    const a = proposals(rows, [alex], many).map((p) => p.row);
    const b = proposals([...rows].reverse(), [alex], many).map((p) => p.row);
    expect(a).toEqual(b);
  });
});
