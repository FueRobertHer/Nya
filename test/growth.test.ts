import { describe, expect, test } from 'bun:test';
import { contributionBaseline, moneyInOutOn, movedBetween, movedNear, movedSince, rangeSplit, seenIn, sinceStarted, usableTotals, withoutMoves, type Totals } from '@/lib/growth';

const r = (date: string, value: number) => ({ date, value });
const e = (date: string, value: number) => ({ date, value, estimated: true });
/** A point on the line, with the money in and out it holds. */
const b = (date: string, value: number, inn = 0, out = 0) => ({ date, value, in: inn, out });

describe('contributionBaseline', () => {
  // A flow counts from the day after its date: the 13:00 UTC snapshot on the
  // flow's own date is taken before investment balances update.
  test('the starting balance plus money added before each point', () => {
    const points = [r('2026-09-01', 1000), r('2026-09-02', 1010), r('2026-09-03', 1015), r('2026-09-04', 1600)];
    const flows = [{ date: '2026-09-03', amount: 500 }];
    expect(contributionBaseline(points, flows, '2026-01-01')).toEqual([
      b('2026-09-01', 1000),
      b('2026-09-02', 1000),
      b('2026-09-03', 1000),
      b('2026-09-04', 1500, 500),
    ]);
  });

  // An account opened by a rollover: the first snapshot predates the money, so
  // assuming it was already in the starting balance would call it all growth.
  test('a flow dated on the start day is counted', () => {
    expect(contributionBaseline([r('2026-09-01', 0), r('2026-09-02', 60_000)], [{ date: '2026-09-01', amount: 60_000 }], '2026-01-01'))
      .toEqual([b('2026-09-01', 0), b('2026-09-02', 60_000, 60_000)]);
  });

  test('flows before the start are already in the starting balance', () => {
    expect(contributionBaseline([r('2026-09-01', 1000), r('2026-09-02', 1000)], [{ date: '2026-08-20', amount: 500 }], '2026-01-01'))
      .toEqual([b('2026-09-01', 1000), b('2026-09-02', 1000)]);
  });

  // The backfilled region has no market movement in it: growth measured across
  // it would be whatever the walk left there.
  test('starts at the first real point, never in the estimated region', () => {
    const out = contributionBaseline([e('2026-08-01', 1), r('2026-09-01', 1000), r('2026-09-02', 1000)], [], '2026-01-01');
    expect(out?.[0]).toEqual(b('2026-09-01', 1000));
    expect(out).toHaveLength(2);
  });

  // Flows before the window start are unknown, so the start must be inside it.
  test('starts inside the flows window', () => {
    const out = contributionBaseline([r('2025-01-01', 5), r('2026-09-01', 1000)], [], '2025-09-24');
    expect(out).toEqual([b('2026-09-01', 1000)]);
  });

  test('withdrawals bring it down, as money out', () => {
    expect(
      contributionBaseline([r('2026-09-01', 1000), r('2026-09-02', 1000), r('2026-09-03', 700)], [{ date: '2026-09-02', amount: -300 }], '2026-01-01')
    ).toEqual([b('2026-09-01', 1000), b('2026-09-02', 1000), b('2026-09-03', 700, 0, 300)]);
  });

  // Each day is one net (lib/investments.ts dailyFlows): a day's is money in
  // above zero, money out below, and in and out keep their own sums.
  test('money in and out are summed apart, a day each', () => {
    const points = [r('2026-09-01', 1000), r('2026-09-02', 1000), r('2026-09-03', 1000), r('2026-09-04', 1000)];
    const flows = [
      { date: '2026-09-01', amount: 200 },
      { date: '2026-09-02', amount: -50 },
      { date: '2026-09-03', amount: 25 },
    ];
    expect(contributionBaseline(points, flows, '2026-01-01')).toEqual([
      b('2026-09-01', 1000),
      b('2026-09-02', 1200, 200),
      b('2026-09-03', 1150, 200, 50),
      b('2026-09-04', 1175, 225, 50),
    ]);
  });

  test('nothing to draw without flows, a window, or a real point in it', () => {
    expect(contributionBaseline([r('2026-09-01', 1)], null, '2026-01-01')).toBeNull();
    expect(contributionBaseline([r('2026-09-01', 1)], [], null)).toBeNull();
    expect(contributionBaseline([e('2026-09-01', 1)], [], '2026-01-01')).toBeNull();
  });
});

describe('contributionBaseline start day', () => {
  // A flow two days before the first recorded day may or may not be in that
  // day's balance. Starting after a quiet spell avoids guessing.
  test('skips a first day whose balance may not include a recent flow', () => {
    const points = [r('2026-09-01', 1000), r('2026-09-02', 1500), r('2026-09-05', 1500), r('2026-09-06', 1510)];
    const out = contributionBaseline(points, [{ date: '2026-08-30', amount: 500 }], '2026-01-01');
    expect(out?.[0]).toEqual(b('2026-09-05', 1500));
  });

  // Nothing better available: the first real point it is.
  test('falls back to the first real point when every candidate has a recent flow', () => {
    const points = [r('2026-09-01', 1000), r('2026-09-02', 1100)];
    const flows = [{ date: '2026-08-31', amount: 100 }, { date: '2026-09-01', amount: 100 }];
    expect(contributionBaseline(points, flows, '2026-01-01')?.[0]).toEqual(b('2026-09-01', 1000));
  });
});

// The mocks' account (Vanguard Individual): $2,000 in on the 1st of each
// month, totals of $152,000 in and $12,000 out for Oct 15.
const monthly = ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01'].map((date) => ({ date, amount: 2000 }));
const vanguard: Totals = { in: 152_000, out: 12_000, as_of: '2026-10-15' };
const NOW = Date.parse('2026-11-10T15:00:00Z');

describe('money in and out carried from totals', () => {
  test('what moved between a day and the totals is taken off, what moved after is added', () => {
    // Jul 12: before Aug 1, Sep 1 and Oct 1, each already in the totals.
    expect(moneyInOutOn(vanguard, monthly, '2026-07-12')).toEqual({ in: 146_000, out: 12_000 });
    // The day after the totals' day: they are as given.
    expect(moneyInOutOn(vanguard, monthly, '2026-10-16')).toEqual({ in: 152_000, out: 12_000 });
    // Nov 1's shows from Nov 2.
    expect(moneyInOutOn(vanguard, monthly, '2026-11-01')).toEqual({ in: 152_000, out: 12_000 });
    expect(moneyInOutOn(vanguard, monthly, '2026-11-02')).toEqual({ in: 154_000, out: 12_000 });
  });

  test('money out is carried apart from money in', () => {
    const ira: Totals = { in: 120_000, out: 138_000, as_of: '2026-09-30' };
    const withdrawals = ['2026-09-01', '2026-10-01', '2026-11-01'].map((date) => ({ date, amount: -4000 }));
    expect(moneyInOutOn(ira, withdrawals, '2026-09-01')).toEqual({ in: 120_000, out: 134_000 });
    expect(moneyInOutOn(ira, withdrawals, '2026-11-10')).toEqual({ in: 120_000, out: 146_000 });
    expect(movedSince(ira, withdrawals, '2026-11-10')).toEqual({ in: 0, out: 8000 });
  });

  test('the line is the net money in on each day, from the same start', () => {
    const points = [e('2026-07-01', 160_000), r('2026-07-12', 170_207.65), r('2026-08-02', 172_000), r('2026-11-10', 184_520.4)];
    const line = contributionBaseline(points, monthly, '2026-06-01', '2026-11-10', vanguard);
    expect(line).toEqual([
      b('2026-07-12', 134_000, 146_000, 12_000),
      b('2026-08-02', 136_000, 148_000, 12_000),
      b('2026-11-10', 142_000, 154_000, 12_000),
    ]);
    // Between two points the parts are the same as without totals: only the
    // line's level moves.
    const plain = contributionBaseline(points, monthly, '2026-06-01', '2026-11-10')!;
    expect(plain[2].value - plain[0].value).toBeCloseTo(line![2].value - line![0].value, 6);
  });

  // An institution that now keeps less history (or a re-link to a new id):
  // what moved between the totals' day and the activity's start is unknown.
  test('totals for a day before the activity, or after the person’s today, are not carried', () => {
    expect(usableTotals(vanguard, '2026-06-01', NOW)).toBe(true);
    expect(usableTotals(vanguard, '2026-10-15', NOW)).toBe(true);
    expect(usableTotals(vanguard, '2026-10-16', NOW)).toBe(false);
    expect(usableTotals({ ...vanguard, as_of: '2026-11-11' }, '2026-06-01', NOW)).toBe(true);
    expect(usableTotals({ ...vanguard, as_of: '2026-11-12' }, '2026-06-01', NOW)).toBe(false);
    expect(usableTotals(null, '2026-06-01', NOW)).toBe(false);
    const points = [r('2026-07-12', 170_207.65), r('2026-11-10', 184_520.4)];
    expect(contributionBaseline(points, monthly, '2026-10-16', '2026-11-10', vanguard)).toEqual(
      contributionBaseline(points, monthly, '2026-10-16', '2026-11-10')
    );
  });
});

describe('sinceStarted', () => {
  test('the mocks’ figures: net today, and growth so far against the balance', () => {
    expect(sinceStarted(vanguard, monthly, '2026-11-10', 184_520.4, null, NOW)).toEqual({
      in: 154_000,
      out: 12_000,
      net: 142_000,
      growth: 42_520.4,
      to: null,
      since: { in: 2000, out: 0 },
    });
  });

  test('more came out than went in: a net below zero, growth more than the balance', () => {
    const ira: Totals = { in: 120_000, out: 138_000, as_of: '2026-09-30' };
    const withdrawals = ['2026-10-01', '2026-11-01'].map((date) => ({ date, amount: -4000 }));
    const f = sinceStarted(ira, withdrawals, '2026-11-09', 115_846.2, null, NOW);
    expect(f.net).toBe(-26_000);
    expect(f.growth).toBe(141_846.2);
  });

  // Money that moved after the activity ends isn't known yet, so the
  // figures are measured on the last recorded balance it covers.
  test('activity known only to an earlier day is measured there', () => {
    const points = [r('2026-11-01', 180_000), r('2026-11-03', 181_000), e('2026-11-06', 182_000), r('2026-11-08', 183_000)];
    const f = sinceStarted(vanguard, monthly, '2026-11-04', 184_520.4, points, NOW);
    expect(f.to).toBe('2026-11-03');
    expect(f.net).toBe(142_000);
    expect(f.growth).toBe(39_000);
    expect(sinceStarted(vanguard, monthly, '2026-11-04', 184_520.4, null, NOW).growth).toBeNull();
  });

  test('no balance, no growth', () => {
    expect(sinceStarted(vanguard, monthly, '2026-11-10', null, null, NOW).growth).toBeNull();
  });
});

describe('the form’s checks', () => {
  test('what Nya has seen go in by a day, and what moved in the days up to it', () => {
    const flows = [{ date: '2026-10-01', amount: 2000 }, { date: '2026-10-14', amount: -300 }, { date: '2026-10-15', amount: 2000 }, { date: '2026-10-16', amount: 50 }];
    expect(seenIn(flows, '2026-10-15')).toBe(4000);
    expect(movedNear(flows, '2026-10-15')).toEqual([flows[1], flows[2]]);
    expect(movedNear(flows, '2026-10-12')).toEqual([]);
  });
});

// Money that left and came back is a move, not money in and out: the legs of
// an exchange booked days apart, or a transfer between two investment accounts.
describe('moves', () => {
  test('out and the same amount in within five days, in one account: both legs dropped', () => {
    const flows = [
      { date: '2026-03-02', amount: -10_000 },
      { date: '2026-03-04', amount: 10_000 },
      { date: '2026-03-15', amount: 500 },
    ];
    expect(withoutMoves(flows)).toEqual({ flows: [{ date: '2026-03-15', amount: 500 }], moves: [{ from: '2026-03-02', to: '2026-03-04' }] });
  });

  test('money in first and out after is a move too', () => {
    expect(withoutMoves([{ date: '2026-03-02', amount: 250.5 }, { date: '2026-03-07', amount: -250.5 }])).toEqual({ flows: [], moves: [{ from: '2026-03-02', to: '2026-03-07' }] });
  });

  test('more than five days apart, or not the same to the cent: money in and out', () => {
    const apart = [{ date: '2026-03-02', amount: -10_000 }, { date: '2026-03-08', amount: 10_000 }];
    expect(withoutMoves(apart)).toEqual({ flows: apart, moves: [] });
    const different = [{ date: '2026-03-02', amount: -10_000 }, { date: '2026-03-04', amount: 9_999.99 }];
    expect(withoutMoves(different)).toEqual({ flows: different, moves: [] });
  });

  test('the nearest legs pair: a withdrawal a week before a round trip stays money out', () => {
    const flows = [
      { date: '2026-03-01', amount: -1_000 },
      { date: '2026-03-05', amount: -1_000 },
      { date: '2026-03-06', amount: 1_000 },
    ];
    expect(withoutMoves(flows).flows).toEqual([{ date: '2026-03-01', amount: -1_000 }]);
  });

  test('a leg pairs once: two outs and one in leave one out', () => {
    const flows = [
      { date: '2026-03-02', amount: -400 },
      { date: '2026-03-03', amount: -400 },
      { date: '2026-03-04', amount: 400 },
    ];
    expect(withoutMoves(flows).flows).toEqual([{ date: '2026-03-02', amount: -400 }]);
  });

  // $10,000 sent out on Dec 30 and back on Jan 2, the balance down between:
  // from Jan 1, with the legs out of the flows, the return would be growth.
  test('the line never starts between a move’s two legs', () => {
    const { flows, moves } = withoutMoves([{ date: '2025-12-30', amount: -10_000 }, { date: '2026-01-02', amount: 10_000 }]);
    const points = [r('2026-01-01', 40_000), r('2026-01-05', 50_000), r('2026-02-01', 50_000)];
    expect(contributionBaseline(points, flows, '2025-01-01', '2026-02-01', null, moves)?.[0].date).toBe('2026-01-05');
    expect(rangeSplit(points, flows, '2025-01-01', '2026-02-01', null, moves)).toEqual({ from: '2026-01-05', to: '2026-02-01', in: 0, out: 0, growth: 0 });
  });

  test('between accounts: one’s money out that another took in, within five days', () => {
    const roth = [{ date: '2026-04-01', amount: -7_000 }, { date: '2026-04-20', amount: 300 }];
    const brokerage = [{ date: '2026-04-03', amount: 7_000 }];
    expect(movedBetween([roth, brokerage])).toBe(7_000);
    // Never one account's own legs: those are withoutMoves', at the source.
    expect(movedBetween([[{ date: '2026-04-01', amount: -7_000 }, { date: '2026-04-03', amount: 7_000 }]])).toBe(0);
    expect(movedBetween([roth, [{ date: '2026-04-07', amount: 7_000 }]])).toBe(0);
  });
});
