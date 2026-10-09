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
// transactions for leaves spending short with nothing to say so. Each view
// says what is true instead. /api/transactions reports these connections
// beside the rows, not as notes: nothing is wrong, so the payload stays
// cacheable.
//
// Rows can come from elsewhere: transactions entered by hand on a manual
// account (lib/manual-txns.ts), which is not a connection. With any of those,
// there is spending to show, so nothing says there is none: the views show
// the rows, and name the connections that bring in none (withoutNote).

import type { NoTransactionsReason } from './item-products';
import { joinNames } from './month-coverage';

/** One connection that brings in no transactions, and why. */
export type WithoutTransactions = { institution_name: string; reason: NoTransactionsReason };

/** What /api/transactions says about them, as the views take it: the
 *  connections without transactions, and how many connections there are
 *  (unknown until the transactions load, or on a payload from before). */
export type NoTransactionsView = { without: WithoutTransactions[]; connections?: number };

export const NO_CONNECTIONS_WITHOUT: NoTransactionsView = { without: [] };

const REASONS: ReadonlySet<string> = new Set(['investment_accounts', 'no_cash_accounts', 'refused']);

/** The view from a /api/transactions payload, keeping only well-formed entries
 *  (a cached payload from before has neither field). */
export function noTransactionsView(payload: unknown): NoTransactionsView {
  const p = (payload ?? {}) as { without_transactions?: unknown; connections?: unknown };
  const without = Array.isArray(p.without_transactions)
    ? p.without_transactions.filter(
        (w): w is WithoutTransactions => !!w && typeof w.institution_name === 'string' && REASONS.has(w.reason)
      )
    : [];
  const connections = typeof p.connections === 'number' && Number.isSafeInteger(p.connections) && p.connections >= 0 ? p.connections : undefined;
  return connections === undefined ? { without } : { without, connections };
}

/** No connection brings in spending: what is true of them, as the start of a
 *  sentence, and what would bring some in, to follow "To see spending, ". */
export type NoSpending = { lead: string; remedy: string };

/** Whether every connection brings in no transactions (none refused or not),
 *  as far as the payload says. */
function noneBringTransactions(view: NoTransactionsView): boolean {
  return !!view.connections && view.without.length === view.connections;
}

/**
 * When no connection can bring in spending at all, and there are no rows from
 * anywhere else (`rows`, every transaction shown, entered by hand included),
 * what to say instead of an empty year or a zero:
 *   - every account is an investment account: "Your connected accounts are
 *     investment accounts";
 *   - some hold a loan or other account instead: "None of your connected
 *     accounts is a bank account or card";
 *   - a bank account or card is there, and Plaid doesn't provide its
 *     transactions: that, naming the institutions, and "another" bank or card
 *     as the remedy.
 * Null when some connection does bring transactions in (they say the rest),
 * when there are rows anyway (withoutNote names the connections then), with
 * nothing connected, or before the transactions have loaded (`connections`
 * unknown).
 */
export function noSpending(view: NoTransactionsView, rows: number): NoSpending | null {
  if (rows > 0 || !noneBringTransactions(view)) return null;
  const { without } = view;
  const refused = refusedNames(view);
  if (refused.length > 0) {
    return {
      lead: `Plaid doesn't provide transactions for the bank or card accounts at ${joinNames(refused)}`,
      remedy: 'connect another bank or card',
    };
  }
  return {
    lead: without.every((w) => w.reason === 'investment_accounts')
      ? 'Your connected accounts are investment accounts'
      : 'None of your connected accounts is a bank account or card',
    remedy: 'connect a bank or card',
  };
}

/**
 * When no connection brings in transactions but there are rows anyway
 * (entered by hand on a manual account), in place of noSpending's sentence:
 * the connections that hold no bank account or card, named, under the totals
 * and beside the Plan's figures. Null otherwise. One whose bank account or
 * card Plaid refuses is named by the refused notes instead.
 */
export function withoutNote(view: NoTransactionsView, rows: number): string | null {
  if (rows === 0 || !noneBringTransactions(view)) return null;
  const names = [...new Set(view.without.filter((w) => w.reason !== 'refused').map((w) => w.institution_name))];
  if (names.length === 0) return null;
  const one = names.length === 1;
  return `${joinNames(names)} ${one ? 'holds' : 'hold'} no bank account or card, so no transactions come from ${one ? 'it' : 'them'}.`;
}

/** The connections holding a bank account or card that Plaid doesn't provide
 *  transactions for: their spending is not known. */
export function refusedNames(view: NoTransactionsView): string[] {
  return [...new Set(view.without.filter((w) => w.reason === 'refused').map((w) => w.institution_name))];
}

/** Under a month's totals (Activity, budgets), when a refused bank account or
 *  card leaves its spending short; null when none does. */
export function refusedMonthNote(view: NoTransactionsView): string | null {
  const names = refusedNames(view);
  if (names.length === 0) return null;
  return `Doesn't include the bank or card accounts at ${joinNames(names)}: Plaid doesn't provide their transactions, so this month may be incomplete.`;
}

/** In place of the transactions, when there are none and a refused bank
 *  account or card is why some can't be; null when none is. */
export function refusedEmptyNote(view: NoTransactionsView): string | null {
  const names = refusedNames(view);
  if (names.length === 0) return null;
  return `Plaid doesn't provide transactions for the bank or card accounts at ${joinNames(names)}, so they can't be shown.`;
}

/** The Plan's caveat on a figure measured from transactions, when a refused
 *  bank account or card is missing from it (`uncounted` where there is no
 *  figure yet); null when none is. */
export function refusedFigureNote(view: NoTransactionsView, what: 'low' | 'off' | 'uncounted'): string | null {
  const names = refusedNames(view);
  if (names.length === 0) return null;
  const consequence = what === 'uncounted' ? "so they aren't counted" : `so this figure may be ${what}`;
  return `Plaid doesn't provide transactions for the bank or card accounts at ${joinNames(names)}, ${consequence}.`;
}
