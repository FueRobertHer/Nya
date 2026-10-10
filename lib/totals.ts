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

/** What these totals read of a transaction: its category's words, and,
 *  filed into the person's categories (lib/category-store.ts fileRows), the
 *  category's id and name. */
export type TotalsRow = Countable & { date: string; amount: number; category: string | null; category_id?: string; category_name?: string | null };

/** A row's category words, or "other" for none: what a row not filed into
 *  the person's categories is totalled under, as the Budgets tab filed it
 *  before categories had ids. */
export const categoryOf = (t: Pick<TotalsRow, 'category'>): string => t.category ?? 'other';

/** What a row is totalled under: the id of the category it is filed under
 *  (lib/category-store.ts fileRows), or, on a row not filed, its words. */
export const bucketOf = (t: Pick<TotalsRow, 'category' | 'category_id'>): string => t.category_id ?? categoryOf(t);

/** A bucket's sums, and what to call it when nothing names it (a total's
 *  `describe`): the first name a row in it was filed under (one that says
 *  nothing of its category has none), else the first row's words, or
 *  "other". Never an id. */
type BucketSum = { amount: number; transactions: number; named: string | null; words: string };

function addTo(sums: Map<string, BucketSum>, t: TotalsRow, amount: number): void {
  const bucket = bucketOf(t);
  const s = sums.get(bucket) ?? { amount: 0, transactions: 0, named: null, words: categoryOf(t) };
  s.amount += amount;
  s.transactions++;
  if (s.named === null && t.category_name) s.named = t.category_name;
  sums.set(bucket, s);
}

/** A bucket's name: as `describe` says, else as its rows do (BucketSum). */
const nameOf = (bucket: string, s: BucketSum, describe?: (bucket: string) => { category: string }): string =>
  describe ? describe(bucket).category : (s.named ?? s.words);

/**
 * Spending per category over the rows whose date `inRange` takes, as the
 * Budgets tab shows it: outflows (positive amounts, Plaid's sign) that count in
 * totals kept in `currency`, by category id (bucketOf, or `bucket`: the page
 * files a row by the categories it loaded, lib/categories.ts filedId).
 * Unrounded, as summed.
 */
export function spendingByCategory(
  rows: readonly TotalsRow[],
  inRange: (date: string) => boolean,
  currency: string | null,
  bucket: (t: TotalsRow) => string = bucketOf
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of rows) {
    if (!inRange(t.date) || t.amount <= 0 || !countsInTotals(t, currency)) continue;
    const cat = bucket(t);
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
/** What one category adds to money in or to money out, as a positive sum, and
 *  how many rows it sums. */
export type CategoryTotal = { category: string; amount: number; transactions: number };

/**
 * Money in and money out per category over the rows whose date `inRange`
 * takes, kept in `currency`, by the rule every total follows (countsInTotals):
 * money in is the inflows (negative amounts, Plaid's sign), a refund among
 * them, filed under its own row's category; money out is the outflows. Each
 * most first, then by name. `out` is summarize's `categories`, by another
 * name; `in` is what a report adds to it (lib/report/build.ts).
 */
export function categoryTotals(
  rows: readonly TotalsRow[],
  inRange: (date: string) => boolean,
  currency: string | null,
  describe?: (bucket: string) => { category: string }
): { in: CategoryTotal[]; out: CategoryTotal[] } {
  // By the category each row is filed under (bucketOf), as summarize and the
  // Activity tab total them, named by `describe`, else by the rows' own name.
  const into = new Map<string, BucketSum>();
  const outOf = new Map<string, BucketSum>();
  for (const t of rows) {
    if (!inRange(t.date) || t.amount === 0 || !countsInTotals(t, currency)) continue;
    addTo(t.amount < 0 ? into : outOf, t, Math.abs(t.amount));
  }
  const listed = (m: Map<string, BucketSum>): CategoryTotal[] =>
    [...m]
      .map(([bucket, s]) => ({ category: nameOf(bucket, s, describe), amount: tidy(s.amount), transactions: s.transactions }))
      .sort((a, b) => b.amount - a.amount || (a.category < b.category ? -1 : 1));
  return { in: listed(into), out: listed(outOf) };
}

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
 * `describe`, or, without it, by the name its rows were filed under, else
 * their words: never a category's id.
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
  const byCategory = new Map<string, BucketSum>();
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
      addTo(byCategory, t, t.amount);
    }
  }
  const leftOut = leftOutByCurrency(ranged, currency);
  return {
    currency,
    money_in: tidy(moneyIn),
    money_out: tidy(moneyOut),
    net: tidy(moneyIn - moneyOut),
    // Named by `describe`, else by the rows' own name: never an id.
    categories: [...byCategory]
      .map(([bucket, s]) => ({ ...(describe ? describe(bucket) : { category: nameOf(bucket, s) }), spent: tidy(s.amount), transactions: s.transactions }))
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
