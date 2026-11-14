import { describe, expect, test } from 'bun:test';
import { allTimeFromMonths, monthsDropped, withPastMonths, type InvestmentMonths, type MonthsImport, type PastMonth } from '@/lib/investment-months';
import { contributionBaseline, rangeSplit, type BalancePoint, type Flow } from '@/lib/growth';
import { summarizeGrowth, type GrowthAccount, type GrowthActivity } from '@/lib/growth-summary';

// The seam joining an account's imported months to its own history
// (lib/investment-months.ts withPastMonths): month ends as entered points on
// the 1st before the first recorded day, estimates before it dropped, one
// flow a month before Nya's activity at the middle of its uncovered days,
// the month the activity starts in less Nya's own, flows_from reaching back
// while typed totals stay bound to Nya's activity, months Nya covers compared
// and never used, and each reason the months don't apply. Then the account's
// split and Accounts > Investments read through it, and all time from months
// that start at $0.00, when the account opened.

/** `n` months from `from`, each `net` in and `returns`, from `balance`. */
function months(from: string, n: number, balance: number, net = 100, returns = 10): PastMonth[] {
  const out: PastMonth[] = [];
  let [y, m] = from.split('-').map(Number);
  let end = balance;
  for (let i = 0; i < n; i++) {
    end = Math.round((end + net + returns) * 100) / 100;
    out.push({ month: `${y}-${String(m).padStart(2, '0')}`, net, returns, end });
    m = m === 12 ? 1 : m + 1;
    if (m === 1) y++;
  }
  return out;
}

const record = (over: Partial<MonthsImport> = {}): MonthsImport => ({
  id: 'import-0001',
  source: 'vanguard-performance',
  file_name: 'Performance.pdf',
  imported_at: '2026-11-11T12:00:00.000Z',
  start: { month: '2023-01', balance: 1000 },
  // Jan 2023 to Oct 2026: 46 months.
  months: months('2023-01', 46, 1000),
  currency: 'USD',
  ...over,
});
const entry = (...imports: MonthsImport[]): InvestmentMonths => ({ imports });

/** Nya's own deposits: $100 on the 5th of each month it covers, and $60 of
 *  November 2024 after its activity starts on the 12th. */
function nyas(): Flow[] {
  const out: Flow[] = [{ date: '2024-11-20', amount: 60 }];
  for (const m of months('2024-12', 23, 0)) out.push({ date: `${m.month}-05`, amount: 100 });
  return out;
}
const ACTIVITY = { flows: nyas(), flows_from: '2024-11-12', flows_to: '2026-11-13', moves: [] };

/** What Nya has: the backfill's estimates back to its activity's start, then
 *  the days it recorded from the link, one an estimated hole. */
const POINTS: BalancePoint[] = [
  { date: '2024-11-12', value: 3000, estimated: true },
  { date: '2025-06-01', value: 4000, estimated: true },
  { date: '2026-11-11', value: 6063 },
  { date: '2026-11-12', value: 6064, estimated: true },
  { date: '2026-11-13', value: 6065 },
];

describe('applied', () => {
  const out = withPastMonths(POINTS, ACTIVITY, entry(record()), 'USD');

  test('each month’s end is an entered point on the next 1st, the start on the first 1st, all before the first recorded day', () => {
    const entered = out.points.filter((p) => p.entered);
    expect(entered).toHaveLength(47);
    expect(entered[0]).toEqual({ date: '2023-01-01', value: 1000, entered: true });
    expect(entered[1]).toEqual({ date: '2023-02-01', value: 1110, entered: true });
    expect(entered.at(-1)).toEqual({ date: '2026-11-01', value: 6060, entered: true });
  });

  test('estimates before the first recorded day are dropped; those after it stay', () => {
    expect(out.points.filter((p) => !p.entered)).toEqual(POINTS.slice(2));
  });

  test('months that stop over a month before the first recorded day: Nya’s estimates fill the days after their last end', () => {
    const early = withPastMonths([{ date: '2024-09-01', value: 2900, estimated: true }, ...POINTS], { ...ACTIVITY, flows_from: '2024-09-01' }, entry(record({ months: months('2023-01', 20, 1000) })), 'USD');
    expect(early.points.filter((p) => p.entered).at(-1)).toEqual({ date: '2024-09-01', value: 3200, entered: true });
    // The estimate on the last end's own day goes; those after it stay.
    expect(early.points.filter((p) => !p.entered)).toEqual(POINTS);
    expect(early.applied).toMatchObject({ entered_to: '2024-09-01', joined: false });
  });

  test('one flow a month before the activity, at the middle of its days; the straddle month less Nya’s own; none inside the activity', () => {
    const before = out.flows!.filter((f) => f.date < '2024-11-12');
    expect(before).toHaveLength(23);
    expect(before.slice(0, 3)).toEqual([
      { date: '2023-01-16', amount: 100 },
      { date: '2023-02-15', amount: 100 },
      { date: '2023-03-16', amount: 100 },
    ]);
    expect(before.find((f) => f.date.startsWith('2023-04'))).toEqual({ date: '2023-04-16', amount: 100 });
    // November 2024: $100 at Vanguard, $60 of it on Nya's days, so $40 on
    // the middle of the 1st to the 11th.
    expect(before.at(-1)).toEqual({ date: '2024-11-06', amount: 40 });
    expect(out.flows!.filter((f) => f.date >= '2024-11-12')).toEqual(ACTIVITY.flows);
  });

  test('flows_from reaches back to the first month; typed totals stay bound to Nya’s own activity', () => {
    expect(out).toMatchObject({ flows_from: '2023-01-01', totals_from: '2024-11-12', unused: null });
    expect(out.applied).toEqual({ from: '2023-01-01', first_recorded: '2026-11-11', activity_from: '2024-11-12', entered_to: '2026-11-01', joined: true });
    expect(out.counting?.id).toBe('import-0001');
  });

  test('months Nya’s activity covers are compared, never used: those off by more than a dollar are listed', () => {
    expect(out.differs).toEqual([]);
    const flows = ACTIVITY.flows.filter((f) => f.date !== '2025-07-05').map((f) => (f.date === '2025-08-05' ? { ...f, amount: 100.5 } : f));
    const off = withPastMonths(POINTS, { ...ACTIVITY, flows }, entry(record()), 'USD');
    expect(off.differs).toEqual([{ month: '2025-07', theirs: 100, nyas: 0 }]);
    // Never past the last day Nya's activity is known to.
    const short = withPastMonths(POINTS, { ...ACTIVITY, flows: flows.filter((f) => f.date < '2025-07-01'), flows_to: '2025-06-30' }, entry(record()), 'USD');
    expect(short.differs).toEqual([]);
  });

  test('the newest import counts, whole', () => {
    const older = record({ id: 'import-0000', imported_at: '2026-11-01T00:00:00.000Z', start: { month: '2020-01', balance: 0 }, months: months('2020-01', 82, 0) });
    const both = withPastMonths(POINTS, ACTIVITY, entry(older, record()), 'USD');
    expect(both.counting?.id).toBe('import-0001');
    expect(both.points[0].date).toBe('2023-01-01');
  });

  test('a month whose net is all on Nya’s days adds no flow', () => {
    const flows = [{ date: '2024-11-20', amount: 100 }, ...ACTIVITY.flows.slice(1)];
    const out2 = withPastMonths(POINTS, { ...ACTIVITY, flows }, entry(record()), 'USD');
    expect(out2.flows!.filter((f) => f.date.startsWith('2024-11'))).toEqual([{ date: '2024-11-20', amount: 100 }]);
  });
});

describe('not applied, and why', () => {
  const unused = (points: readonly BalancePoint[], activity: Parameters<typeof withPastMonths>[1], e: InvestmentMonths | null, currency: string | null = 'USD') => {
    const out = withPastMonths(points, activity, e, currency);
    if (out.unused || !e) {
      // As given.
      expect(out.points).toEqual([...points]);
      expect(out.flows).toEqual(activity.flows ?? null);
      expect(out.flows_from).toBe(activity.flows_from ?? null);
      expect(out.totals_from).toBe(activity.flows_from ?? null);
      expect(out.applied).toBeNull();
    }
    return out.unused;
  };

  test('nothing imported', () => {
    expect(unused(POINTS, ACTIVITY, null)).toBeNull();
  });

  test('another currency; none on either side is US dollars', () => {
    expect(unused(POINTS, ACTIVITY, entry(record({ currency: 'CAD' })))).toBe('currency');
    expect(unused(POINTS, ACTIVITY, entry(record({ currency: null })), 'USD')).toBeNull();
    expect(unused(POINTS, ACTIVITY, entry(record()), null)).toBeNull();
  });

  test('no activity to join them to', () => {
    expect(unused(POINTS, { ...ACTIVITY, flows: null }, entry(record()))).toBe('activity');
    expect(unused(POINTS, { ...ACTIVITY, flows_from: null }, entry(record()))).toBe('activity');
  });

  test('no recorded balance yet', () => {
    expect(unused(POINTS.map((p) => ({ ...p, estimated: true })), ACTIVITY, entry(record()))).toBe('no-record');
  });

  test('activity that starts after the first recorded day', () => {
    expect(unused(POINTS, { ...ACTIVITY, flows_from: '2026-11-12' }, entry(record()))).toBe('activity-late');
  });

  test('a stretch neither covers: the activity starts after the month after their last', () => {
    const toOct = record({ months: months('2023-01', 22, 1000) });
    expect(toOct.months.at(-1)!.month).toBe('2024-10');
    expect(unused(POINTS, { ...ACTIVITY, flows_from: '2024-11-01' }, entry(toOct))).toBeNull();
    expect(unused(POINTS, { ...ACTIVITY, flows_from: '2024-11-02' }, entry(toOct))).toBe('gap');
  });

  test('Nya has its own balance for every month', () => {
    const late = record({ start: { month: '2026-11', balance: 6000 }, months: [{ month: '2026-11', net: 0, returns: 5, end: 6005 }] });
    expect(unused(POINTS, ACTIVITY, entry(late))).toBe('covered');
  });
});

describe('read through the seam', () => {
  // Recorded only from the link, Nov 11 2026, and Nya's activity from Nov 12
  // 2024: without the months, nothing before the link counts.
  const points: BalancePoint[] = [
    { date: '2024-11-12', value: 3000, estimated: true },
    { date: '2026-11-11', value: 6063 },
  ];
  const joined = withPastMonths(points, ACTIVITY, entry(record()), 'USD');

  test('the split from a month’s end to the last recorded day: each month’s net in, its returns as growth', () => {
    const shown = joined.points.filter((p) => p.date >= '2023-12-01');
    const split = rangeSplit(shown, joined.flows, joined.flows_from, ACTIVITY.flows_to);
    // End of Nov 2023 to Nov 11 2026: 35 months of $100 in and $10 of
    // returns, then $3 in November's first days.
    expect(split).toEqual({ from: '2023-12-01', to: '2026-11-11', in: 3500, out: 0, growth: 353 });
    // Without the months it counts from the one recorded day: nothing moved.
    expect(rangeSplit(points, ACTIVITY.flows, ACTIVITY.flows_from, ACTIVITY.flows_to)).toEqual({ from: '2026-11-11', to: '2026-11-11', in: 0, out: 0, growth: 0 });
  });

  test('an entered point starts the grey line though a flow is days before it', () => {
    const line = contributionBaseline(joined.points.filter((p) => p.date >= '2024-12-01'), joined.flows, joined.flows_from, ACTIVITY.flows_to);
    expect(line![0]).toMatchObject({ date: '2024-12-01', value: 3530 });
  });

  const ready = (over: Partial<GrowthActivity> = {}): GrowthAccount['activity'] => ({
    state: 'ready',
    data: { flows: joined.flows, flows_from: joined.flows_from, totals_from: joined.totals_from, flows_to: ACTIVITY.flows_to, note: null, txns: [{}], money_in_out: null, ...over },
  });
  const account = (over: Partial<GrowthAccount> = {}): GrowthAccount => ({ account_id: 'vg', item_id: 'i', currency: 'USD', activity: ready(), points: joined.points, ...over });

  test('Investments: the ranges and figures reach back into the months', () => {
    const summary = summarizeGrowth([account()], '3Y', 'USD', false);
    expect(summary.ranges).toContain('3Y');
    const group = summary.groups[0];
    expect(group.figures).toEqual({ begin: 2210, dw: 3500, returns: 353, end: 6063 });
    expect(group.rows[0].split).toEqual({ from: '2023-12-01', to: '2026-11-11', in: 3500, out: 0, growth: 353 });
    expect(group.rate).not.toBeNull();
    // Recorded, as the summary counts it, is Nya's own first day.
    expect(group.firstRecorded).toBe('2026-11-11');
    // The chart marks the months' points as entered.
    expect(group.chart!.points.find((p) => p.date === '2023-12-01')).toMatchObject({ value: 2210, entered: true });
    expect(group.chart!.points.at(-1)).toEqual({ date: '2026-11-11', value: 6063 });
  });

  test('a range that starts inside the months counts from a month’s end, said so', () => {
    const summary = summarizeGrowth([account()], '3Y', 'USD', false);
    expect(summary.groups[0].rows[0].from).toEqual({ day: '2023-12-01', cause: 'month-end' });
  });

  test('typed totals for a day before Nya’s own activity still read as outdated', () => {
    const totals = (as_of: string) => ({ in: 9000, out: 0, as_of, currency: 'USD', set_at: '2026-11-01T00:00:00.000Z' });
    const before = summarizeGrowth([account({ activity: ready({ money_in_out: totals('2024-06-30') }) })], '3Y', 'USD', false);
    expect(before.groups[0].rows[0].totals).toBe('outdated');
    const after = summarizeGrowth([account({ activity: ready({ money_in_out: totals('2025-06-30') }) })], '3Y', 'USD', false);
    expect(after.groups[0].rows[0].totals).toBe('set');
  });
});

describe('what a new import would stop counting', () => {
  test('the months the counting one has at either end that the new one doesn’t', () => {
    const now = record();
    expect(monthsDropped(null, record())).toEqual({ before: null, after: null });
    expect(monthsDropped(now, now)).toEqual({ before: null, after: null });
    expect(monthsDropped(now, { start: { month: '2024-01' }, months: months('2024-01', 34, 0) })).toEqual({ before: { from: '2023-01', to: '2023-12' }, after: null });
    expect(monthsDropped(now, { start: { month: '2023-01' }, months: months('2023-01', 40, 0) })).toEqual({ before: null, after: { from: '2026-05', to: '2026-10' } });
    expect(monthsDropped(now, { start: { month: '2020-01' }, months: months('2020-01', 90, 0) })).toEqual({ before: null, after: null });
  });

  test('a file from $0.00 counts from its first month with anything in it', () => {
    const opened = record({ start: { month: '2022-01', balance: 0 }, months: [...months('2022-01', 12, 0, 0, 0), ...months('2023-01', 46, 0)] });
    expect(monthsDropped(opened, { start: { month: '2023-01', balance: 0 }, months: months('2023-01', 46, 0) })).toEqual({ before: null, after: null });
    expect(monthsDropped(opened, { start: { month: '2024-01', balance: 0 }, months: months('2024-01', 34, 0) })).toEqual({ before: { from: '2023-01', to: '2023-12' }, after: null });
    // The new one's empty months drop nothing of the old one's either.
    expect(monthsDropped(record(), { start: { month: '2022-01', balance: 0 }, months: [...months('2022-01', 12, 0, 0, 0), ...months('2023-01', 46, 0)] })).toEqual({ before: null, after: null });
  });
});

describe('all time from months that start when the account opened', () => {
  // From $0.00 in Jan 2023: $100 in and $10 of returns a month, $5,060.00 by
  // the end of Oct 2026. Nya recorded the balance from the link, Nov 11 2026.
  const opened = record({ start: { month: '2023-01', balance: 0 }, months: months('2023-01', 46, 0) });
  const points: BalancePoint[] = [
    { date: '2024-11-12', value: 3000, estimated: true },
    { date: '2026-11-11', value: 5063 },
  ];
  const totals = (as_of: string, inn = 9000) => ({ in: inn, out: 0, as_of, currency: 'USD', set_at: '2026-11-01T00:00:00.000Z' });
  const ready = (joined: ReturnType<typeof withPastMonths>, over: Partial<GrowthActivity> = {}): GrowthAccount['activity'] => ({
    state: 'ready',
    data: { flows: joined.flows, flows_from: joined.flows_from, totals_from: joined.totals_from, flows_to: ACTIVITY.flows_to, note: null, txns: [{}], money_in_out: null, ...over },
  });
  const account = (id: string, r: MonthsImport, over: Partial<GrowthActivity> = {}, shown: BalancePoint[] = points): GrowthAccount => {
    const joined = withPastMonths(shown, ACTIVITY, entry(r), 'USD');
    return { account_id: id, item_id: 'i', currency: 'USD', activity: ready(joined, over), points: joined.points };
  };

  test('the day it counts from: only with months from $0.00 that apply, and no totals to stand instead', () => {
    const joined = withPastMonths(points, ACTIVITY, entry(opened), 'USD');
    expect(allTimeFromMonths(joined, null)).toBe('2023-01-01');
    // Totals Nya can carry stand instead; ones for a day before its activity
    // can't, so the months still do.
    expect(allTimeFromMonths(joined, totals('2025-06-30'))).toBeNull();
    expect(allTimeFromMonths(joined, totals('2024-06-30'))).toBe('2023-01-01');
    // Totals that can't be read might say otherwise.
    expect(allTimeFromMonths(joined, null, true)).toBeNull();
    // From a balance: the months start after it opened.
    expect(allTimeFromMonths(withPastMonths(points, ACTIVITY, entry(record()), 'USD'), null)).toBeNull();
    // Months that don't apply, or none.
    expect(allTimeFromMonths(withPastMonths(points, { ...ACTIVITY, flows_from: '2026-11-12' }, entry(opened), 'USD'), null)).toBeNull();
    expect(allTimeFromMonths(withPastMonths(points, ACTIVITY, null, 'USD'), null)).toBeNull();
    expect(allTimeFromMonths(null, null)).toBeNull();
  });

  test('a file from $0.00 that starts before the account opened: from its first month with anything in it', () => {
    const empty: PastMonth[] = months('2022-01', 12, 0, 0, 0);
    const early = record({ start: { month: '2022-01', balance: 0 }, months: [...empty, ...months('2023-01', 46, 0)] });
    const joined = withPastMonths(points, ACTIVITY, entry(early), 'USD');
    expect(joined.points[0]).toEqual({ date: '2023-01-01', value: 0, entered: true });
    expect(joined.points[1]).toEqual({ date: '2023-02-01', value: 110, entered: true });
    expect(joined.flows_from).toBe('2023-01-01');
    expect(allTimeFromMonths(joined, null)).toBe('2023-01-01');
    // Without the trim, a file chosen from earlier would say it opened then.
    const from2023 = withPastMonths(points, ACTIVITY, entry(opened), 'USD');
    expect({ ...joined, counting: null }).toEqual({ ...from2023, counting: null });
  });

  test('All is all time from the months, with a rate: they say when the money went in', () => {
    const group = summarizeGrowth([account('vg', opened)], 'ALL', 'USD', false).groups[0];
    expect(group.basis).toBe('all');
    // 46 months of $100 in, to Nov 11 2026: the months' own before Nya's
    // activity, then Nya's.
    expect(group.figures).toEqual({ begin: 0, dw: 4600, returns: 463, end: 5063 });
    expect(group.span).toEqual({ from: '2023-01-01', to: '2026-11-11' });
    expect(group.rate).not.toBeNull();
    expect(group.rate!.annual).toBe(true);
    expect(group.rate!.value).toBeGreaterThan(0);
    expect(group.rows[0].rate).toEqual(group.rate);
    // The months say when: a rate, never a total return beside it.
    expect(group.total).toBeNull();
    expect(group.rows[0].total).toBeNull();
    expect(group.missing).toEqual([]);
    expect(group.chart!.points[0]).toMatchObject({ date: '2023-01-01', value: 0, entered: true });
  });

  test('typed totals stand instead: all time from them, with a total return and no rate', () => {
    const group = summarizeGrowth([account('vg', opened, { money_in_out: totals('2025-06-30', 3000) })], 'ALL', 'USD', false).groups[0];
    expect(group.basis).toBe('all');
    expect(group.rows[0].totals).toBe('set');
    expect(group.figures!.begin).toBe(0);
    expect(group.rate).toBeNull();
    expect(group.rows[0].rate).toBeNull();
    // Nothing came out, so what was deposited is the net: $3,000 by Jun 30,
    // 2025, and Nya's $100 a month since.
    expect(group.total).toEqual({ value: group.figures!.returns / 4600, deposited: 4600 });
    expect(group.figures!.dw).toBe(4600);
    expect(group.rows[0].total).toEqual(group.total);
  });

  test('totals that can’t be read: All counts from the first day, as a range does', () => {
    const group = summarizeGrowth([account('vg', opened, { money_in_out_unreadable: true })], 'ALL', 'USD', false).groups[0];
    expect(group.basis).toBe('range');
    expect(group.unreadable.map((r) => r.account.account_id)).toEqual(['vg']);
    expect(group.rate).not.toBeNull();
  });

  test('months from a balance: All counts from their first month, and the totals are asked for', () => {
    const group = summarizeGrowth([account('vg', record())], 'ALL', 'USD', false).groups[0];
    expect(group.basis).toBe('range');
    expect(group.figures!.begin).toBe(1000);
    expect(group.missing.map((r) => r.account.account_id)).toEqual(['vg']);
  });

  test('several accounts: all time when each opens or has totals, a rate only when every one opens', () => {
    const later = record({ start: { month: '2025-01', balance: 0 }, months: months('2025-01', 22, 0) });
    const both = summarizeGrowth([account('a', opened), account('b', later)], 'ALL', 'USD', false).groups[0];
    expect(both.basis).toBe('all');
    expect(both.rate).not.toBeNull();
    // The later one counts from when it opened.
    expect(both.rows[1].from).toEqual({ day: '2025-01-01', cause: 'opened' });

    const typed = summarizeGrowth([account('a', opened), account('b', later, { money_in_out: totals('2025-06-30', 2000) })], 'ALL', 'USD', false).groups[0];
    expect(typed.basis).toBe('all');
    expect(typed.rate).toBeNull();
    // The rows follow the group: a total return each, so the one from months
    // gives no yearly rate beside the other's total.
    expect(typed.rows.map((r) => r.rate)).toEqual([null, null]);
    expect(typed.total).not.toBeNull();
    expect(typed.rows.map((r) => r.total?.deposited)).toEqual([4600, typed.total!.deposited - 4600]);
    expect(typed.missing).toEqual([]);
    // Every account from its months: the rate, and no total return.
    expect(both.total).toBeNull();
    expect(both.rows.map((r) => r.total)).toEqual([null, null]);

    // One from a balance: All counts from each first day, and only it is
    // short of totals.
    const short = summarizeGrowth([account('a', opened), account('b', record({ start: { month: '2025-01', balance: 500 }, months: months('2025-01', 22, 500) }))], 'ALL', 'USD', false).groups[0];
    expect(short.basis).toBe('range');
    expect(short.missing.map((r) => r.account.account_id)).toEqual(['b']);
    expect(short.rows[1].from).toEqual({ day: '2025-01-01', cause: 'months' });
  });

  // Vanguard gives one net a month: Jun 2023 with $100 in and $150 out reads
  // as −$50, so it counts nothing as deposited and $50 as withdrawn.
  test('beside typed totals, an account’s deposits from its months are each month’s net when above zero', () => {
    const netted = opened.months.map((m) => ({ ...m }));
    netted[5].net = -50;
    for (let k = 5; k < netted.length; k++) netted[k].end = Math.round((netted[k - 1].end + netted[k].net + netted[k].returns) * 100) / 100;
    const typed = account('t', opened, { money_in_out: totals('2025-06-30', 2000) });
    const before = summarizeGrowth([account('a', opened), typed], 'ALL', 'USD', false).groups[0];
    const after = summarizeGrowth([account('a', record({ ...opened, months: netted })), typed], 'ALL', 'USD', false).groups[0];
    expect(after.rows[0].figures!.dw).toBe(before.rows[0].figures!.dw - 150);
    expect(after.rows[0].total!.deposited).toBe(before.rows[0].total!.deposited - 100);
    expect(after.total!.deposited).toBe(before.total!.deposited - 100);
  });
});
