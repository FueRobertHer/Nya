import { describe, expect, test } from 'bun:test';
import { usMarket } from '@/lib/fire/us-market';
import { historicalCycles, monteCarlo, successGrid, type SimPlan, type SimResult } from '@/lib/fire/simulate';

// Golden tests: the engine against what published studies of the same
// question report. They assert RANGES, never one exact figure, because the
// studies differ from this engine in ways that move the answer by a few
// points: the Trinity study used annual data from 1926 to 1995 and corporate
// bonds; Bengen (1994) annual data from 1926 and intermediate Treasuries;
// FIRECalc and cFIREsim annual data from 1871. This engine uses Shiller's
// MONTHLY data from 1871 to 2023, 10-year Treasuries, every start month, and
// withdrawals at the start of each year. Each figure below says what it is
// based on.
//
// Sources:
//   - Cooley, Hubbard and Walz, "Retirement Savings: Choosing a Withdrawal
//     Rate That Is Sustainable", AAII Journal, February 1998 (the Trinity
//     study): with withdrawals raised for inflation, 4% over 30 years
//     succeeded in roughly 95% or more of the periods for portfolios of half
//     or more in stocks, and much less often for bond-heavy ones.
//   - Bengen, "Determining Withdrawal Rates Using Historical Data", Journal
//     of Financial Planning, October 1994: a first-year withdrawal of 4%,
//     raised with inflation, lasted at least 30 years from every start in his
//     data, for portfolios of 50% to 75% in stocks; the worst starts were in
//     the mid-1960s.
//   - FIRECalc and cFIREsim: both report roughly 95% or more for 4% over 30
//     years with a stock-heavy portfolio on their defaults.
//   - Early Retirement Now (Karsten Jeske), "The Ultimate Guide to Safe
//     Withdrawal Rates" (2016 onward), on the same Shiller monthly data: 4%
//     fails from the 1929 and mid-1960s starts, the early 1900s come close,
//     and retirements of 50 to 60 years call for lower rates (the series
//     argues for roughly 3.25% to 3.5%).

const us = usMarket();

function plan(stocks: number, rate: number, years = 30): SimPlan {
  return {
    startBalance: 1_000_000,
    years,
    allocation: { stocks, bonds: 1 - stocks, cash: 0 },
    rebalance: 'annual',
    fee: 0,
    taxRate: 0,
    rule: { kind: 'constant', rate },
    income: [],
    oneOffs: [],
    cashRealReturn: 0,
  };
}

/** The known bad times to retire. The early 1900s: the 1906 and 1907 panics,
 *  then the inflation of the First World War. 1929: the crash and the
 *  Depression. The mid-1960s to early 1970s: stagnant stocks and rising
 *  inflation until 1982. */
const BAD_PERIODS: [number, number][] = [
  [1899, 1912],
  [1927, 1931],
  [1959, 1973],
];
const inBadPeriod = (start: string) => {
  const y = Number(start.slice(0, 4));
  return BAD_PERIODS.some(([a, b]) => y >= a && y <= b);
};

const failures = (r: SimResult) => r.worst.filter((w) => w.failedYear !== null);

describe('the 4% rule over 30 years', () => {
  for (const stocks of [1, 0.75, 0.5]) {
    test(`succeeds in the large majority of historical starts with ${stocks * 100}% stocks, but not all`, () => {
      const r = historicalCycles(plan(stocks, 0.04), us);
      // Roughly 95% or more, as the Trinity study, FIRECalc and cFIREsim
      // report (this data gives 96% to 97.5%), and not 100%: on Shiller's
      // data some 1929 and mid-1960s starts run out (ERN).
      expect(r.successRate).toBeGreaterThanOrEqual(0.93);
      expect(r.successRate).toBeLessThan(0.99);
      expect(r.paths).toBe(1470);
    });
  }

  test('fails only from starts in the known bad periods, and the worst years are those periods', () => {
    for (const stocks of [1, 0.75, 0.5]) {
      const r = historicalCycles(plan(stocks, 0.04), us);
      // Every listed start (the worst month of each of the ten worst years) lies
      // in a bad period, whether it ran out or came closest.
      expect(r.worst).toHaveLength(10);
      for (const w of r.worst) expect(inBadPeriod(w.start!)).toBe(true);
      // The mid-1960s is where the 4% rule is famously tested (Bengen).
      expect(failures(r).some((w) => w.start!.startsWith('1966'))).toBe(true);
    }
    // With all stocks, the 1929 crash is the single worst start: it runs out
    // first, within about two decades.
    const allStocks = historicalCycles(plan(1, 0.04), us);
    expect(allStocks.worst[0].start!.slice(0, 4)).toBe('1929');
    expect(allStocks.worst[0].failedYear!).toBeLessThan(25);
  });

  test('3% never ran out over 30 years', () => {
    // Bengen found 4% lasted 30 years from every start in his data; this
    // longer history has worse starts, but none that 3% fails from.
    for (const stocks of [1, 0.75, 0.5]) expect(historicalCycles(plan(stocks, 0.03), us).successRate).toBe(1);
  });

  test('bond-heavy portfolios do much worse, as the Trinity study found', () => {
    const allBonds = historicalCycles(plan(0, 0.04), us).successRate;
    const quarter = historicalCycles(plan(0.25, 0.04), us).successRate;
    const stockHeavy = historicalCycles(plan(0.75, 0.04), us).successRate;
    expect(allBonds).toBeLessThan(0.75);
    expect(quarter).toBeLessThan(stockHeavy);
    expect(allBonds).toBeLessThan(quarter);
  });
});

describe('longer retirements need lower rates', () => {
  test('4% fails more often over 50 years than 30, and 3.5% holds up over 50', () => {
    const cells = successGrid('historical', plan(0.75, 0.04), us, [0.035, 0.04], [30, 50]);
    const at = (rate: number, years: number) => cells.find((c) => c.rate === rate && c.years === years)!.successRate!;
    expect(at(0.04, 50)).toBeLessThan(at(0.04, 30) - 0.05);
    // ERN's range for long retirements (3.25% to 3.5%) holds in this data.
    expect(at(0.035, 50)).toBeGreaterThanOrEqual(0.95);
  });
});

describe('Monte Carlo against the history it resamples', () => {
  test('lands near the historical answer, a little lower', () => {
    // No published study runs this exact bootstrap, so this is a sanity
    // range, not a published figure: resampled sequences spread wider than
    // the history (blocks break up its longest cycles), so a success rate a
    // few points under the historical one is what to expect.
    const historical = historicalCycles(plan(0.75, 0.04), us).successRate;
    const mc = monteCarlo(plan(0.75, 0.04), us).successRate;
    expect(mc).toBeGreaterThan(0.85);
    expect(mc).toBeLessThanOrEqual(historical + 0.01);
    expect(mc).toBeGreaterThan(historical - 0.08);
  });
});
