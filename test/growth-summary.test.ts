import { describe, expect, test } from 'bun:test';
import { summarizeGrowth, type GrowthAccount, type GrowthActivity } from '@/lib/growth-summary';

// Accounts > Investments' numbers (lib/growth-summary.ts), apart from the
// screen: why an account counts from or to the day it does, the four figures
// and how they add up, when All is all time, the rate, the hero's chart, what
// is left out, and the order of the currencies. The screen's own view test
// (test/investment-growth-view.test.tsx) covers what it says.

const ready = (over: Partial<GrowthActivity> = {}): GrowthAccount['activity'] => ({
  state: 'ready',
  data: { flows: [], flows_from: '2025-01-01', flows_to: '2026-11-05', note: null, txns: [{}], money_in_out: null, ...over },
});
const account = (id: string, over: Partial<GrowthAccount> = {}): GrowthAccount => ({
  account_id: id,
  item_id: 'i',
  currency: 'USD',
  activity: ready(),
  points: [
    { date: '2025-12-01', value: 100 },
    { date: '2026-01-01', value: 100 },
    { date: '2026-11-05', value: 110 },
  ],
  ...over,
});
const sum = (accounts: GrowthAccount[], range: Parameters<typeof summarizeGrowth>[1] = null, main: string | null = 'USD') =>
  summarizeGrowth(accounts, range, main, false);
const totals = (inn: number, as_of = '2026-03-31', out = 0) => ({ in: inn, out, as_of, currency: 'USD', set_at: '2026-11-01T00:00:00.000Z' });

describe('where an account counts from', () => {
  test('its first recorded day, when its history starts late', () => {
    const late = account('late', { points: [{ date: '2026-07-12', value: 50 }, { date: '2026-11-05', value: 60 }] });
    const [, row] = sum([account('a'), late]).groups[0].rows;
    expect(row.from).toEqual({ day: '2026-07-12', cause: 'recorded' });
  });

  test('the first day Nya has its activity, when it was recorded before then', () => {
    const late = account('late', {
      activity: ready({ flows_from: '2026-07-01' }),
      points: [{ date: '2026-01-01', value: 40 }, { date: '2026-07-12', value: 50 }, { date: '2026-11-05', value: 60 }],
    });
    const [, row] = sum([account('a'), late]).groups[0].rows;
    expect(row.from).toEqual({ day: '2026-07-12', cause: 'activity' });
  });

  test('nothing said within a week of the range start', () => {
    const near = account('near', { points: [{ date: '2025-12-01', value: 1 }, { date: '2026-01-05', value: 50 }, { date: '2026-11-05', value: 60 }] });
    expect(sum([near]).groups[0].rows[0].from).toBeNull();
  });

  test('on All, a start well after the earliest in its currency', () => {
    const late = account('late', { points: [{ date: '2026-07-12', value: 50 }, { date: '2026-11-05', value: 60 }] });
    const rows = sum([account('a'), late], 'ALL').groups[0].rows;
    expect(rows.map((r) => r.from)).toEqual([null, { day: '2026-07-12', cause: 'recorded' }]);
  });
});

describe('where an account counts to', () => {
  test('the last day Nya has its activity, when recorded after it', () => {
    const early = account('early', { activity: ready({ flows_to: '2026-10-20' }), points: [{ date: '2025-12-01', value: 1 }, { date: '2026-01-01', value: 100 }, { date: '2026-10-20', value: 105 }, { date: '2026-11-05', value: 110 }] });
    expect(sum([account('a'), early]).groups[0].rows[1].to).toEqual({ day: '2026-10-20', cause: 'activity' });
  });

  test('its last recorded day', () => {
    const stopped = account('stopped', { points: [{ date: '2025-12-01', value: 1 }, { date: '2026-01-01', value: 100 }, { date: '2026-10-01', value: 105 }] });
    expect(sum([account('a'), stopped]).groups[0].rows[1].to).toEqual({ day: '2026-10-01', cause: 'recorded' });
  });

  // Its own sheet's 3M would go back three months from Oct 1, to Jul 1, and
  // count Jul 15's money in: the screen's starts Aug 5.
  test('one whose history stopped counts from the start of the range, as the others do', () => {
    const stopped = account('stopped', {
      activity: ready({ flows: [{ date: '2026-07-15', amount: 3000 }] }),
      points: [{ date: '2026-06-01', value: 1000 }, { date: '2026-07-01', value: 1000 }, { date: '2026-08-06', value: 4100 }, { date: '2026-10-01', value: 4200 }],
    });
    const row = sum([account('a'), stopped], '3M').groups[0].rows[1];
    expect(row.split).toEqual({ from: '2026-08-06', to: '2026-10-01', in: 0, out: 0, growth: 100 });
    expect(row.from).toBeNull();
    expect(row.to).toEqual({ day: '2026-10-01', cause: 'recorded' });
  });

  test('a day before the latest is not said: the activity is known to yesterday', () => {
    const daily = account('a', {
      activity: ready({ flows_to: '2026-11-04' }),
      points: [{ date: '2025-12-01', value: 1 }, { date: '2026-01-01', value: 100 }, { date: '2026-11-04', value: 109 }, { date: '2026-11-05', value: 110 }],
    });
    expect(sum([daily]).groups[0].rows[0].to).toBeNull();
  });
});

// Beginning balance + Deposits & withdrawals + Investment returns = Ending
// balance, for each account and across them.
describe('the four figures over a range', () => {
  const deposits = account('deposits', {
    activity: ready({ flows: [{ date: '2026-03-01', amount: 2_000 }, { date: '2026-06-01', amount: -500 }] }),
    points: [{ date: '2025-12-01', value: 10_000 }, { date: '2026-01-01', value: 10_000 }, { date: '2026-11-05', value: 12_300 }],
  });

  test('each account: its first balance, its net, its returns and its last balance', () => {
    const [row] = sum([deposits]).groups[0].rows;
    expect(row.figures).toEqual({ begin: 10_000, dw: 1_500, returns: 800, end: 12_300 });
  });

  test('across the accounts, the rows added up', () => {
    const g = sum([deposits, account('a')]).groups[0];
    expect(g.basis).toBe('range');
    expect(g.figures).toEqual({ begin: 10_100, dw: 1_500, returns: 810, end: 12_410 });
    expect(g.span).toEqual({ from: '2026-01-01', to: '2026-11-05' });
  });

  test('one recorded from later starts there, its balance then its beginning balance', () => {
    const late = account('late', { points: [{ date: '2026-07-12', value: 50 }, { date: '2026-11-05', value: 60 }] });
    const g = sum([account('a'), late]).groups[0];
    expect(g.rows[1].figures).toEqual({ begin: 50, dw: 0, returns: 10, end: 60 });
    expect(g.figures).toEqual({ begin: 150, dw: 0, returns: 20, end: 170 });
  });

  // Money one account sent another is a withdrawal from one and a deposit to
  // the other: each row shows its leg, and the net has them cancel out.
  test('a move between the accounts cancels out in the net', () => {
    const roth = account('roth', {
      activity: ready({ flows: [{ date: '2026-04-01', amount: -7_000 }] }),
      points: [{ date: '2025-12-01', value: 10_000 }, { date: '2026-01-01', value: 10_000 }, { date: '2026-11-05', value: 3_100 }],
    });
    const brokerage = account('brokerage', {
      activity: ready({ flows: [{ date: '2026-04-03', amount: 7_000 }] }),
      points: [{ date: '2025-12-01', value: 1_000 }, { date: '2026-01-01', value: 1_000 }, { date: '2026-11-05', value: 8_050 }],
    });
    const g = sum([roth, brokerage]).groups[0];
    expect(g.rows.map((r) => r.figures?.dw)).toEqual([-7_000, 7_000]);
    expect(g.figures).toEqual({ begin: 11_000, dw: 0, returns: 150, end: 11_150 });
  });
});

describe('all time', () => {
  const roth = account('roth', {
    activity: ready({ flows: [{ date: '2026-04-01', amount: -7_000 }], money_in_out: totals(10_000) }),
    points: [{ date: '2025-12-01', value: 10_000 }, { date: '2026-01-01', value: 10_000 }, { date: '2026-11-05', value: 3_100 }],
  });
  const brokerage = account('brokerage', {
    activity: ready({ flows: [{ date: '2026-04-03', amount: 7_000 }], money_in_out: totals(1_000) }),
    points: [{ date: '2025-12-01', value: 1_000 }, { date: '2026-01-01', value: 1_000 }, { date: '2026-11-05', value: 8_050 }],
  });

  test('every total set: All starts at $0.00, its net the totals carried', () => {
    const g = sum([roth, brokerage], 'ALL').groups[0];
    expect(g.basis).toBe('all');
    expect(g.rows.map((r) => r.figures)).toEqual([
      { begin: 0, dw: 3_000, returns: 100, end: 3_100 },
      { begin: 0, dw: 8_000, returns: 50, end: 8_050 },
    ]);
    expect(g.figures).toEqual({ begin: 0, dw: 11_000, returns: 150, end: 11_150 });
    // No rate: Nya doesn't know when the money before its records went in.
    expect(g.rate).toBeNull();
    expect(g.rows.map((r) => r.rate)).toEqual([null, null]);
  });

  // The Roth IRA's $10,000 in, though $7,000 came out; the brokerage's
  // $1,000 and the $7,000 moved in to it on Apr 3, carried from its totals.
  test('the total return: the returns on every deposit since each opened, withdrawals not taken off', () => {
    const g = sum([roth, brokerage], 'ALL').groups[0];
    expect(g.rows.map((r) => r.total)).toEqual([
      { value: 100 / 10_000, deposited: 10_000 },
      { value: 50 / 8_000, deposited: 8_000 },
    ]);
    // Added up: the $7,000 moved between them counts as deposited in the one
    // it went to.
    expect(g.total).toEqual({ value: 150 / 18_000, deposited: 18_000 });
  });

  test('no total return with nothing deposited', () => {
    // Only withdrawals typed: more came out than ever went in.
    const out = account('out', { activity: ready({ money_in_out: totals(0, '2026-03-31', 500) }) });
    const g = sum([out], 'ALL').groups[0];
    expect(g.basis).toBe('all');
    expect(g.figures).toEqual({ begin: 0, dw: -500, returns: 610, end: 110 });
    expect(g.total).toBeNull();
    expect(g.rows[0].total).toBeNull();
    // Beside one that has deposits, the group's counts every deposit.
    const both = sum([roth, out], 'ALL').groups[0];
    expect(both.total).toEqual({ value: 710 / 10_000, deposited: 10_000 });
    expect(both.rows.map((r) => r.total?.deposited ?? null)).toEqual([10_000, null]);
  });

  test('only on All: every other range counts from its start', () => {
    const g = sum([roth, brokerage], 'YTD').groups[0];
    expect(g.basis).toBe('range');
    // A range has its rate, never a total return.
    expect(g.total).toBeNull();
    expect(g.rows.map((r) => r.total)).toEqual([null, null]);
  });

  test('one total missing: All counts from the first recorded day, and names it', () => {
    const unset = account('unset', { points: [{ date: '2025-12-01', value: 500 }, { date: '2026-11-05', value: 520 }] });
    const g = sum([roth, brokerage, unset], 'ALL').groups[0];
    expect(g.basis).toBe('range');
    expect(g.missing.map((r) => r.account.account_id)).toEqual(['unset']);
    expect(g.figures).toEqual({ begin: 11_500, dw: 0, returns: 170, end: 11_670 });
    expect(g.firstRecorded).toBe('2025-12-01');
    expect(g.rate).not.toBeNull();
    expect(g.total).toBeNull();
  });

  test('totals set for a day before the activity Nya has: missing too, as outdated', () => {
    const outdated = account('old', { activity: ready({ flows_from: '2026-02-01', money_in_out: totals(100, '2026-01-01') }) });
    const g = sum([roth, outdated], 'ALL').groups[0];
    expect(g.basis).toBe('range');
    expect(g.missing.map((r) => [r.account.account_id, r.totals])).toEqual([['old', 'outdated']]);
  });

  test('totals that can not be read: not all time, and kept apart', () => {
    const unreadable = account('unreadable', { activity: ready({ money_in_out_unreadable: true }) });
    const g = sum([roth, unreadable], 'ALL').groups[0];
    expect(g.basis).toBe('range');
    expect(g.unreadable.map((r) => r.account.account_id)).toEqual(['unreadable']);
    expect(g.missing).toEqual([]);
  });

  // It adds nothing either way, and is said as not counted: setting its
  // totals would change nothing.
  test('an account with no line to count neither keeps All from all time nor is asked for totals', () => {
    const estimated = account('estimated', {
      points: [{ date: '2025-12-01', value: 70, estimated: true }, { date: '2026-11-05', value: 80, estimated: true }],
    });
    const g = sum([roth, brokerage, estimated], 'ALL').groups[0];
    expect(g.basis).toBe('all');
    expect(g.figures).toEqual({ begin: 0, dw: 11_000, returns: 150, end: 11_150 });
    expect(g.uncounted.map((r) => r.account.account_id)).toEqual(['estimated']);
    expect(g.missing).toEqual([]);
  });

  test('an account short of its activity: not all time', () => {
    const g = sum([roth, brokerage, account('failed', { activity: { state: 'failed' } })], 'ALL').groups[0];
    expect(g.basis).toBe('range');
    expect(g.failed.map((r) => r.account.account_id)).toEqual(['failed']);
  });
});

describe('the rate of return', () => {
  test('each account a leg from its own first day', () => {
    const late = account('late', { points: [{ date: '2026-07-12', value: 50 }, { date: '2026-11-05', value: 60 }] });
    const g = sum([account('a'), late]).groups[0];
    // Jan 1 to Nov 5 is 308 days; Jul 12 to Nov 5, 116 of them.
    expect(g.rate?.annual).toBe(false);
    expect(g.rate?.value).toBeCloseTo(20 / (100 + (50 * 116) / 308), 10);
    expect(g.rows.map((r) => r.rate?.value)).toEqual([0.1, 0.2]);
  });

  test('a deposit is weighed by when it went in', () => {
    const deposit = account('d', {
      activity: ready({ flows: [{ date: '2026-07-11', amount: 100 }] }),
      points: [{ date: '2025-12-01', value: 100 }, { date: '2026-01-01', value: 100 }, { date: '2026-11-05', value: 220 }],
    });
    const g = sum([deposit]).groups[0];
    // In from Jul 12, so 116 of 308 days.
    expect(g.rate?.value).toBeCloseTo(20 / (100 + (100 * 116) / 308), 10);
  });
});

// The hero's chart: the counted accounts' balances added up by day, and the
// grey line under them, whose gap at the end is the returns.
describe('the chart', () => {
  const last = <T,>(xs: readonly T[]) => xs[xs.length - 1];

  test('it ends on the Ending balance, the gap there the returns', () => {
    const deposits = account('deposits', {
      activity: ready({ flows: [{ date: '2026-03-01', amount: 2_000 }] }),
      points: [{ date: '2025-12-01', value: 10_000 }, { date: '2026-01-01', value: 10_000 }, { date: '2026-03-02', value: 12_000 }, { date: '2026-11-05', value: 12_800 }],
    });
    const g = sum([deposits, account('a')]).groups[0];
    const chart = g.chart!;
    // From the range's start.
    expect(chart.points[0].date).toBe('2026-01-01');
    expect(last(chart.points)).toEqual({ date: '2026-11-05', value: g.figures!.end });
    expect(last(chart.points).value - last(chart.baseline).value).toBe(g.figures!.returns);
    // It starts on the beginning balance, with no returns yet.
    expect(chart.baseline[0].value).toBe(chart.points[0].value);
  });

  // Before an account is counted its balance is in both lines, so it adds
  // no returns: no cliff where it joins.
  test('an account counted from later adds no returns before its first day', () => {
    const late = account('late', {
      points: [{ date: '2026-01-01', value: 40, estimated: true }, { date: '2026-07-12', value: 50 }, { date: '2026-11-05', value: 60 }],
    });
    const chart = sum([account('a'), late]).groups[0].chart!;
    const jan = chart.points.findIndex((p) => p.date === '2026-01-01');
    expect(chart.points[jan]).toEqual({ date: '2026-01-01', value: 140, estimated: true });
    expect(chart.baseline[jan].value).toBe(140);
    expect(last(chart.points).value - last(chart.baseline).value).toBe(20);
  });

  // After its last counted day an account holds there, so the chart still
  // ends on the Ending balance.
  test('one that stops early holds at its last counted day', () => {
    const stopped = account('stopped', { points: [{ date: '2025-12-01', value: 100 }, { date: '2026-01-01', value: 100 }, { date: '2026-10-01', value: 105 }] });
    const g = sum([account('a'), stopped]).groups[0];
    expect(last(g.chart!.points)).toEqual({ date: '2026-11-05', value: 215 });
    expect(g.figures!.end).toBe(215);
    expect(last(g.chart!.points).value - last(g.chart!.baseline).value).toBe(g.figures!.returns);
  });

  test('for all time the grey line is the deposits less withdrawals', () => {
    const set = (id: string, inn: number, start: number, end: number) =>
      account(id, {
        activity: ready({ money_in_out: totals(inn, '2026-03-31') }),
        points: [{ date: '2025-12-01', value: start }, { date: '2026-01-01', value: start }, { date: '2026-11-05', value: end }],
      });
    const g = sum([set('x', 800, 1_000, 1_100), set('y', 300, 400, 420)], 'ALL').groups[0];
    expect(g.basis).toBe('all');
    expect(last(g.chart!.baseline).value).toBe(g.figures!.dw);
    expect(last(g.chart!.points).value - last(g.chart!.baseline).value).toBe(g.figures!.returns);
  });

  test('none with fewer than two days to draw', () => {
    const one = account('one', { points: [{ date: '2026-11-05', value: 10 }] });
    expect(sum([one]).groups[0].chart).toBeNull();
  });
});

describe('what is left out', () => {
  test('each kind of activity it can not count', () => {
    const rows = sum([
      account('loading', { activity: { state: 'loading' } }),
      account('failed', { activity: { state: 'failed' } }),
      account('busy', { activity: ready({ flows: null, flows_from: null, txns: [], note: 'Investment activity is still loading' }) }),
      account('down', { activity: ready({ flows: null, flows_from: null, txns: [], note: 'The institution is down' }) }),
      account('none', { activity: ready({ flows: null, flows_from: null, txns: [] }) }),
      account('counted'),
    ]).groups[0].rows;
    expect(rows.map((r) => [r.account.account_id, r.status])).toEqual([
      ['loading', 'loading'],
      ['failed', 'failed'],
      ['busy', 'busy'],
      ['down', 'failed'],
      ['none', 'none'],
      ['counted', 'counted'],
    ]);
  });

  // Its own range would be the year its history stopped in.
  test('a counted account with nothing in the range is named, not summed', () => {
    const g = sum([account('a'), account('gone', { points: [{ date: '2025-06-01', value: 5 }, { date: '2025-07-01', value: 5 }] })]).groups[0];
    expect(g.uncounted.map((r) => r.account.account_id)).toEqual(['gone']);
    expect(g.figures).toEqual({ begin: 100, dw: 0, returns: 10, end: 110 });
  });

  test('no figures while anything is loading, the histories included', () => {
    expect(sum([account('a', { activity: { state: 'loading' } }), account('b')]).groups[0].figures).toBeNull();
    expect(summarizeGrowth([account('a', { points: null })], null, 'USD', true).groups[0].figures).toBeNull();
  });
});

describe('currencies', () => {
  test('the home currency first, then the most accounts; one that names none is US dollars', () => {
    const groups = sum(
      [account('e1', { currency: 'EUR' }), account('c1', { currency: 'CAD' }), account('c2', { currency: 'CAD' }), account('u', { currency: null })],
      null,
      'EUR'
    ).groups;
    expect(groups.map((g) => [g.currency, g.rows.length])).toEqual([
      ['EUR', 1],
      ['CAD', 2],
      ['USD', 1],
    ]);
  });
});

// The figures count only from a recorded day (lib/growth.ts
// contributionBaseline), so a range is offered and named by those days.
describe('ranges', () => {
  test('offered and named by the days Nya recorded, not by its estimates', () => {
    const recent = account('recent', {
      points: [
        { date: '2025-06-01', value: 900, estimated: true },
        { date: '2026-01-01', value: 950, estimated: true },
        { date: '2026-08-31', value: 990, estimated: true },
        { date: '2026-09-01', value: 1_000 },
        { date: '2026-10-01', value: 1_010 },
        { date: '2026-11-05', value: 1_020 },
      ],
    });
    const s = sum([recent]);
    expect(s.ranges).not.toContain('YTD');
    expect(s.range).toBe('ALL');
    expect(s.label).toBe('Since Sep 1');
    expect(s.groups[0].rows[0].split).toEqual({ from: '2026-09-01', to: '2026-11-05', in: 0, out: 0, growth: 20 });
  });
});
