// lib/fire/derive.ts
//
// How the monthly market history in lib/fire/history-data.ts is derived from
// Robert Shiller's US data. Pure arithmetic, shared by the generator
// (scripts/fire-data.ts) and its tests, so each rule is tested here rather
// than only trusted inside a script.
//
// Every series is a RETURN OVER ONE MONTH, from the start of a month to the
// start of the next, labelled by the month it starts in. Shiller's price for a
// month is the average of that month's daily closes, so "the start of a month"
// really means that average; this is the convention every calculator built on
// his data shares, and the reason his series is smoother than end-of-month
// prices would be.
//
// Imports nothing: the Plan tab runs the engine in the browser.

/** The four fields of one month of Shiller's data that the derivations use. */
export type ShillerMonth = {
  /** YYYY-MM. */
  month: string;
  /** S&P composite index, the month's average of daily closes. */
  price: number;
  /** Dividends per share of the index, ANNUALIZED: a twelve-month total,
   *  interpolated monthly from quarterly (since 1926) or annual figures. */
  dividend: number;
  /** Consumer price index: CPI-U from 1913, Warren and Pearson's index spliced
   *  on before that. */
  cpi: number;
  /** Long-term government bond yield (the 10-year Treasury in modern data), in
   *  percent a year. */
  longRate: number;
};

/**
 * Nominal total return of US stocks over one month: the price change plus the
 * dividend paid during the month. Shiller's dividend is a yearly figure, so a
 * month receives a twelfth of it. The month's dividend is the ending month's,
 * as in the "total return price" column of Shiller's own spreadsheet.
 */
export function stockReturn(from: ShillerMonth, to: ShillerMonth): number {
  return (to.price + to.dividend / 12) / from.price - 1;
}

/** Maturity of the bond the bond series holds, in years. */
export const BOND_MATURITY_YEARS = 10;

/**
 * Nominal total return over one month of a constant-maturity government bond,
 * from two monthly yields (percent a year). This is the standard
 * approximation for turning a yield series into returns, used by Shiller's
 * spreadsheet and by calculators built on his data:
 *
 *   - At the start of the month, buy a 10-year bond at par, so its coupon is
 *     the yield then (fromYield).
 *   - A month later, sell it. It now has 9 years 11 months left, and is priced
 *     at the new yield (toYield): the coupons and the principal discounted at
 *     that yield, with annual compounding (an annuity of `coupon` for n years
 *     plus 1 repaid after n years).
 *   - The month's return is the price change plus one month of coupon.
 *
 * So a rise in yields is a capital loss (about 7.5% for one percentage point,
 * the duration of a 10-year bond) and a fall is a gain, and the bond is
 * rolled into a fresh 10-year bond every month, which keeps the maturity
 * constant. Credit risk is nil (government bonds) and taxes are ignored.
 */
export function bondReturn(fromYield: number, toYield: number): number {
  const coupon = fromYield / 100;
  const y = toYield / 100;
  const n = BOND_MATURITY_YEARS - 1 / 12;
  // At a zero yield nothing is discounted: the price is every remaining coupon
  // plus the principal. (No month of the data has a zero yield; this keeps the
  // formula total, since c / y would divide by zero.)
  const price = Math.abs(y) < 1e-12 ? 1 + coupon * n : (coupon / y) * (1 - (1 + y) ** -n) + (1 + y) ** -n;
  return price - 1 + coupon / 12;
}

/** Inflation over one month, from the price index at its start and at the next. */
export function monthInflation(from: ShillerMonth, to: ShillerMonth): number {
  return to.cpi / from.cpi - 1;
}

/**
 * A nominal return expressed in today's money: what it buys, not what it
 * pays. A month that returns 1% while prices rise 1% leaves you exactly where
 * you were. Applying inflation this way, once, is what lets the engine work in
 * today's dollars throughout and never adjust a withdrawal for inflation
 * itself (a second adjustment would count it twice).
 */
export function realReturn(nominal: number, inflation: number): number {
  return (1 + nominal) / (1 + inflation) - 1;
}

/** The three series the engine reads, for one month. */
export type DerivedMonth = {
  month: string;
  stocksReal: number;
  bondsReal: number;
  inflation: number;
};

/** One month's returns, from that month's data and the next month's. */
export function deriveMonth(from: ShillerMonth, to: ShillerMonth): DerivedMonth {
  const inflation = monthInflation(from, to);
  return {
    month: from.month,
    stocksReal: realReturn(stockReturn(from, to), inflation),
    bondsReal: realReturn(bondReturn(from.longRate, to.longRate), inflation),
    inflation,
  };
}

/** Whether a row carries every field the derivations need. The packaged data
 *  extends the price past the end of Shiller's own series with zeros in the
 *  other columns, and a zero dividend or CPI would read as a real number. */
export function isComplete(m: ShillerMonth): boolean {
  return [m.price, m.dividend, m.cpi, m.longRate].every((v) => Number.isFinite(v) && v > 0);
}

/** The month after a YYYY-MM month. */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * Every month's returns from a run of consecutive complete months. Throws on a
 * gap, a repeated month, an incomplete row, or fewer than two rows: a silently
 * skipped month would shift every later return onto the wrong date.
 */
export function deriveSeries(rows: ShillerMonth[]): DerivedMonth[] {
  if (rows.length < 2) throw new Error('need at least two months of data');
  for (let i = 0; i < rows.length; i++) {
    if (!isComplete(rows[i])) throw new Error(`incomplete row for ${rows[i].month}`);
    if (i > 0 && rows[i].month !== nextMonth(rows[i - 1].month)) {
      throw new Error(`months are not consecutive: ${rows[i - 1].month} then ${rows[i].month}`);
    }
  }
  const out: DerivedMonth[] = [];
  for (let i = 0; i + 1 < rows.length; i++) out.push(deriveMonth(rows[i], rows[i + 1]));
  return out;
}
