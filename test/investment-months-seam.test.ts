import { describe, expect, test } from 'bun:test';
import { monthsDropped, withPastMonths, type InvestmentMonths, type MonthsImport, type PastMonth } from '@/lib/investment-months';
import { contributionBaseline, rangeSplit, type BalancePoint, type Flow } from '@/lib/growth';
import { summarizeGrowth, type GrowthAccount, type GrowthActivity } from '@/lib/growth-summary';

// The seam joining an account's imported months to its own history
// (lib/investment-months.ts withPastMonths): month ends as entered points on
// the 1st before the first recorded day, estimates before it dropped, one
// flow a month before Nya's activity at the middle of its uncovered days,
// the month the activity starts in less Nya's own, flows_from reaching back
// while typed totals stay bound to Nya's activity, months Nya covers compared
// and never used, and each reason the months don't apply. Then the account's
// split and Accounts > Investments read through it.

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
    expect(out.applied).toEqual({ from: '2023-01-01', first_recorded: '2026-11-11', activity_from: '2024-11-12' });
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
});
