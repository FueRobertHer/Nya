// lib/no-transactions.ts
//
// Connections that bring in no bank or card transactions (lib/item-products.ts),
// and the words the views that count spending use for them: Activity, budgets
// and the Plan. Client-safe: no Redis, no Plaid.
//
// Why it is needed: someone who connects only a 401(k) and an IRA would
// otherwise read "No transactions in the last 12 months", see every budget at
// $0, and be told the Plan has "not enough transactions to measure from yet",
// as if waiting would help. It won't: those connections carry investment
// activity, never spending. And a bank account Plaid doesn't provide
// transactions for, or whose transactions the person didn't allow, leaves
// spending short with nothing to say so. Each view says what is true instead. /api/transactions reports these connections
// beside the rows, not as notes: nothing is wrong, so the payload stays
// cacheable.
//
// Rows can come from elsewhere: transactions entered by hand or imported
// from a file on a manual account (lib/manual-txns.ts), which is not a
// connection. With any of those, there is spending to show, so nothing says
// there is none: the views show the rows, and name the connections that
// bring in none (withoutNote).

import type { NoTransactionsReason } from './item-products';
import { joinNames } from './month-coverage';

/** One connection that brings in no transactions, and why. `item_id` matches
 *  it to the connection's health; absent on a payload cached before it was
 *  sent. */
export type WithoutTransactions = { item_id?: string; institution_name: string; reason: NoTransactionsReason };

/** What /api/transactions says about them, as the views take it: the
 *  connections without transactions, and how many connections there are
 *  (unknown until the transactions load, or on a payload from before). */
export type NoTransactionsView = { without: WithoutTransactions[]; connections?: number };

export const NO_CONNECTIONS_WITHOUT: NoTransactionsView = { without: [] };

const REASONS: ReadonlySet<string> = new Set(['investment_accounts', 'no_cash_accounts', 'refused', 'no_consent']);
/** The reasons that mean a connection holds no bank account or card: it never
 *  brings transactions in, whatever happens to it. */
const BY_DESIGN: ReadonlySet<string> = new Set(['investment_accounts', 'no_cash_accounts']);

/** The view from a /api/transactions payload, keeping only well-formed entries
 *  (a cached payload from before has neither field). */
export function noTransactionsView(payload: unknown): NoTransactionsView {
  const p = (payload ?? {}) as { without_transactions?: unknown; connections?: unknown };
  const without = Array.isArray(p.without_transactions)
    ? p.without_transactions.flatMap((w): WithoutTransactions[] =>
        !!w && typeof w.institution_name === 'string' && REASONS.has(w.reason)
          ? [{ ...(typeof w.item_id === 'string' ? { item_id: w.item_id } : {}), institution_name: w.institution_name, reason: w.reason }]
          : []
      )
    : [];
  const connections = typeof p.connections === 'number' && Number.isSafeInteger(p.connections) && p.connections >= 0 ? p.connections : undefined;
  return connections === undefined ? { without } : { without, connections };
}

/**
 * The connections that hold no bank account or card, by id: they never bring
 * transactions in, so a lapsed sign-in leaves no month short of any, and they
 * are left out of the connections named as stopped (lib/month-coverage.ts).
 * One whose bank account or card Plaid refuses, or the person didn't allow,
 * is not among them: its transactions exist.
 */
export function quietItemIds(view: NoTransactionsView): Set<string> {
  return new Set(view.without.flatMap((w) => (BY_DESIGN.has(w.reason) && w.item_id ? [w.item_id] : [])));
}

/** The connections whose transactions the person didn't allow, by id: their
 *  card on the Accounts tab offers "Allow transactions". */
export function unallowedItemIds(view: NoTransactionsView): Set<string> {
  return new Set(view.without.flatMap((w) => (w.reason === 'no_consent' && w.item_id ? [w.item_id] : [])));
}

/** Whether every connection brings in no transactions (for whatever reason),
 *  as far as the payload says. */
function noneBringTransactions(view: NoTransactionsView): boolean {
  return !!view.connections && view.without.length === view.connections;
}

/** The connections without transactions for one reason, each named once. */
function namesFor(view: NoTransactionsView, reason: NoTransactionsReason): string[] {
  return [...new Set(view.without.filter((w) => w.reason === reason).map((w) => w.institution_name))];
}

/** The connections holding a bank account or card that Plaid doesn't provide
 *  transactions for: their spending is not known. */
export function refusedNames(view: NoTransactionsView): string[] {
  return namesFor(view, 'refused');
}

/** The connections holding a bank account or card whose transactions the
 *  person didn't allow Nya to see: allowing them (the card's "Allow
 *  transactions") fixes it. */
export function unallowedNames(view: NoTransactionsView): string[] {
  return namesFor(view, 'no_consent');
}

/** Whether some connection's bank account or card has spending that doesn't
 *  come in: refused, or not allowed. */
export function spendingUnknown(view: NoTransactionsView): boolean {
  return refusedNames(view).length > 0 || unallowedNames(view).length > 0;
}

/** No connection brings in spending: what is true of them, as the start of a
 *  sentence, and what would bring some in, to follow "To see spending, ". */
export type NoSpending = { lead: string; remedy: string };

/**
 * When no connection can bring in spending at all, and there are no rows from
 * anywhere else (`rows`, every transaction shown, entered by hand included),
 * what to say instead of an empty year or a zero:
 *   - every account is an investment account: "Your connected accounts are
 *     investment accounts";
 *   - some hold a loan or other account instead: "None of your connected
 *     accounts is a bank account or card";
 *   - a bank account or card is there and its transactions don't come in:
 *     whose, and why (not allowed, or Plaid doesn't provide them), with the
 *     way to bring them in: Allow transactions on its card, or another bank or
 *     card.
 * Null when some connection does bring transactions in (they say the rest),
 * when there are rows anyway (withoutNote names the connections then), with
 * nothing connected, or before the transactions have loaded (`connections`
 * unknown).
 */
export function noSpending(view: NoTransactionsView, rows: number): NoSpending | null {
  if (rows > 0 || !noneBringTransactions(view)) return null;
  const refused = refusedNames(view);
  const unallowed = unallowedNames(view);
  if (refused.length > 0 || unallowed.length > 0) {
    const leads: string[] = [];
    const remedies: string[] = [];
    if (unallowed.length > 0) {
      leads.push(`You didn't allow Nya to see transactions from the bank or card accounts at ${joinNames(unallowed)}`);
      remedies.push('choose Allow transactions on the Accounts tab');
    }
    if (refused.length > 0) {
      leads.push(`Plaid doesn't provide transactions for the bank or card accounts at ${joinNames(refused)}`);
      remedies.push('connect another bank or card');
    }
    return { lead: leads.join(', and '), remedy: remedies.join(', or ') };
  }
  return {
    lead: view.without.every((w) => w.reason === 'investment_accounts')
      ? 'Your connected accounts are investment accounts'
      : 'None of your connected accounts is a bank account or card',
    remedy: 'connect a bank or card',
  };
}

/**
 * When no connection brings in transactions but there are rows anyway
 * (entered by hand on a manual account), in place of noSpending's sentence:
 * the connections that hold no bank account or card, named, beside the totals
 * and the Plan's figures. Null otherwise. One whose bank account or card
 * doesn't bring its transactions in is named by the missing notes instead.
 */
export function withoutNote(view: NoTransactionsView, rows: number): string | null {
  if (rows === 0 || !noneBringTransactions(view)) return null;
  const names = [...new Set(view.without.filter((w) => BY_DESIGN.has(w.reason)).map((w) => w.institution_name))];
  if (names.length === 0) return null;
  const one = names.length === 1;
  return `${joinNames(names)} ${one ? 'holds' : 'hold'} no bank account or card, so no transactions come from ${one ? 'it' : 'them'}.`;
}

/** How to bring in the transactions the person didn't allow: the action on
 *  each such connection's card (components/Dashboard.tsx). */
const ALLOW_THEM = 'To bring them in, choose Allow transactions on the Accounts tab.';

/** Under a month's totals (Activity, budgets, Home's spending insights): each
 *  bank account or card whose transactions the month lacks, and why. Empty
 *  when none does. */
export function missingMonthNotes(view: NoTransactionsView): string[] {
  const refused = refusedNames(view);
  const unallowed = unallowedNames(view);
  return [
    ...(refused.length > 0
      ? [`Doesn't include the bank or card accounts at ${joinNames(refused)}: Plaid doesn't provide their transactions, so this month may be incomplete.`]
      : []),
    ...(unallowed.length > 0
      ? [
          `Doesn't include the bank or card accounts at ${joinNames(unallowed)}: you didn't allow Nya to see their transactions, so this month may be incomplete. ${ALLOW_THEM}`,
        ]
      : []),
  ];
}

/** In place of the transactions, when there are none, and some bank account
 *  or card is why some can't be shown. */
export function missingEmptyNotes(view: NoTransactionsView): string[] {
  const refused = refusedNames(view);
  const unallowed = unallowedNames(view);
  return [
    ...(refused.length > 0 ? [`Plaid doesn't provide transactions for the bank or card accounts at ${joinNames(refused)}, so they can't be shown.`] : []),
    ...(unallowed.length > 0
      ? [`You didn't allow Nya to see transactions from the bank or card accounts at ${joinNames(unallowed)}, so they can't be shown. ${ALLOW_THEM}`]
      : []),
  ];
}

/** The Plan's caveats on a figure measured from transactions, for each bank
 *  account or card missing from it (`uncounted` where there is no figure
 *  yet). */
export function missingFigureNotes(view: NoTransactionsView, what: 'low' | 'off' | 'uncounted'): string[] {
  const refused = refusedNames(view);
  const unallowed = unallowedNames(view);
  const consequence = what === 'uncounted' ? "so they aren't counted" : `so this figure may be ${what}`;
  return [
    ...(refused.length > 0 ? [`Plaid doesn't provide transactions for the bank or card accounts at ${joinNames(refused)}, ${consequence}.`] : []),
    ...(unallowed.length > 0
      ? [`You didn't allow Nya to see transactions from the bank or card accounts at ${joinNames(unallowed)}, ${consequence}. ${ALLOW_THEM}`]
      : []),
  ];
}

/** What the missing spending is, for "May be low: spending is missing ...";
 *  null when nothing is. */
export function missingWhat(view: NoTransactionsView): string | null {
  const refused = refusedNames(view).length > 0;
  const unallowed = unallowedNames(view).length > 0;
  if (refused && unallowed) return "transactions Plaid doesn't provide or you didn't allow";
  if (refused) return "transactions Plaid doesn't provide";
  if (unallowed) return "transactions you didn't allow";
  return null;
}
