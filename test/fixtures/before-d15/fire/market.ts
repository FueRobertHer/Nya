// lib/fire/market.ts
//
// The market history the engine runs on: monthly real returns for stocks and
// bonds, and monthly inflation, all aligned on one month index. The US
// history is lib/fire/us-market.ts; tests build small synthetic markets with
// makeMarket.
//
// Imports nothing, and in particular not the 44 KB of data: the plan's
// validation (lib/fire/plan.ts, which the API route uses) reaches this module
// through the engine's types and must not carry it.

export type Market = {
  /** YYYY-MM of month 0. */
  firstMonth: string;
  /** Length of every series. */
  months: number;
  /** Real total return of stocks over each month (0.01 is +1%). */
  stocks: Float64Array;
  /** Real total return of bonds over each month. */
  bonds: Float64Array;
  /** Consumer price inflation over each month. */
  inflation: Float64Array;
};

/**
 * A market from plain arrays. Throws unless the three series have the same
 * length (at least a year) and every value is a finite return above -100%: a
 * misaligned or damaged series would put one month's stocks beside another
 * month's inflation, and nothing downstream could tell.
 */
export function makeMarket(firstMonth: string, stocks: ArrayLike<number>, bonds: ArrayLike<number>, inflation: ArrayLike<number>): Market {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(firstMonth)) throw new Error(`bad first month "${firstMonth}"`);
  const n = stocks.length;
  if (bonds.length !== n || inflation.length !== n) throw new Error('market series differ in length');
  if (n < 12) throw new Error('a market needs at least a year of months');
  for (const [name, s] of [['stocks', stocks], ['bonds', bonds], ['inflation', inflation]] as const) {
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(s[i]) || s[i] <= -1) throw new Error(`${name}[${i}] is not a usable return`);
    }
  }
  return {
    firstMonth,
    months: n,
    stocks: Float64Array.from(stocks),
    bonds: Float64Array.from(bonds),
    inflation: Float64Array.from(inflation),
  };
}

/** YYYY-MM of a month index. */
export function monthLabel(market: Market, index: number): string {
  const [y, m] = market.firstMonth.split('-').map(Number);
  const total = y * 12 + (m - 1) + index;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Index of a YYYY-MM month, or -1 when the market doesn't cover it. */
export function monthIndex(market: Market, month: string): number {
  const [y0, m0] = market.firstMonth.split('-').map(Number);
  const [y, m] = month.split('-').map(Number);
  const i = (y - y0) * 12 + (m - m0);
  return Number.isInteger(i) && i >= 0 && i < market.months ? i : -1;
}

/**
 * The growth of 1 over the twelve months starting at each month, given each
 * month's return. Circular: a year starting in the last eleven months wraps
 * round to the first, which only the Monte Carlo's resampling ever reads
 * (lib/fire/simulate.ts). Historical cycles never start a year that late.
 */
export function yearFactors(months: number, monthly: (i: number) => number): Float64Array {
  const out = new Float64Array(months);
  for (let m = 0; m < months; m++) {
    let f = 1;
    for (let k = 0; k < 12; k++) f *= 1 + monthly((m + k) % months);
    out[m] = f;
  }
  return out;
}

/** Compound growth of 1 over a run of months [from, to). */
export function compound(series: Float64Array, from: number, to: number): number {
  let f = 1;
  for (let i = from; i < to; i++) f *= 1 + series[i];
  return f;
}
