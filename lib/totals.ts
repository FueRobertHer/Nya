// lib/totals.ts
//
// Totals over transactions, by the rules of lib/spending.ts, as pure
// functions: the Budgets tab's spending per category (components/BudgetsTab.tsx)
// and the read-only API's totals (lib/api-read.ts), so a budget's spent figure
// is the same number in the app and through the API. The monthly figure of
// recurring bills and income (recurringMonthly) is here too, for the same
// reason: the Budgets tab's recurring list and the API add it up alike. Safe
// to import from client code.
//
// Every total goes through countsInTotals: one currency per total (the one
// the caller passes, totalsCurrency over the rows the app shows), what the
// person excluded left out, transfers, cash withdrawals and loan payments left
// out (a bank's fees count as spending), and what was left out for its
// currency named, never added.

import { countsInTotals, isTransfer, isExcluded, leftOutByCurrency, leftOutText, type Countable, type LeftOut } from './spending';
import { expectedDates, perMonth, type RecurringSeries } from './recurring';

/** What these totals read of a transaction. */
export type TotalsRow = Countable & { date: string; amount: number; category: string | null; category_id?: string };

/** A row's category words, or "other" for none: what a row not filed into
 *  the person's categories is totalled under, as the Budgets tab filed it
 *  before categories had ids. */
export const categoryOf = (t: Pick<TotalsRow, 'category'>): string => t.category ?? 'other';

/** What a row is totalled under: the id of the category it is filed under
 *  (lib/category-store.ts fileRows), or, on a row not filed, its words. */
export const bucketOf = (t: Pick<TotalsRow, 'category' | 'category_id'>): string => t.category_id ?? categoryOf(t);

/**
 * Spending per category over the rows whose date `inRange` takes, as the
 * Budgets tab shows it: outflows (positive amounts, Plaid's sign) that count in
 * totals kept in `currency`, by category id (bucketOf). Unrounded, as summed.
 */
export function spendingByCategory(rows: readonly TotalsRow[], inRange: (date: string) => boolean, currency: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of rows) {
    if (!inRange(t.date) || t.amount <= 0 || !countsInTotals(t, currency)) continue;
    const cat = bucketOf(t);
    out[cat] = (out[cat] ?? 0) + t.amount;
  }
  return out;
}

/** A sum as an answer gives it: with the floating-point noise of adding cents
 *  taken off (0.1 + 0.2 is 0.3), and nothing a currency with finer units
 *  (a cryptocurrency's eight places) would lose. */
export const tidy = (n: number): number => Math.round(n * 1e8) / 1e8 || 0;

/** A category in a Summary. */
export type SummaryCategory = { category: string; spent: number; transactions: number } & Partial<Described>;

/** What a total says of the category behind a bucket (bucketOf): its name, its
 *  id and its group's, as the API shows them. */
export type Described = { category: string; category_id: string | null; group_id: string | null; group: string | null };

export type Summary = {
  /** The currency every total here is in; null when no row says one. */
  currency: string | null;
  /** Money in: refunds, pay and other inflows that count, as a positive sum. */
  money_in: number;
  /** Money out: spending that counts, as a positive sum. */
  money_out: number;
  /** money_in less money_out. */
  net: number;
  /** Money out by category, most first, with how many rows each sums: the
   *  category's name, and, filed into the person's categories, its id and
   *  group's (null for one not stored yet). */
  categories: SummaryCategory[];
  /** Rows in the range, and of them: counted in these totals; left out as
   *  transfers, cash withdrawals or loan payments; left out because the person
   *  excluded them; counted although whether the person excluded them could
   *  not be read; left out for another currency (left_out). */
  transactions: number;
  counted: number;
  transfers: number;
  excluded: number;
  exclusion_unknown: number;
  left_out: LeftOut;
  /** left_out as a sentence, or null when nothing was. */
  left_out_text: string | null;
};

/**
 * The totals over the rows whose date `inRange` takes, kept in `currency`: what
 * the Activity tab sums for a month (money in, out and net, and spending by
 * category), for any range. Categories are by bucket (bucketOf), each said by
 * `describe` (by default, the bucket itself as its name).
 */
export function summarize(
  rows: readonly TotalsRow[],
  inRange: (date: string) => boolean,
  currency: string | null,
  describe?: (bucket: string) => Described
): Summary {
  let moneyIn = 0;
  let moneyOut = 0;
  let counted = 0;
  let transfers = 0;
  let excluded = 0;
  let unknown = 0;
  let transactions = 0;
  const byCategory = new Map<string, { spent: number; transactions: number }>();
  const ranged: TotalsRow[] = [];
  for (const t of rows) {
    if (!inRange(t.date)) continue;
    ranged.push(t);
    transactions++;
    if (t.excluded === null) unknown++;
    if (isExcluded(t)) excluded++;
    else if (isTransfer(t)) transfers++;
    if (!countsInTotals(t, currency)) continue;
    counted++;
    if (t.amount < 0) {
      moneyIn += -t.amount;
    } else if (t.amount > 0) {
      moneyOut += t.amount;
      const c = byCategory.get(bucketOf(t)) ?? { spent: 0, transactions: 0 };
      c.spent += t.amount;
      c.transactions++;
      byCategory.set(bucketOf(t), c);
    }
  }
  const leftOut = leftOutByCurrency(ranged, currency);
  return {
    currency,
    money_in: tidy(moneyIn),
    money_out: tidy(moneyOut),
    net: tidy(moneyIn - moneyOut),
    categories: [...byCategory]
      .map(([bucket, c]) => ({ ...(describe ? describe(bucket) : { category: bucket }), spent: tidy(c.spent), transactions: c.transactions }))
      .sort((a, b) => b.spent - a.spent || (a.category < b.category ? -1 : 1)),
    transactions,
    counted,
    transfers,
    excluded,
    exclusion_unknown: unknown,
    left_out: leftOut,
    left_out_text: leftOutText(leftOut, currency),
  };
}

/** Whether a recurring series counts in a monthly figure (recurringMonthly):
 *  still coming on `today` (not one whose expected dates went by with nothing
 *  arriving, lib/recurring.ts expectedDates), its amount known (not pay that
 *  varies too much to forecast), and not a card's payment, the card's own
 *  charges being counted where they are charged. */
export function countsInMonthly(s: RecurringSeries, today: string): boolean {
  return s.agreement !== 'varies' && !s.paysCard && expectedDates(s, today, today).status !== 'ended';
}

/**
 * What recurring series come to in a month, as the Budgets tab's recurring
 * list adds them (components/RecurringCard.tsx) and the read-only API answers
 * (lib/api-read.ts): those that count (countsInMonthly), each at what it comes
 * to in an average month (perMonth: a weekly 10 is about 43), kept in
 * `currency`. One that says no currency counts in it; those in another are
 * left out, counted by currency, never added. Unrounded, as summed.
 */
export function recurringMonthly(series: readonly RecurringSeries[], today: string, currency: string | null): { total: number; leftOut: LeftOut } {
  let total = 0;
  const others = new Map<string, number>();
  for (const s of series) {
    if (!countsInMonthly(s, today)) continue;
    const c = s.currency ?? currency;
    if (c === currency || currency === null) total += perMonth(s);
    else if (c) others.set(c, (others.get(c) ?? 0) + 1);
  }
  return { total, leftOut: [...others].map(([c, count]) => ({ currency: c, count })).sort((a, b) => b.count - a.count) };
}
