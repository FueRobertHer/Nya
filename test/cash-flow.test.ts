import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cashFlow,
  cashFlowNotes,
  drawnNodeOf,
  flowGraph,
  historyNote,
  inPeriod,
  lastDayOf,
  payerKey,
  periodCaption,
  periodOf,
  pickedRows,
  rowIdsOf,
  windowStart,
  PERIODS,
  WINDOW_DAYS,
  type CashFlow,
  type FlowRow,
} from '@/lib/cash-flow';
import { layoutSankey } from '@/lib/sankey';
import { summarize, spendingByCategory, tidy } from '@/lib/totals';
import { countsInTotals, countTransactions } from '@/lib/spending';
import { bankRows, expandSplitsAndGroups } from '@/lib/split-rows';
import type { SplitRecord } from '@/lib/splits';
import type { TxnGroup } from '@/lib/groups';
import type { Txn } from '@/lib/transactions';
import { spendingByGroup } from '@/lib/budget-set';
import { addCategory, addGroup, categoryById, filedId, groupOf, indexTaxonomy } from '@/lib/categories';
import { localDate } from '@/lib/local-date';
import { IMPORTED_TXN_PREFIX, importedRowsNote } from '@/lib/history-import/view';
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
    // The same flows, of rows filed otherwise.
    const shape = (f: CashFlow) => ({
      groups: f.groups.map((g) => ({ ...g, categories: g.categories.map(({ rows, ...c }) => ({ ...c, rows: rows.map((t) => t.transaction_id) })) })),
      payers: f.payers.map(({ rows, ...p }) => ({ ...p, rows: rows.map((t) => t.transaction_id) })),
    });
    expect(shape(again)).toEqual(shape(flow));
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
    expect(other.categories).toEqual([{ id: taxonomy.uncategorized, name: 'other', amount: 34, transactions: 2, ids: expect.any(Array), rows: expect.any(Array) }]);
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

  test('seven large payers are drawn as seven: the seventh would be alone in Other income', () => {
    const g = flowGraph(flowWith([1800, 1700, 1600, 1500, 1400, 1300, 1200], { Eating: [1000] }));
    expect(g.nodes.filter((x) => x.column === 0).map((x) => x.label)).toEqual(['Payer 1', 'Payer 2', 'Payer 3', 'Payer 4', 'Payer 5', 'Payer 6', 'Payer 7']);
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
    expect(deficit).toMatchObject({ column: 0, value: 500, label: 'Savings or debt', ids: null });
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

describe('what the chart marks for a pick from its table', () => {
  test('the node itself when drawn; for a folded payer Other income, for a folded category its group’s Other, else its group', () => {
    const f = flowWith([5000, 300, 100, 50], { Eating: [450, 10, 8], Fees: [20, 15] });
    const g = flowGraph(f);
    const eating = f.groups.find((x) => x.name === 'Eating')!;
    const fees = f.groups.find((x) => x.name === 'Fees')!;
    const big = f.payers[0];
    expect(drawnNodeOf(f, g, `payer:${big.key}`)).toBe(`payer:${big.key}`);
    expect(drawnNodeOf(f, g, `payer:${f.payers[3].key}`)).toBe('other-income');
    expect(drawnNodeOf(f, g, `category:${eating.categories[0].id}`)).toBe(`category:${eating.categories[0].id}`);
    expect(drawnNodeOf(f, g, `category:${eating.categories[2].id}`)).toBe(`other:${eating.id}`);
    // Fees is under 3%: it ends at its group, which holds its categories.
    expect(drawnNodeOf(f, g, `category:${fees.categories[0].id}`)).toBe(`group:${fees.id}`);
    expect(drawnNodeOf(f, g, `group:${fees.id}`)).toBe(`group:${fees.id}`);
    expect(drawnNodeOf(f, g, 'total')).toBe('total');
    // Nothing for one that isn't there.
    expect(drawnNodeOf(f, g, 'payer:nobody')).toBeNull();
    expect(drawnNodeOf(f, g, 'category:gone')).toBeNull();
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
    expect(historyNote(p, [{ date: '2027-03-02' }], now)).toBe("The Activity tab loads the last 365 days of transactions, from Mar 2, 2027 on, so this period's first days aren't in it.");
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

  test('a history reaching back to the window’s first days is no late start, however quiet the period’s first days', () => {
    // The last evening of October: the window starts October 31 a year back,
    // the twelve months on November 1, and the first transaction was November 3.
    const now = Date.parse('2026-10-31T18:00:00Z');
    const year = periodOf('last-12-months', '2026-10-31');
    expect(historyNote(year, [{ date: '2025-11-03' }, { date: '2026-10-20' }], now)).toBeNull();
    // A week in, still none; more than a week in, the history begins late.
    expect(historyNote(year, [{ date: '2025-11-07' }], now)).toBeNull();
    expect(historyNote(year, [{ date: '2025-11-08' }], now)).toBe('The earliest transaction here is from Nov 8, 2025, so this period may be missing what came before it.');
  });
});

describe('what is said beside the chart', () => {
  const day = (iso: string) => iso.slice(5, 10);
  const notes = (over: Partial<Parameters<typeof cashFlowNotes>[0]> = {}) =>
    cashFlowNotes({ flow, period: sep, rows: SEPTEMBER, today: '2026-10-11', now: Date.parse('2026-10-11T12:00:00Z'), day, ...over });

  test('what it leaves out, by the totals’ rules: transfers, exclusions, a rule’s hides, unreadable exclusions, other currencies, refunds', () => {
    expect(notes().counted).toEqual([
      "Transfers, cash withdrawals and loan payments are left out, as in the month's totals (3 here). So are 1 transaction you excluded and 1 a rule hides.",
      "Whether you excluded 1 transaction couldn't be read, so it counts here.",
      "1 transaction in EUR isn't in these totals, which are in USD.",
      "A refund counts as money in, as in the month's totals, never as less spending in its category.",
    ]);
    const plain = cashFlow([row('2026-09-02', 'Pay', -10, { category: 'income' })], inSep, 'USD', ix);
    expect(notes({ flow: plain }).counted).toEqual(["Transfers, cash withdrawals and loan payments are left out, as in the month's totals."]);
  });

  test('what the load couldn’t read comes first, each once, as a sentence', () => {
    const read = ["Manual accounts: couldn't be read, so transactions entered for them aren't shown", "Your rules couldn't be read, so none are applied until they can be: transactions show as the bank and you have them.", "Manual accounts: couldn't be read, so transactions entered for them aren't shown"];
    const gaps = notes({ read, stopped: [{ institution_name: 'Chase', last_ok_at: '2026-09-12T15:00:00.000Z' }] }).gaps;
    expect(gaps.slice(0, 2)).toEqual([
      "Manual accounts: couldn't be read, so transactions entered for them aren't shown.",
      "Your rules couldn't be read, so none are applied until they can be: transactions show as the bank and you have them.",
    ]);
    expect(gaps[2]).toContain("Chase hasn't synced since");
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

describe('rows imported into a linked account from its bank’s files (#52)', () => {
  // As the assembly gives them (lib/history-import/read.ts toDisplay): ids of
  // their own, the file's names, and its words or none, beside the bank's.
  // A row the bank sends later stands for its imported twin, which the
  // assembly then leaves out (test/cash-flow-imports.test.ts), so no row
  // here is another's twin.
  let k = 0;
  const imported = (date: string, name: string, amount: number, over: Partial<FlowRow> = {}): FlowRow =>
    row(date, name, amount, { transaction_id: `${IMPORTED_TXN_PREFIX}acc_chk:${++k}`, category: null, source: 'import:ofx', ...over });
  const FILES: FlowRow[] = [
    imported('2026-09-02', 'ACME CORP', -3000, { category: 'income' }), // the bank's payer, by its name
    imported('2026-09-04', 'OLD DEPOSIT', -500), // says nothing of itself
    imported('2026-09-05', 'CORNER SHOP', 60, { category: 'groceries' }), // filed by the file's words
    imported('2026-09-06', 'STORE', 40), // and by none: uncategorized
    imported('2026-09-07', 'CARD PAYMENT', 200, { category: 'transfer out', transaction_code: 'transfer' }), // left out, as a bank's
    imported('2026-08-30', 'EARLIER', 15), // August
  ];
  const rows = [...SEPTEMBER, ...FILES];
  const both = cashFlow(rows, inSep, 'USD', ix);
  const day = (iso: string) => iso.slice(5, 10);
  const notesOf = (period: typeof sep, over: Partial<Parameters<typeof cashFlowNotes>[0]> = {}) =>
    cashFlowNotes({ flow: cashFlow(rows, inPeriod(period), 'USD', ix), period, rows, today: '2026-10-11', now: Date.parse('2026-10-11T12:00:00Z'), day, ...over });

  test('money in, out and spending by category are still summarize’s and spendingByCategory’s, to the cent', () => {
    const s = summarize(rows, inSep, 'USD');
    expect([both.money_in, both.money_out, both.net, both.counted, both.transfers]).toEqual([s.money_in, s.money_out, s.net, s.counted, s.transfers]);
    expect([both.money_in, both.money_out]).toEqual([tidy(flow.money_in + 3500), tidy(flow.money_out + 100)]);
    const budgets = spendingByCategory(rows, inSep, 'USD', bucket);
    expect(Object.fromEntries(both.groups.flatMap((g) => g.categories.map((c) => [c.id, c.amount])))).toEqual(
      Object.fromEntries(Object.entries(budgets).map(([id, v]) => [id, tidy(v)]))
    );
    expect(both.groups.map((g) => [g.id, g.amount])).toEqual(spendingByGroup(ix, new Map(Object.entries(budgets))).map((r) => [r.group.id, tidy(r.total)]));
  });

  test('a deposit goes to the payer its name names, the bank’s own of that name among them, and a purchase to the category it is filed under', () => {
    const acme = both.payers.find((p) => p.key === 'acme corp')!;
    expect([acme.name, acme.amount, acme.transactions]).toEqual(['ACME CORP', 9000, 3]);
    expect(acme.ids).toEqual(['t1', 't2', FILES[0].transaction_id]);
    expect(both.payers.find((p) => p.key === 'old deposit')).toMatchObject({ name: 'OLD DEPOSIT', amount: 500, transactions: 1, refund: false });
    const category = (id: string) => both.groups.flatMap((g) => g.categories).find((c) => c.id === id)!;
    expect(category(named('groceries'))).toMatchObject({ amount: tidy(120.4 + 60), ids: [SEPTEMBER[5].transaction_id, FILES[2].transaction_id] });
    expect(category(taxonomy.uncategorized).ids).toContain(FILES[3].transaction_id);
    // The transfer is left out, as the bank's is; August's is August's.
    const all = [...both.payers.flatMap((p) => p.ids), ...both.groups.flatMap((g) => g.ids)];
    expect(all).not.toContain(FILES[4].transaction_id);
    expect(all).not.toContain(FILES[5].transaction_id);
  });

  test('a tap lists them in the Activity list, beside the bank’s', () => {
    const pick = (node: string, period = 'last-month' as const) => pickedRows(rows, { period, node, label: '' }, { ix, currency: 'USD', today: '2026-10-11' }).map((t) => t.transaction_id);
    expect(pick('payer:acme corp')).toEqual(['t1', 't2', FILES[0].transaction_id]);
    expect(pick('payer:old deposit')).toEqual([FILES[1].transaction_id]);
    expect(pick(`category:${named('groceries')}`)).toEqual([SEPTEMBER[5].transaction_id, FILES[2].transaction_id]);
  });

  test('the notes say how many of the period’s transactions were imported, counted or not, as the month’s totals do', () => {
    const said = notesOf(sep).counted;
    expect(said[said.length - 1]).toBe('5 of September’s transactions were imported from your bank’s files, not sent by the bank.');
    // The month's summary says it of the same rows: the same count.
    expect(importedRowsNote(rows.filter((t) => inSep(t.date)))).toBe('5 of this month’s transactions were imported from your bank’s files, not sent by the bank.');
    // Over several months, of the period; one is one.
    expect(notesOf(periodOf('last-3-months', '2026-10-11')).counted).toContain('6 of this period’s transactions were imported from your bank’s files, not sent by the bank.');
    const aug = periodOf('last-month', '2026-09-15');
    expect(notesOf(aug).counted).toContain('1 of August’s transactions was imported from your bank’s files, not sent by the bank.');
    // None imported, nothing said: a file imported into a manual account is
    // that account's own (SEPTEMBER's hardware store), as under the month.
    expect(cashFlowNotes({ flow, period: sep, rows: SEPTEMBER, today: '2026-10-11', now: Date.parse('2026-10-11T12:00:00Z'), day }).counted.join(' ')).not.toContain('imported');
  });

  test('months only the files reach don’t begin late, and what may be missing of each month is the Activity tab’s, whatever the files hold', () => {
    const now = Date.parse('2026-10-11T12:00:00Z');
    const ytd = periodOf('year-to-date', '2026-10-11');
    const bank = [row('2026-08-03', 'Shop', 5)];
    expect(historyNote(ytd, bank, now)).toBe('The earliest transaction here is from Aug 3, 2026, so this period may be missing what came before it.');
    expect(historyNote(ytd, [...bank, imported('2025-12-30', 'OLD STORE', 10)], now)).toBeNull();
    // Reaching some of the way, they move where the history begins.
    expect(historyNote(ytd, [...bank, imported('2026-03-02', 'OLD STORE', 10)], now)).toBe('The earliest transaction here is from Mar 2, 2026, so this period may be missing what came before it.');
    // A connection's gaps are lib/month-coverage.ts's of each month, which
    // read no rows: the same with the files' rows as without them, where only
    // the history's first day moves, to the file's August 30.
    const q = periodOf('last-3-months', '2026-10-11');
    const over = { stopped: [{ institution_name: 'Chase', last_ok_at: '2026-09-12T15:00:00.000Z' }], incomplete: [{ institution_name: 'Amex', coverage: 'importing' as const }] };
    const withFiles = notesOf(q, over).gaps;
    const without = cashFlowNotes({ ...over, flow: cashFlow(SEPTEMBER, inPeriod(q), 'USD', ix), period: q, rows: SEPTEMBER, today: '2026-10-11', now, day }).gaps;
    const begins = (gaps: string[]) => gaps.filter((g) => g.startsWith('The earliest transaction here'));
    const others = (gaps: string[]) => gaps.filter((g) => !g.startsWith('The earliest transaction here'));
    expect(others(withFiles)).toEqual(others(without));
    expect(others(withFiles)).toContain("Chase hasn't synced since 09-12, so September and October may be missing some of its transactions.");
    expect([begins(without), begins(withFiles)]).toEqual([
      ['The earliest transaction here is from Aug 31, 2026, so this period may be missing what came before it.'],
      ['The earliest transaction here is from Aug 30, 2026, so this period may be missing what came before it.'],
    ]);
  });
});

describe('split and grouped transactions (#39), as the read layer gives them', () => {
  const at = '2026-09-20T12:00:00.000Z';
  const split = (amount: number, parts: [number, string][]): SplitRecord => ({
    version: 1,
    amount,
    currency: 'USD',
    parts: parts.map(([a, c], i) => ({ id: `part-${i}-${c.replace(/\W/g, '')}`, amount: a, category_id: named(c) })),
    updated_at: at,
  });
  const group = (name: string, category: string, members: string[], date: string): TxnGroup => ({ version: 1, name, category_id: named(category), members, date, currency: 'USD', created_at: at, updated_at: at });
  /** Rows as lib/activity.ts finishActivity answers them: each split
   *  transaction as its parts, each group as its net. */
  const expand = (rows: FlowRow[], splits: Record<string, SplitRecord>, groups: Record<string, TxnGroup> = {}): FlowRow[] => {
    const done = expandSplitsAndGroups(rows as unknown as Txn[], { splits: new Map(Object.entries(splits)), splitsUnknown: new Set(), groups: new Map(Object.entries(groups)), groupsUnknown: 0, ix });
    expect(done.notes).toEqual([]);
    return done.rows as unknown as FlowRow[];
  };
  const by = (id: string, date: string, name: string, amount: number, category: string | null) => row(date, name, amount, { transaction_id: id, category });
  const BANK: FlowRow[] = [
    by('pay', '2026-09-01', 'ACME CORP', -3000, 'income'),
    // One charge, food and the house: two groups.
    by('costco', '2026-09-03', 'COSTCO', 300, 'general merchandise'),
    // Split, and the bank changed the amount since: up a dollar; down ten.
    by('flix', '2026-09-05', 'NETFLIX', 15.99, 'entertainment'),
    by('gym', '2026-09-06', 'GYM', 50, 'personal care'),
    // A dinner a friend paid half of; a trip reimbursed in full; tickets
    // paid back with more than they cost.
    by('dinner', '2026-09-10', 'DINER', 120, 'food and drink'),
    by('sam', '2026-09-11', 'SAM', -60, null),
    by('flight', '2026-09-12', 'AIRLINE', 400, 'travel'),
    by('reimbursed', '2026-09-14', 'EMPLOYER', -400, 'income'),
    by('tickets', '2026-09-15', 'TICKETS', 90, 'entertainment'),
    by('ann', '2026-09-16', 'ANN', -50, null),
    by('bo', '2026-09-17', 'BO', -50, null),
  ];
  const SPLITS = {
    costco: split(300, [
      [200, 'groceries'],
      [100, 'home improvement'],
    ]),
    flix: split(14.99, [
      [10, 'entertainment'],
      [4.99, 'general merchandise'],
    ]),
    gym: split(60, [
      [30, 'personal care'],
      [30, 'medical'],
    ]),
  };
  const GROUPS = {
    'g-dinner': group('Dinner with Sam', 'food and drink', ['dinner', 'sam'], '2026-09-10'),
    'g-trip': group('Work trip', 'travel', ['flight', 'reimbursed'], '2026-09-12'),
    'g-concert': group('Concert', 'entertainment', ['tickets', 'ann', 'bo'], '2026-09-15'),
  };
  const rows = expand(BANK, SPLITS, GROUPS);
  const split9 = cashFlow(rows, inSep, 'USD', ix);
  const categories = () => split9.groups.flatMap((g) => g.categories.map((c) => ({ ...c, group: g.name })));
  const category = (name: string) => categories().find((c) => c.name === name)!;

  test('money in, out, the counts and every category’s spending and transactions are the totals’ own, to the cent', () => {
    const s = summarize(rows, inSep, 'USD');
    expect([split9.money_in, split9.money_out, split9.net, split9.transactions, split9.counted]).toEqual([s.money_in, s.money_out, s.net, s.transactions, s.counted]);
    expect([split9.money_in, split9.money_out]).toEqual([3020, 435.99]);
    // Transactions, not rows: each split one once, each group as many as it holds.
    expect([split9.transactions, split9.counted]).toEqual([11, 11]);
    const budgets = spendingByCategory(rows, inSep, 'USD', bucket);
    expect(Object.fromEntries(categories().map((c) => [c.id, c.amount]))).toEqual(Object.fromEntries(Object.entries(budgets).map(([id, v]) => [id, tidy(v)])));
    expect(Object.fromEntries(categories().map((c) => [c.name, c.transactions]))).toEqual(Object.fromEntries(s.categories.map((c) => [c.category, c.transactions])));
    expect(split9.groups.map((g) => [g.id, g.amount])).toEqual(spendingByGroup(ix, new Map(Object.entries(budgets))).map((r) => [r.group.id, tidy(r.total)]));
  });

  test('a split transaction flows to each of its parts’ categories, two groups among them, and counts once on each side', () => {
    expect([category('groceries').group, category('groceries').amount, category('groceries').transactions]).toEqual(['Food', 200, 1]);
    expect([category('home improvement').group, category('home improvement').amount, category('home improvement').transactions]).toEqual(['Housing', 100, 1]);
    // Two parts of one transaction in one group are one of its transactions.
    expect(split9.groups.find((g) => g.name === 'Health and personal care')).toMatchObject({ amount: 60, transactions: 1 });
    // Money out: the charge, the subscription, the gym and the dinner's two.
    expect(split9.money_out_transactions).toBe(5);
    // Money in: the pay, the gym's money back and the concert's three.
    expect(split9.money_in_transactions).toBe(5);
    expect(countTransactions(rows.filter((t) => t.amount > 0))).toBe(split9.money_out_transactions);
  });

  test('what the bank changed a split amount by is a part of its own: more is spending in the transaction’s own category, less is money back from its payer', () => {
    expect(category('entertainment')).toMatchObject({ amount: 11, transactions: 1 });
    expect(split9.payers.find((p) => p.key === 'gym')).toMatchObject({ name: 'GYM', amount: 10, transactions: 1, refund: true });
  });

  test('a group counts once, at its net, in its own category: a payback in it is no payer, one netting to nothing flows nowhere, one netting to money in is a payer of its name', () => {
    expect(split9.payers.map((p) => [p.name, p.amount, p.transactions, p.refund])).toEqual([
      ['ACME CORP', 3000, 1, false],
      ['Concert', 10, 3, true],
      ['GYM', 10, 1, true],
    ]);
    expect(category('food and drink')).toMatchObject({ amount: 60, transactions: 2 });
    // The trip comes to nothing: counted, as the totals count it, in no flow.
    expect(categories().some((c) => c.name === 'travel')).toBe(false);
    expect(summarize(rows.filter((t) => t.transaction_id === 'group:g-trip'), inSep, 'USD')).toMatchObject({ counted: 2, money_in: 0, money_out: 0 });
  });

  test('a fold counts each transaction once, however many of its parts it holds', () => {
    const small = expand(
      [by('pay', '2026-09-01', 'PAY', -1000, 'income'), by('diner', '2026-09-02', 'DINER', 500, 'food and drink'), by('mart', '2026-09-03', 'MART', 20, 'general merchandise'), by('rent', '2026-09-04', 'LANDLORD', 400, 'rent and utilities')],
      {
        mart: split(20, [
          [12, 'groceries'],
          [8, 'coffee'],
        ]),
      }
    );
    const g = flowGraph(cashFlow(small, inSep, 'USD', ix));
    const food = taxonomy.groups.find((x) => x.name === 'Food')!.id;
    expect(g.nodes.find((n) => n.id === `other:${food}`)).toMatchObject({ value: 20, transactions: 1, members: [{ name: 'Groceries', amount: 12 }, { name: 'Coffee', amount: 8 }] });
    expect(cashFlow(small, inSep, 'USD', ix).money_out_transactions).toBe(3);
  });

  test('a tap lists the parts in its node, which the list puts back whole, and a group’s row with its transactions inside it', () => {
    const pick = (node: string) => pickedRows(rows, { period: 'last-month', node, label: '' }, { ix, currency: 'USD', today: '2026-10-11' });
    const groceries = pick(`category:${named('groceries')}`);
    expect(groceries.map((t) => [t.transaction_id, t.amount, (t as FlowRow & { split_of?: string }).split_of])).toEqual([[`split:part-0-groceries`, 200, 'costco']]);
    const listed = bankRows(groceries);
    expect(listed.map((t) => [t.transaction_id, t.amount, t.split_parts?.length])).toEqual([['costco', 300, 1]]);
    const concert = pick('payer:concert');
    expect(concert.map((t) => [t.transaction_id, (t.group_members as readonly FlowRow[]).map((m) => m.transaction_id)])).toEqual([['group:g-concert', ['tickets', 'ann', 'bo']]]);
    expect(countTransactions(concert)).toBe(3);
  });

  test('what is left out is counted by transaction too: a split one excluded, or hidden by a rule, is one', () => {
    const excluded = expand(
      BANK.map((t) => (t.transaction_id === 'costco' ? { ...t, excluded: true } : t.transaction_id === 'flix' ? { ...t, excluded: true, excluded_by_rule: true as const } : t)),
      SPLITS,
      GROUPS
    );
    const f = cashFlow(excluded, inSep, 'USD', ix);
    expect([f.excluded, f.hidden_by_rule]).toEqual([2, 1]);
    expect(cashFlowNotes({ flow: f, period: sep, rows: excluded, today: '2026-10-11', now: Date.parse('2026-10-11T12:00:00Z'), day: (iso) => iso }).counted[0]).toBe(
      "Transfers, cash withdrawals and loan payments are left out, as in the month's totals. So are 1 transaction you excluded and 1 a rule hides."
    );
  });
});
