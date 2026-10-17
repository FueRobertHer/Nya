import { describe, expect, test } from 'bun:test';
import { CATCH_UP_DAYS, dueSendDay, sendDayOn, todayIn, weekBefore, weekdayOf } from '@/lib/weekly-summary/week';
import {
  billsFact,
  budgetFact,
  connectionsFact,
  goalsFact,
  levelOf,
  median,
  monthsFact,
  spendingFact,
  uncategorizedFact,
  UNREAD,
  type SpendingInput,
  type WeeklyFacts,
} from '@/lib/weekly-summary/content';
import { checkedSummary, composeWeekly, dayText, figuresIn, FigureError, namesText, safeName, weekText, type ComposeOptions } from '@/lib/weekly-summary/compose';
import { isWeeklySetting, parseWeeklyChoice, defaultSetting } from '@/lib/weekly-summary/settings';
import { addDays, detectRecurring, type RecurringRow } from '@/lib/recurring';
import { budgetsInMonth, setRollover, startMonths, NO_COVERAGE_GAPS, type CoverageFacts } from '@/lib/rollover';
import { indexTaxonomy, type Taxonomy } from '@/lib/categories';
import type { Budgets } from '@/lib/budget-set';
import { categoriesFor } from './category-fixture';

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
  test('at their target and behind, as the Goals card says, never archived or untracked ones', () => {
    const goals = [
      { name: 'Emergency fund', archived: false, state: 'tracked', status: 'complete' as const },
      { name: 'Trip', archived: false, state: 'tracked', status: 'behind' as const },
      { name: 'Old trip', archived: true, state: 'tracked', status: 'behind' as const },
      { name: 'Car', archived: false, state: 'tracked', status: 'on_track' as const },
      { name: 'Hidden one', archived: false, state: 'hidden', status: null },
    ];
    expect(goalsFact(goals)).toEqual({ reached: ['Emergency fund'], behind: ['Trip'] });
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
  });
});

// ---- The words ----

const WEEK = { send_day: '2026-10-12', first: '2026-10-05', last: '2026-10-11', today: '2026-10-12', time_zone: 'America/New_York', weekday: 1 as const };
const quietFacts = (over: Partial<WeeklyFacts> = {}): WeeklyFacts => ({
  ...WEEK,
  spending: { kind: 'compared', level: 'same', left_out: [] },
  budgets: null,
  bills: [],
  goals: { reached: [], behind: [] },
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
    goals: { reached: ['Emergency fund'], behind: ['Trip 2027', 'New car'] },
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
const opts = (over: Partial<ComposeOptions> = {}): ComposeOptions => ({ link: LINK, unsubscribe: STOP, requested: false, enabled: true, now: NOW, ...over });

describe('names', () => {
  test('carried only without a digit or a currency sign; one line, not too long', () => {
    expect(safeName('Groceries')).toBe('Groceries');
    expect(safeName('  Dining\nout  ')).toBe('Dining out');
    for (const bad of ['Rent 1500', 'Transfer to 4821', 'Goal 5k', '$ Treats', '€uro trip', 'Trip ２０２７', 'Half ½', '']) expect([bad, safeName(bad)]).toEqual([bad, null]);
    expect(safeName('word '.repeat(30))!.length).toBeLessThanOrEqual(60);
  });

  test('a list says the others by count', () => {
    expect(namesText(['Groceries'], 'budget')).toBe('Groceries');
    expect(namesText(['Groceries', 'Dining out'], 'budget')).toBe('Groceries and Dining out');
    expect(namesText(['Groceries', 'Rent 1500'], 'budget')).toBe('Groceries and 1 other');
    expect(namesText(['Rent 1500', 'Car 2'], 'budget')).toBe('2 budgets');
    expect(namesText(['A', 'B', 'C', 'D', 'E', 'F', 'G'], 'budget')).toBe('A, B, C, D, E and 2 others');
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
    expect(text).toContain('- A bank needs connecting again.');
    expect(text).toContain("October may be missing transactions: Chase hasn't synced since Thursday, October 8 and whether you excluded 3 transactions couldn't be read.");
    expect(text).toContain('2 transactions from SimpleFIN this week have no category, so they count as spending or income until you categorize them.');
    expect(text).toContain(`Open Nya to see the figures: ${LINK}/`);
    expect(text).toContain(`Nya sends you this every Monday because you turned on the weekly summary. It never includes balances, amounts or account numbers. To stop these summaries, open ${STOP} or turn them off in Nya, under Manage on the Accounts tab.`);
    expect(text).not.toContain('Nothing needs your attention');
    expect(text.endsWith('\n')).toBe(true);
  });

  test('never carries a figure: no amount, no balance, no account number, whatever the names hold', () => {
    for (const f of [richFacts(), quietFacts(), richFacts({ send_day: '2027-01-04', first: '2026-12-28', last: '2027-01-03', today: '2027-01-05' })]) {
      for (const o of [opts(), opts({ requested: true }), opts({ requested: true, enabled: false, unsubscribe: null })]) {
        const { subject, text } = composeWeekly(f, o);
        expect(figuresIn(subject, text)).toEqual([]);
        // Not any fragment of a name with a figure, either.
        for (const leak of ['1500', '4821', '2027', '$', '1st']) expect([leak, `${subject}\n${text}`.replace(/https:\S+/g, '').replace(/January \d+, 2027/g, '').includes(leak)]).toEqual([leak, false]);
        expect(checkedSummary({ subject, text })).toEqual({ subject, text });
      }
    }
  });

  test('the check finds every kind of figure, outside dates and links', () => {
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
    for (const [text, kind] of cases) expect([text, figuresIn(text)]).toEqual([text, expect.arrayContaining([kind])]);
    // Its own words pass: days, a year across one, counts, its links.
    expect(figuresIn('Your week in Nya: 2 bills due', 'Monday, December 28, 2026 to Sunday, January 3, 2027. 12 transactions. October 2025 may be missing some.', STOP)).toEqual([]);
    expect(() => checkedSummary({ subject: 'Your week', text: 'Spent $5' })).toThrow(FigureError);
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
    expect(composeWeekly(quietFacts({ goals: { reached: [], behind: ['Trip'] } }), opts()).subject).toBe('Your week in Nya: Trip behind');
    // A name that can't be carried is counted, in the subject too.
    expect(composeWeekly(quietFacts({ budgets: { month: '2026-10', running: true, over: ['Rent 1500'], close: [] } }), opts()).subject).toBe('Your week in Nya: 1 budget over');
  });

  test('says why it came and how to stop it, asked for or not', () => {
    const asked = composeWeekly(quietFacts(), opts({ requested: true })).text;
    expect(asked).toContain('You asked Nya to send this now. It comes every Monday too, because you turned on the weekly summary.');
    expect(asked).toContain(`To stop these summaries, open ${STOP}`);
    const off = composeWeekly(quietFacts(), opts({ requested: true, enabled: false, unsubscribe: null })).text;
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
