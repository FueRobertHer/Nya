// lib/spending.ts
//
// Which transactions count in budgets and reports, decided in one place, so
// every total agrees. Pure, safe to import from client code.
//
// Three things keep a transaction out of a total:
//   - it moves money rather than spending or earning it: between your own
//     accounts, out as cash, or a loan payment (paying a card off settles
//     purchases already counted on the card). isTransfer, the Activity tab's
//     rule. A bank's fee is spending: it leaves your money for good;
//   - you excluded it (lib/txn-annotations.ts): a one-off you want left out of
//     budgets and reports, such as a car bought outright or a work trip that
//     was paid back. isExcluded;
//   - it is in another currency than the total. Nothing is converted between
//     currencies, so a total only ever adds up amounts in one: its currency
//     (totalsCurrency, the one most of the rows are in), and it says what it
//     left out (leftOutText: "1 transaction in JPY isn't in these totals,
//     which are in USD"). The rows stay listed, each in its own currency.
//     inCurrency.
// countsInTotals is all three, and every total that leaves transfers out uses
// it: the Activity tab's money in and out, its chart, trend, top categories,
// places and channels, the budgets, and the Home insights. Two totals have a
// transfer rule of their own and check isExcluded and inCurrency all the
// same: recurring bills (lib/recurring.ts), which keep loan payments, and the
// Plan's spending (lib/fire/inputs.ts), which puts some of them back. A
// transaction you excluded still shows in the list, marked; only the totals
// leave it out.
//
// A ROW'S CATEGORY decides it by its kind, once filed into the person's
// categories (lib/categories.ts: category_kind, its group's kind). A category
// in a transfer group is a transfer; seeded, those are exactly the categories
// the rule below called transfers (transfer in, transfer out, loan payments,
// and any written as words starting with "transfer"), so no total moved when
// categories arrived, and moving a category into a group of another kind is
// how a person changes how it counts. A row not filed (one built before
// categories had kinds) is judged by its category words, as before. The finer
// rules (recurring detection's everyday categories, the Plan's loan payments
// and refunds) read those words, the key the row carries (categoryKey):
// Plaid's category for a row nobody recategorized, else the words of the
// category chosen, never its name, so renaming or regrouping a category never
// moves them. A loan payment is a transfer here, but a bill to recurring
// detection, whatever group holds it.
//
// A ROW'S CURRENCY is Plaid's ISO code, or its unofficial one (a
// cryptocurrency), or a manual row's own. A row with neither is taken to be
// in the totals' currency, and is shown in it: Plaid gives every transaction
// one or the other, so a row with none is one stored before its currency was
// kept (the oldest stored history), always shown and summed as the person's
// main currency.
//
// New code that sums spending or income goes through countsInTotals (or, with
// a rule of its own, checks isExcluded and inCurrency), never a filter of its
// own.

import { dominantCurrency } from './format';
import type { CategoryKind } from './categories';

/** What these rules read of a transaction (the Activity tab's Txn). */
export type Countable = {
  transaction_code: string | null;
  /** The category words the row carries: its key for the rules (categoryKey). */
  category: string | null;
  /** The kind of the category it is filed under (lib/categories.ts), once
   *  filed: what decides a transfer. Absent on a row not filed. */
  category_kind?: CategoryKind | null;
  iso_currency_code: string | null;
  /** Plaid's code for a currency without an ISO one (a cryptocurrency). */
  unofficial_currency_code?: string | null;
  /** True when you excluded it; null when whether you did could not be read,
   *  which counts it (see isExcluded). */
  excluded?: boolean | null;
};

// Plaid's transaction_code is the reliable signal for money that moves without
// being spent (transfers, ATM withdrawals); the category heuristic covers rows
// Plaid didn't code (older data, or codes it never resolved). A "bank charge"
// is a fee, which is spent.
const MOVEMENT_CODES = new Set(['transfer', 'atm']);

/** The words Plaid's loan payments are written as: a transfer to totals, a
 *  bill to recurring detection. */
export const LOAN_PAYMENTS = 'loan payments';

/** The key the finer category rules read: the category words the row carries
 *  (see A ROW'S CATEGORY), never a name. */
export function categoryKey(t: Pick<Countable, 'category'>): string | null {
  return t.category;
}

/** Money moved rather than spent or earned: between your own accounts, or out
 *  as cash. Loan payments are not in it: for recurring bills a mortgage
 *  payment is a classic bill. */
export function isMoneyMovement(t: Pick<Countable, 'transaction_code' | 'category' | 'category_kind'>): boolean {
  if (t.transaction_code && MOVEMENT_CODES.has(t.transaction_code)) return true;
  const key = categoryKey(t);
  if (t.category_kind) return t.category_kind === 'transfer' && key !== LOAN_PAYMENTS;
  return !!key && key.startsWith('transfer');
}

/** The Activity tab's rule: money moved, or a loan payment (paying a card off
 *  would otherwise count its purchases twice): a category in a transfer
 *  group, once filed. */
export function isTransfer(t: Pick<Countable, 'transaction_code' | 'category' | 'category_kind'>): boolean {
  if (t.transaction_code && MOVEMENT_CODES.has(t.transaction_code)) return true;
  if (t.category_kind) return t.category_kind === 'transfer';
  return isMoneyMovement(t) || categoryKey(t) === LOAN_PAYMENTS;
}

/** You excluded it from budgets and reports. When whether you did could not be
 *  read (null), it counts: a total that may include it is shown with a note,
 *  never one that silently leaves out something you did not exclude. */
export function isExcluded(t: Pick<Countable, 'excluded'>): boolean {
  return t.excluded === true;
}

/** The currency a row is in, or null when it doesn't say (see the header). */
export function currencyOf(t: Pick<Countable, 'iso_currency_code' | 'unofficial_currency_code'>): string | null {
  return t.iso_currency_code || t.unofficial_currency_code || null;
}

/** The currency totals over these rows are in: the one most of them are in,
 *  or null when none says (then every row counts, and amounts show in "$"). */
export function totalsCurrency(txns: readonly Pick<Countable, 'iso_currency_code' | 'unofficial_currency_code'>[]): string | null {
  return dominantCurrency(txns.map((t) => ({ iso_currency_code: currencyOf(t) })));
}

/** Whether a row can be added into a total in `currency`: it is in that
 *  currency, or says none (taken to be in it). */
export function inCurrency(t: Pick<Countable, 'iso_currency_code' | 'unofficial_currency_code'>, currency: string | null): boolean {
  const c = currencyOf(t);
  return c === null || currency === null || c === currency;
}

/** Whether a transaction counts in totals of money in and out kept in
 *  `currency` (totalsCurrency): not a transfer or loan payment, not excluded,
 *  and in that currency. */
export function countsInTotals(t: Countable, currency: string | null): boolean {
  return !isExcluded(t) && !isTransfer(t) && inCurrency(t, currency);
}

/** How many rows were left out of a total for being in another currency, by
 *  currency, most first. */
export type LeftOut = { currency: string; count: number }[];

/**
 * The rows `counts` would put in a total but for their currency, by currency:
 * what the total says it left out. `counts` is the total's own rule without
 * the currency (by default, not a transfer and not excluded).
 */
export function leftOutByCurrency<T extends Countable>(
  txns: readonly T[],
  currency: string | null,
  counts: (t: T) => boolean = (t) => !isExcluded(t) && !isTransfer(t)
): LeftOut {
  const by = new Map<string, number>();
  for (const t of txns) {
    if (inCurrency(t, currency) || !counts(t)) continue;
    const c = currencyOf(t)!;
    by.set(c, (by.get(c) ?? 0) + 1);
  }
  return [...by].map(([c, count]) => ({ currency: c, count })).sort((a, b) => b.count - a.count || (a.currency < b.currency ? -1 : 1));
}

/**
 * What a total left out for being in another currency, as a sentence, or null
 * when it left nothing out: "1 transaction in JPY isn't in these totals, which
 * are in USD." `noun` is what was counted, `where` the totals ("these
 * budgets", or "this total" with `plural` false).
 */
export function leftOutText(
  leftOut: LeftOut,
  currency: string | null,
  opts: { noun?: string; where?: string; plural?: boolean } = {}
): string | null {
  if (leftOut.length === 0) return null;
  const { noun = 'transaction', where = 'these totals', plural = true } = opts;
  const total = leftOut.reduce((n, l) => n + l.count, 0);
  const parts = leftOut.map((l, i) => (i === 0 ? `${l.count} ${noun}${l.count === 1 ? '' : 's'} in ${l.currency}` : `${l.count} in ${l.currency}`));
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  const which = currency ? `, which ${plural ? 'are' : 'is'} in ${currency}` : '';
  return `${list} ${total === 1 ? "isn't" : "aren't"} in ${where}${which}.`;
}
