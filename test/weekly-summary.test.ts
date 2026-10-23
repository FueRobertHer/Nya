import { describe, expect, test } from 'bun:test';
import { CATCH_UP_DAYS, MIN_NEW_DAYS, dueSendDay, sendDayOn, todayIn, weekBefore, weekdayOf } from '@/lib/weekly-summary/week';
import {
  billsFact,
  budgetFact,
  connectionsFact,
  goalsFact,
  levelOf,
  median,
  moneyOut,
  monthsFact,
  spendingFact,
  uncategorizedFact,
  uncategorizedSourcesFact,
  UNREAD,
  type SpendingInput,
  type WeeklyFacts,
} from '@/lib/weekly-summary/content';
import {
  checkedSummary,
  composeWeekly,
  dayText,
  figuresIn,
  FigureError,
  namesText,
  safeBankName,
  safeName,
  spellsFigure,
  tidyName,
  weekText,
  type ComposeOptions,
} from '@/lib/weekly-summary/compose';
import { isWeeklySetting, parseWeeklyChoice, defaultSetting } from '@/lib/weekly-summary/settings';
import { addDays, detectRecurring, type RecurringRow } from '@/lib/recurring';
import { budgetsInMonth, setRollover, startMonths, NO_COVERAGE_GAPS, type CoverageFacts } from '@/lib/rollover';
import { indexTaxonomy, type Taxonomy } from '@/lib/categories';
import type { Budgets } from '@/lib/budget-set';
import { categoriesFor } from './category-fixture';
import { summarize } from '@/lib/totals';
import { leftOutByCurrency } from '@/lib/spending';

// The weekly summary's pure parts (lib/weekly-summary/): which week a summary
// covers and when it is due on the person's own calendar (midnight, a change
// of clocks, the week's edges), each section worked out as the app works it
// out, and the words, which never carry a figure: no amount, no balance, no
// account number, whatever the names hold.

// ---- The week ----

describe('the week', () => {
  test('is the seven days before the send day, on the weekday chosen', () => {
    expect(weekdayOf('2026-10-12')).toBe(1); // a Monday
    expect(sendDayOn('2026-10-12', 1)).toBe('2026-10-12');
    expect(sendDayOn('2026-10-13', 1)).toBe('2026-10-12');
    expect(sendDayOn('2026-10-11', 1)).toBe('2026-10-05');
    expect(sendDayOn('2026-10-11', 0)).toBe('2026-10-11');
    expect(weekBefore('2026-10-12')).toEqual({ first: '2026-10-05', last: '2026-10-11' });
    // Across a year.
    expect(weekBefore('2027-01-04')).toEqual({ first: '2026-12-28', last: '2027-01-03' });
  });

  test('today is the person’s day, around their midnight', () => {
    expect(todayIn(Date.parse('2026-10-12T03:59:00Z'), 'America/New_York')).toBe('2026-10-11');
    expect(todayIn(Date.parse('2026-10-12T04:00:00Z'), 'America/New_York')).toBe('2026-10-12');
    // The job's hour is the next day already east of the date line, and
    // still early that day far west of it.
    expect(todayIn(Date.parse('2026-10-12T13:00:00Z'), 'Pacific/Kiritimati')).toBe('2026-10-13');
    expect(todayIn(Date.parse('2026-10-12T13:00:00Z'), 'Pacific/Pago_Pago')).toBe('2026-10-12');
    expect(todayIn(Date.now(), 'Not/A_Zone')).toBeNull();
  });

  test('is due on its send day, once, and never for a week already sent', () => {
    expect(dueSendDay('2026-10-12', 1, null, '2026-09-01')).toBe('2026-10-12');
    expect(dueSendDay('2026-10-12', 1, '2026-10-05', '2026-09-01')).toBe('2026-10-12');
    expect(dueSendDay('2026-10-12', 1, '2026-10-12', '2026-09-01')).toBeNull();
    // Set up on the send day itself, before the job: it goes that day.
    expect(dueSendDay('2026-10-12', 1, null, '2026-10-12')).toBe('2026-10-12');
    // Not the send day: nothing.
    expect(dueSendDay('2026-10-16', 1, '2026-10-12', '2026-09-01')).toBeNull();
  });

  test('a day moved after a summary went never sends most of its week again', () => {
    expect(MIN_NEW_DAYS).toBe(4);
    // Monday, October 12 went; then moved to Tuesday: not the next day, which
    // would repeat six of its days, but the Tuesday after.
    expect(dueSendDay('2026-10-13', 2, '2026-10-12', '2026-09-01')).toBeNull();
    expect(dueSendDay('2026-10-20', 2, '2026-10-12', '2026-09-01')).toBe('2026-10-20');
    // To Thursday, three days on: still most of the same days. To Friday, four
    // days on, most of its week is new: it goes.
    expect(dueSendDay('2026-10-15', 4, '2026-10-12', '2026-09-01')).toBeNull();
    expect(dueSendDay('2026-10-16', 5, '2026-10-12', '2026-09-01')).toBe('2026-10-16');
    // To Sunday, six days on: it goes.
    expect(dueSendDay('2026-10-18', 0, '2026-10-12', '2026-09-01')).toBe('2026-10-18');
    // Moved earlier in the week before this week's went: Monday, October 5
    // went, moved to Saturday on Thursday: Saturday, October 10 is five days on.
    expect(dueSendDay('2026-10-10', 6, '2026-10-05', '2026-10-08')).toBe('2026-10-10');
  });

  test('catches up on the days after its send day, unless the setting changed since', () => {
    expect(CATCH_UP_DAYS).toBe(2);
    expect(dueSendDay('2026-10-13', 1, '2026-10-05', '2026-09-01')).toBe('2026-10-12');
    expect(dueSendDay('2026-10-14', 1, '2026-10-05', '2026-09-01')).toBe('2026-10-12');
    expect(dueSendDay('2026-10-15', 1, '2026-10-05', '2026-09-01')).toBeNull();
    // Turned on, or moved, after the day began: the next send day instead.
    expect(dueSendDay('2026-10-13', 1, null, '2026-10-12')).toBeNull();
    expect(dueSendDay('2026-10-13', 1, null, '2026-10-13')).toBeNull();
    expect(dueSendDay('2026-10-13', 1, null, null)).toBeNull();
  });

  test('a change of clocks that skips the send day on the person’s calendar still sends it, once', () => {
    // Sydney's clocks go forward on Sunday, October 4: the job's hour is 11
    // p.m. on Saturday, then midnight on Monday. A Sunday summary goes on Monday.
    const sat = todayIn(Date.parse('2026-10-03T13:00:00Z'), 'Australia/Sydney')!;
    const mon = todayIn(Date.parse('2026-10-04T13:00:00Z'), 'Australia/Sydney')!;
    expect([sat, mon]).toEqual(['2026-10-03', '2026-10-05']);
    expect(dueSendDay(sat, 0, '2026-09-27', '2026-09-01')).toBeNull();
    expect(dueSendDay(mon, 0, '2026-09-27', '2026-09-01')).toBe('2026-10-04');
    expect(dueSendDay(mon, 0, '2026-10-04', '2026-09-01')).toBeNull();
  });

  test('a change of clocks that gives the send day twice sends it once', () => {
    // Sydney's clocks go back on Sunday, April 5: both runs fall on that Sunday.
    const first = todayIn(Date.parse('2026-04-04T13:00:00Z'), 'Australia/Sydney')!;
    const second = todayIn(Date.parse('2026-04-05T13:00:00Z'), 'Australia/Sydney')!;
    expect([first, second]).toEqual(['2026-04-05', '2026-04-05']);
    expect(dueSendDay(first, 0, '2026-03-29', '2026-03-01')).toBe('2026-04-05');
    // Recorded after the first: the second finds it sent.
    expect(dueSendDay(second, 0, '2026-04-05', '2026-03-01')).toBeNull();
  });
});

// ---- The setting ----

describe('the setting', () => {
  test('is a closed shape: an unknown field or a wrong type is never read as off', () => {
    const ok = { v: 1, enabled: true, weekday: 1, time_zone: 'America/New_York', updated_at: '2026-10-01T00:00:00.000Z' };
    expect(isWeeklySetting(ok)).toBe(true);
    for (const bad of [
      { ...ok, extra: 1 },
      { ...ok, v: 2 },
      { ...ok, enabled: 'yes' },
      { ...ok, weekday: 7 },
      { ...ok, weekday: 1.5 },
      { ...ok, time_zone: '' },
      { ...ok, time_zone: '../etc' },
      { ...ok, updated_at: 'yesterday' },
      null,
      [],
    ]) {
      expect([bad, isWeeklySetting(bad)]).toEqual([bad, false]);
    }
    // A zone this runtime doesn't know still reads: the job says it can't
    // place it rather than reading the setting as unrecognised.
    expect(isWeeklySetting({ ...ok, time_zone: 'Mars/Olympus_Mons' })).toBe(true);
    expect(defaultSetting('UTC', 0)).toEqual({ v: 1, enabled: false, weekday: 1, time_zone: 'UTC', updated_at: '1970-01-01T00:00:00.000Z' });
  });

  test('a save is checked field by field, and its zone kept as the runtime names it', () => {
    expect(parseWeeklyChoice({ enabled: true, weekday: 0, time_zone: 'america/new_york' })).toEqual({ choice: { enabled: true, weekday: 0, time_zone: 'America/New_York' } });
    for (const bad of [
      null,
      'on',
      { enabled: 'true', weekday: 1, time_zone: 'UTC' },
      { enabled: true, weekday: -1, time_zone: 'UTC' },
      { enabled: true, weekday: '1', time_zone: 'UTC' },
      { enabled: true, weekday: 1, time_zone: 'Mars/Olympus_Mons' },
      { enabled: true, weekday: 1, time_zone: 'x'.repeat(65) },
      { enabled: true, weekday: 1, time_zone: 'UTC', email: 'someone@example.com' },
      { enabled: true, weekday: 1 },
    ]) {
      expect('error' in parseWeeklyChoice(bad)).toBe(true);
    }
  });
});

// ---- Spending ----

const ROW = { transaction_code: null, category: 'groceries', iso_currency_code: 'USD' };
/** A row of `amount` (Plaid's sign) on a day. */
const row = (date: string, amount: number, over: Record<string, unknown> = {}) => ({ ...ROW, date, amount, institution_name: 'Chase', ...over });

/** Nine weeks before the week of the send day 2026-10-12, each spending `perWeek` (the oldest first), and this week `now`. */
function weeks(perWeek: number[], now: number, over: Record<string, unknown> = {}) {
  const out: ReturnType<typeof row>[] = [];
  perWeek.forEach((amount, i) => out.push(row(addDays('2026-10-05', -7 * (perWeek.length - i)), amount, over)));
  if (now > 0) out.push(row('2026-10-07', now, over));
  return out;
}

const FRESH = { name: 'Chase', brings: true, synced_at: '2026-10-12T13:00:00.000Z', complete: true };
const spend = (rows: SpendingInput['rows'], over: Partial<SpendingInput> = {}): ReturnType<typeof spendingFact> =>
  spendingFact({
    rows,
    currency: 'USD',
    send_day: '2026-10-12',
    first: '2026-10-05',
    last: '2026-10-11',
    time_zone: 'America/New_York',
    sources: [FRESH],
    facts: NO_COVERAGE_GAPS,
    none_come_in: false,
    ...over,
  });

describe('spending against a usual week', () => {
  test('is in words, by the median of the weeks before', () => {
    expect(median([1, 5, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(levelOf(150, 100)).toBe('much_higher');
    expect(levelOf(149, 100)).toBe('higher');
    expect(levelOf(115, 100)).toBe('higher');
    expect(levelOf(114, 100)).toBe('same');
    expect(levelOf(86, 100)).toBe('same');
    expect(levelOf(85, 100)).toBe('lower');
    expect(levelOf(51, 100)).toBe('lower');
    expect(levelOf(50, 100)).toBe('much_lower');
    expect(levelOf(0, 0)).toBe('same');
    expect(levelOf(10, 0)).toBe('higher');
    const usual = [100, 100, 100, 100, 100, 100, 100, 100];
    expect(spend(weeks(usual, 200))).toEqual({ kind: 'compared', level: 'much_higher', left_out: [] });
    expect(spend(weeks(usual, 120))).toMatchObject({ level: 'higher' });
    expect(spend(weeks(usual, 100))).toMatchObject({ level: 'same' });
    expect(spend(weeks(usual, 70))).toMatchObject({ level: 'lower' });
    expect(spend(weeks(usual, 10))).toMatchObject({ level: 'much_lower' });
  });

  test('one big week before doesn’t make the usual week bigger', () => {
    expect(spend(weeks([100, 100, 100, 5000, 100, 100, 100, 100], 100))).toMatchObject({ level: 'same' });
  });

  test('counts what every total counts: not a refund, a transfer, a loan payment, or what was excluded', () => {
    const base = weeks([100, 100, 100, 100, 100, 100, 100, 100], 100);
    const noise = [
      row('2026-10-06', 900, { transaction_code: 'transfer' }),
      row('2026-10-06', 900, { category: 'loan payments' }),
      row('2026-10-06', 900, { excluded: true }),
      row('2026-10-06', -900),
    ];
    expect(spend([...base, ...noise])).toMatchObject({ level: 'same' });
    // A row whose exclusion couldn't be read counts, as in every total.
    expect(spend([...base, row('2026-10-06', 900, { excluded: null })])).toMatchObject({ level: 'much_higher' });
  });

  test('counts split parts, group nets and a group’s transactions counted elsewhere as every total does', () => {
    // The week's rows as the read layer finishes them (lib/split-rows.ts):
    // a split transaction's parts, one of them left out on its own; a group
    // whose net is a refund; a transaction of a group counted on a day
    // before what was read; and a split transaction in another currency.
    const week = [
      row('2026-10-06', 70, { split_of: 't-costco', split_index: 0, split_count: 2 }),
      row('2026-10-06', 30, { split_of: 't-costco', split_index: 1, split_count: 2, excluded: true }),
      row('2026-10-07', -40, { group_members: [{ transaction_id: 't-dinner' }, { transaction_id: 't-paid-back' }] }),
      row('2026-10-08', 55, { group_outside: { id: 'g-old', name: 'Trip', date: '2025-01-01', category_id: 'c', here: 1, missing: 0 } }),
      row('2026-10-09', 20, { split_of: 't-paris', split_index: 0, split_count: 2, iso_currency_code: 'EUR' }),
      row('2026-10-09', 30, { split_of: 't-paris', split_index: 1, split_count: 2, iso_currency_code: 'EUR' }),
      row('2026-10-10', 25),
    ];
    const inWeek = (d: string) => d >= '2026-10-05' && d <= '2026-10-11';
    // The money out the summary weighs is the totals' own, to the cent.
    expect(moneyOut(week, '2026-10-05', '2026-10-11', 'USD')).toBe(95);
    expect(moneyOut(week, '2026-10-05', '2026-10-11', 'USD')).toBe(summarize(week as never, inWeek, 'USD').money_out);
    // What it leaves out for its currency is counted in transactions: the
    // two parts of the one in Paris are one.
    expect(leftOutByCurrency(week, 'USD')).toEqual([{ currency: 'EUR', count: 1 }]);
    // So against usual weeks of 95, the week is the same, and says EUR.
    const usual = weeks([95, 95, 95, 95, 95, 95, 95, 95], 0);
    expect(spend([...usual, ...week])).toEqual({ kind: 'compared', level: 'same', left_out: ['EUR'] });
    // Were the part left out on its own counted, or the transaction counted
    // through its group, the week would read higher than it is.
    expect(moneyOut(week.map((t) => ({ ...t, excluded: undefined, group_outside: undefined })), '2026-10-05', '2026-10-11', 'USD')).toBe(180);
  });

  test('says which currencies it couldn’t count, and converts nothing', () => {
    const rows = [...weeks([100, 100, 100, 100, 100, 100, 100, 100], 100), row('2026-10-08', 5000, { iso_currency_code: 'EUR' })];
    expect(spend(rows)).toEqual({ kind: 'compared', level: 'same', left_out: ['EUR'] });
  });

  test('the week’s edges: its first and last days count, the send day and the day before the week don’t', () => {
    const usual = weeks([100, 100, 100, 100, 100, 100, 100, 100], 0);
    expect(spend([...usual, row('2026-10-05', 50), row('2026-10-11', 50)])).toMatchObject({ level: 'same' });
    // Spent on the send day, and the day before the week began: not this week.
    expect(spend([...usual, row('2026-10-12', 500), row('2026-10-04', 500), row('2026-10-07', 100)])).toMatchObject({ level: 'same' });
  });

  test('a week with no transactions says so', () => {
    expect(spend(weeks([100, 100, 100, 100, 100, 100, 100, 100], 0))).toEqual({ kind: 'no_transactions' });
    expect(spend([])).toEqual({ kind: 'no_transactions' });
  });

  test('too early with fewer than four weeks to go by, counting only weeks after every connection’s history began', () => {
    expect(spend(weeks([100, 100, 100], 100))).toEqual({ kind: 'too_early', why: 'history' });
    expect(spend(weeks([100, 100, 100, 100], 100))).toMatchObject({ kind: 'compared' });
    // A second bank whose stored history began three weeks ago.
    const facts = { ...NO_COVERAGE_GAPS, first: [{ institution: 'Amex', day: '2026-09-14' }] };
    expect(spend(weeks([100, 100, 100, 100, 100, 100, 100, 100], 100), { facts })).toEqual({ kind: 'too_early', why: 'history' });
    // Older transactions still arriving.
    expect(spend(weeks([100, 100, 100, 100, 100, 100, 100, 100], 100), { sources: [{ ...FRESH, complete: false }] })).toEqual({ kind: 'too_early', why: 'importing' });
  });

  test('isn’t compared while the week’s transactions aren’t all in, and says from where', () => {
    const rows = weeks([100, 100, 100, 100, 100, 100, 100, 100], 10);
    // Last brought in on Saturday, on the person's calendar: before the week ended.
    expect(spend(rows, { sources: [{ ...FRESH, synced_at: '2026-10-10T15:00:00.000Z' }] })).toEqual({ kind: 'behind', sources: [{ name: 'Chase', since: '2026-10-10' }] });
    // 1 a.m. UTC on the send day is still the Sunday before in New York.
    expect(spend(rows, { sources: [{ ...FRESH, synced_at: '2026-10-12T01:00:00.000Z' }] })).toMatchObject({ kind: 'behind', sources: [{ since: '2026-10-11' }] });
    expect(spend(rows, { sources: [{ ...FRESH, synced_at: null }] })).toEqual({ kind: 'behind', sources: [{ name: 'Chase', since: null }] });
    // A connection that stopped before the week ended.
    const stopped = { ...NO_COVERAGE_GAPS, stopped: [{ institution_name: 'Amex', last_ok_at: '2026-10-08T12:00:00.000Z' }] };
    expect(spend(rows, { facts: stopped })).toEqual({ kind: 'behind', sources: [{ name: 'Amex', since: '2026-10-08' }] });
    // Unless every account it holds ended before the week began.
    const ended = { ...NO_COVERAGE_GAPS, stopped: [{ institution_name: 'Amex', last_ok_at: '2026-09-01T12:00:00.000Z', until: '2026-09-15' }] };
    expect(spend(rows, { facts: ended })).toMatchObject({ kind: 'compared' });
    // One whose transactions couldn't be loaded at all.
    expect(spend(rows, { facts: { ...NO_COVERAGE_GAPS, incomplete: [{ institution_name: 'Amex', coverage: 'missing' }] } })).toEqual({ kind: 'behind', sources: [{ name: 'Amex', since: null }] });
    // A connection that brings in no transactions doesn't count either way.
    expect(spend(rows, { sources: [FRESH, { name: 'Broker', brings: false, synced_at: null, complete: true }] })).toMatchObject({ kind: 'compared' });
  });

  test('says when no connection brings in transactions at all', () => {
    expect(spend([], { none_come_in: true })).toEqual({ kind: 'none_come_in' });
  });
});

// ---- Budgets ----

const cats = categoriesFor({}, { words: ['groceries', 'restaurants', 'coffee', 'rent 1500'], groups: { groceries: 'Food', restaurants: 'Food', coffee: 'Food' } });
const ix = indexTaxonomy(cats.taxonomy);
const idOf = (t: Taxonomy, name: string) => t.categories.find((c) => c.name.toLowerCase() === name)!.id;
const GROCERIES = idOf(cats.taxonomy, 'groceries');
const RESTAURANTS = idOf(cats.taxonomy, 'restaurants');
const COFFEE = idOf(cats.taxonomy, 'coffee');
const FOOD = cats.taxonomy.groups.find((g) => g.name === 'Food')!.id;
const budgetsOf = (categories: Record<string, number>, groups: Record<string, number> = {}): Budgets => ({
  categories: Object.fromEntries(Object.entries(categories).map(([k, amount]) => [k, { amount }])),
  groups: Object.fromEntries(Object.entries(groups).map(([k, amount]) => [k, { amount }])),
});
const monthView = (budgets: Budgets, spending: Record<string, Record<string, number>>, month = '2026-10', months = startMonths(budgets, '2026-01')) =>
  budgetsInMonth({ ix, budgets, months, month, today: month, spending: (m) => new Map(Object.entries(spending[m] ?? {})), earliest: '2026-01', uncertain: () => false });

describe('budgets over and close', () => {
  test('as the Budgets tab meters them: over once used up, close from 85%, the most over first', () => {
    const budgets = budgetsOf({ [GROCERIES]: 400, [RESTAURANTS]: 100, [COFFEE]: 50 });
    const spent = { [GROCERIES]: 500, [RESTAURANTS]: 100, [COFFEE]: 43 };
    const view = monthView(budgets, { '2026-10': spent });
    expect(budgetFact({ ix, view, spent, month: '2026-10', running: true })).toEqual({ month: '2026-10', running: true, over: ['groceries', 'restaurants'], close: ['coffee'] });
    // 84% is not close.
    expect(budgetFact({ ix, view, spent: { [COFFEE]: 42 }, month: '2026-10', running: true })).toBeNull();
  });

  test('close only means something while the month runs', () => {
    const budgets = budgetsOf({ [COFFEE]: 50 });
    const view = monthView(budgets, {});
    expect(budgetFact({ ix, view, spent: { [COFFEE]: 45 }, month: '2026-09', running: false })).toBeNull();
    expect(budgetFact({ ix, view, spent: { [COFFEE]: 50 }, month: '2026-09', running: false })).toMatchObject({ over: ['coffee'], close: [] });
  });

  test('a group with a budget of its own is metered as a whole', () => {
    const budgets = budgetsOf({}, { [FOOD]: 300 });
    const spent = { [GROCERIES]: 200, [RESTAURANTS]: 120 };
    expect(budgetFact({ ix, view: monthView(budgets, { '2026-10': spent }), spent, month: '2026-10', running: true })).toMatchObject({ over: ['Food'] });
  });

  test('with what rolled over, as rollover sees the month', () => {
    // Groceries rolls over from August: 300 a month, 450 spent in September, so
    // October starts 150 over and 200 of its 300 is what is left.
    const budgets = budgetsOf({ [GROCERIES]: 300 });
    const months = setRollover(startMonths(budgets, '2026-08'), 'categories', GROCERIES, { on: true, from: '2026-09' }, '2026-09');
    const spending = { '2026-09': { [GROCERIES]: 450 }, '2026-10': { [GROCERIES]: 160 } };
    const view = monthView(budgets, spending, '2026-10', months);
    expect(view.carries.categories[GROCERIES].carry).toBe(-150);
    // 160 of 150 available: over, where a flat 300 would say nothing.
    expect(budgetFact({ ix, view, spent: spending['2026-10'], month: '2026-10', running: true })).toMatchObject({ over: ['groceries'] });
  });

  test('none over or close is no section', () => {
    const budgets = budgetsOf({ [GROCERIES]: 400 });
    expect(budgetFact({ ix, view: monthView(budgets, {}), spent: { [GROCERIES]: 10 }, month: '2026-10', running: true })).toBeNull();
    expect(budgetFact({ ix, view: monthView(budgetsOf({}), {}), spent: {}, month: '2026-10', running: true })).toBeNull();
  });
});

// ---- Bills ----

const billRow = (date: string, name: string, amount: number, over: Partial<RecurringRow> = {}): RecurringRow => ({
  date,
  name,
  amount,
  institution_name: 'Chase',
  category: 'entertainment',
  transaction_code: null,
  iso_currency_code: 'USD',
  account_name: 'Checking',
  account_type: 'depository',
  ...over,
});
/** Charged on the 14th of each month since May. */
const monthly = (name: string, day = '14', amount = 15.99) => ['05', '06', '07', '08', '09'].map((m) => billRow(`2026-${m}-${day}`, name, amount));

describe('bills due in the next seven days', () => {
  test('as detected, on their expected days, once by name, soonest first', () => {
    const series = detectRecurring([...monthly('Netflix'), ...monthly('Gym', '20', 40), ...monthly('Rent', '01', 1500)]);
    const bills = billsFact({ series, dismissed: [], planned: [], today: '2026-10-12' });
    expect(bills).toEqual([{ name: 'Netflix', day: '2026-10-14', late: false, planned: false }]);
    // Seven days: the send day through the sixth after it.
    expect(billsFact({ series, dismissed: [], planned: [], today: '2026-10-14' }).map((b) => b.name)).toEqual(['Netflix', 'Gym']);
    expect(billsFact({ series, dismissed: [], planned: [], today: '2026-10-08' }).map((b) => b.name)).toEqual(['Netflix']);
  });

  test('never one the person said isn’t recurring', () => {
    const series = detectRecurring(monthly('Netflix'));
    expect(billsFact({ series, dismissed: [series[0].id], planned: [], today: '2026-10-12' })).toEqual([]);
  });

  test('one late is expected now, with its own due day, first', () => {
    const series = detectRecurring(monthly('Netflix', '10'));
    expect(billsFact({ series, dismissed: [], planned: [], today: '2026-10-12' })).toEqual([{ name: 'Netflix', day: '2026-10-10', late: true, planned: false }]);
  });

  test('with the expenses the person planned, not their income', () => {
    const planned = [
      { id: 'p1', name: 'Car insurance', kind: 'expense' as const, amount: 60000, currency: 'USD', date: '2026-10-15', cadence: 'once' as const },
      { id: 'p2', name: 'Tax refund', kind: 'income' as const, amount: 90000, currency: 'USD', date: '2026-10-13', cadence: 'once' as const },
      { id: 'p3', name: 'Later', kind: 'expense' as const, amount: 100, currency: 'USD', date: '2026-10-19', cadence: 'once' as const },
    ];
    expect(billsFact({ series: [], dismissed: [], planned, today: '2026-10-12' })).toEqual([{ name: 'Car insurance', day: '2026-10-15', late: false, planned: true }]);
  });
});

// ---- Goals, connections, months ----

describe('goals', () => {
  const goals = [
    { id: 'g-fund', name: 'Emergency fund', archived: false, state: 'tracked', status: 'complete' as const },
    { id: 'g-trip', name: 'Trip', archived: false, state: 'tracked', status: 'behind' as const },
    { id: 'g-old', name: 'Old trip', archived: true, state: 'tracked', status: 'behind' as const },
    { id: 'g-car', name: 'Car', archived: false, state: 'tracked', status: 'on_track' as const },
    { id: 'g-hidden', name: 'Hidden one', archived: false, state: 'hidden', status: null },
  ];

  test('at their target and behind, as the Goals card says, never archived or untracked ones', () => {
    expect(goalsFact(goals)).toEqual({ reached: ['Emergency fund'], behind: ['Trip'], complete: ['g-fund'] });
  });

  test('one at its target is told of once, behind ones every week', () => {
    // Told last week: not again, though it is still there; still behind: again.
    expect(goalsFact(goals, ['g-fund'])).toEqual({ reached: [], behind: ['Trip'], complete: ['g-fund'] });
    // One that slipped below its target and reached it again is news again.
    const slipped = goalsFact(goals.map((g) => (g.id === 'g-fund' ? { ...g, status: 'on_track' as const } : g)), ['g-fund']);
    expect(slipped.complete).toEqual([]);
    expect(goalsFact(goals, slipped.complete).reached).toEqual(['Emergency fund']);
    // Before any summary went: every one at its target is news.
    expect(goalsFact(goals, null).reached).toEqual(['Emergency fund']);
  });
});

const NOW = Date.parse('2026-10-12T13:30:00.000Z');
const items = [
  { item_id: 'i1', institution_name: 'Chase' },
  { item_id: 'i2', institution_name: 'Amex' },
  { item_id: 'i3', institution_name: 'Ally' },
  { item_id: 'i4', institution_name: 'Wells' },
];
const notice = (state: string, over: Record<string, unknown> = {}) => ({ episode: 'e1', since: '2026-10-10T13:00:00.000Z', state, side: 'you', notified_at: null, reminded_at: null, ...over }) as any;

describe('connections that need the person', () => {
  test('from what the daily job last found, never a problem on Nya’s side', () => {
    const notices = new Map([
      ['i1', notice('needs_reauth')],
      ['i2', notice('relink', { side: 'bank' })],
      ['i3', notice('outage', { side: 'nya' })],
      ['i4', notice('closed', { side: 'bank' })],
    ]);
    expect(connectionsFact({ items, notices, warnings: new Map(), syncs: new Map(), now: NOW }).map((c) => [c.name, c.state])).toEqual([
      ['Amex', 'relink'],
      ['Chase', 'needs_reauth'],
      ['Wells', 'closed'],
    ]);
  });

  test('an outage only once it has gone three days', () => {
    const notices = new Map([['i1', notice('outage', { side: 'bank' })]]);
    expect(connectionsFact({ items, notices, warnings: new Map(), syncs: new Map([['i1', { at: '2026-10-11T13:00:00.000Z' }]]), now: NOW })).toEqual([]);
    expect(connectionsFact({ items, notices, warnings: new Map(), syncs: new Map([['i1', { at: '2026-10-08T13:00:00.000Z' }]]), now: NOW })).toEqual([{ name: 'Chase', state: 'outage', ends_at: null }]);
  });

  test('a warned end, with its day, unless it lapsed', () => {
    const warning = { kind: 'pending_expiration', received_at: '2026-10-09T00:00:00.000Z', ends_at: '2026-10-20T00:00:00.000Z', ends_estimated: false, reason: null } as const;
    expect(connectionsFact({ items, notices: new Map(), warnings: new Map([['i1', warning]]), syncs: new Map(), now: NOW })).toEqual([{ name: 'Chase', state: 'reconnect_soon', ends_at: '2026-10-20T00:00:00.000Z' }]);
    // It answered past the end it named: lapsed.
    const lapsed = connectionsFact({ items, notices: new Map(), warnings: new Map([['i1', warning]]), syncs: new Map([['i1', { at: '2026-10-21T00:00:00.000Z' }]]), now: NOW });
    expect(lapsed).toEqual([]);
  });
});

describe('months that may be incomplete', () => {
  test('the week’s months, as the Budgets tab says them', () => {
    const facts: CoverageFacts = { ...NO_COVERAGE_GAPS, stopped: [{ institution_name: 'Chase', last_ok_at: '2026-09-25T10:00:00.000Z' }] };
    expect(monthsFact(['2026-09', '2026-10', '2026-10'], facts)).toEqual([
      { month: '2026-09', gaps: [{ kind: 'stopped', institution: 'Chase', since: '2026-09-25T10:00:00.000Z' }] },
      { month: '2026-10', gaps: [{ kind: 'stopped', institution: 'Chase', since: '2026-09-25T10:00:00.000Z' }] },
    ]);
    expect(monthsFact(['2026-10'], NO_COVERAGE_GAPS)).toEqual([]);
  });
});

describe('transactions with no category', () => {
  test('the week’s from SimpleFIN that count, as the Activity tab counts them', () => {
    const rows = [
      row('2026-10-06', 10, { source: 'simplefin', category: null }),
      row('2026-10-07', 10, { source: 'simplefin', category: null }),
      row('2026-10-07', 10, { source: 'simplefin', category: null, excluded: true }),
      row('2026-10-12', 10, { source: 'simplefin', category: null }),
      row('2026-10-07', 10, { category: null }),
    ];
    expect(uncategorizedFact(rows, '2026-10-05', '2026-10-11')).toBe(2);
    // Named by the services they came through that week, and no other.
    expect(uncategorizedSourcesFact(rows, '2026-10-05', '2026-10-11')).toBe('SimpleFIN');
    const both = [...rows, row('2026-10-08', 5, { source: 'lunchflow', category: null }), row('2026-10-13', 5, { source: 'lunchflow', category: null })];
    expect(uncategorizedSourcesFact(both, '2026-10-05', '2026-10-11')).toBe('SimpleFIN or Lunch Flow');
    expect(uncategorizedSourcesFact(both.slice(rows.length), '2026-10-05', '2026-10-11')).toBe('Lunch Flow');
  });
});

// ---- The words ----

const WEEK = { send_day: '2026-10-12', first: '2026-10-05', last: '2026-10-11', today: '2026-10-12', time_zone: 'America/New_York', weekday: 1 as const };
const quietFacts = (over: Partial<WeeklyFacts> = {}): WeeklyFacts => ({
  ...WEEK,
  spending: { kind: 'compared', level: 'same', left_out: [] },
  budgets: null,
  bills: [],
  goals: { reached: [], behind: [], complete: [] },
  connections: [],
  months: [],
  uncategorized: 0,
  ...over,
});
const richFacts = (over: Partial<WeeklyFacts> = {}): WeeklyFacts =>
  quietFacts({
    spending: { kind: 'compared', level: 'higher', left_out: ['EUR'] },
    budgets: { month: '2026-10', running: true, over: ['Groceries', 'Rent 1500'], close: ['Dining out', '$ Treats'] },
    bills: [
      { name: 'Netflix', day: '2026-10-13', late: false, planned: false },
      { name: 'Transfer to 4821', day: '2026-10-14', late: false, planned: false },
      { name: 'Car insurance', day: '2026-10-15', late: false, planned: true },
      { name: 'Spotify', day: '2026-10-10', late: true, planned: false },
    ],
    goals: { reached: ['Emergency fund'], behind: ['Trip 2027', 'New car'], complete: ['g-fund'] },
    connections: [
      { name: 'Chase', state: 'needs_reauth', ends_at: null },
      { name: 'Ally', state: 'reconnect_soon', ends_at: '2026-10-20T03:00:00.000Z' },
      { name: '1st Bank', state: 'relink', ends_at: null },
    ],
    months: [{ month: '2026-10', gaps: [{ kind: 'stopped', institution: 'Chase', since: '2026-10-08T12:00:00.000Z' }, { kind: 'exclusions', count: 3 }] }],
    uncategorized: 2,
    ...over,
  });
const LINK = 'https://nya.example.com';
const STOP = `${LINK}/unsubscribe?t=0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b.20270110.${'A'.repeat(43)}`;
const opts = (over: Partial<ComposeOptions> = {}): ComposeOptions => ({ link: LINK, unsubscribe: STOP, requested: false, schedule: 1, now: NOW, ...over });
/** The check, as the senders run it on a composed summary. */
const figures = (s: { subject: string; text: string; send_day?: string; banks?: string[]; codes?: string[] }) =>
  figuresIn([s.subject, s.text], { sendDay: s.send_day ?? '2026-10-12', banks: s.banks, codes: s.codes });
/** The check over one bit of text, in a week of October 2026. */
const figuresOf = (text: string) => figuresIn([text], { sendDay: '2026-10-12' });

describe('names', () => {
  test('carried only without a digit or a currency sign; one line, not too long', () => {
    expect(safeName('Groceries')).toBe('Groceries');
    expect(safeName('  Dining\nout  ')).toBe('Dining out');
    expect(safeName('Café crème')).toBe('Café crème');
    for (const bad of ['Rent 1500', 'Transfer to 4821', 'Goal 5k', '$ Treats', '€uro trip', 'Trip ２０２７', 'Half ½', 'Ⅻ club', '①', '% off', 'Save 10%', '']) {
      expect([bad, safeName(bad)]).toEqual([bad, null]);
    }
    expect(safeName('word '.repeat(30))!.length).toBeLessThanOrEqual(60);
  });

  test('never one shaped like a link or an address, which a program could have named: counted instead', () => {
    for (const bad of ['Verify at evil.example', 'https://x', 'www.bank-login', 'Pay me@there', 'St.Louis trip', 'Login.SECURE']) {
      expect([bad, safeName(bad)]).toEqual([bad, null]);
    }
    for (const fine of ['Dr. Smith', 'e.g. snacks', 'Food & drink', 'A. B. Groceries']) expect([fine, safeName(fine)]).toEqual([fine, fine]);
  });

  test('never one that spells out a number or a currency, in any case, plural or run together', () => {
    for (const bad of [
      'Fifty dollars a week',
      'Ten thousand for the car',
      'Rent: one thousand five hundred',
      'Half my pay',
      'Ten grand',
      'Groceries (max fifty)',
      'Emergency fund three months',
      'Million dollar house',
      'A dollar a day',
      'A buck a day',
      'TWENTY FIVE',
      'Twenties for the kids',
      'Fivehundred',
      'fiftybucks',
      'Tenk for the trip',
      'Save hundreds',
      'Pennies jar',
      'fifteen percent',
      'Fifteen per cent',
      'Cinquante euros',
      'Cincuenta dólares',
      'Mil pesos',
      'Twenty quid',
      'Forty kronor',
    ]) {
      expect([bad, safeName(bad)]).toEqual([bad, null]);
    }
    // Words that only look like them.
    for (const fine of ['Often', 'Tension', 'Phone bill', 'Someone else', 'Quarterly taxes', 'Starbucks', 'Kmart', 'Real estate', 'Network', 'Done', 'Bones']) {
      expect([fine, safeName(fine)]).toEqual([fine, fine]);
    }
    expect(spellsFigure('the next seven days')).toBe(true);
    expect(spellsFigure('Groceries and Dining out')).toBe(false);
  });

  test('never one that spells out a number in Spanish, Portuguese, French, Italian or German', () => {
    for (const bad of [
      'Diez mil para el coche',
      'Quinientos al mes',
      'Veinticinco',
      'Veintiuno',
      'Cinquenta e cinco',
      'Dois mil',
      'Cinq cents',
      'Trente mille',
      'Soixante-dix',
      'Cinquemila',
      'Duemila',
      'Zehntausend',
      'Fünfhundert',
      'Einhundert',
      'Fünfundzwanzig',
      'Zwei Millionen',
    ]) {
      expect([bad, safeName(bad)]).toEqual([bad, null]);
    }
    // Their words for one, which are their word for "a" too, and those that
    // are English words as well, are left as they are.
    for (const fine of ['Membership dues', 'Bills due', 'Once a year', 'Sept rent', 'Seize the day', 'Elf costume', 'Null and void', 'Une soirée', 'Uno pizza', 'Un viaje', 'Air miles', 'Einstein', 'Tree fund', 'Trend']) {
      expect([fine, safeName(fine)]).toEqual([fine, fine]);
    }
  });

  test('never one with letters outside the Latin alphabet: no list of words can read them', () => {
    for (const bad of ['五百元', 'Продукты', 'Οικογένεια', 'خمسون', 'Rent 五']) expect([bad, safeName(bad)]).toEqual([bad, null]);
  });

  test('control and format characters out, so nothing reorders or hides what is around it', () => {
    expect(tidyName('Chase \u202Eknab')).toBe('Chase knab');
    expect(safeName('Dining\u200Bout')).toBe('Diningout');
    expect(safeName('\u2066Netflix\u2069 \u200Ebill\u200F')).toBe('Netflix bill');
    expect(safeName('\u200B')).toBeNull();
  });

  test('a bank’s name, from Plaid or SimpleFIN, is held to digits and currency and percent signs only', () => {
    for (const bank of ['Capital One', 'Five Star Bank', 'Dollar Bank', 'Fifth Third Bank']) expect([bank, safeBankName(bank)]).toEqual([bank, bank]);
    for (const bad of ['1st Bank', '$ Bank', '']) expect([bad, safeBankName(bad)]).toEqual([bad, null]);
    expect(safeBankName('Chase\u202E')).toBe('Chase');
  });

  test('a list says the others by count', () => {
    expect(namesText(['Groceries'], 'budget')).toBe('Groceries');
    expect(namesText(['Groceries', 'Dining out'], 'budget')).toBe('Groceries and Dining out');
    expect(namesText(['Groceries', 'Rent 1500'], 'budget')).toBe('Groceries and 1 other');
    expect(namesText(['Groceries', 'Fifty a week'], 'budget')).toBe('Groceries and 1 other');
    expect(namesText(['Rent 1500', 'Car 2'], 'budget')).toBe('2 budgets');
    expect(namesText(['A', 'B', 'C', 'D', 'E', 'F', 'G'], 'budget')).toBe('A, B, C, D, E and 2 others');
    // One name, however it is spaced or cased, is one.
    expect(namesText(['Dining out', 'Dining  out', 'Dining\nout', 'dining out'], 'budget')).toBe('Dining out');
    // One that is nothing once tidied is still a budget.
    expect(namesText(['\u200B'], 'budget')).toBe('1 budget');
  });

  test('days and weeks in words, with years only across one', () => {
    expect(dayText('2026-10-13')).toBe('Tuesday, October 13');
    expect(dayText('2027-01-02', '2026')).toBe('Saturday, January 2, 2027');
    expect(weekText('2026-10-05', '2026-10-11')).toBe('Monday, October 5 to Sunday, October 11');
    expect(weekText('2026-12-28', '2027-01-03')).toBe('Monday, December 28, 2026 to Sunday, January 3, 2027');
  });
});

describe('the summary’s words', () => {
  test('a rich week: every section, names that can be carried, the rest counted', () => {
    const { subject, text } = composeWeekly(richFacts(), opts());
    expect(subject).toBe('Your week in Nya: 3 connections need you, 2 budgets over');
    expect(text).toContain('Your week in Nya: Monday, October 5 to Sunday, October 11.');
    expect(text).toContain("You spent more this week than in a usual week. Transactions in EUR aren't counted in that.");
    expect(text).toContain('Over budget in October: Groceries and 1 other.');
    expect(text).toContain('Close to the limit in October: Dining out and 1 other.');
    expect(text).toContain('Bills due in the next seven days:\n- Netflix: Tuesday, October 13\n- A bill: Wednesday, October 14\n- Car insurance (planned): Thursday, October 15\n- Spotify: due Saturday, October 10, not in yet');
    expect(text).toContain('Goals at their target: Emergency fund.');
    expect(text).toContain('Goals behind their target date: New car and 1 other.');
    expect(text).toContain('- Chase needs reconnecting.');
    expect(text).toContain('- Reconnect Ally soon: Plaid says its connection ends around Monday, October 19.');
    // A bank that can't be repaired, by what is true whether or not
    // connecting it again would help, which the record doesn't say.
    expect(text).toContain("- A bank's connection can't be repaired.");
    expect(text).toContain("October may be missing transactions: Chase hasn't synced since Thursday, October 8 and whether you excluded 3 transactions couldn't be read.");
    expect(text).toContain('2 transactions from SimpleFIN or Lunch Flow this week have no category, so they count as spending or income until you categorize them.');
    // Named by the service they came through, when the facts say which.
    expect(composeWeekly(richFacts({ uncategorized_from: 'SimpleFIN' }), opts()).text).toContain('2 transactions from SimpleFIN this week have no category');
    expect(composeWeekly(richFacts({ uncategorized: 1, uncategorized_from: 'Lunch Flow' }), opts()).text).toContain('1 transaction from Lunch Flow this week has no category');
    expect(text).toContain(`Open Nya to see the figures: ${LINK}/`);
    expect(text).toContain(`Nya sends you this every Monday because you turned on the weekly summary. It never includes balances, amounts or account numbers. To stop these summaries, open ${STOP} or turn them off in Nya, under Manage on the Accounts tab.`);
    expect(text).not.toContain('Nothing needs your attention');
    expect(text.endsWith('\n')).toBe(true);
  });

  test('never carries a figure: no amount, no balance, no account number, whatever the names hold', () => {
    const newYear = { send_day: '2027-01-04', first: '2026-12-28', last: '2027-01-03', today: '2027-01-05' };
    const spelled = richFacts({
      budgets: { month: '2026-10', running: true, over: ['Fifty dollars a week', 'Groceries'], close: ['Ten grand'] },
      goals: { reached: ['One million'], behind: ['Ten thousand for the car'], complete: [] },
      bills: [{ name: 'Rent fifteen hundred', day: '2026-10-13', late: false, planned: true }],
    });
    for (const f of [richFacts(), quietFacts(), richFacts(newYear), spelled]) {
      for (const o of [opts(), opts({ requested: true }), opts({ requested: true, schedule: null, unsubscribe: null })]) {
        const composed = composeWeekly(f, o);
        const { subject, text } = composed;
        expect(figures(composed)).toEqual([]);
        // Not any fragment of a name with a figure, either.
        const bare = `${subject}\n${text}`.replace(/https:\S+/g, '').replace(/January \d+, 2027/g, '');
        for (const leak of ['1500', '4821', '2027', '$', '1st', 'Fifty', 'thousand', 'grand', 'million', 'fifteen']) expect([leak, bare.includes(leak)]).toEqual([leak, false]);
        expect(checkedSummary(composed)).toEqual({ subject, text });
      }
    }
  });

  test('a week with a currency left out that is also a money word is sent: the codes it writes are its own', () => {
    // Plaid's code for bitcoin is BTC, which is on the money words for names.
    const s = composeWeekly(quietFacts({ spending: { kind: 'compared', level: 'same', left_out: ['BTC', 'EUR'] } }), opts());
    expect(s.text).toContain("Transactions in BTC and EUR aren't counted in that.");
    expect(s.codes).toEqual(['BTC', 'EUR']);
    expect(figures({ ...s, codes: s.codes } as never)).toEqual([]);
    expect(checkedSummary(s).text).toBe(s.text);
    // Only as it writes them: a code anywhere else is still a word to refuse,
    // and one beside a number is still a number.
    expect(figuresIn(['Spent in btc'], { sendDay: '2026-10-12', codes: ['BTC'] })).toEqual(['a number or a currency written as a word']);
    expect(figuresIn(['Transactions in BTC 40'], { sendDay: '2026-10-12', codes: ['BTC'] }).length).toBeGreaterThan(0);
  });

  test('a name that spells out an amount is counted, in the body and in the subject', () => {
    const one = composeWeekly(
      quietFacts({
        budgets: { month: '2026-10', running: true, over: ['Fifty dollars a week'], close: [] },
        goals: { reached: [], behind: ['Ten thousand for the car'], complete: [] },
      }),
      opts()
    );
    expect(one.subject).toBe('Your week in Nya: 1 budget over, 1 goal behind');
    expect(one.text).toContain('Over budget in October: 1 budget.');
    expect(one.text).toContain('Goals behind their target date: 1 goal.');
    expect(one.text).not.toContain('Fifty');
    expect(one.text).not.toContain('thousand');
    // A bank's name is its bank's: named, though it holds a number word.
    const bank = composeWeekly(quietFacts({ connections: [{ name: 'Capital One', state: 'needs_reauth', ends_at: null }] }), opts());
    expect(bank.subject).toBe('Your week in Nya: Capital One needs reconnecting');
    expect(bank.text).toContain('- Capital One needs reconnecting.');
    expect(bank.banks).toEqual(['Capital One']);
    expect(figures(bank)).toEqual([]);
  });

  test('the check finds every kind of figure, outside its own days, counts and links', () => {
    const cases: [string, string][] = [
      ['You spent $120 this week.', 'a currency sign by a number'],
      ['You spent 120 € this week.', 'a currency sign by a number'],
      ['Spent: USD 40', 'a currency code by a number'],
      ['Spent 40 EUR', 'a currency code by a number'],
      ['Balance 1,204', 'a number with a decimal or grouping mark'],
      ['Spent 12.50', 'a number with a decimal or grouping mark'],
      ['Up 15% on last week', 'a percentage'],
      ['Checking ••4821', 'an account mask'],
      ['Checking *4821', 'an account mask'],
      ['the account ending in 21', 'an account mask'],
      ['Card x4821', 'an account mask'],
      ['Rent was 1500', 'a number of three digits or more'],
      ['Spent ٣ times', 'a digit that is not ASCII'],
    ];
    for (const [text, kind] of cases) expect([text, figuresOf(text)]).toEqual([text, expect.arrayContaining([kind])]);
    expect(() => checkedSummary({ subject: 'Your week', text: 'Spent $5', send_day: '2026-10-12', banks: [], codes: [] })).toThrow(FigureError);
  });

  test('anything but its own days and counts is refused: every figure a blocklist missed', () => {
    for (const text of [
      '$1,234',
      '1.234,56 €',
      '12k',
      'USD 40',
      '40 dollars',
      '40 usd',
      '40 kr',
      'kr 40',
      'Fr. 40',
      '5 grand',
      'forty dollars',
      'Spent 40 at Target',
      'Rent for May 1500',
      'June 1234.56',
      'Paid October 12, 2500 to Chase',
      '1 500',
      '12 345',
      '£40',
      '40p',
      '€40',
      '40€',
      'R$40',
      'CHF40',
      'EUR 1,234',
      '15%',
      '15 %',
      'fifteen percent',
      '½',
      'x1234',
      'xx12',
      'acct 4821',
      'Account 4821',
      '...4821',
      'ending 4821',
      '#21',
      'No. 21',
      'Card 21',
      'Fifty dollars a week over budget',
      '五百元',
      '% off',
      // A date as it never writes one: a day without its weekday, a weekday
      // that isn't the date's, a year far from the send day's.
      'October 12',
      // (October 12 is a Sunday in 2025, a Monday in 2026, a Tuesday in 2027.)
      'Wednesday, October 12',
      'Monday, October 12, 1999',
      'Monday, October 12, 2037',
      'May 1500',
      // A count of something it never counts.
      '12 dollars',
      '2 cards',
    ]) {
      expect([text, figuresOf(text).length > 0]).toEqual([text, true]);
    }
    // Its own words pass: days, a year where one is in another year, months,
    // counts, the week in the subject, its links and the next seven days.
    for (const own of [
      'Your week in Nya: 2 bills due, 1 budget over',
      'Monday, December 28, 2026 to Sunday, January 3, 2027.',
      'Saturday, January 2, 2027',
      'Monday, October 12',
      'October 2025 may be missing transactions',
      '12 transactions from SimpleFIN',
      'Restaurants and 1 other. 3 goals behind. over 99 bills due. 2 connections need you. 2 other reasons.',
      'Your week in Nya: October 5 to 11',
      `Open Nya to see the figures: ${LINK}/ ${STOP}`,
      'Bills due in the next seven days:',
    ]) {
      expect([own, figuresOf(own)]).toEqual([own, []]);
    }
    // A bank's name is left to its own rule; a name of the person's isn't.
    expect(figuresIn(['Capital One needs reconnecting.'], { sendDay: '2026-10-12', banks: ['Capital One'] })).toEqual([]);
    expect(figuresIn(['Capital One needs reconnecting.'], { sendDay: '2026-10-12' })).toEqual(['a number or a currency written as a word']);
    // The week of a summary sent on New Year's Day is in the year before.
    expect(figuresIn(['Your week in Nya: Friday, December 25 to Thursday, December 31.'], { sendDay: '2027-01-01' })).toEqual([]);
  });

  test('a quiet week says so', () => {
    const { subject, text } = composeWeekly(quietFacts(), opts());
    expect(subject).toBe('Your week in Nya: a quiet week');
    expect(text).toBe(
      [
        'Your week in Nya: Monday, October 5 to Sunday, October 11.',
        'You spent about as much this week as in a usual week.',
        'Nothing needs your attention this week.',
        `Open Nya to see the figures: ${LINK}/`,
        `Nya sends you this every Monday because you turned on the weekly summary. It never includes balances, amounts or account numbers. To stop these summaries, open ${STOP} or turn them off in Nya, under Manage on the Accounts tab.`,
      ].join('\n\n') + '\n'
    );
  });

  test('a week with no transactions says so plainly', () => {
    const { subject, text } = composeWeekly(quietFacts({ spending: { kind: 'no_transactions' } }), opts());
    expect(subject).toBe('Your week in Nya: no transactions');
    expect(text).toContain('\n\nNo transactions this week.\n\n');
  });

  test('a week whose transactions aren’t all in says from where, and isn’t called quiet', () => {
    const behind = quietFacts({ spending: { kind: 'behind', sources: [{ name: 'Chase', since: '2026-10-10' }, { name: 'Amex', since: null }] } });
    const { subject, text } = composeWeekly(behind, opts());
    expect(subject).toBe('Your week in Nya: October 5 to 11');
    expect(text).toContain("This week's spending isn't compared, as not all of its transactions are in: Chase's last came in on Saturday, October 10 and Amex's haven't come in.");
    expect(text).not.toContain('Nothing needs your attention');
    // Those that never came in, together; a name that can't be carried as "a bank".
    const never = quietFacts({ spending: { kind: 'behind', sources: [{ name: 'Broker', since: null }, { name: 'NewBank', since: null }, { name: '5th Bank', since: '2026-10-09' }] } });
    expect(composeWeekly(never, opts()).text).toContain("not all of its transactions are in: a bank's last came in on Friday, October 9 and Broker's and NewBank's haven't come in.");
    for (const [kind, words] of [
      [{ kind: 'too_early', why: 'history' }, "Nya doesn't have enough weeks of transactions yet"],
      [{ kind: 'too_early', why: 'importing' }, 'Nya is still bringing in older transactions'],
      [{ kind: 'none_come_in' }, "None of your connected accounts brings in bank or card transactions, so there's no spending to compare."],
    ] as const) {
      expect(composeWeekly(quietFacts({ spending: kind }), opts()).text).toContain(words);
    }
  });

  test('a section that couldn’t be read is left out, and says so, never guessed', () => {
    for (const key of ['spending', 'budgets', 'bills', 'goals', 'connections', 'months', 'uncategorized'] as const) {
      const { text } = composeWeekly(richFacts({ [key]: UNREAD }), opts());
      expect([key, text.includes("Some of your data couldn't be read, so part of this summary is left out. Open Nya to see it all.")]).toEqual([key, true]);
      expect(text).not.toContain('Nothing needs your attention');
    }
    const { text } = composeWeekly(richFacts({ budgets: UNREAD, bills: UNREAD }), opts());
    expect(text).not.toContain('Over budget');
    expect(text).not.toContain('Bills due');
    expect(text).toContain('Goals at their target');
    // Everything unreadable: only the week, the line, the link and the footer.
    const all = composeWeekly(
      quietFacts({ spending: UNREAD, budgets: UNREAD, bills: UNREAD, goals: UNREAD, connections: UNREAD, months: UNREAD, uncategorized: UNREAD }),
      opts()
    );
    expect(all.subject).toBe('Your week in Nya: October 5 to 11');
    expect(all.text.split('\n\n')).toHaveLength(4);
  });

  test('each section absent says nothing of it', () => {
    const { text } = composeWeekly(quietFacts({ spending: { kind: 'compared', level: 'lower', left_out: [] } }), opts());
    for (const absent of ['Over budget', 'Close to the limit', 'Bills due', 'Goals', 'Bank connections', 'may be missing', 'no category', "couldn't be read"]) expect(text).not.toContain(absent);
    expect(composeWeekly(quietFacts({ spending: { kind: 'compared', level: 'lower', left_out: [] } }), opts()).subject).toBe('Your week in Nya: less spending than usual');
  });

  test('the subject names one of a kind, and counts the rest', () => {
    const one = composeWeekly(
      quietFacts({ budgets: { month: '2026-10', running: true, over: ['Groceries'], close: [] }, bills: [{ name: 'Netflix', day: '2026-10-13', late: false, planned: false }, { name: 'Gym', day: '2026-10-14', late: false, planned: false }] }),
      opts()
    );
    expect(one.subject).toBe('Your week in Nya: Groceries over budget, 2 bills due');
    expect(composeWeekly(quietFacts({ connections: [{ name: 'Chase', state: 'needs_reauth', ends_at: null }] }), opts()).subject).toBe('Your week in Nya: Chase needs reconnecting');
    expect(composeWeekly(quietFacts({ connections: [{ name: 'Ally', state: 'reconnect_soon', ends_at: '2026-10-20T03:00:00.000Z' }] }), opts()).subject).toBe('Your week in Nya: reconnect Ally soon');
    expect(composeWeekly(quietFacts({ goals: { reached: [], behind: ['Trip'], complete: [] } }), opts()).subject).toBe('Your week in Nya: Trip behind');
    // A name that can't be carried is counted, in the subject too.
    expect(composeWeekly(quietFacts({ budgets: { month: '2026-10', running: true, over: ['Rent 1500'], close: [] } }), opts()).subject).toBe('Your week in Nya: 1 budget over');
  });

  test('says why it came and how to stop it, asked for or not', () => {
    const asked = composeWeekly(quietFacts(), opts({ requested: true })).text;
    expect(asked).toContain('You asked Nya to send this now. It comes every Monday too, because you turned on the weekly summary.');
    expect(asked).toContain(`To stop these summaries, open ${STOP}`);
    // Asked for with the sheet on Friday while Monday is saved: the week
    // before Friday, and the footer says Monday, the day it really comes.
    const friday = composeWeekly(quietFacts({ weekday: 5, send_day: '2026-10-09', first: '2026-10-02', last: '2026-10-08' }), opts({ requested: true, schedule: 1 })).text;
    expect(friday).toContain('Your week in Nya: Friday, October 2 to Thursday, October 8.');
    expect(friday).toContain('It comes every Monday too, because you turned on the weekly summary.');
    expect(friday).not.toContain('every Friday');
    const off = composeWeekly(quietFacts(), opts({ requested: true, schedule: null, unsubscribe: null })).text;
    expect(off).toContain("You asked Nya to send this now. The weekly summary isn't on, so no other comes unless you turn it on in Nya, under Manage on the Accounts tab. It never includes balances, amounts or account numbers.");
    expect(off).not.toContain('/unsubscribe');
    // Without a link to the app, it says to open it.
    expect(composeWeekly(quietFacts(), opts({ link: null, unsubscribe: null })).text).toContain('Open Nya to see the figures.\n\n');
  });

  test('no em or en dashes, ever', () => {
    for (const f of [richFacts(), quietFacts()]) {
      const { subject, text } = composeWeekly(f, opts());
      expect(/[–—]/.test(subject + text)).toBe(false);
    }
  });
});
