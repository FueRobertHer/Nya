// lib/fire/simulate.ts
//
// The portfolio simulator: a retirement plan run through many sequences of
// market years. Two ways to choose the sequences, one engine:
//
//   - HISTORICAL CYCLES (the cFIREsim and FIRECalc idea, on monthly data):
//     the plan starts in every month of the history that leaves its whole
//     length inside the data, and lives through what actually followed.
//     January 1871 to May 2023 gives 1,470 starts for a 30-year plan.
//   - MONTE CARLO by block bootstrap: each run is built from blocks of
//     BLOCK_MONTHS consecutive historical months drawn at random. A block
//     keeps the months together, so the link between stocks, bonds and
//     inflation in the same months survives, as do runs of good or bad years
//     shorter than a block. Longer cycles (a decade of stagnation, valuations
//     reverting) are cut at block edges, which is why these results spread
//     wider than the historical ones. Draws come from a seeded generator
//     (lib/fire/random.ts), so the same seed gives the same answer.
//
// ONE PLAN YEAR, in today's dollars (every return is already after
// inflation, so no amount is ever raised for inflation here):
//
//   1. The withdrawal rule decides the year's planned withdrawal from the
//      balance at the start of the year (lib/fire/rules.ts). What it leaves
//      to spend, after a flat tax on withdrawals, is planned * (1 - tax).
//   2. Need = that spending + the year's one-off expenses - other income
//      (Social Security, a pension: entered after tax). A positive need is
//      withdrawn, grossed up for the tax: need / (1 - tax). A negative one is
//      income the plan doesn't need, and is invested.
//   3. If the withdrawal is more than the balance, the portfolio has RUN OUT
//      in this year: the plan failed, and its balance is 0 from here on.
//   4. The rest earns the next twelve months of real returns. Rebalancing
//      decides how: "annual" resets the mix to the target at the start of
//      each year, "monthly" every month, "none" never (withdrawals and
//      deposits are taken pro rata, so the mix drifts with the markets).
//   5. The annual fee (an expense ratio) is charged on what is left, at the
//      monthly rate that compounds to the annual one.
//
// Withdrawals are taken once a year, at the start of each plan year: the
// convention of the published annual studies, slightly conservative against
// spreading them through the year, and the reason VPW can end at exactly
// zero. Returns still compound monthly, and plans start in any month.
//
// SUCCESS means the portfolio never ran out: every year's withdrawal was paid
// in full, to the end of the plan. A plan that ends with $1 left succeeded.
//
// Imports nothing that touches storage: the Plan tab runs this in the browser.

import { monthLabel, yearFactors, type Market } from './market';
import { plannedWithdrawal, withRate, type RuleSpec, type YearState } from './rules';
import { seededRandom } from './random';

export type Allocation = { stocks: number; bonds: number; cash: number };
export type Rebalance = 'annual' | 'monthly' | 'none';
export type Method = 'historical' | 'monte-carlo';

export type OtherIncome = {
  /** A year's amount, after tax, in today's dollars. */
  amount: number;
  /** Plan year it starts in (0 is the first year). */
  fromYear: number;
  /** True for income that keeps up with inflation (Social Security). False
   *  for a pension without cost-of-living raises: it keeps its value until it
   *  starts, then loses value to inflation every year after. */
  inflationAdjusted: boolean;
};

export type OneOffExpense = {
  /** In today's dollars, spent (after tax) in that plan year. */
  amount: number;
  year: number;
};

export type SimPlan = {
  startBalance: number;
  /** Length of the plan in years. */
  years: number;
  /** Fractions of the portfolio, summing to 1. */
  allocation: Allocation;
  rebalance: Rebalance;
  /** Annual cost of the funds (expense ratio), as a fraction. */
  fee: number;
  /** Flat effective tax rate on withdrawals, as a fraction. */
  taxRate: number;
  rule: RuleSpec;
  income: OtherIncome[];
  oneOffs: OneOffExpense[];
  /** Real return on cash, a year: see CASH_REAL_RETURN. */
  cashRealReturn: number;
};

/**
 * Cash earns this much after inflation, a year, unless a plan says
 * otherwise: it keeps its value and earns nothing more. Shiller's data has no
 * short-term rate, so cash is modelled as a fixed real return rather than
 * from the 10-year yield, which would credit it with a bond's term premium.
 */
export const CASH_REAL_RETURN = 0;

/** The longest plan the engine runs: 60 years still leaves 1,110 historical starts. */
export const MAX_YEARS = 60;

/** Monte Carlo defaults. 5,000 runs put a success rate near 95% within about
 *  0.3 percentage points of where more runs would settle (one standard error). */
export const DEFAULT_RUNS = 5000;
export const DEFAULT_SEED = 1;
/** Five-year blocks: long enough to keep a bear market and its recovery
 *  together, short enough that a run mixes many parts of the history. */
export const BLOCK_MONTHS = 60;

/** How many of the worst starts a result lists. */
export const WORST_COUNT = 10;

export type Percentiles = { p10: number; p25: number; p50: number; p75: number; p90: number };
/** One series per percentile, one value per year. */
export type Bands = { [K in keyof Percentiles]: number[] };

export type WorstStart = {
  /** YYYY-MM the plan started in, or null for a Monte Carlo run. */
  start: string | null;
  /** Plan year the portfolio ran out in (0-based), or null when it lasted. */
  failedYear: number | null;
  endBalance: number;
  /** The lowest year's planned spending (after tax) while the money lasted. */
  lowestSpending: number;
};

export type SimResult = {
  method: Method;
  years: number;
  /** Starts (historical) or runs (Monte Carlo) simulated. */
  paths: number;
  /** How many never ran out. */
  successes: number;
  successRate: number;
  /** Balance percentiles at the start of each year, and at the end: years + 1 points. */
  balance: Bands;
  /** Balance percentiles at the end of the plan (0 for every plan that ran out). */
  ending: Percentiles;
  /** Planned spending (after tax) percentiles each year, among the plans that
   *  lasted; null when none did. */
  spending: Bands | null;
  /** The first year's planned spending, after tax. */
  firstYearSpending: number;
  /** The lowest year's spending among the plans that lasted, and when that
   *  plan started (null for Monte Carlo); null when none lasted. */
  lowestSpending: { amount: number; start: string | null } | null;
  /** The worst starts: ran out soonest, then lowest spending, then lowest
   *  ending balance. Historical starts are listed once per calendar year
   *  (that year's worst month), so one bad episode does not fill the list. */
  worst: WorstStart[];
  /** First and last start month (historical cycles). */
  firstStart: string | null;
  lastStart: string | null;
  /** Monte Carlo settings, so a result says how it was made. */
  runs: number | null;
  seed: number | null;
  blockMonths: number | null;
};

export type MonteCarloOptions = { runs?: number; seed?: number; blockMonths?: number };

function fail(message: string): never {
  throw new RangeError(message);
}

/** Throws on a plan the engine cannot run honestly: every number is checked,
 *  since one NaN would quietly turn every balance after it into NaN. */
export function checkPlan(plan: SimPlan): void {
  const finite = (v: number) => typeof v === 'number' && Number.isFinite(v);
  if (!finite(plan.startBalance) || plan.startBalance < 0) fail('the starting balance must be zero or more');
  if (!Number.isInteger(plan.years) || plan.years < 1 || plan.years > MAX_YEARS) fail(`a plan runs 1 to ${MAX_YEARS} years`);
  const { stocks, bonds, cash } = plan.allocation;
  if (![stocks, bonds, cash].every((w) => finite(w) && w >= 0) || Math.abs(stocks + bonds + cash - 1) > 1e-9) {
    fail('the allocation must be shares of zero or more that add up to 100%');
  }
  if (!finite(plan.fee) || plan.fee < 0 || plan.fee >= 0.5) fail('the fee must be from 0% to under 50%');
  if (!finite(plan.taxRate) || plan.taxRate < 0 || plan.taxRate >= 0.99) fail('the tax rate must be from 0% to under 99%');
  if (!finite(plan.cashRealReturn) || plan.cashRealReturn <= -1) fail('the return on cash must be above -100%');
  const r = plan.rule;
  if (r.kind === 'vpw') {
    if (!finite(r.expectedReturn) || r.expectedReturn <= -1) fail('VPW needs an expected return above -100%');
  } else if (!finite(r.rate) || r.rate < 0) {
    fail('the withdrawal rate must be zero or more');
  }
  if (r.kind === 'floor-ceiling' && !(finite(r.floor) && finite(r.ceiling) && r.floor >= 0 && r.floor <= r.ceiling)) {
    fail('the floor must be zero or more and no higher than the ceiling');
  }
  for (const s of plan.income) {
    if (!finite(s.amount) || s.amount < 0 || !Number.isInteger(s.fromYear)) fail('other income needs an amount and a start year');
  }
  for (const o of plan.oneOffs) {
    if (!finite(o.amount) || o.amount < 0 || !Number.isInteger(o.year) || o.year < 0) fail('a one-off expense needs an amount and a plan year');
  }
}

/** How a plan's money grows over the twelve months starting at each month. */
type Growth = {
  stocks: Float64Array;
  bonds: Float64Array;
  cash: number;
  /** The whole portfolio with the mix held at its target (annual or monthly
   *  rebalancing); null when it is never rebalanced. */
  portfolio: Float64Array | null;
  inflation: Float64Array;
};

// The last tables built, reused while the market and the mix stay the same:
// the success grid runs twenty plans that differ only in rate and length.
let lastGrowth: { market: Market; key: string; tables: Growth } | null = null;

function growthTables(plan: SimPlan, market: Market): Growth {
  const { stocks: s, bonds: b, cash: c } = plan.allocation;
  const key = `${s},${b},${c},${plan.rebalance},${plan.cashRealReturn}`;
  if (lastGrowth && lastGrowth.market === market && lastGrowth.key === key) return lastGrowth.tables;
  const tables = buildGrowthTables(plan, market);
  lastGrowth = { market, key, tables };
  return tables;
}

function buildGrowthTables(plan: SimPlan, market: Market): Growth {
  const n = market.months;
  const { stocks: ws, bonds: wb, cash: wc } = plan.allocation;
  const stocks = yearFactors(n, (i) => market.stocks[i]);
  const bonds = yearFactors(n, (i) => market.bonds[i]);
  const cash = 1 + plan.cashRealReturn;
  const cashMonthly = cash ** (1 / 12) - 1;
  let portfolio: Float64Array | null = null;
  if (plan.rebalance === 'annual') {
    portfolio = new Float64Array(n);
    for (let m = 0; m < n; m++) portfolio[m] = ws * stocks[m] + wb * bonds[m] + wc * cash;
  } else if (plan.rebalance === 'monthly') {
    portfolio = yearFactors(n, (i) => ws * market.stocks[i] + wb * market.bonds[i] + wc * cashMonthly);
  }
  return { stocks, bonds, cash, portfolio, inflation: yearFactors(n, (i) => market.inflation[i]) };
}

/** Which months each path's years start in. */
type PathSource = {
  count: number;
  monthAt(path: number, year: number): number;
  label(path: number): string | null;
};

type RunOutput = {
  /** paths x (years + 1), when kept. */
  balances: Float64Array | null;
  /** paths x years, when kept. */
  spending: Float64Array | null;
  failedYear: Int32Array;
  lowestSpending: Float64Array;
  endBalance: Float64Array;
  firstYearSpending: number;
};

const EPS = 1e-9;

function runPaths(plan: SimPlan, market: Market, source: PathSource, keep: boolean): RunOutput {
  checkPlan(plan);
  const years = plan.years;
  const count = source.count;
  const g = growthTables(plan, market);
  const tax = plan.taxRate;
  const afterFee = 1 - plan.fee;
  const w = plan.allocation;
  const drift = plan.rebalance === 'none';

  const oneOffs = new Float64Array(years);
  for (const o of plan.oneOffs) if (o.year < years) oneOffs[o.year] += o.amount;

  const out: RunOutput = {
    balances: keep ? new Float64Array(count * (years + 1)) : null,
    spending: keep ? new Float64Array(count * years) : null,
    failedYear: new Int32Array(count).fill(-1),
    lowestSpending: new Float64Array(count),
    endBalance: new Float64Array(count),
    firstYearSpending: 0,
  };
  // The price level at the start of each year, relative to the start of the
  // plan, for income that does not keep up with inflation.
  const priceAt = new Float64Array(years + 1);
  // One state object, refilled each year: a plan is run up to 300,000 years
  // at a time, and a fresh object for each would be most of the work.
  const state: YearState = {
    year: 0,
    years,
    balance: 0,
    startBalance: plan.startBalance,
    previous: 0,
    initial: 0,
    lastNominalReturn: 0,
    lastInflation: 0,
  };

  for (let p = 0; p < count; p++) {
    let bal = plan.startBalance;
    // Holdings by asset, tracked only when the mix is left to drift.
    let hs = bal * w.stocks;
    let hb = bal * w.bonds;
    let hc = bal * w.cash;
    let previous = 0;
    let initial = 0;
    let lastNominalReturn = 0;
    let lastInflation = 0;
    let lowest = Infinity;
    let failed = -1;
    priceAt[0] = 1;

    for (let y = 0; y < years; y++) {
      if (out.balances) out.balances[p * (years + 1) + y] = bal;

      state.year = y;
      state.balance = bal;
      state.previous = previous;
      state.initial = initial;
      state.lastNominalReturn = lastNominalReturn;
      state.lastInflation = lastInflation;
      const raw = plannedWithdrawal(plan.rule, state);
      const planned = Number.isFinite(raw) && raw > 0 ? raw : 0;
      if (y === 0) initial = planned;
      previous = planned;
      const spend = planned * (1 - tax);
      if (y === 0 && p === 0) out.firstYearSpending = spend;

      let income = 0;
      for (const s of plan.income) {
        if (y < s.fromYear) continue;
        income += s.inflationAdjusted ? s.amount : (s.amount * priceAt[Math.max(0, s.fromYear)]) / priceAt[y];
      }

      const need = spend + oneOffs[y] - income;
      if (need > 0) {
        const gross = need / (1 - tax);
        if (gross > bal * (1 + EPS) + EPS) {
          failed = y;
          break;
        }
        const left = Math.max(0, bal - gross);
        if (drift) {
          const k = bal > 0 ? left / bal : 0;
          hs *= k;
          hb *= k;
          hc *= k;
        }
        bal = left;
      } else if (need < 0) {
        if (drift) {
          if (bal > 0) {
            const k = (bal - need) / bal;
            hs *= k;
            hb *= k;
            hc *= k;
          } else {
            hs = -need * w.stocks;
            hb = -need * w.bonds;
            hc = -need * w.cash;
          }
        }
        bal -= need;
      }
      if (out.spending) out.spending[p * years + y] = spend;
      if (spend < lowest) lowest = spend;

      const m = source.monthAt(p, y);
      let grown: number;
      if (drift) {
        hs *= g.stocks[m] * afterFee;
        hb *= g.bonds[m] * afterFee;
        hc *= g.cash * afterFee;
        grown = hs + hb + hc;
      } else {
        grown = bal * (g.portfolio as Float64Array)[m] * afterFee;
      }
      lastNominalReturn = bal > 0 ? (grown / bal) * g.inflation[m] - 1 : 0;
      lastInflation = g.inflation[m] - 1;
      priceAt[y + 1] = priceAt[y] * g.inflation[m];
      bal = grown;
    }

    out.failedYear[p] = failed;
    out.lowestSpending[p] = lowest === Infinity ? 0 : lowest;
    // A plan that ran out holds 0 from then on; the arrays start at 0.
    out.endBalance[p] = failed >= 0 ? 0 : bal;
    if (out.balances && failed < 0) out.balances[p * (years + 1) + years] = bal;
  }
  return out;
}

/** The p-th quantile of sorted values, interpolating between neighbours
 *  (the usual "type 7" definition, as spreadsheet PERCENTILE functions use). */
export function quantile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

function percentiles(sorted: ArrayLike<number>): Percentiles {
  return {
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
  };
}

/** Percentile bands over the columns of a paths x width matrix, from the
 *  given rows only. */
function bands(matrix: Float64Array, width: number, rows: number[]): Bands {
  const out: Bands = { p10: [], p25: [], p50: [], p75: [], p90: [] };
  const column = new Float64Array(rows.length);
  for (let c = 0; c < width; c++) {
    for (let i = 0; i < rows.length; i++) column[i] = matrix[rows[i] * width + c];
    column.sort();
    const q = percentiles(column);
    out.p10.push(q.p10);
    out.p25.push(q.p25);
    out.p50.push(q.p50);
    out.p75.push(q.p75);
    out.p90.push(q.p90);
  }
  return out;
}

function summarize(
  method: Method,
  plan: SimPlan,
  source: PathSource,
  run: RunOutput,
  extra: Pick<SimResult, 'firstStart' | 'lastStart' | 'runs' | 'seed' | 'blockMonths'>
): SimResult {
  const years = plan.years;
  const count = source.count;
  const all: number[] = [];
  const lasted: number[] = [];
  for (let p = 0; p < count; p++) {
    all.push(p);
    if (run.failedYear[p] < 0) lasted.push(p);
  }

  const ending = percentiles(Float64Array.from(run.endBalance).sort());

  let lowestSpending: SimResult['lowestSpending'] = null;
  for (const p of lasted) {
    if (!lowestSpending || run.lowestSpending[p] < lowestSpending.amount) {
      lowestSpending = { amount: run.lowestSpending[p], start: source.label(p) };
    }
  }

  // Worst first: ran out soonest, then the lowest year's spending, then the
  // lowest ending balance, then the earliest start.
  const failedAt = (p: number) => (run.failedYear[p] < 0 ? Infinity : run.failedYear[p]);
  const order = all.slice().sort((a, b) => {
    const fa = failedAt(a);
    const fb = failedAt(b);
    if (fa !== fb) return fa < fb ? -1 : 1;
    if (run.lowestSpending[a] !== run.lowestSpending[b]) return run.lowestSpending[a] - run.lowestSpending[b];
    if (run.endBalance[a] !== run.endBalance[b]) return run.endBalance[a] - run.endBalance[b];
    return a - b;
  });
  const worst: WorstStart[] = [];
  const yearsSeen = new Set<string>();
  for (const p of order) {
    if (worst.length >= WORST_COUNT) break;
    const start = source.label(p);
    if (start) {
      if (yearsSeen.has(start.slice(0, 4))) continue;
      yearsSeen.add(start.slice(0, 4));
    }
    worst.push({
      start,
      failedYear: run.failedYear[p] < 0 ? null : run.failedYear[p],
      endBalance: run.endBalance[p],
      lowestSpending: run.lowestSpending[p],
    });
  }

  return {
    method,
    years,
    paths: count,
    successes: lasted.length,
    successRate: count > 0 ? lasted.length / count : 0,
    balance: bands(run.balances as Float64Array, years + 1, all),
    ending,
    spending: lasted.length > 0 ? bands(run.spending as Float64Array, years, lasted) : null,
    firstYearSpending: run.firstYearSpending,
    lowestSpending,
    worst,
    ...extra,
  };
}

/** How many historical starts leave a whole plan of `years` inside the data. */
export function historicalStarts(market: Market, years: number): number {
  return Math.max(0, market.months - 12 * years + 1);
}

function historicalSource(market: Market, years: number): PathSource {
  const count = historicalStarts(market, years);
  if (count < 1) fail(`the history is too short for a ${years}-year plan`);
  return { count, monthAt: (p, y) => p + 12 * y, label: (p) => monthLabel(market, p) };
}

function monteCarloSource(market: Market, opts: MonteCarloOptions): PathSource & { runs: number; seed: number; blockMonths: number } {
  const runs = opts.runs ?? DEFAULT_RUNS;
  const seed = opts.seed ?? DEFAULT_SEED;
  const blockMonths = opts.blockMonths ?? BLOCK_MONTHS;
  if (!Number.isInteger(runs) || runs < 1 || runs > 100_000) fail('runs must be a whole number from 1 to 100,000');
  if (!Number.isInteger(blockMonths) || blockMonths < 12 || blockMonths % 12 !== 0 || blockMonths > market.months) {
    fail('blocks must be whole years, no longer than the history');
  }
  // Every run draws blocks for the longest plan, whatever this plan's length,
  // so a 30-year run is the first 30 years of the same 60-year run. For a rule
  // that ignores the plan's length (constant, percent of portfolio, floor and
  // ceiling), a run that ran out within 30 years also runs out within 40, so
  // the grid's longer columns never read safer. Guardrails (no cuts in the
  // last 15 years) and VPW (its share depends on the years left) withdraw
  // differently at different lengths, so their columns can differ slightly
  // either way.
  const blocks = Math.ceil((MAX_YEARS * 12) / blockMonths);
  const random = seededRandom(seed);
  const starts = new Int32Array(runs * blocks);
  for (let i = 0; i < starts.length; i++) starts[i] = Math.floor(random() * market.months);
  return {
    count: runs,
    runs,
    seed,
    blockMonths,
    // A year never straddles two blocks (blocks are whole years). A block that
    // runs past the last month wraps round to the first, so every month is
    // equally likely to be drawn (a circular block bootstrap).
    monthAt: (p, y) => {
      const month = 12 * y;
      const b = Math.floor(month / blockMonths);
      return (starts[p * blocks + b] + month - b * blockMonths) % market.months;
    },
    label: () => null,
  };
}

/** The plan started in every historical month that leaves its whole length inside the data. */
export function historicalCycles(plan: SimPlan, market: Market): SimResult {
  const source = historicalSource(market, plan.years);
  const run = runPaths(plan, market, source, true);
  return summarize('historical', plan, source, run, {
    firstStart: source.label(0),
    lastStart: source.label(source.count - 1),
    runs: null,
    seed: null,
    blockMonths: null,
  });
}

/** The plan run through resampled history: see the top of this file. */
export function monteCarlo(plan: SimPlan, market: Market, opts: MonteCarloOptions = {}): SimResult {
  const source = monteCarloSource(market, opts);
  const run = runPaths(plan, market, source, true);
  return summarize('monte-carlo', plan, source, run, {
    firstStart: null,
    lastStart: null,
    runs: source.runs,
    seed: source.seed,
    blockMonths: source.blockMonths,
  });
}

/** Either method by name. */
export function simulate(method: Method, plan: SimPlan, market: Market, opts: MonteCarloOptions = {}): SimResult {
  return method === 'historical' ? historicalCycles(plan, market) : monteCarlo(plan, market, opts);
}

export type GridCell = {
  /** Null for VPW, which has no rate to vary: one cell per length. */
  rate: number | null;
  years: number;
  successRate: number;
  /** The lowest year's spending as a share of the first year's, among plans
   *  that lasted: how far a flexible rule cut spending. Null when none lasted
   *  or the first year spent nothing. */
  lowestSpendingShare: number | null;
  paths: number;
  /** The first and last start month of a historical column (a longer plan
   *  has fewer starts, ending earlier); null for Monte Carlo. */
  firstStart: string | null;
  lastStart: string | null;
};

/**
 * The plan at each withdrawal rate and length: the success-rate grid. Each
 * cell keeps everything else (balance, allocation, income and one-offs, which
 * a shorter length may never reach) and changes only the rule's rate and the
 * plan's length. A rule without a rate (VPW) gets one cell per length, with
 * `rate` null. Monte Carlo cells share a seed, so every cell of a column is
 * judged on the same runs.
 */
export function successGrid(
  method: Method,
  plan: SimPlan,
  market: Market,
  rates: number[],
  horizons: number[],
  opts: MonteCarloOptions = {}
): GridCell[] {
  const cells: GridCell[] = [];
  for (const years of horizons) {
    const source = method === 'historical' ? historicalSource(market, years) : monteCarloSource(market, opts);
    const span = {
      firstStart: method === 'historical' ? source.label(0) : null,
      lastStart: method === 'historical' ? source.label(source.count - 1) : null,
    };
    const variants: { rate: number | null; rule: RuleSpec }[] = withRate(plan.rule, 0)
      ? rates.map((rate) => ({ rate, rule: withRate(plan.rule, rate) as RuleSpec }))
      : [{ rate: null, rule: plan.rule }];
    for (const { rate, rule } of variants) {
      const run = runPaths({ ...plan, years, rule }, market, source, false);
      let lasted = 0;
      let lowest = Infinity;
      for (let p = 0; p < source.count; p++) {
        if (run.failedYear[p] >= 0) continue;
        lasted++;
        lowest = Math.min(lowest, run.lowestSpending[p]);
      }
      cells.push({
        rate,
        years,
        successRate: lasted / source.count,
        lowestSpendingShare: lasted > 0 && run.firstYearSpending > 0 ? lowest / run.firstYearSpending : null,
        paths: source.count,
        ...span,
      });
    }
  }
  return cells;
}
