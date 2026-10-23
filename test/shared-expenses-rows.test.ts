import { describe, expect, test } from 'bun:test';
import { applyShares, isLayerRow, type ShareInputs } from '@/lib/shared-expenses/rows';
import type { Iou, Payment, Share } from '@/lib/shared-expenses/model';
import { bankRows, expandSplitsAndGroups } from '@/lib/split-rows';
import { indexTaxonomy, seedTaxonomy, textKeys, type Taxonomy } from '@/lib/categories';
import { summarize, spendingByCategory } from '@/lib/totals';
import { countTransactions, isHistoryRow, totalsCurrency } from '@/lib/spending';
import type { SplitRecord } from '@/lib/splits';
import type { TxnGroup } from '@/lib/groups';
import type { Txn } from '@/lib/transactions';

// Shared expenses applied on read (lib/shared-expenses/rows.ts): your part
// of a shared transaction counts, the others' parts and what was paid back
// count in no total, an IOU you owe for something counts once on its day,
// every bank row's rows add up to it, and bankRows puts each back whole.

let n = 0;
const taxonomy: Taxonomy = seedTaxonomy(textKeys(['groceries', 'household', 'restaurants', 'transfer in']), () => `c${++n}`);
const ix = indexTaxonomy(taxonomy);
const cat = (name: string) => taxonomy.categories.find((c) => c.name === name)!.id;
const kindOf = (id: string) => taxonomy.groups.find((g) => g.id === taxonomy.categories.find((c) => c.id === id)!.group)!.kind;
const AT = '2026-10-03T12:00:00.000Z';

function row(id: string, over: Partial<Txn> = {}): Txn {
  const category = over.category_id ?? cat('restaurants');
  const c = taxonomy.categories.find((x) => x.id === category)!;
  return {
    transaction_id: id,
    date: '2026-10-03',
    name: 'Joe’s',
    amount: 120,
    pending: false,
    account_name: 'Card',
    account_type: 'credit',
    institution_name: 'Chase',
    category: c.provider_keys.find((k) => k.provider === 'text')!.key,
    category_id: category,
    category_name: c.name,
    category_kind: kindOf(category),
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    vendor_key: 'joes',
    logo_url: null,
    category_icon_url: null,
    subcategory: null,
    category_confidence: null,
    transaction_code: null,
    payment_channel: 'in store',
    datetime: null,
    website: null,
    check_number: null,
    account_owner: null,
    city: null,
    region: null,
    counterparty: null,
    payment_processor: null,
    payment_reference: null,
    account_id: 'acc-card',
    needs_review: true,
    ...over,
  };
}

const venmoIn = (id: string, amount: number, over: Partial<Txn> = {}) =>
  row(id, { name: 'VENMO CASHOUT', amount, date: '2026-10-09', category_id: cat('transfer in'), transaction_code: 'transfer', account_id: 'acc-checking', account_name: 'Checking', account_type: 'depository', ...over });

const share = (entries: Share['entries'], over: Partial<Share> = {}): Share => ({ version: 1, account_id: 'acc-card', amount_was: 120, currency: 'USD', date: '2026-10-03', what: 'Dinner', entries, created_at: AT, updated_at: AT, ...over });
const iou = (over: Partial<Iou> = {}): Iou => ({ version: 1, person: 'alex', direction: 'by_you', amount: 25, currency: 'USD', date: '2026-10-05', what: 'Groceries', category_id: cat('groceries'), created_at: AT, updated_at: AT, ...over });
const payment = (amount: number, allocations: Payment['allocations'], over: Partial<Payment> = {}): Payment => ({ version: 1, account_id: 'acc-checking', row: { amount, currency: 'USD', date: '2026-10-09' }, allocations, confirmed_at: AT, ...over });

function inputs(over: Partial<ShareInputs> = {}): ShareInputs {
  return { counting: 'part', shares: new Map(), sharesUnknown: new Set(), payments: new Map(), paymentsUnknown: new Set(), ious: new Map(), iousUnread: 0, ix, ...over };
}

const october = (d: string) => d.startsWith('2026-10');
const units = (rows: readonly Txn[]) => rows.reduce((s, t) => s + Math.round(t.amount * 100), 0);

describe('your part counts, on the day it was bought', () => {
  const dinner = row('t-dinner');
  const shares = new Map([['t-dinner', share([{ id: 'e1', person: 'alex', amount: 60, how: { kind: 'half' } }])]]);

  test('a shared transaction counts your part; the other part is left out, and the bank row’s rows add up to it', () => {
    const { rows } = applyShares([dinner], inputs({ shares }));
    expect(rows.map((t) => [t.transaction_id, t.amount, t.excluded ?? false])).toEqual([
      ['t-dinner', 60, false],
      ['share:e1', 60, true],
    ]);
    expect(units(rows)).toBe(12000);
    expect(spendingByCategory(rows, october, 'USD')).toEqual({ [cat('restaurants')]: 60 });
    const s = summarize(rows, october, 'USD');
    expect([s.money_out, s.transactions, s.counted, s.excluded, s.shared]).toEqual([60, 1, 1, 0, 1]);
    // Reviewed once: the added row carries no review mark.
    expect(rows[1].needs_review).toBeUndefined();
    expect(rows[0].shared).toEqual({ your_part: 60, people: [{ person: 'alex', item: 'e1', amount: 60 }], counted: true });
  });

  test('bankRows puts it back whole, at the bank’s amount, with its rows beside it', () => {
    const { rows } = applyShares([dinner], inputs({ shares }));
    const whole = bankRows(rows);
    expect(whole).toHaveLength(1);
    expect(whole[0].amount).toBe(120);
    expect(whole[0].transaction_id).toBe('t-dinner');
    expect(whole[0].shared_was).toBeUndefined();
    expect(whole[0].shared_parts!.map((p) => p.amount)).toEqual([60, 60]);
    expect(whole[0].needs_review).toBe(true);
    expect(countTransactions(rows)).toBe(1);
  });

  test('a repayment confirmed counts its paid-back part nowhere, whatever its row is filed as', () => {
    const paid = new Map([['t-venmo', payment(-60, [{ item: 'e1', amount: 60 }])]]);
    // Filed as income by a rule: still not counted twice.
    const asIncome = venmoIn('t-venmo', -60, { transaction_code: null, category_id: cat('groceries'), category_kind: 'income' });
    for (const t of [venmoIn('t-venmo', -60), asIncome]) {
      const { rows } = applyShares([t, dinner], inputs({ shares, payments: paid }));
      const s = summarize(rows, october, 'USD');
      expect([s.money_in, s.money_out]).toEqual([0, 60]);
      expect(rows.find((r) => r.transaction_id === 't-venmo')!.amount).toBe(0);
      expect(bankRows(rows).find((r) => r.transaction_id === 't-venmo')!.amount).toBe(-60);
      expect(countTransactions(rows)).toBe(2);
    }
  });

  test('an IOU you owe for something counts once, on its day, in its category, however it is settled', () => {
    const ious = new Map([['i1', iou()]]);
    // Settled by a payment of yours (money out): the payment counts nowhere.
    const yours = row('t-pay', { name: 'Venmo', amount: 25, date: '2026-10-07', category_id: cat('transfer in'), transaction_code: 'transfer', account_id: 'acc-checking' });
    const byRow = applyShares([yours], inputs({ ious, payments: new Map([['t-pay', payment(25, [{ item: 'i1', amount: 25 }])]]) }));
    expect(spendingByCategory(byRow.rows, october, 'USD')).toEqual({ [cat('groceries')]: 25 });
    // Settled in cash: the IOU still counts once, and says how much was cash.
    const cash = new Map([['i1', iou({ closed: [{ event: 'ev', kind: 'outside', amount: 25, date: '2026-10-06', at: AT }] })]]);
    const byCash = applyShares([], inputs({ ious: cash }));
    expect(byCash.rows.map((t) => [t.transaction_id, t.amount, t.shared_iou?.cash])).toEqual([['iou:i1', 25, 25]]);
    // Let go: they gave it to you, so it counts nothing.
    const forgiven = new Map([['i1', iou({ closed: [{ event: 'ev', kind: 'forgiven', amount: 25, date: '2026-10-06', at: AT }] })]]);
    expect(applyShares([], inputs({ ious: forgiven })).rows).toEqual([]);
    // A loan (no category) and one owed to you count nothing.
    expect(applyShares([], inputs({ ious: new Map([['i2', iou({ category_id: undefined })], ['i3', iou({ direction: 'to_you', category_id: undefined })]]) })).rows).toEqual([]);
    // On no account, never a bank transaction, never evidence of history.
    const t = byCash.rows[0];
    expect(t.account_id).toBeUndefined();
    expect(bankRows(byCash.rows)).toEqual([]);
    expect(bankRows(byCash.rows, { ious: 'keep' })).toHaveLength(1);
    expect(isHistoryRow(t)).toBe(false);
    expect(isLayerRow(t)).toBe(true);
    // Dated before the read's first day: no row here.
    expect(applyShares([], inputs({ ious: cash, from: '2026-10-10' })).rows).toEqual([]);
  });

  test('one net payment closes both ways: their part of your dinner and your part of their groceries', () => {
    const ious = new Map([['i1', iou()]]);
    const net = venmoIn('t-net', -35);
    const { rows } = applyShares([net, dinner], inputs({ shares, ious, payments: new Map([['t-net', payment(-35, [{ item: 'e1', amount: 60 }, { item: 'i1', amount: 25 }])]]) }));
    expect(rows.filter((t) => t.shared_of === 't-net').map((t) => [t.transaction_id, t.amount])).toEqual([
      ['t-net', 0],
      ['settled:t-net:e1', -60],
      ['settled:t-net:i1', 25],
    ]);
    const s = summarize(rows, october, 'USD');
    // Your part of the dinner and your part of the groceries: $85, as the bank's -120 + 35 says.
    expect([s.money_in, s.money_out]).toEqual([0, 85]);
  });

  test('a split transaction shared from one part: the share comes off that part only', () => {
    const costco = row('t-costco', { amount: 150, name: 'Costco' });
    const split: SplitRecord = {
      version: 1,
      amount: 150,
      currency: 'USD',
      parts: [
        { id: 'p1', amount: 100, category_id: cat('groceries') },
        { id: 'p2', amount: 50, category_id: cat('household') },
      ],
      updated_at: AT,
    };
    const expanded = expandSplitsAndGroups([costco], { splits: new Map([['t-costco', split]]), splitsUnknown: new Set(), groups: new Map(), groupsUnknown: 0, ix }).rows;
    const { rows } = applyShares(expanded, inputs({ shares: new Map([['t-costco', share([{ id: 'e9', person: 'sam', amount: 50 }], { part: 'p1', amount_was: 100 })]]) }));
    expect(spendingByCategory(rows, october, 'USD')).toEqual({ [cat('groceries')]: 50, [cat('household')]: 50 });
    const whole = bankRows(rows);
    expect(whole).toHaveLength(1);
    expect(whole[0].amount).toBe(150);
    expect(whole[0].shared).toBeUndefined();
    expect(whole[0].split_parts!.filter((p) => !p.excluded).reduce((s, p) => s + p.amount, 0)).toBe(100);
    expect(countTransactions(rows)).toBe(1);
  });

  test('with `bank`, every total is what it is without shared expenses', () => {
    const paid = new Map([['t-venmo', payment(-60, [{ item: 'e1', amount: 60 }])]]);
    const plain = [venmoIn('t-venmo', -60, { transaction_code: null, category_kind: 'income' }), dinner];
    const { rows } = applyShares(plain, inputs({ counting: 'bank', shares, payments: paid, ious: new Map([['i1', iou()]]) }));
    expect(rows.map((t) => t.amount)).toEqual(plain.map((t) => t.amount));
    expect(summarize(rows, october, 'USD')).toEqual(summarize(plain, october, 'USD'));
    expect(rows[1].shared?.counted).toBe(false);
    // And so with a setting that can't be read, said in a note.
    const unread = applyShares(plain, inputs({ shares, settingsUnread: true }));
    expect(unread.rows.map((t) => t.amount)).toEqual([-60, 120]);
    expect(unread.notes[0]).toContain('couldn’t be read');
  });
});

describe('what no longer applies counts as the bank shows it, and says so', () => {
  test('a share on a grouped transaction, another currency, or more than the row now', () => {
    const dinner = row('t-dinner');
    const payback = venmoIn('t-back', -60);
    const group: TxnGroup = { version: 1, name: 'Dinner', category_id: cat('restaurants'), members: ['t-dinner', 't-back'], date: '2026-10-03', currency: 'USD', created_at: AT, updated_at: AT };
    const grouped = expandSplitsAndGroups([dinner, payback], { splits: new Map(), splitsUnknown: new Set(), groups: new Map([['g1', group]]), groupsUnknown: 0, ix }).rows;
    const shares = new Map([['t-dinner', share([{ id: 'e1', person: 'alex', amount: 60 }])]]);
    const inGroup = applyShares(grouped, inputs({ shares }));
    expect(inGroup.rows.map((t) => t.amount)).toEqual([60]);
    expect(inGroup.notes.some((x) => x.includes('changed since you shared'))).toBe(true);
    const euro = applyShares([row('t-dinner', { iso_currency_code: 'EUR' })], inputs({ shares }));
    expect(euro.rows.map((t) => [t.amount, t.shared_unapplied])).toEqual([[120, 'currency']]);
    const smaller = applyShares([row('t-dinner', { amount: 50 })], inputs({ shares }));
    expect(smaller.rows.map((t) => [t.amount, t.shared_unapplied])).toEqual([[50, 'amount']]);
  });

  test('a share and a payment on one row: the share wins, the payment is unapplied', () => {
    const { rows, notes } = applyShares(
      [row('t-x')],
      inputs({ shares: new Map([['t-x', share([{ id: 'e1', person: 'alex', amount: 60 }])]]), payments: new Map([['t-x', payment(120, [{ item: 'e1', amount: 60 }], { account_id: 'acc-card' })]]) })
    );
    expect(rows.map((t) => [t.transaction_id, t.amount])).toEqual([
      ['t-x', 60],
      ['share:e1', 60],
    ]);
    expect(rows[0].settles_unapplied).toBe('shared');
    expect(notes.some((x) => x.includes('no longer fit'))).toBe(true);
  });

  test('an allocation to an item since removed: that much counts as the row says', () => {
    const { rows, notes } = applyShares([venmoIn('t-v', -60, { transaction_code: null, category_kind: 'income' })], inputs({ payments: new Map([['t-v', payment(-60, [{ item: 'gone', amount: 60 }])]]) }));
    expect(rows.map((t) => t.amount)).toEqual([-60]);
    expect(notes.some((x) => x.includes('removed'))).toBe(true);
  });

  test('a share whose row is gone, as this read can tell, is named and noted, never dropped', () => {
    const others = [row('t-a', { date: '2026-10-01' }), row('t-b', { date: '2026-10-08' })];
    const shares = new Map([['t-gone', share([{ id: 'e1', person: 'alex', amount: 60 }])]]);
    const r = applyShares(others, inputs({ shares }));
    expect(r.gone.shares).toEqual(['t-gone']);
    expect(r.notes.some((x) => x.includes('isn’t in your accounts any more'))).toBe(true);
    // Its account hidden, or its rows not reaching its day: never called gone.
    expect(applyShares(others, inputs({ shares, hidden: new Set(['acc-card']) })).gone.shares).toEqual([]);
    expect(applyShares([others[1]], inputs({ shares })).gone.shares).toEqual([]);
    // Kept by the person: not again.
    expect(applyShares(others, inputs({ shares: new Map([['t-gone', share([{ id: 'e1', person: 'alex', amount: 60 }], { kept_gone: AT })]]) })).gone.shares).toEqual([]);
  });

  test('shared twice through an imported twin: the bank row’s own counts, and both are named', () => {
    const bank = row('t-bank');
    const shares = new Map([
      ['t-bank', share([{ id: 'e1', person: 'alex', amount: 60 }])],
      ['imported-txn:x', share([{ id: 'e2', person: 'alex', amount: 60 }])],
    ]);
    const r = applyShares([bank], inputs({ shares, stands: new Map([['t-bank', ['imported-txn:x']]]) }));
    expect(r.twice).toEqual([{ bank: 't-bank', imported: ['imported-txn:x'] }]);
    expect(r.rows[0].shared_twice).toEqual(['imported-txn:x']);
    expect(r.rows.map((t) => t.transaction_id)).toEqual(['t-bank', 'share:e1']);
    // Without its own, it takes the imported row's.
    const carried = applyShares([bank], inputs({ shares: new Map([['imported-txn:x', shares.get('imported-txn:x')!]]), stands: new Map([['t-bank', ['imported-txn:x']]]) }));
    expect(carried.rows[0].shared_carried_from).toBe('imported-txn:x');
    expect(carried.gone.shares).toEqual([]);
  });
});

describe('the rows this layer adds are no evidence and no vote', () => {
  test('they never change the totals’ currency', () => {
    const eur = Array.from({ length: 10 }, (_, i) => row(`e${i}`, { iso_currency_code: 'EUR' }));
    const usd = Array.from({ length: 9 }, (_, i) => row(`u${i}`));
    const shares = new Map(usd.slice(0, 3).map((t, i) => [t.transaction_id, share([{ id: `x${i}`, person: 'alex', amount: 60 }])] as const));
    const { rows } = applyShares([...eur, ...usd], inputs({ shares }));
    expect(totalsCurrency([...eur, ...usd])).toBe('EUR');
    expect(totalsCurrency(rows)).toBe('EUR');
  });

  test('money in from a payment app counted while someone owes you is noted', () => {
    const shares = new Map([['t-dinner', share([{ id: 'e1', person: 'alex', amount: 60 }])]]);
    const zelle = row('t-z', { name: 'Zelle payment from ALEX SMITH', amount: -60, category_kind: 'income', account_id: 'acc-checking' });
    const r = applyShares([zelle, row('t-dinner')], inputs({ shares }));
    expect(r.notes.some((x) => x.includes('payment in from a payment app counts as money in'))).toBe(true);
    // Said to be no repayment: not again.
    expect(applyShares([zelle, row('t-dinner')], inputs({ shares, dismissed: new Set(['t-z']) })).notes.some((x) => x.includes('payment app'))).toBe(false);
  });
});
