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
//     was paid back; or a rule of yours hides it (lib/rules.ts), which marks
//     it excluded the same way, under what you set on the row. isExcluded;
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
import { ANY_CONNECTOR, CONNECTOR_KINDS, connectorLabel, isConnectorKind, type ConnectorKind } from './connectors/types';

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
  /** On a part of a split transaction (lib/split-rows.ts): the transaction
   *  it is part of, counted once where transactions are counted. */
  split_of?: string;
  /** On a group's row (lib/split-rows.ts): the transactions it stands for,
   *  each counted where transactions are counted. */
  group_members?: readonly unknown[];
  /** On a transaction of a group counted on a day before what was read
   *  (lib/split-rows.ts): it counts there, through its group, so in no total
   *  of what was read. */
  group_outside?: unknown;
  /** On the rows shared expenses make of an unsplit transaction or a payment
   *  (lib/shared-expenses/rows.ts): the transaction they are of, counted
   *  once where transactions are counted, as a split's parts are. */
  shared_of?: string;
  /** On a row shared expenses added (another person's part, a paid-back
   *  part) and an IOU's row: never evidence of what an account holds
   *  (isHistoryRow), never a vote for the totals' currency. */
  shared_part?: unknown;
  shared_iou?: unknown;
};

/**
 * Whether a row is evidence of what the person's accounts hold on its day:
 * every row but those shared expenses add (lib/shared-expenses/rows.ts),
 * above all an IOU's, which is on no account and dated whatever day the
 * person typed. Every reader that takes the earliest row, or whether there
 * are rows at all, as where the history begins or whether transactions come
 * in (the Plan's history length, the cash flow's late-history note, a
 * share's first month, noSpending) reads only rows this takes; they still
 * count in totals. test/history-rows.test.ts finds such readers in the
 * source and holds each to it.
 */
export function isHistoryRow(t: Pick<Countable, 'shared_part' | 'shared_iou'>): boolean {
  return t.shared_part === undefined && t.shared_iou === undefined;
}

/**
 * Counts transactions, not rows, as a total's counts do (#39): a split
 * transaction's parts (split_of) are one transaction, and a group's row is
 * as many as it holds. Every other row is one. `add` a row, read `n`.
 */
export function transactionCounter(): { add: (t: Pick<Countable, 'split_of' | 'group_members' | 'shared_of'>) => void; readonly n: number } {
  const splits = new Set<string>();
  let rows = 0;
  return {
    add(t) {
      // A shared transaction's rows are one, as a split's parts are.
      const of = t.split_of ?? t.shared_of;
      if (of !== undefined) splits.add(of);
      else rows += t.group_members ? t.group_members.length : 1;
    },
    get n() {
      return rows + splits.size;
    },
  };
}

/** How many transactions the rows are (transactionCounter). */
export function countTransactions(rows: Iterable<Pick<Countable, 'split_of' | 'group_members' | 'shared_of'>>): number {
  const c = transactionCounter();
  for (const t of rows) c.add(t);
  return c.n;
}

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

/** A row a connector the person brought (SimpleFIN, Lunch Flow) counts with no
 *  category: neither gives categories (see below). */
const uncategorizedConnectorRow = (t: Countable & { source?: string | null }) => isConnectorKind(t.source) && t.category === null && !isExcluded(t) && !isTransfer(t);

/**
 * How many rows from a connector the person brought (SimpleFIN, Lunch Flow)
 * have no category and still count in totals. Neither gives categories, so
 * nothing says such a row is a card payment or a move between the person's
 * own accounts: it counts as spending or income until they categorize it,
 * except a pair between two of their connector accounts, which is shown as a
 * transfer (lib/manual-txns.ts connectorTransfers).
 */
export function uncategorizedFromConnector(rows: readonly (Countable & { source?: string | null })[]): number {
  return rows.filter(uncategorizedConnectorRow).length;
}

/** Which connectors those rows came through, by name, for uncategorizedNote:
 *  "SimpleFIN", or "SimpleFIN or Lunch Flow" when both brought some. */
export function uncategorizedFrom(rows: readonly (Countable & { source?: string | null })[]): string {
  const kinds = new Set(rows.filter(uncategorizedConnectorRow).map((t) => t.source as ConnectorKind));
  const labels = CONNECTOR_KINDS.filter((k) => kinds.has(k)).map(connectorLabel);
  return labels.length > 0 ? labels.join(' or ') : ANY_CONNECTOR;
}

/** What to say under a total that counts them, or null when there are none.
 *  `from` names the connectors they came through (uncategorizedFrom), every
 *  one when only a count is known. */
export function uncategorizedNote(n: number, from: string = ANY_CONNECTOR): string | null {
  if (n <= 0) return null;
  return `${n} transaction${n === 1 ? '' : 's'} from ${from} ${n === 1 ? 'has' : 'have'} no category, so ${n === 1 ? 'it counts' : 'they count'} as spending or income. A move between two of your ${from} accounts is left out on its own; categorize any other card payment or move between your accounts as a transfer to leave it out too.`;
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
 *  or null when none says (then every row counts, and amounts show in "$").
 *  The rows shared expenses add don't vote: sharing a few dinners never
 *  changes which currency a month is counted in. */
export function totalsCurrency(txns: readonly (Pick<Countable, 'iso_currency_code' | 'unofficial_currency_code'> & Partial<Pick<Countable, 'shared_part' | 'shared_iou'>>)[]): string | null {
  return dominantCurrency(txns.filter((t) => isHistoryRow(t)).map((t) => ({ iso_currency_code: currencyOf(t) })));
}

/** Whether a row can be added into a total in `currency`: it is in that
 *  currency, or says none (taken to be in it). */
export function inCurrency(t: Pick<Countable, 'iso_currency_code' | 'unofficial_currency_code'>, currency: string | null): boolean {
  const c = currencyOf(t);
  return c === null || currency === null || c === currency;
}

/** Whether a transaction counts in totals of money in and out kept in
 *  `currency` (totalsCurrency): not a transfer or loan payment, not excluded,
 *  in that currency, and not one of a group counted on a day before what was
 *  read (group_outside), which counts there. */
export function countsInTotals(t: Countable, currency: string | null): boolean {
  return !isExcluded(t) && !isTransfer(t) && inCurrency(t, currency) && !t.group_outside;
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
  counts: (t: T) => boolean = (t) => !isExcluded(t) && !isTransfer(t) && !t.group_outside
): LeftOut {
  // Transactions, not rows: a split one's parts are one, a group as many as
  // it holds (transactionCounter).
  const counters = new Map<string, ReturnType<typeof transactionCounter>>();
  for (const t of txns) {
    if (inCurrency(t, currency) || !counts(t)) continue;
    const c = currencyOf(t)!;
    const counter = counters.get(c) ?? transactionCounter();
    counter.add(t);
    counters.set(c, counter);
  }
  const by = new Map([...counters].map(([c, counter]) => [c, counter.n] as const));
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
