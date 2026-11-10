import { describe, expect, test } from 'bun:test';
import { summarizeGrowth, type GrowthAccount, type GrowthActivity } from '@/lib/growth-summary';

// Accounts > Investments' numbers (lib/growth-summary.ts), apart from the card:
// why an account counts from or to the day it does, how All names a late
// start, what is left out, and the order of the currencies. The card's own
// view test (test/investment-growth-view.test.tsx) covers the figures.

const NOW = Date.parse('2026-11-06T12:00:00Z');

const ready = (over: Partial<GrowthActivity> = {}): GrowthAccount['activity'] => ({
  state: 'ready',
  data: { flows: [], flows_from: '2025-01-01', flows_to: '2026-11-05', note: null, txns: [{}], money_in_out: null, ...over },
});
const account = (id: string, over: Partial<GrowthAccount> = {}): GrowthAccount => ({
  account_id: id,
  item_id: 'i',
  currency: 'USD',
  balance: 100,
  activity: ready(),
  points: [
    { date: '2025-12-01', value: 100 },
    { date: '2026-01-01', value: 100 },
    { date: '2026-11-05', value: 110 },
  ],
  ...over,
});
const sum = (accounts: GrowthAccount[], range: Parameters<typeof summarizeGrowth>[1] = null, main: string | null = 'USD') =>
  summarizeGrowth(accounts, range, main, false, NOW);

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
  // count Jul 15's money in: the card's starts Aug 5.
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
    expect(g.figures).toEqual({ in: 0, out: 0, net: 0, growth: 10 });
  });

  test('totals set with no balance to measure by: named, and no All-time performance', () => {
    const totals = { in: 50, out: 0, as_of: '2026-06-30', currency: 'USD', set_at: '2026-11-01T00:00:00.000Z' };
    const g = sum([account('a', { activity: ready({ money_in_out: totals }) }), account('b', { activity: ready({ money_in_out: totals }), balance: null })]).groups[0];
    expect(g.since).toBeNull();
    expect(g.unmeasured.map((r) => r.account.account_id)).toEqual(['b']);
    expect(g.missing).toEqual([]);
  });

  test('no figures while anything is loading, the histories included', () => {
    expect(sum([account('a', { activity: { state: 'loading' } }), account('b')]).groups[0].figures).toBeNull();
    expect(summarizeGrowth([account('a', { points: null })], null, 'USD', true, NOW).groups[0].figures).toBeNull();
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

// Money one account sent another is a move across them: off the totals' money
// in and money out alike, never off the rows, which keep their own sheet's.
describe('moves between accounts', () => {
  const totals = (inn: number) => ({ in: inn, out: 0, as_of: '2026-03-31', currency: 'USD', set_at: '2026-11-01T00:00:00.000Z' });
  const roth = account('roth', {
    balance: 3_100,
    activity: ready({ flows: [{ date: '2026-04-01', amount: -7_000 }], money_in_out: totals(10_000) }),
    points: [{ date: '2025-12-01', value: 10_000 }, { date: '2026-01-01', value: 10_000 }, { date: '2026-11-05', value: 3_100 }],
  });
  const brokerage = account('brokerage', {
    balance: 8_050,
    activity: ready({ flows: [{ date: '2026-04-03', amount: 7_000 }], money_in_out: totals(1_000) }),
    points: [{ date: '2025-12-01', value: 1_000 }, { date: '2026-01-01', value: 1_000 }, { date: '2026-11-05', value: 8_050 }],
  });

  test('the range: off money in and out, the net and growth as they were', () => {
    const g = sum([roth, brokerage]).groups[0];
    expect(g.rows.map((r) => [r.split?.in, r.split?.out, r.split?.growth])).toEqual([
      [0, 7_000, 100],
      [7_000, 0, 50],
    ]);
    expect(g.moved).toBe(7_000);
    expect(g.figures).toEqual({ in: 0, out: 0, net: 0, growth: 150 });
  });

  test('All-time performance: the same, from each one’s totals’ day', () => {
    const g = sum([roth, brokerage]).groups[0];
    expect(g.rows.map((r) => [r.since?.in, r.since?.out])).toEqual([
      [10_000, 7_000],
      [8_000, 0],
    ]);
    expect(g.sinceMoved).toBe(7_000);
    expect(g.since).toEqual({ in: 11_000, out: 0, net: 11_000, growth: 150 });
  });

  test('a move before the totals’ day is in them already: nothing taken off', () => {
    const early = (a: GrowthAccount, as_of: string): GrowthAccount => {
      const data = (a.activity as { data: GrowthActivity }).data;
      return { ...a, activity: ready({ ...data, money_in_out: { ...data.money_in_out!, as_of } }) };
    };
    const g = sum([early(roth, '2026-04-05'), early(brokerage, '2026-04-05')]).groups[0];
    expect(g.sinceMoved).toBe(0);
    expect(g.moved).toBe(7_000);
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
