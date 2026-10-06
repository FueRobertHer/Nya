// lib/fire/market.ts
//
// The market history the engine runs on: monthly real returns for stocks and
// bonds, and monthly inflation, all aligned on one month index. The US
// history (lib/fire/history-data.ts, 1871 to 2023) is decoded once into typed
// arrays; tests build small synthetic markets with makeMarket.
//
// Imports only the generated data, and only through usMarket: the Plan tab
// loads this module lazily so the other tabs never carry the data.

import { BONDS_REAL, HISTORY_FIRST_MONTH, HISTORY_MONTHS, HISTORY_SCALE, INFLATION, STOCKS_REAL } from './history-data';

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

let us: Market | null = null;

/** US stocks, 10-year Treasuries and CPI, monthly from January 1871. */
export function usMarket(): Market {
  if (!us) {
    const decode = (s: readonly number[]) => s.map((v) => v / HISTORY_SCALE);
    us = makeMarket(HISTORY_FIRST_MONTH, decode(STOCKS_REAL), decode(BONDS_REAL), decode(INFLATION));
    if (us.months !== HISTORY_MONTHS) throw new Error('history data is not the length it says');
  }
  return us;
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
