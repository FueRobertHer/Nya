import { describe, expect, test } from 'bun:test';
import { isoDaysAgo, reconstruct, type WalkInput } from '@/lib/backfill';

// A fixed clock, so every date in these tests is a literal rather than a
// computed one. The walk keys everything off `now`, which is why it takes one.
const NOW = Date.UTC(2026, 8, 14); // 2026-09-14

const walk = (over: Partial<WalkInput>) =>
  reconstruct({
    balances: {},
    walkType: {},
    dailyByAccount: {},
    oldestTxn: '2026-01-01',
    oldestInvTxn: null,
    lookbackDays: 365,
    now: NOW,
    ...over,
  });

const byDate = (points: { date: string; balances: Record<string, number> }[]) =>
  Object.fromEntries(points.map((p) => [p.date, p.balances]));

const totalsByDate = (points: { date: string; walked: number }[]) =>
  Object.fromEntries(points.map((p) => [p.date, p.walked]));

describe('isoDaysAgo', () => {
  test('counts back in whole UTC days', () => {
    expect(isoDaysAgo(0, NOW)).toBe('2026-09-14');
    expect(isoDaysAgo(1, NOW)).toBe('2026-09-13');
    expect(isoDaysAgo(365, NOW)).toBe('2025-09-14');
  });
});

describe('direction', () => {
  // Plaid's convention: a positive amount is money LEAVING the account, so
  // un-applying it going backward puts it back.
  test('a depository balance is higher before the money left', () => {
    const { accountPoints } = walk({
      balances: { cash: 1000 },
      walkType: { cash: 'depository' },
      dailyByAccount: { '2026-09-10': { cash: 200 } },
    });
    const dates = byDate(accountPoints);
    expect(dates['2026-09-10'].cash).toBe(1000); // the spend hasn't been un-applied yet
    expect(dates['2026-09-09'].cash).toBe(1200);
  });

  // The opposite, and the reason the walk can't be written in terms of
  // signedContribution: a card purchase RAISES the amount owed.
  test('a credit balance is lower before the purchase', () => {
    const { accountPoints } = walk({
      balances: { card: 500 },
      walkType: { card: 'credit' },
      dailyByAccount: { '2026-09-10': { card: 200 } },
    });
    expect(byDate(accountPoints)['2026-09-09'].card).toBe(300);
  });

  test('the walked total treats owed balances as negative', () => {
    const { totalPoints } = walk({
      balances: { cash: 1000, card: 500 },
      walkType: { cash: 'depository', card: 'credit' },
    });
    expect(totalsByDate(totalPoints)['2026-09-13']).toBe(500);
  });
});

describe('investment arrivals', () => {
  // The regression this file exists for. An IRA opened by a $60k rollover that
  // is worth less than the rollover today reconstructs to a negative balance
  // the day before it existed. That used to drop the whole account back to the
  // flat term -- held at TODAY's balance for the entire year -- which drew the
  // rollover as if the money had always been there, so the event itself never
  // appeared on the account's chart.
  const rolloverWalk = () =>
    walk({
      balances: { ira: 58_000 },
      walkType: { ira: 'investment' },
      // -delta: the walk's convention is positive = value left the account, so
      // $60k arriving is -60_000.
      dailyByAccount: { '2026-06-01': { ira: -60_000 } },
    });

  test('the account keeps a series instead of being dropped', () => {
    const { accountPoints } = rolloverWalk();
    expect(accountPoints[0].date).toBe('2026-09-13');
    expect(accountPoints[accountPoints.length - 1].date).toBe('2026-01-01');
    expect(accountPoints.every((p) => 'ira' in p.balances)).toBe(true);
  });

  test('the arrival shows as a step, not a flat line', () => {
    const dates = byDate(rolloverWalk().accountPoints);
    expect(dates['2026-06-01'].ira).toBe(58_000); // still held, arrival not yet un-applied
    expect(dates['2026-05-31'].ira).toBe(0); // the day before it arrived
    expect(dates['2026-01-01'].ira).toBe(0);
  });

  test('it is floored at zero rather than left impossible', () => {
    const { floored, accountPoints } = rolloverWalk();
    expect(floored).toEqual(['ira']);
    expect(accountPoints.every((p) => p.balances.ira >= 0)).toBe(true);
  });

  // Once the flows have contradicted the balance, everything further back rests
  // on a premise already known to be wrong, so nothing more is applied.
  test('a floored account takes no earlier flows', () => {
    const { accountPoints } = walk({
      balances: { ira: 58_000 },
      walkType: { ira: 'investment' },
      dailyByAccount: {
        '2026-06-01': { ira: -60_000 },
        '2026-03-01': { ira: -5_000 }, // an earlier contribution
      },
    });
    const dates = byDate(accountPoints);
    expect(dates['2026-02-28'].ira).toBe(0);
  });

  // The ordinary case: nothing out-runs the balance, so nothing is floored and
  // the walk is exact apart from market movement.
  test('an arrival the balance can absorb is walked normally', () => {
    const { accountPoints, floored } = walk({
      balances: { ira: 66_000 },
      walkType: { ira: 'investment' },
      dailyByAccount: { '2026-06-01': { ira: -60_000 } },
    });
    expect(floored).toEqual([]);
    expect(byDate(accountPoints)['2026-05-31'].ira).toBe(6_000);
  });

  // Cash accounts are not floored: an overdrawn checking account is a real
  // negative balance, and its walk is exact rather than an estimate.
  test('a cash account is allowed to go negative', () => {
    const { accountPoints, floored } = walk({
      balances: { cash: 100 },
      walkType: { cash: 'depository' },
      dailyByAccount: { '2026-06-01': { cash: -500 } },
    });
    expect(floored).toEqual([]);
    expect(byDate(accountPoints)['2026-05-31'].cash).toBe(-400);
  });
});

describe('horizons', () => {
  // The totals can't outlive the cash data -- every cash balance would be
  // frozen and the line would flatline as if it were history -- but an
  // investment account's own flows are real out there, and that span is exactly
  // where an old rollover lives.
  const spanning = () =>
    walk({
      balances: { cash: 1000, ira: 60_000 },
      walkType: { cash: 'depository', ira: 'investment' },
      dailyByAccount: { '2026-05-02': { ira: -20_000 } },
      oldestTxn: '2026-08-01',
      oldestInvTxn: '2026-03-01',
    });

  test('the total series stops at the cash horizon', () => {
    const { totalPoints } = spanning();
    expect(totalPoints[totalPoints.length - 1].date).toBe('2026-08-01');
    expect(totalPoints.some((p) => p.date < '2026-08-01')).toBe(false);
  });

  test('the investment series keeps going to its own horizon', () => {
    const { accountPoints } = spanning();
    expect(accountPoints[accountPoints.length - 1].date).toBe('2026-03-01');
    const dates = byDate(accountPoints);
    expect(dates['2026-05-02'].ira).toBe(60_000);
    expect(dates['2026-05-01'].ira).toBe(40_000); // the old arrival, now visible
  });

  // Past the cash horizon a cash balance is frozen, not known. Omitting it
  // leaves a gap on its chart rather than a flat line that looks measured.
  test('cash accounts are absent from points past their horizon', () => {
    const dates = byDate(spanning().accountPoints);
    expect(dates['2026-08-01']).toEqual({ cash: 1000, ira: 60_000 });
    expect(dates['2026-07-31']).toEqual({ ira: 60_000 });
  });

  test('investment history that stops short of the cash data extends nothing', () => {
    const { accountPoints, totalPoints } = walk({
      balances: { cash: 1000, ira: 60_000 },
      walkType: { cash: 'depository', ira: 'investment' },
      oldestTxn: '2026-06-01',
      oldestInvTxn: '2026-08-01',
    });
    expect(accountPoints[accountPoints.length - 1].date).toBe('2026-06-01');
    expect(totalPoints.length).toBe(accountPoints.length);
    expect(accountPoints.every((p) => 'cash' in p.balances)).toBe(true);
  });

  // A cash account that saw no activity all year leaves the route with no cash
  // horizon at all, and it passes today as one. Nothing can be said about the
  // total then -- every cash balance would be frozen -- but the investment
  // accounts still have flows, and their own series is the whole point.
  test('a cash horizon of today yields investment points and no totals', () => {
    const { accountPoints, totalPoints } = walk({
      balances: { cash: 1000, ira: 60_000 },
      walkType: { cash: 'depository', ira: 'investment' },
      dailyByAccount: { '2026-05-02': { ira: -20_000 } },
      oldestTxn: '2026-09-14', // today
      oldestInvTxn: '2026-03-01',
    });
    expect(totalPoints).toEqual([]);
    expect(accountPoints.every((p) => Object.keys(p.balances).join() === 'ira')).toBe(true);
    expect(byDate(accountPoints)['2026-05-01'].ira).toBe(40_000);
  });

  test('an investment horizon equal to the cash one extends nothing', () => {
    const { accountPoints, totalPoints } = walk({
      balances: { cash: 1000, ira: 60_000 },
      walkType: { cash: 'depository', ira: 'investment' },
      oldestTxn: '2026-06-01',
      oldestInvTxn: '2026-06-01',
    });
    expect(accountPoints).toHaveLength(totalPoints.length);
    expect(accountPoints[accountPoints.length - 1].date).toBe('2026-06-01');
  });

  // The two fixes meeting: an arrival older than the cash window, in an account
  // that can't absorb it. The extended span is where it shows at all.
  test('an arrival past the cash horizon is floored there and still drawn', () => {
    const { accountPoints, floored } = walk({
      balances: { cash: 1000, ira: 58_000 },
      walkType: { cash: 'depository', ira: 'investment' },
      dailyByAccount: { '2026-04-01': { ira: -60_000 } },
      oldestTxn: '2026-08-01',
      oldestInvTxn: '2026-03-01',
    });
    const dates = byDate(accountPoints);
    expect(floored).toEqual(['ira']);
    expect(dates['2026-04-01'].ira).toBe(58_000);
    expect(dates['2026-03-31'].ira).toBe(0);
    expect(dates['2026-03-01'].ira).toBe(0);
  });

  test('the walk never reaches past the lookback window', () => {
    const { accountPoints } = walk({
      balances: { cash: 1000 },
      walkType: { cash: 'depository' },
      oldestTxn: '2020-01-01',
      lookbackDays: 30,
    });
    expect(accountPoints).toHaveLength(30);
    expect(accountPoints[29].date).toBe('2026-08-15');
  });
});

// Both flow streams are filtered by membership before they get here, so this is
// belt-and-braces -- but `balances[id] += amount` on an unknown key yields NaN
// and poisons every later point, which is worth refusing outright.
test('a flow for an account that is not being walked is ignored', () => {
  const { accountPoints } = walk({
    balances: { cash: 1000 },
    walkType: { cash: 'depository' },
    dailyByAccount: { '2026-09-10': { cash: 200, ghost: 999 } },
  });
  const dates = byDate(accountPoints);
  expect(dates['2026-09-09']).toEqual({ cash: 1200 });
});
