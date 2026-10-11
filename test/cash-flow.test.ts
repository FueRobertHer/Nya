import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cashFlow,
  cashFlowNotes,
  flowGraph,
  historyNote,
  inPeriod,
  lastDayOf,
  payerKey,
  periodCaption,
  periodOf,
  rowIdsOf,
  windowStart,
  PERIODS,
  WINDOW_DAYS,
  type CashFlow,
  type FlowRow,
} from '@/lib/cash-flow';
import { layoutSankey } from '@/lib/sankey';
import { summarize, spendingByCategory, tidy } from '@/lib/totals';
import { countsInTotals } from '@/lib/spending';
import { spendingByGroup } from '@/lib/budget-set';
import { addCategory, addGroup, categoryById, filedId, groupOf, indexTaxonomy } from '@/lib/categories';
import { localDate } from '@/lib/local-date';
import { categoriesFor } from './category-fixture';

// Where money came from and where it went (lib/cash-flow.ts, #41): the flows
// the cash flow chart draws and the API answers, held to the totals every
// other view uses (lib/totals.ts summarize and spendingByCategory), to the
// cent, over rows with every way a transaction can be left out; the chart's
// folds, its deficit and left over; the periods and their time zones; and
// what is said beside it.

const { taxonomy } = categoriesFor({}, { words: ['groceries', 'coffee'], groups: { groceries: 'Food', coffee: 'Food' } });
const ix = indexTaxonomy(taxonomy);
const named = (name: string) => taxonomy.categories.find((c) => c.name === name)!.id;

let n = 0;
const row = (date: string, name: string, amount: number, over: Partial<FlowRow> = {}): FlowRow => ({
  transaction_id: `t${++n}`,
  date,
  name,
  amount,
  category: 'general merchandise',
  transaction_code: null,
  iso_currency_code: 'USD',
  ...over,
});

/** A September with a bit of everything: pay from one employer written two
 *  ways, interest, a refund, a SimpleFIN deposit with no category, spending
 *  in four groups, an import, a pending charge, and every way a row is left
 *  out of the totals. */
const SEPTEMBER: FlowRow[] = [
  row('2026-09-01', 'ACME CORP', -3000, { category: 'income' }),
  row('2026-09-15', 'Acme  Corp', -3000, { category: 'income' }),
  row('2026-09-30', 'Interest', -2.5, { category: 'income' }),
  row('2026-09-12', 'Shop', -20), // a refund, under the shop's own category
  row('2026-09-20', 'DEPOSIT ACME', -500, { category: null, source: 'simplefin' }), // says nothing of itself
  row('2026-09-03', 'Market', 120.4, { category: 'groceries' }),
  row('2026-09-03', 'Cafe', 4.5, { category: 'coffee' }),
  row('2026-09-01', 'Landlord', 1500, { category: 'rent and utilities' }),
  row('2026-09-05', 'Bank', 35, { category: 'bank fees' }), // a fee is spending
  row('2026-09-06', 'To savings', 500, { category: 'transfer out', transaction_code: 'transfer' }),
  row('2026-09-06', 'ATM', 100, { transaction_code: 'atm' }),
  row('2026-09-07', 'Mortgage', 900, { category: 'loan payments' }),
  row('2026-09-08', 'Car', 20000, { excluded: true }),
  row('2026-09-08', 'Gym', 50, { excluded: true, excluded_by_rule: true }),
  row('2026-09-09', 'Snacks', 7, { category: 'food and drink', excluded: null }), // couldn't be read: counts
  row('2026-09-10', 'Paris', 50, { category: 'travel', iso_currency_code: 'EUR' }),
  row('2026-09-10', 'Old row', 9, { category: 'other', iso_currency_code: null }), // no currency: the totals'
  row('2026-09-11', 'Hardware store', 60, { category: 'home improvement', source: 'import:csv' }),
  row('2026-09-11', 'POS 1234', 25, { category: null, source: 'simplefin' }),
  row('2026-09-14', 'Payroll correction', 100, { category: 'income' }), // money out, under an income category
  row('2026-09-29', 'Pending lunch', 12, { category: 'food and drink' }),
  row('2026-08-31', 'Market', 999, { category: 'groceries' }), // August
];
const sep = periodOf('last-month', '2026-10-11');
const inSep = inPeriod(sep);
const flow = cashFlow(SEPTEMBER, inSep, 'USD', ix);
const bucket = (t: Pick<FlowRow, 'category' | 'category_id'>) => filedId(ix, t);

describe('one source of truth: the totals’ own figures, to the cent', () => {
  test('money in, out and net are summarize’s, the Activity tab’s month', () => {
    const s = summarize(SEPTEMBER, inSep, 'USD');
    expect([flow.money_in, flow.money_out, flow.net]).toEqual([s.money_in, s.money_out, s.net]);
    expect(flow.money_in).toBe(6522.5);
    expect(flow.money_out).toBe(1872.9);
    expect(flow.net).toBe(4649.6);
    expect([flow.left_over, flow.from_savings_or_debt]).toEqual([4649.6, 0]);
  });

  test('the payers add up to money in, and the groups to money out', () => {
    expect(tidy(flow.payers.reduce((a, p) => a + p.amount, 0))).toBe(flow.money_in);
    expect(tidy(flow.groups.reduce((a, g) => a + g.amount, 0))).toBe(flow.money_out);
    for (const g of flow.groups) expect([g.name, tidy(g.categories.reduce((a, c) => a + c.amount, 0))]).toEqual([g.name, g.amount]);
  });

  test('spending by category is the Budgets tab’s and the API’s (spendingByCategory, by the category each row is filed under)', () => {
    const budgets = spendingByCategory(SEPTEMBER, inSep, 'USD', bucket);
    const chart = Object.fromEntries(flow.groups.flatMap((g) => g.categories.map((c) => [c.id, c.amount])));
    expect(chart).toEqual(Object.fromEntries(Object.entries(budgets).map(([id, v]) => [id, tidy(v)])));
    // By group, as the Activity tab's top spending rolls them up.
    const rolled = spendingByGroup(ix, new Map(Object.entries(budgets)));
    expect(flow.groups.map((g) => [g.id, g.amount])).toEqual(rolled.map((r) => [r.group.id, tidy(r.total)]));
  });

  test('with the rows filed by the server, the same: by their ids and kinds', () => {
    const filed = SEPTEMBER.map((t) => {
      const c = categoryById(ix, filedId(ix, t))!;
      return { ...t, category_id: c.id, category_name: t.category === null ? null : c.name, category_kind: groupOf(ix, c).kind };
    });
    const again = cashFlow(filed, inSep, 'USD', ix);
    expect(again.groups).toEqual(flow.groups);
    expect(again.payers).toEqual(flow.payers);
    expect(again.money_in).toBe(flow.money_in);
  });

  test('what is left out is counted as the totals count it, a rule’s hides apart', () => {
    expect(flow).toMatchObject({ transactions: 21, counted: 15, transfers: 3, excluded: 2, hidden_by_rule: 1, exclusion_unknown: 1, left_out: [{ currency: 'EUR', count: 1 }] });
    expect(flow.left_out_text).toBe("1 transaction in EUR isn't in these totals, which are in USD.");
    // Nothing left out is in any payer, group or category.
    const counted = new Set(SEPTEMBER.filter((t) => inSep(t.date) && countsInTotals(t, 'USD')).map((t) => t.transaction_id));
    const all = [...flow.payers.flatMap((p) => p.ids), ...flow.groups.flatMap((g) => g.ids)];
    expect(new Set(all)).toEqual(counted);
    expect(all.length).toBe(counted.size);
  });

  test('in another currency, only that currency’s rows, and those that say none', () => {
    const eur = cashFlow(SEPTEMBER, inSep, 'EUR', ix);
    expect([eur.money_in, eur.money_out]).toEqual([0, 59]);
    expect(eur.groups.map((g) => [g.name, g.amount])).toEqual([
      ['Travel and entertainment', 50],
      ['Other', 9],
    ]);
  });
});

describe('money in, by who paid it', () => {
  test('one payer whatever its capitals and spacing, most first, each with its rows', () => {
    expect(flow.payers.map((p) => [p.name, p.amount, p.transactions])).toEqual([
      ['ACME CORP', 6000, 2],
      ['DEPOSIT ACME', 500, 1],
      ['Shop', 20, 1],
      ['Interest', 2.5, 1],
    ]);
    expect(payerKey(' Acme\tCorp ')).toBe('acme corp');
    expect(flow.payers[0].ids).toEqual(['t1', 't2']);
  });

  test('a refund is money in, never less spending, and marked only when its row names a spending category', () => {
    const byName = Object.fromEntries(flow.payers.map((p) => [p.name, p.refund]));
    // Shop's money back is under general merchandise; the SimpleFIN deposit
    // says nothing, so it is never called a refund; pay is income.
    expect(byName).toEqual({ 'ACME CORP': false, 'DEPOSIT ACME': false, Shop: true, Interest: false });
    const shopping = flow.groups.find((g) => g.name === 'Shopping');
    expect(shopping).toBeUndefined();
  });

  test('money out under an income category is money out, as the totals count it', () => {
    expect(flow.groups.find((g) => g.name === 'Income')).toMatchObject({ kind: 'income', amount: 100 });
  });

  test('SimpleFIN and imported rows count like a bank’s: an uncategorized one under the uncategorized category', () => {
    const other = flow.groups.find((g) => g.name === 'Other')!;
    expect(other.categories).toEqual([{ id: taxonomy.uncategorized, name: 'other', amount: 34, transactions: 2, ids: expect.any(Array) }]);
    expect(flow.groups.find((g) => g.name === 'Housing')!.categories.map((c) => [c.name, c.amount])).toEqual([
      ['rent and utilities', 1500],
      ['home improvement', 60],
    ]);
  });
});

/** A flow with these payers, and these groups (made for it, spending) with
 *  their categories' amounts, each category named for its group. */
function flowWith(payers: number[], groups: Record<string, number[]>): CashFlow {
  let id = 0;
  const newId = () => `x${++id}`;
  let t = categoriesFor({}).taxonomy;
  for (const [group, amounts] of Object.entries(groups)) {
    const made = addGroup(t, { name: group, kind: 'expense' }, newId);
    t = made.taxonomy;
    amounts.forEach((_, i) => {
      t = addCategory(t, { name: `${group} ${i}`, group: made.group.id }, newId).taxonomy;
    });
  }
  const rows: FlowRow[] = [
    ...payers.map((amount, i) => row('2026-09-02', `Payer ${i + 1}`, -amount, { category: 'income' })),
    ...Object.entries(groups).flatMap(([group, amounts]) => amounts.map((amount, i) => row('2026-09-03', `${group} ${i}`, amount, { category: `${group} ${i}` }))),
  ];
  return cashFlow(rows, inSep, 'USD', indexTaxonomy(t));
}

describe('the chart’s nodes and links', () => {
  test('four columns: payers, everything counted, the groups and the left over, their categories', () => {
    const g = flowGraph(flow);
    expect(g.total).toBe(flow.money_in);
    expect(g.nodes.filter((x) => x.column === 0).map((x) => x.label)).toEqual(['ACME CORP', 'DEPOSIT ACME', 'Other income']);
    expect(g.nodes.filter((x) => x.column === 1).map((x) => x.id)).toEqual(['total']);
    expect(g.nodes.filter((x) => x.column === 2).map((x) => x.label)).toEqual(['Housing', 'Food', 'Income', 'Services and fees', 'Other', 'Left over']);
    // Groups under 3% of the flow (6,522.50 in) end at their group: only
    // Housing goes on, its one small category drawn as itself.
    expect(g.nodes.filter((x) => x.column === 3).map((x) => x.label)).toEqual(['Rent and utilities', 'Home improvement']);
    // Every link runs forward: the layout takes them all.
    expect(() => layoutSankey(g.nodes, g.links)).not.toThrow();
  });

  test('every node’s amount is what its links carry, in and out alike', () => {
    const g = flowGraph(flow);
    const l = layoutSankey(g.nodes, g.links);
    for (const x of g.nodes) expect([x.id, Math.abs(l.nodes.find((b) => b.id === x.id)!.value - x.value) < 1e-6]).toEqual([x.id, true]);
    const into = (id: string) => tidy(g.links.filter((k) => k.target === id).reduce((a, k) => a + k.value, 0));
    const outOf = (id: string) => tidy(g.links.filter((k) => k.source === id).reduce((a, k) => a + k.value, 0));
    expect(into('total')).toBe(outOf('total'));
    expect(into('total')).toBe(flow.money_in);
  });

  test('small payers fold into Other income, which says whom it holds; the largest stand alone', () => {
    const f = flowWith([5000, 300, 100, 50, 40, 30, 20, 10], { Eating: [1000] });
    const g = flowGraph(f);
    const sources = g.nodes.filter((x) => x.column === 0);
    expect(sources.map((x) => x.label)).toEqual(['Payer 1', 'Payer 2', 'Other income']);
    expect(sources[2]).toMatchObject({ kind: 'other-income', value: 250, transactions: 6 });
    expect(sources[2].members!.map((m) => m.name)).toEqual(['Payer 3', 'Payer 4', 'Payer 5', 'Payer 6', 'Payer 7', 'Payer 8']);
    expect(sources[2].ids).toHaveLength(6);
  });

  test('one small payer alone is drawn as itself, never folded', () => {
    const g = flowGraph(flowWith([5000, 100], { Eating: [1000] }));
    expect(g.nodes.filter((x) => x.column === 0).map((x) => x.label)).toEqual(['Payer 1', 'Payer 2']);
  });

  test('at most six payers stand alone, however large the rest', () => {
    const g = flowGraph(flowWith([1800, 1700, 1600, 1500, 1400, 1300, 1200, 1100], { Eating: [1000] }));
    const sources = g.nodes.filter((x) => x.column === 0);
    expect(sources.map((x) => x.label)).toEqual(['Payer 1', 'Payer 2', 'Payer 3', 'Payer 4', 'Payer 5', 'Payer 6', 'Other income']);
    expect(sources[6].value).toBe(2300);
  });

  test('a group’s small categories fold into Other, in that group, saying which; one alone stays itself', () => {
    const g = flowGraph(flowWith([3000], { Eating: [450, 10, 8, 7], Fun: [500, 20] }));
    const cats = g.nodes.filter((x) => x.column === 3);
    // Groups most first: Fun (520) then Eating (475), each with its own.
    expect(cats.map((x) => x.label)).toEqual(['Fun 0', 'Fun 1', 'Eating 0', 'Other']);
    const other = cats[3];
    expect(other).toMatchObject({ kind: 'other-categories', value: 25, transactions: 3 });
    expect(other.members!.map((m) => [m.name, m.amount])).toEqual([
      ['Eating 1', 10],
      ['Eating 2', 8],
      ['Eating 3', 7],
    ]);
    // It flows from its own group, as the one small category beside Fun 0 does from Fun.
    const eating = g.nodes.find((x) => x.label === 'Eating')!;
    expect(g.links.find((k) => k.target === other.id)!.source).toBe(eating.id);
    expect(g.links.find((k) => k.target === cats[1].id)!.source).toBe(g.nodes.find((x) => x.label === 'Fun')!.id);
  });

  test('a group under the threshold, or whose categories would all fold, ends at its group', () => {
    const g = flowGraph(flowWith([3000], { Home: [1500], Fees: [20, 15], Shop: [40, 40, 40, 40, 40] }));
    expect(g.nodes.filter((x) => x.column === 2).map((x) => x.label)).toEqual(['Home', 'Shop', 'Fees', 'Left over']);
    // Fees is 1% of the flow; Shop is 7%, but each of its five is 1%.
    expect(g.nodes.filter((x) => x.column === 3).map((x) => x.label)).toEqual(['Home 0']);
    expect(g.links.filter((k) => k.source !== 'total' && k.target !== 'total').map((k) => k.target)).toEqual([g.nodes.find((x) => x.label === 'Home 0')!.id]);
  });

  test('more out than in: the difference comes from savings or debt, a node beside the payers, never a link back', () => {
    const f = flowWith([1000], { Eating: [900], Home: [600] });
    expect([f.net, f.from_savings_or_debt, f.left_over]).toEqual([-500, 500, 0]);
    const g = flowGraph(f);
    const deficit = g.nodes.find((x) => x.kind === 'deficit')!;
    expect(deficit).toMatchObject({ column: 0, value: 500, label: 'From savings or debt', ids: null });
    expect(g.nodes.some((x) => x.kind === 'left-over')).toBe(false);
    expect(g.links.find((k) => k.source === 'deficit')).toEqual({ source: 'deficit', target: 'total', value: 500 });
    // The middle carries what was spent; nothing runs from a group back.
    const l = layoutSankey(g.nodes, g.links);
    expect(l.nodes.find((b) => b.id === 'total')!.value).toBe(1500);
    for (const k of l.links) expect(l.nodes.find((b) => b.id === k.target)!.column).toBeGreaterThan(l.nodes.find((b) => b.id === k.source)!.column);
    // At the foot of the payers.
    expect(g.nodes.filter((x) => x.column === 0).map((x) => x.kind)).toEqual(['payer', 'deficit']);
  });

  test('a month with nothing in: everything spent came from savings or debt', () => {
    const g = flowGraph(flowWith([], { Eating: [400] }));
    expect(g.nodes.filter((x) => x.column === 0).map((x) => [x.kind, x.value])).toEqual([['deficit', 400]]);
    expect(g.total).toBe(400);
    expect(layoutSankey(g.nodes, g.links).nodes.length).toBe(4);
  });

  test('in and out exactly even: neither a left over nor a deficit', () => {
    const g = flowGraph(flowWith([500], { Eating: [500] }));
    expect(g.nodes.map((x) => x.kind)).toEqual(['payer', 'total', 'group', 'category']);
  });

  test('an empty month draws nothing, without an error', () => {
    const empty = cashFlow(SEPTEMBER, (d) => d === '2027-01-01', 'USD', ix);
    expect([empty.money_in, empty.money_out, empty.payers, empty.groups]).toEqual([0, 0, [], []]);
    expect(flowGraph(empty)).toEqual({ nodes: [], links: [], total: 0 });
    expect(layoutSankey([], []).nodes).toEqual([]);
  });

  test('a payer with no name is called so, never given one', () => {
    const f = cashFlow([row('2026-09-02', '  ', -100, { category: 'income' })], inSep, 'USD', ix);
    expect(flowGraph(f).nodes[0].label).toBe('No name');
  });
});

describe('the rows behind a node: what a tap shows', () => {
  const g = flowGraph(flow);
  const amountOf = (ids: readonly string[]) => tidy(SEPTEMBER.filter((t) => ids.includes(t.transaction_id)).reduce((a, t) => a + Math.abs(t.amount), 0));

  test('a payer, a group, a category, a fold: exactly the rows it sums', () => {
    for (const x of g.nodes) {
      if (!x.ids || x.kind === 'total') continue;
      expect([x.id, amountOf(x.ids)]).toEqual([x.id, x.value]);
    }
    expect(rowIdsOf(flow, g, 'other-income')).toEqual(g.nodes.find((x) => x.id === 'other-income')!.ids);
  });

  test('everything counted: every row in the chart, in and out', () => {
    expect(new Set(rowIdsOf(flow, g, 'total'))).toEqual(new Set([...flow.payers.flatMap((p) => p.ids), ...flow.groups.flatMap((x) => x.ids)]));
  });

  test('one the chart folds or leaves to its group is still found, from the table', () => {
    const fee = named('bank fees');
    expect(g.nodes.some((x) => x.id === `category:${fee}`)).toBe(false);
    expect(rowIdsOf(flow, g, `category:${fee}`)).toEqual(['t9']);
    expect(rowIdsOf(flow, g, `payer:${payerKey('Interest')}`)).toEqual(['t3']);
  });

  test('none for what is no transactions, or isn’t there', () => {
    expect(rowIdsOf(flow, g, 'left-over')).toBeNull();
    expect(rowIdsOf(flow, g, 'category:nope')).toBeNull();
    expect(rowIdsOf(flow, g, 'nonsense')).toBeNull();
  });
});

describe('the periods', () => {
  const months = (key: Parameters<typeof periodOf>[0], today: string) => periodOf(key, today).months;

  test('whole months, from the person’s own today: this month, last month, the last 3, the year to date, the last 12', () => {
    expect(periodOf('this-month', '2026-10-11')).toEqual({ key: 'this-month', months: ['2026-10'], from: '2026-10-01', to: '2026-10-31' });
    expect(periodOf('last-month', '2026-10-11')).toEqual({ key: 'last-month', months: ['2026-09'], from: '2026-09-01', to: '2026-09-30' });
    expect(months('last-3-months', '2026-10-11')).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(months('year-to-date', '2026-10-11')).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    const year = periodOf('last-12-months', '2026-10-11');
    expect([year.months.length, year.from, year.to]).toEqual([12, '2025-11-01', '2026-10-31']);
    expect(PERIODS.map((p) => p.key)).toEqual(['this-month', 'last-month', 'last-3-months', 'year-to-date', 'last-12-months']);
  });

  test('across a new year, and in a leap year', () => {
    expect(months('last-month', '2027-01-05')).toEqual(['2026-12']);
    expect(months('last-3-months', '2027-01-05')).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(months('year-to-date', '2027-01-05')).toEqual(['2027-01']);
    expect(periodOf('this-month', '2028-02-29').to).toBe('2028-02-29');
    expect(periodOf('last-12-months', '2028-02-29').from).toBe('2027-03-01');
    expect([lastDayOf('2026-02'), lastDayOf('2028-02'), lastDayOf('2026-12'), lastDayOf('2026-04')]).toEqual(['2026-02-28', '2028-02-29', '2026-12-31', '2026-04-30']);
  });

  test('this month is the person’s own, whatever UTC says: the last evening of October is still October', () => {
    // Built from local components, so these hold in whatever zone the tests run in.
    expect(periodOf('this-month', localDate(new Date(2026, 9, 31, 23, 45))).months).toEqual(['2026-10']);
    expect(periodOf('this-month', localDate(new Date(2026, 10, 1, 0, 10))).months).toEqual(['2026-11']);
    expect(periodOf('last-month', localDate(new Date(2026, 0, 1, 0, 5))).months).toEqual(['2025-12']);
  });

  test('a row counts in a period by the day it is dated, the bank’s, never moved', () => {
    const p = periodOf('this-month', '2026-10-11');
    expect([inPeriod(p)('2026-09-30'), inPeriod(p)('2026-10-01'), inPeriod(p)('2026-10-31'), inPeriod(p)('2026-11-01')]).toEqual([false, true, true, false]);
  });

  test('said by its months, with a year whenever it isn’t this one', () => {
    expect(periodCaption(periodOf('this-month', '2026-10-11'), '2026-10-11')).toBe('October');
    expect(periodCaption(periodOf('last-3-months', '2026-10-11'), '2026-10-11')).toBe('August to October');
    expect(periodCaption(periodOf('last-12-months', '2026-10-11'), '2026-10-11')).toBe('November 2025 to October 2026');
    expect(periodCaption(periodOf('last-month', '2027-01-05'), '2027-01-05')).toBe('December 2026');
  });
});

describe('the transactions held', () => {
  test('the window is the Activity tab’s own, the last 365 days by UTC day', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'lib', 'transactions.ts'), 'utf8');
    expect(Number(source.match(/export const LOOKBACK_DAYS = (\d+);/)![1])).toBe(WINDOW_DAYS);
    expect(windowStart(Date.parse('2026-10-11T12:00:00Z'))).toBe('2025-10-11');
    // Late in the evening west of Greenwich, UTC is already tomorrow.
    expect(windowStart(Date.parse('2026-11-01T03:00:00Z'))).toBe('2025-11-01');
  });

  test('a period reaching before the window says its first days aren’t in it', () => {
    // A leap day's evening in California: UTC is March 1, so the window starts
    // March 2 a year back, a day after the twelve months begin.
    const now = Date.parse('2028-03-01T04:00:00Z');
    const p = periodOf('last-12-months', '2028-02-29');
    expect(historyNote(p, [{ date: '2027-03-02' }], now)).toBe("Nya holds the last 365 days of transactions, from Mar 2, 2027 on, so this period's first days aren't in it.");
    expect(historyNote(periodOf('last-3-months', '2028-02-29'), [{ date: '2027-03-02' }], now)).toBeNull();
  });

  test('one starting before the earliest transaction there is says it may be missing what came before', () => {
    const now = Date.parse('2026-10-11T12:00:00Z');
    const ytd = periodOf('year-to-date', '2026-10-11');
    expect(historyNote(ytd, [{ date: '2026-08-03' }, { date: '2026-10-01' }], now)).toBe('The earliest transaction here is from Aug 3, 2026, so this period may be missing what came before it.');
    expect(historyNote(ytd, [{ date: '2025-12-30' }], now)).toBeNull();
    // With nothing at all, nothing is said of a history: the chart says there is nothing.
    expect(historyNote(ytd, [], now)).toBeNull();
  });
});

describe('what is said beside the chart', () => {
  const day = (iso: string) => iso.slice(5, 10);
  const notes = (over: Partial<Parameters<typeof cashFlowNotes>[0]> = {}) =>
    cashFlowNotes({ flow, period: sep, rows: SEPTEMBER, today: '2026-10-11', now: Date.parse('2026-10-11T12:00:00Z'), day, ...over });

  test('what it leaves out, by the totals’ rules: transfers, exclusions, a rule’s hides, unreadable exclusions, other currencies, refunds', () => {
    expect(notes().counted).toEqual([
      'Transfers, cash withdrawals and loan payments are left out, as in every total (3 here). So are 1 transaction you excluded and 1 a rule hides.',
      "Whether you excluded 1 transaction couldn't be read, so it counts here.",
      "1 transaction in EUR isn't in these totals, which are in USD.",
      'A refund counts as money in, as in every total, never as less spending in its category.',
    ]);
    const plain = cashFlow([row('2026-09-02', 'Pay', -10, { category: 'income' })], inSep, 'USD', ix);
    expect(notes({ flow: plain }).counted).toEqual(['Transfers, cash withdrawals and loan payments are left out, as in every total.']);
  });

  test('connections that may leave it short, with the months they touch', () => {
    const q = periodOf('last-3-months', '2026-10-11');
    const n3 = (o: Partial<Parameters<typeof cashFlowNotes>[0]>) => notes({ period: q, flow: cashFlow(SEPTEMBER, inPeriod(q), 'USD', ix), ...o }).gaps;
    expect(n3({ stopped: [{ institution_name: 'Chase', last_ok_at: '2026-09-12T15:00:00.000Z' }] })).toContain(
      "Chase hasn't synced since 09-12, so September and October may be missing some of its transactions."
    );
    expect(n3({ stopped: [{ institution_name: 'Amex', last_ok_at: null }] })).toContain("Amex isn't syncing, so this period may be missing some of its transactions.");
    expect(n3({ incomplete: [{ institution_name: 'Chase', coverage: 'missing' }] })).toContain(
      "Doesn't include Chase: its transactions couldn't be loaded, so this period may be incomplete."
    );
    expect(n3({ incomplete: [{ institution_name: 'Amex', coverage: 'importing' }] })).toContain('Amex is still importing older transactions, so this period may be incomplete.');
    // A month that ended before the connection last answered is as complete as it was.
    expect(n3({ stopped: [{ institution_name: 'Chase', last_ok_at: '2026-11-02T15:00:00.000Z' }] }).join(' ')).not.toContain('Chase');
    // A single month is named.
    expect(notes({ stopped: [{ institution_name: 'Chase', last_ok_at: '2026-09-12T15:00:00.000Z' }] }).gaps).toContain(
      "Chase hasn't synced since 09-12, so September may be missing some of its transactions."
    );
  });

  test('a bank account or card whose transactions don’t come in is named; a 401(k) never is', () => {
    const view = {
      without: [
        { item_id: 'a', institution_name: 'Credit Union', reason: 'refused' as const },
        { item_id: 'b', institution_name: 'Big Bank', reason: 'no_consent' as const },
        { item_id: 'c', institution_name: 'Empower', reason: 'investment_accounts' as const },
      ],
      connections: 4,
    };
    const gaps = notes({ view }).gaps.join(' ');
    expect(gaps).toContain("Doesn't include the bank or card accounts at Credit Union: Plaid doesn't provide their transactions, so September may be incomplete.");
    expect(gaps).toContain("Doesn't include the bank or card accounts at Big Bank: you didn't allow Nya to see their transactions, so September may be incomplete. To bring them in, choose Allow transactions on the Accounts tab.");
    expect(gaps).not.toContain('Empower');
  });

  test('SimpleFIN rows counted without a category, and a period before the history, say so', () => {
    expect(notes().gaps).toContain('2 transactions from SimpleFIN have no category, so they count as spending or income. A move between two of your SimpleFIN accounts is left out on its own; categorize any other card payment or move between your accounts as a transfer to leave it out too.');
    const ytd = periodOf('year-to-date', '2026-10-11');
    expect(notes({ period: ytd }).gaps).toContain('The earliest transaction here is from Aug 31, 2026, so this period may be missing what came before it.');
  });

  test('nothing to say of gaps when nothing is missing', () => {
    const clean = [row('2026-09-02', 'Pay', -10, { category: 'income' }), row('2026-08-02', 'Older', 5)];
    expect(notes({ rows: clean, flow: cashFlow(clean, inSep, 'USD', ix) }).gaps).toEqual([]);
  });
});
