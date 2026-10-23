// lib/fire/us-market.ts
//
// The US market history (lib/fire/history-data.ts, January 1871 to May 2023)
// as a Market, decoded once. The only module that imports the data: the Plan
// tab loads it lazily, so no other tab carries it.

import { BONDS_REAL, HISTORY_FIRST_MONTH, HISTORY_MONTHS, HISTORY_SCALE, INFLATION, STOCKS_REAL } from './history-data';
import { makeMarket, type Market } from './market';

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
