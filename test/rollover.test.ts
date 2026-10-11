import { describe, expect, test } from 'bun:test';
import {
  addMonths,
  amountIn,
  availableMeters,
  budgetsInMonth,
  carryInto,
  carryText,
  currentMonths,
  endRollover,
  gapText,
  incomePool,
  isBudgetMonths,
  isIncomeCarryover,
  monthGapsOf,
  monthsAfterMerge,
  monthsFrom,
  monthsText,
  monthsWithout,
  noteBudgets,
  NO_COVERAGE_GAPS,
  placeMonths,
  resetCarry,
  RolloverError,
  setIncome,
  setRollover,
  sinceText,
  startChoices,
  startMonths,
  startRollover,
  thisMonth,
  type BudgetMonths,
  type CarryInput,
  type MonthInput,
} from '@/lib/rollover';
import { indexTaxonomy, mergeCategories, deleteCategory, type Taxonomy } from '@/lib/categories';
import { summarize, spendingByCategory, type TotalsRow } from '@/lib/totals';
import type { Budgets } from '@/lib/budget-set';
import { categoriesFor } from './category-fixture';

// Budget rollover and income carryover (#37), the pure part (lib/rollover.ts):
// what a budget had in a past month, what it carries into a month, what a
// group's meter shows with carries under the reconcile rule, and what an
// income pool holds, held to the months' net flows to the cent.

const { taxonomy } = categoriesFor({}, { words: ['groceries', 'restaurants', 'coffee'], groups: { groceries: 'Food', restaurants: 'Food', coffee: 'Food' } });
const ix = indexTaxonomy(taxonomy);
const id = (t: Taxonomy, name: string) => t.categories.find((c) => c.name === name)!.id;
const groupId = (t: Taxonomy, name: string) => t.groups.find((g) => g.name === name)!.id;
const GROCERIES = id(taxonomy, 'groceries');
const RESTAURANTS = id(taxonomy, 'restaurants');
const COFFEE = id(taxonomy, 'coffee');
const FOOD = groupId(taxonomy, 'Food');

/** Spending by month, then by category id. */
type Spend = Record<string, Record<string, number>>;
const spendingOf = (s: Spend) => (m: string) => new Map(Object.entries(s[m] ?? {}));
const always = (earliest: string | null = '2020-01'): CarryInput => ({ earliest, uncertain: () => false });

/** A month's input: the budgets now, the record, the spending. */
function input(budgets: Budgets, months: BudgetMonths | null, month: string, spend: Spend, extra: Partial<MonthInput> = {}): MonthInput {
  return { ix, budgets, months, month, today: month, spending: spendingOf(spend), ...always(), ...extra };
}

const budgetsOf = (categories: Record<string, number>, groups: Record<string, number> = {}): Budgets => ({
  categories: Object.fromEntries(Object.entries(categories).map(([k, amount]) => [k, { amount }])),
  groups: Object.fromEntries(Object.entries(groups).map(([k, amount]) => [k, { amount }])),
});

/** A record begun in `since` with rollover on for groceries from `from`. */
function rollingGroceries(amount: number, since: string, from: string): { budgets: Budgets; months: BudgetMonths } {
  const budgets = budgetsOf({ [GROCERIES]: amount });
  const months = setRollover(startMonths(budgets, since), 'categories', GROCERIES, { on: true, from }, from > since ? from : since);
  return { budgets, months };
}

describe('months', () => {
  test('counted across a year boundary, both ways', () => {
    expect(addMonths('2025-12', 1)).toBe('2026-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-03', -15)).toBe('2024-12');
    expect(addMonths('2026-03', 0)).toBe('2026-03');
    expect(monthsFrom('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthsFrom('2026-02', '2026-01')).toEqual([]);
  });

  test('ranges end where they say, past the year 9999 too', () => {
    expect(monthsFrom('9999-10', '9999-12')).toEqual(['9999-10', '9999-11', '9999-12']);
    expect(addMonths('9999-12', 1)).toBe('10000-01');
    expect(monthsFrom('9999-12', '10000-02')).toEqual(['9999-12', '10000-01', '10000-02']);
  });

  test('“this month” is one some time zone is in now, else the UTC month', () => {
    const lateOct31 = Date.parse('2026-10-31T23:30:00Z');
    expect(currentMonths(lateOct31)).toEqual(['2026-10', '2026-11']);
    expect(thisMonth('2026-11', lateOct31)).toBe('2026-11');
    expect(thisMonth('2026-10', lateOct31)).toBe('2026-10');
    // A month no time zone is in now, or none at all: the UTC month.
    expect(thisMonth('2026-09', lateOct31)).toBe('2026-10');
    expect(thisMonth(undefined, lateOct31)).toBe('2026-10');
    expect(thisMonth('2026-13', lateOct31)).toBe('2026-10');
  });
});

describe('the stored shapes, closed', () => {
  const ok: BudgetMonths = {
    version: 1,
    since: '2026-01',
    categories: { [GROCERIES]: { seen: 300, amounts: [{ until: '2026-03', amount: null }, { until: '2026-06', amount: 250 }], rollover: [{ from: '2026-03', to: '2026-05' }, { from: '2026-05', reset: true }] } },
    groups: { [FOOD]: { seen: null } },
  };

  test('accepts what this release writes', () => {
    expect(isBudgetMonths(ok)).toBe(true);
    expect(isBudgetMonths(startMonths(budgetsOf({ [GROCERIES]: 1 }), '2026-10'))).toBe(true);
    expect(isIncomeCarryover({ version: 1, enabled: false, start: '2026-04' })).toBe(true);
  });

  test('a field a later release added, anywhere, is unrecognised, so nothing here saves over it', () => {
    expect(isBudgetMonths({ ...ok, extra: 1 })).toBe(false);
    expect(isBudgetMonths({ ...ok, version: 2 })).toBe(false);
    expect(isBudgetMonths({ ...ok, categories: { [GROCERIES]: { seen: 300, note: 'x' } } })).toBe(false);
    expect(isBudgetMonths({ ...ok, categories: { [GROCERIES]: { seen: 300, amounts: [{ until: '2026-03', amount: 1, why: 'x' }] } } })).toBe(false);
    expect(isBudgetMonths({ ...ok, categories: { [GROCERIES]: { seen: 300, rollover: [{ from: '2026-03', paused: true }] } } })).toBe(false);
    expect(isIncomeCarryover({ version: 1, enabled: true, start: '2026-04', target: 5 })).toBe(false);
    expect(isIncomeCarryover({ version: 2, enabled: true, start: '2026-04' })).toBe(false);
  });

  test('refuses what could only be damage: out of order, overlapping, open in the middle, bad amounts and ids', () => {
    const one = (t: unknown) => isBudgetMonths({ ...ok, categories: { [GROCERIES]: t } });
    expect(one({ seen: 300, amounts: [{ until: '2026-06', amount: 1 }, { until: '2026-03', amount: 2 }] })).toBe(false);
    expect(one({ seen: 300, amounts: [{ until: '2026-03', amount: 1 }, { until: '2026-03', amount: 2 }] })).toBe(false);
    expect(one({ seen: 300, amounts: [{ until: '2026-03', amount: -1 }] })).toBe(false);
    expect(one({ seen: 0 })).toBe(false);
    expect(one({ seen: 300, rollover: [{ from: '2026-03' }, { from: '2026-05' }] })).toBe(false);
    expect(one({ seen: 300, rollover: [{ from: '2026-03', to: '2026-06' }, { from: '2026-05' }] })).toBe(false);
    expect(one({ seen: 300, rollover: [{ from: '2026-03', to: '2026-03' }] })).toBe(false);
    expect(one({ seen: 300, rollover: [{ from: '2026-3' }] })).toBe(false);
    expect(isBudgetMonths({ ...ok, categories: { 'not an id!': { seen: 1 } } })).toBe(false);
    expect(isBudgetMonths({ ...ok, since: '2026-13' })).toBe(false);
  });
});

describe('recording what a budget had (a past month’s budget is what it was then)', () => {
  test('a change keeps the amount before it for the months before the month it was made in', () => {
    const start = startMonths(budgetsOf({ [GROCERIES]: 300 }), '2026-01');
    const next = noteBudgets(start, budgetsOf({ [GROCERIES]: 400 }), '2026-05');
    expect(next.categories[GROCERIES]).toEqual({ seen: 400, amounts: [{ until: '2026-05', amount: 300 }] });
    expect(amountIn(next.categories[GROCERIES], 400, '2026-04')).toBe(300);
    expect(amountIn(next.categories[GROCERIES], 400, '2026-05')).toBe(400);
    expect(amountIn(next.categories[GROCERIES], 400, '2027-01')).toBe(400);
  });

  test('changed twice in a month, the months before keep what the month began with', () => {
    const start = startMonths(budgetsOf({ [GROCERIES]: 300 }), '2026-01');
    const once = noteBudgets(start, budgetsOf({ [GROCERIES]: 400 }), '2026-05');
    const twice = noteBudgets(once, budgetsOf({ [GROCERIES]: 350 }), '2026-05');
    expect(twice.categories[GROCERIES]).toEqual({ seen: 350, amounts: [{ until: '2026-05', amount: 300 }] });
  });

  test('a budget first seen now had none before; one removed ends its rollover, and the months it had keep it', () => {
    const start = startMonths(budgetsOf({ [GROCERIES]: 300 }), '2026-01');
    const added = noteBudgets(start, budgetsOf({ [GROCERIES]: 300, [COFFEE]: 40 }), '2026-03');
    expect(added.categories[COFFEE]).toEqual({ seen: 40, amounts: [{ until: '2026-03', amount: null }] });
    expect(amountIn(added.categories[COFFEE], 40, '2026-02')).toBeNull();
    const rolling = setRollover(added, 'categories', COFFEE, { on: true, from: '2026-03' }, '2026-04');
    const removed = noteBudgets(rolling, budgetsOf({ [GROCERIES]: 300 }), '2026-06');
    expect(removed.categories[COFFEE]).toEqual({ seen: null, amounts: [{ until: '2026-03', amount: null }, { until: '2026-06', amount: 40 }], rollover: [{ from: '2026-03', to: '2026-06' }] });
    expect(amountIn(removed.categories[COFFEE], null, '2026-05')).toBe(40);
    expect(amountIn(removed.categories[COFFEE], null, '2026-06')).toBeNull();
  });

  test('nothing different, the record itself: an update then writes nothing', () => {
    const start = startMonths(budgetsOf({ [GROCERIES]: 300 }, { [FOOD]: 800 }), '2026-01');
    expect(noteBudgets(start, budgetsOf({ [GROCERIES]: 300 }, { [FOOD]: 800 }), '2026-05', ix)).toBe(start);
  });

  test('a deleted category’s record goes; a merged one’s stays until it moves', () => {
    const t = deleteCategory(taxonomy, COFFEE, { transactions: 0, budget: false });
    const start: BudgetMonths = { ...startMonths(budgetsOf({ [GROCERIES]: 300 }), '2026-01'), categories: { [GROCERIES]: { seen: 300 }, [COFFEE]: { seen: null, amounts: [{ until: '2026-03', amount: 40 }] } } };
    expect(noteBudgets(start, budgetsOf({ [GROCERIES]: 300 }), '2026-05', indexTaxonomy(t)).categories[COFFEE]).toBeUndefined();
    const merged = mergeCategories(taxonomy, COFFEE, GROCERIES);
    expect(noteBudgets(start, budgetsOf({ [GROCERIES]: 300 }), '2026-05', indexTaxonomy(merged)).categories[COFFEE]).toBeDefined();
    expect(monthsWithout(start, 'categories', COFFEE).categories[COFFEE]).toBeUndefined();
  });

  test('neighbouring changes to the same amount are one', () => {
    let m = startMonths(budgetsOf({ [GROCERIES]: 300 }), '2026-01');
    m = noteBudgets(m, budgetsOf({ [GROCERIES]: 400 }), '2026-03');
    m = noteBudgets(m, budgetsOf({ [GROCERIES]: 300 }), '2026-04');
    m = noteBudgets(m, budgetsOf({ [GROCERIES]: 400 }), '2026-05');
    expect(m.categories[GROCERIES].amounts).toEqual([{ until: '2026-03', amount: 300 }, { until: '2026-04', amount: 400 }, { until: '2026-05', amount: 300 }]);
    expect(isBudgetMonths(m)).toBe(true);
  });
});

describe('turning rollover on and off, and resetting it', () => {
  const base = startMonths(budgetsOf({ [GROCERIES]: 300 }), '2026-01');

  test('on from a month, off from another: the months between roll over', () => {
    const on = setRollover(base, 'categories', GROCERIES, { on: true, from: '2026-02' }, '2026-04');
    expect(on.categories[GROCERIES].rollover).toEqual([{ from: '2026-02' }]);
    const off = setRollover(on, 'categories', GROCERIES, { on: false }, '2026-06');
    expect(off.categories[GROCERIES].rollover).toEqual([{ from: '2026-02', to: '2026-06' }]);
  });

  test('off in the month it began leaves no period at all', () => {
    const on = setRollover(base, 'categories', GROCERIES, { on: true, from: '2026-06' }, '2026-06');
    expect(setRollover(on, 'categories', GROCERIES, { on: false }, '2026-06').categories[GROCERIES].rollover).toBeUndefined();
  });

  test('on again from an earlier month replaces the periods from it on', () => {
    expect(startRollover([{ from: '2026-01', to: '2026-04' }, { from: '2026-06', to: '2026-08' }], '2026-03')).toEqual([{ from: '2026-01', to: '2026-03' }, { from: '2026-03' }]);
    expect(endRollover([{ from: '2026-01' }], '2026-01')).toEqual([]);
  });

  test('a reset ends the open period and starts one marked as a reset; refused without rollover', () => {
    const on = setRollover(base, 'categories', GROCERIES, { on: true, from: '2026-02' }, '2026-04');
    const reset = resetCarry(on, 'categories', GROCERIES, '2026-05');
    expect(reset.categories[GROCERIES].rollover).toEqual([{ from: '2026-02', to: '2026-05' }, { from: '2026-05', reset: true }]);
    // Again in the same month: nothing to do.
    expect(resetCarry(reset, 'categories', GROCERIES, '2026-05')).toBe(reset);
    expect(() => resetCarry(base, 'categories', GROCERIES, '2026-05')).toThrow(RolloverError);
  });

  test('refused for a budget that no longer exists, a start after this month or too far back', () => {
    expect(() => setRollover(base, 'categories', COFFEE, { on: true, from: '2026-02' }, '2026-04')).toThrow('no longer exists');
    expect(() => setRollover(base, 'categories', GROCERIES, { on: true, from: '2026-05' }, '2026-04')).toThrow('after this month');
    expect(() => setRollover(base, 'categories', GROCERIES, { on: true, from: '2015-01' }, '2026-04')).toThrow('10 years');
  });
});

describe('the carry into a month', () => {
  test('leftover and overspending both carry, and the meter reflects what is available', () => {
    const { budgets, months } = rollingGroceries(300, '2026-01', '2026-01');
    const view = budgetsInMonth(input(budgets, months, '2026-03', { '2026-01': { [GROCERIES]: 200 }, '2026-02': { [GROCERIES]: 450 }, '2026-03': { [GROCERIES]: 10 } }));
    // January leaves 100; February overspends by 150: -50 into March.
    expect(view.carries.categories[GROCERIES]).toMatchObject({ carry: -50, from: '2026-01', why: 'start', uncertain: [] });
    const meters = availableMeters(ix, view.budgets, view.carries, new Map([[GROCERIES, 10]]));
    const food = meters.groups.find((g) => g.group.id === FOOD)!;
    expect(food.categories.find((c) => c.category.id === GROCERIES)!.budget).toBe(250);
    expect(food.limit).toBe(250);
    expect(meters.total).toEqual({ budget: 250, spent: 10 });
  });

  test('carried across a year boundary', () => {
    const { budgets, months } = rollingGroceries(100, '2025-11', '2025-11');
    const view = budgetsInMonth(input(budgets, months, '2026-02', { '2025-11': { [GROCERIES]: 60 }, '2025-12': { [GROCERIES]: 90 }, '2026-01': { [GROCERIES]: 100 } }));
    expect(view.carries.categories[GROCERIES].carry).toBe(50);
  });

  test('months with no spending roll the whole budget over', () => {
    const { budgets, months } = rollingGroceries(120.5, '2026-01', '2026-01');
    expect(budgetsInMonth(input(budgets, months, '2026-04', {})).carries.categories[GROCERIES].carry).toBe(361.5);
  });

  test('the month it starts carries nothing yet; turned off, nothing at once, earlier months keep theirs', () => {
    const { budgets, months } = rollingGroceries(300, '2026-01', '2026-03');
    const spend = { '2026-03': { [GROCERIES]: 100 }, '2026-04': { [GROCERIES]: 100 } };
    expect(budgetsInMonth(input(budgets, months, '2026-03', spend)).carries.categories[GROCERIES].carry).toBe(0);
    expect(budgetsInMonth(input(budgets, months, '2026-05', spend)).carries.categories[GROCERIES].carry).toBe(400);
    const off = setRollover(months, 'categories', GROCERIES, { on: false }, '2026-05');
    expect(budgetsInMonth(input(budgets, off, '2026-05', spend)).carries.categories[GROCERIES]).toBeUndefined();
    // April, looked back on, still carried what March left.
    expect(budgetsInMonth(input(budgets, off, '2026-04', spend)).carries.categories[GROCERIES].carry).toBe(200);
  });

  test('on again starts fresh from the month chosen; from the first start, the old carry comes back exactly', () => {
    const { budgets, months } = rollingGroceries(300, '2026-01', '2026-01');
    const spend = { '2026-01': { [GROCERIES]: 250 }, '2026-02': { [GROCERIES]: 250 }, '2026-03': { [GROCERIES]: 250 } };
    const off = setRollover(months, 'categories', GROCERIES, { on: false }, '2026-03');
    const fresh = setRollover(off, 'categories', GROCERIES, { on: true, from: '2026-04' }, '2026-04');
    expect(budgetsInMonth(input(budgets, fresh, '2026-04', spend)).carries.categories[GROCERIES].carry).toBe(0);
    const back = setRollover(off, 'categories', GROCERIES, { on: true, from: '2026-01' }, '2026-04');
    expect(budgetsInMonth(input(budgets, back, '2026-04', spend)).carries.categories[GROCERIES].carry).toBe(150);
  });

  test('a reset sets it to zero from its month and counts on from there', () => {
    const { budgets, months } = rollingGroceries(300, '2026-01', '2026-01');
    const spend = { '2026-01': { [GROCERIES]: 500 }, '2026-02': { [GROCERIES]: 100 }, '2026-03': { [GROCERIES]: 100 } };
    const reset = resetCarry(months, 'categories', GROCERIES, '2026-02');
    const feb = budgetsInMonth(input(budgets, reset, '2026-02', spend)).carries.categories[GROCERIES];
    expect(feb).toMatchObject({ carry: 0, why: 'reset', from: '2026-02' });
    expect(budgetsInMonth(input(budgets, reset, '2026-04', spend)).carries.categories[GROCERIES].carry).toBe(400);
    // Without the reset, January's overspending was still being climbed out of.
    expect(budgetsInMonth(input(budgets, months, '2026-04', spend)).carries.categories[GROCERIES].carry).toBe(200);
  });

  test('changing this month’s amount leaves the carry of earlier months as it was', () => {
    const { budgets, months } = rollingGroceries(300, '2026-01', '2026-01');
    const spend = { '2026-01': { [GROCERIES]: 100 }, '2026-02': { [GROCERIES]: 100 }, '2026-03': { [GROCERIES]: 100 } };
    const before = budgetsInMonth(input(budgets, months, '2026-03', spend)).carries.categories[GROCERIES].carry;
    const raised = budgetsOf({ [GROCERIES]: 500 });
    const noted = noteBudgets(months, raised, '2026-03');
    const after = budgetsInMonth(input(raised, noted, '2026-03', spend));
    expect(before).toBe(400);
    expect(after.carries.categories[GROCERIES].carry).toBe(400);
    expect(after.budgets.categories[GROCERIES].amount).toBe(500);
    // April counts March at its new amount.
    expect(budgetsInMonth(input(raised, noted, '2026-04', spend)).carries.categories[GROCERIES].carry).toBe(800);
    // February, looked back on, had 300.
    expect(budgetsInMonth(input(raised, noted, '2026-02', spend)).budgets.categories[GROCERIES].amount).toBe(300);
  });

  test('a month with no budget ends the carry; it starts again from zero the next month with one', () => {
    // Coffee: budgeted from March only; rollover from January.
    const budgets = budgetsOf({ [COFFEE]: 50 });
    let months = startMonths(budgetsOf({}), '2026-01');
    months = noteBudgets(months, budgets, '2026-03');
    months = setRollover(months, 'categories', COFFEE, { on: true, from: '2026-01' }, '2026-03');
    const spend = { '2026-01': { [COFFEE]: 80 }, '2026-02': { [COFFEE]: 80 }, '2026-03': { [COFFEE]: 20 } };
    const view = budgetsInMonth(input(budgets, months, '2026-04', spend));
    expect(view.carries.categories[COFFEE]).toMatchObject({ carry: 30, from: '2026-03', why: 'budget' });
    // Before it had a budget, there is no meter and nothing to carry.
    const feb = budgetsInMonth(input(budgets, months, '2026-02', spend));
    expect(feb.budgets.categories[COFFEE]).toBeUndefined();
    expect(feb.carries.categories[COFFEE]).toBeUndefined();
  });

  test('clamped at the first month with transactions, and named', () => {
    const { budgets, months } = rollingGroceries(100, '2026-01', '2025-01');
    const view = budgetsInMonth(input(budgets, months, '2026-03', { '2025-12': { [GROCERIES]: 40 }, '2026-01': { [GROCERIES]: 100 } }, { earliest: '2025-12' }));
    expect(view.carries.categories[GROCERIES]).toMatchObject({ carry: 160, from: '2025-12', why: 'data', start: '2025-01' });
    expect(sinceText(view.carries.categories[GROCERIES], '2026-03')).toBe('Rolling over since December 2025, the first month with transactions');
    // No transactions at all: nothing carried, and said.
    const none = budgetsInMonth(input(budgets, months, '2026-03', {}, { earliest: null }));
    expect(none.carries.categories[GROCERIES]).toMatchObject({ carry: 0, why: 'none' });
    expect(sinceText(none.carries.categories[GROCERIES], '2026-03')).toBe('Rolling over, with no transactions to count yet');
  });

  test('a month that may be incomplete makes the carry across it uncertain, by month', () => {
    const { budgets, months } = rollingGroceries(100, '2026-01', '2026-01');
    const view = budgetsInMonth(input(budgets, months, '2026-05', {}, { uncertain: (m) => m === '2026-03' || m === '2026-05' }));
    // May is the month shown, not counted in the carry into it.
    expect(view.carries.categories[GROCERIES].uncertain).toEqual(['2026-03']);
    expect(carryText(view.carries.categories[GROCERIES], (n) => `$${n}`, '2026-05')).toBe('+$400 rolled over (may be off: March is incomplete)');
  });

  test('nothing is counted past this month: a month still to come has its amounts and no carry', () => {
    const { budgets, months } = rollingGroceries(100, '2026-01', '2026-01');
    const later = budgetsInMonth(input(budgets, months, '9999-12', {}, { today: '2026-05' }));
    expect(later.budgets.categories[GROCERIES]).toEqual({ amount: 100 });
    expect(later.carries).toEqual({ categories: {}, groups: {} });
    // And a carry into the last possible month ends where it should.
    expect(carryInto([{ from: '9999-10' }], '9999-12', () => 10, () => 0, always('2020-01'))!.carry).toBe(20);
  });

  test('amounts from before the record began are assumed, and said to be', () => {
    const { budgets, months } = rollingGroceries(100, '2026-03', '2026-01');
    const jan = budgetsInMonth(input(budgets, months, '2026-01', {}, { today: '2026-05' }));
    expect(jan.assumed.categories).toEqual([GROCERIES]);
    expect(jan.recorded_since).toBe('2026-03');
    expect(budgetsInMonth(input(budgets, months, '2026-04', {}, { today: '2026-05' })).assumed.categories).toEqual([]);
    // Nothing recorded at all: every month before this one is.
    expect(budgetsInMonth(input(budgets, null, '2026-04', {}, { today: '2026-05' })).assumed.categories).toEqual([GROCERIES]);
  });

  test('no record at all, and no rollover: the budgets exactly as before', () => {
    const budgets = budgetsOf({ [GROCERIES]: 300, [RESTAURANTS]: 200 }, { [FOOD]: 600 });
    const view = budgetsInMonth(input(budgets, null, '2026-05', {}));
    expect(view.budgets).toEqual(budgets);
    expect(view.carries).toEqual({ categories: {}, groups: {} });
    const spent = new Map([[GROCERIES, 120]]);
    expect(availableMeters(ix, view.budgets, view.carries, spent)).toEqual(availableMeters(ix, budgets, null, spent));
  });
});

describe('merged and deleted categories', () => {
  test('merged: past amounts add up month by month, its rollover goes with its budget, and the carry counts the spending together', () => {
    const budgets = budgetsOf({ [GROCERIES]: 300, [COFFEE]: 50 });
    let months = startMonths(budgets, '2026-01');
    months = setRollover(months, 'categories', COFFEE, { on: true, from: '2026-01' }, '2026-01');
    // Coffee was 30 before March.
    months = { ...months, categories: { ...months.categories, [COFFEE]: { ...months.categories[COFFEE], amounts: [{ until: '2026-03', amount: 30 }] } } };
    const merged = indexTaxonomy(mergeCategories(taxonomy, COFFEE, GROCERIES));
    const moved = monthsAfterMerge(months, merged);
    expect(moved.categories[COFFEE]).toBeUndefined();
    expect(moved.categories[GROCERIES]).toEqual({ seen: 350, amounts: [{ until: '2026-03', amount: 330 }], rollover: [{ from: '2026-01' }] });
    expect(monthsAfterMerge(moved, merged)).toBe(moved);
    // Before it moves, reading follows the merge and adds the two up all the same.
    const spend = { '2026-01': { [GROCERIES]: 300 }, '2026-02': { [GROCERIES]: 300 }, '2026-03': { [GROCERIES]: 300 } };
    const read = (m: BudgetMonths, b: Budgets) => budgetsInMonth({ ...input(b, m, '2026-04', spend), ix: merged });
    const unmoved = read(months, budgets);
    const after = read(moved, { categories: { [GROCERIES]: { amount: 350 } }, groups: {} });
    expect(unmoved.carries.categories[GROCERIES].carry).toBe(110);
    expect(after.carries.categories[GROCERIES]).toEqual(unmoved.carries.categories[GROCERIES]);
    expect(after.budgets).toEqual(unmoved.budgets);
  });

  test('the one merged into keeps its own rollover', () => {
    let months = startMonths(budgetsOf({ [GROCERIES]: 300, [COFFEE]: 50 }), '2026-01');
    months = setRollover(months, 'categories', COFFEE, { on: true, from: '2026-01' }, '2026-01');
    months = setRollover(months, 'categories', GROCERIES, { on: true, from: '2026-02' }, '2026-02');
    const merged = indexTaxonomy(mergeCategories(taxonomy, COFFEE, GROCERIES));
    expect(monthsAfterMerge(months, merged).categories[GROCERIES].rollover).toEqual([{ from: '2026-02' }]);
    expect(placeMonths(budgetsOf({ [GROCERIES]: 300, [COFFEE]: 50 }), months, merged).categories.get(GROCERIES)!.rollover).toEqual([{ from: '2026-02' }]);
  });

  test('a deleted category’s budget and carry are read as gone', () => {
    const t = indexTaxonomy(deleteCategory(taxonomy, COFFEE, { transactions: 0, budget: false }));
    let months = startMonths(budgetsOf({ [COFFEE]: 50 }), '2026-01');
    months = setRollover(months, 'categories', COFFEE, { on: true, from: '2026-01' }, '2026-01');
    const view = budgetsInMonth({ ...input(budgetsOf({}), months, '2026-03', {}), ix: t });
    expect(view.budgets.categories).toEqual({});
    expect(view.carries.categories).toEqual({});
  });
});

describe('groups: a group’s own budget rolls over, under the reconcile rule', () => {
  const spend = { '2026-01': { [GROCERIES]: 150, [RESTAURANTS]: 100, [COFFEE]: 50 } };

  test('a group’s own leftover is its amount less everything spent in it', () => {
    const budgets = budgetsOf({}, { [FOOD]: 400 });
    const months = setRollover(startMonths(budgets, '2026-01'), 'groups', FOOD, { on: true, from: '2026-01' }, '2026-01');
    const view = budgetsInMonth(input(budgets, months, '2026-02', spend));
    expect(view.carries.groups[FOOD].carry).toBe(100);
    const food = availableMeters(ix, view.budgets, view.carries, new Map()).groups.find((g) => g.group.id === FOOD)!;
    expect(food.limit).toBe(500);
    expect(food.own).toBe(500);
  });

  test('categories binding: their available added up is the limit, so a group’s carry is never counted twice', () => {
    // Every category budgeted, adding up to 400 with their carries, under a
    // group amount of 600 (also rolling over): the categories bind.
    const budgets = budgetsOf({ [GROCERIES]: 200, [RESTAURANTS]: 100, [COFFEE]: 50, [id(taxonomy, 'food and drink')]: 10 }, { [FOOD]: 600 });
    let months = startMonths(budgets, '2026-01');
    months = setRollover(months, 'categories', GROCERIES, { on: true, from: '2026-01' }, '2026-01');
    months = setRollover(months, 'groups', FOOD, { on: true, from: '2026-01' }, '2026-01');
    const view = budgetsInMonth(input(budgets, months, '2026-02', spend));
    expect(view.carries.categories[GROCERIES].carry).toBe(50);
    expect(view.carries.groups[FOOD].carry).toBe(300);
    const meters = availableMeters(ix, view.budgets, view.carries, new Map([[GROCERIES, 20]]));
    const food = meters.groups.find((g) => g.group.id === FOOD)!;
    expect(food.categories_total).toBe(410);
    expect(food.own).toBe(900);
    expect(food.limit).toBe(410);
    expect(food.reconcile).toEqual({ binds: 'categories', group: 900, categories: 410 });
    // The month's total counts the group once, at its limit.
    expect(meters.total.budget).toBe(410);
  });

  test('the group’s amount binding: it caps its categories’ carries too', () => {
    const budgets = budgetsOf({ [GROCERIES]: 300, [RESTAURANTS]: 200 }, { [FOOD]: 450 });
    const months = setRollover(startMonths(budgets, '2026-01'), 'categories', GROCERIES, { on: true, from: '2026-01' }, '2026-01');
    const view = budgetsInMonth(input(budgets, months, '2026-02', spend));
    const food = availableMeters(ix, view.budgets, view.carries, new Map()).groups.find((g) => g.group.id === FOOD)!;
    expect(view.carries.categories[GROCERIES].carry).toBe(150);
    expect(food.categories_total).toBe(650);
    expect(food.limit).toBe(450);
    expect(food.reconcile?.binds).toBe('group');
  });

  test('a group without an amount of its own rolls up its categories’ available', () => {
    const budgets = budgetsOf({ [GROCERIES]: 300, [RESTAURANTS]: 200 });
    const months = setRollover(startMonths(budgets, '2026-01'), 'categories', GROCERIES, { on: true, from: '2026-01' }, '2026-01');
    const view = budgetsInMonth(input(budgets, months, '2026-02', spend));
    const food = availableMeters(ix, view.budgets, view.carries, new Map([[GROCERIES, 10], [COFFEE, 5]])).groups.find((g) => g.group.id === FOOD)!;
    expect(food.limit).toBe(650);
    expect(food.spent).toBe(10);
  });
});

describe('the income pool', () => {
  /** Rows as the Activity tab totals them: Plaid's sign, money in negative. */
  const row = (date: string, amount: number, over: Partial<TotalsRow> = {}): TotalsRow => ({
    date,
    amount,
    category: amount < 0 ? 'income' : 'groceries',
    transaction_code: null,
    iso_currency_code: 'USD',
    ...over,
  });
  const ROWS: TotalsRow[] = [
    row('2026-01-03', -9000.01),
    row('2026-01-09', 1234.56),
    row('2026-01-20', 0.1),
    row('2026-01-21', 0.2),
    // A refund is money in, as the Activity tab counts it.
    row('2026-01-25', -19.99, { category: 'groceries' }),
    row('2026-02-01', -2000.33),
    row('2026-02-14', 2999.97),
    // Moving money between your own accounts is never income or spending.
    row('2026-02-15', -5000, { category: 'transfer in', transaction_code: 'transfer' }),
    row('2026-02-15', 5000, { category: 'transfer out', transaction_code: 'transfer' }),
    // Excluded, and another currency: left out.
    row('2026-02-16', 700.07, { excluded: true }),
    row('2026-02-17', -800, { iso_currency_code: 'EUR' }),
    row('2026-03-02', 0.3),
    row('2026-03-05', -0.07),
    row('2026-04-01', 10),
  ];
  const flows = (m: string) => summarize(ROWS, (d) => d.slice(0, 7) === m, 'USD');
  const ON = { version: 1 as const, enabled: true, start: '2026-01' };

  test('reconciles exactly with the months’ net flows added up, to the cent', () => {
    const pool = incomePool(ON, '2026-04', flows, always('2026-01'))!;
    const nets = ['2026-01', '2026-02', '2026-03'].map((m) => flows(m).net);
    const added = nets.reduce((a, n) => Math.round((a + n) * 100) / 100, 0);
    expect(pool.carried_in).toBe(added);
    // January 9,020.00 in, 1,234.86 out; February 2,000.33 in, 2,999.97 out;
    // March 0.07 in, 0.30 out.
    expect(pool.carried_in).toBe(6785.27);
    for (const [i, m] of pool.months.entries()) {
      expect(m.carried_out).toBe(Math.round((m.carried_in + m.income - m.spending) * 100) / 100);
      if (i > 0) expect(m.carried_in).toBe(pool.months[i - 1].carried_out);
    }
    expect(pool.available).toBe(Math.round((pool.carried_in + pool.income - pool.spending) * 100) / 100);
    expect(pool.months.map((m) => m.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
  });

  test('January’s surplus funds a lean February, as a variable earner wants', () => {
    const pool = incomePool(ON, '2026-02', flows, always('2026-01'))!;
    expect(pool.carried_in).toBe(7785.14);
    expect(pool.income).toBe(2000.33);
    expect(pool.spending).toBe(2999.97);
    expect(pool.available).toBe(6785.5);
  });

  test('transfers, exclusions and other currencies never move it', () => {
    const plain = ROWS.filter((r) => !(r.transaction_code === 'transfer' || r.excluded || r.iso_currency_code === 'EUR'));
    const plainFlows = (m: string) => summarize(plain, (d) => d.slice(0, 7) === m, 'USD');
    expect(incomePool(ON, '2026-04', plainFlows, always('2026-01'))).toEqual(incomePool(ON, '2026-04', flows, always('2026-01')));
  });

  test('off by default, and off it is nothing at all', () => {
    expect(incomePool(null, '2026-04', flows, always())).toBeNull();
    expect(incomePool({ ...ON, enabled: false }, '2026-04', flows, always())).toBeNull();
    expect(setIncome(ON, { enabled: false }, '2026-04')).toEqual({ ...ON, enabled: false });
    expect(setIncome(null, { enabled: false }, '2026-04')).toBeNull();
  });

  test('clamped at the first month with transactions; a month before its start holds nothing yet', () => {
    const pool = incomePool({ ...ON, start: '2025-06' }, '2026-02', flows, always('2026-01'))!;
    expect(pool).toMatchObject({ start: '2025-06', from: '2026-01', clamped: true });
    const early = incomePool({ ...ON, start: '2026-03' }, '2026-02', flows, always('2026-01'))!;
    expect(early).toMatchObject({ months: [], available: 0, carried_in: 0 });
    expect(() => setIncome(null, { enabled: true, start: '2026-05' }, '2026-04')).toThrow(RolloverError);
  });

  test('a month that may be incomplete is named', () => {
    const pool = incomePool(ON, '2026-03', flows, { earliest: '2026-01', uncertain: (m) => m === '2026-02' })!;
    expect(pool.uncertain).toEqual(['2026-02']);
    expect(pool.months.find((m) => m.month === '2026-02')!.uncertain).toBe(true);
  });

  test('the budgets’ spending is the same rows by the same rule: refunds never taken off it', () => {
    const jan = spendingByCategory(ROWS, (d) => d.slice(0, 7) === '2026-01', 'USD');
    expect(jan.groceries).toBe(1234.56 + 0.1 + 0.2);
  });
});

describe('which months may be incomplete', () => {
  const facts = {
    ...NO_COVERAGE_GAPS,
    incomplete: [{ institution_name: 'Wells', coverage: 'missing' as const }],
    stopped: [{ institution_name: 'Chase', last_ok_at: '2026-03-10T12:00:00Z' }],
    first: [
      { institution: 'Amex', day: '2026-02-14' },
      { institution: 'Wells', day: '2026-01-01' },
    ],
    exclusionUnknown: new Map([['2026-01', 2]]),
  };

  test('each cause, for the months it touches', () => {
    expect(monthGapsOf('2026-01', facts)).toEqual([
      { kind: 'missing', institution: 'Wells' },
      { kind: 'begins', institution: 'Amex', first: '2026-02-14' },
      { kind: 'exclusions', count: 2 },
    ]);
    // Chase stopped on March 10: February is as complete as it ever was.
    expect(monthGapsOf('2026-02', facts).map((g) => g.kind)).toEqual(['missing', 'begins']);
    expect(monthGapsOf('2026-03', facts).map((g) => g.kind)).toEqual(['missing', 'stopped']);
    expect(monthGapsOf('2026-03', NO_COVERAGE_GAPS)).toEqual([]);
  });

  test('in words', () => {
    const day = (s: string) => s.slice(0, 10);
    expect(monthGapsOf('2026-01', facts).map((g) => gapText(g, day))).toEqual([
      'Wells’s transactions couldn’t be loaded',
      'Amex’s stored transactions begin on 2026-02-14',
      'whether you excluded 2 transactions couldn’t be read',
    ]);
    expect(gapText({ kind: 'stopped', institution: 'Chase', since: '2026-03-10T12:00:00Z' }, day)).toBe('Chase hasn’t synced since 2026-03-10');
    expect(gapText({ kind: 'without', institution: 'Ally', reason: 'no_consent' }, day)).toContain('didn’t allow');
  });

  test('months named', () => {
    expect(monthsText(['2026-03'], '2026-05')).toBe('March');
    expect(monthsText(['2025-12', '2026-01'], '2026-05')).toBe('December 2025 and January');
    expect(monthsText(['2026-01', '2026-02', '2026-04'], '2026-05')).toBe('3 months from January');
  });

  test('a start can be chosen back to the first month with transactions, at least a year back, at most ten', () => {
    expect(startChoices('2026-10', '2026-08')[0]).toBe('2026-10');
    expect(startChoices('2026-10', '2026-08').at(-1)).toBe('2025-11');
    expect(startChoices('2026-10', '2020-02').at(-1)).toBe('2020-02');
    expect(startChoices('2026-10', '2001-01').at(-1)).toBe('2016-10');
  });
});

describe('words beneath a meter', () => {
  const money = (n: number) => `$${n}`;
  test('rolled over, overspent, nothing yet', () => {
    const c = { carry: 120, from: '2026-01', why: 'start' as const, start: '2026-01', uncertain: [] };
    expect(carryText(c, money, '2026-04')).toBe('+$120 rolled over');
    expect(carryText({ ...c, carry: -45 }, money, '2026-04')).toBe('$45 overspent, carried over');
    expect(carryText({ ...c, carry: 0, from: '2026-04' }, money, '2026-04')).toBe('Nothing to carry over yet');
    expect(carryText({ ...c, carry: 0 }, money, '2026-04')).toBe('Nothing carried over');
    expect(carryText({ ...c, uncertain: ['2026-02', '2026-03'] }, money, '2026-04')).toBe('+$120 rolled over (may be off: February and March are incomplete)');
    expect(sinceText({ ...c, why: 'reset', from: '2026-03' }, '2026-04')).toBe('Carryover reset in March');
  });
});

describe('carryInto on its own', () => {
  test('outside every period, or with no amount that month: none', () => {
    expect(carryInto([{ from: '2026-01', to: '2026-03' }], '2026-04', () => 100, () => 0, always())).toBeNull();
    expect(carryInto([{ from: '2026-01' }], '2026-04', () => null, () => 0, always())).toBeNull();
    expect(carryInto(undefined, '2026-04', () => 100, () => 0, always())).toBeNull();
  });
});
