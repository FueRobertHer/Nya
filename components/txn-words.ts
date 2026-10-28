// What a transaction of the Activity tab's list says of itself, on its row
// and in its sheet (components/MonthBreakdown.tsx, components/TransactionSheet.tsx):
// kept apart from both so each reads them without importing the other.

import { distinctAccountNames, type NamedAccount } from '@/lib/account-names';
import { isTransfer } from '@/lib/spending';
import type { Txn } from './MonthBreakdown';

/** What one side of a pair Nya worked out between two SimpleFIN accounts
 *  (lib/manual-txns.ts connectorTransfers) is. */
const PAIRED_WORDS: Readonly<Record<NonNullable<Txn['paired']>, string>> = {
  card: 'Card payment between your accounts',
  loan: 'Loan payment between your accounts',
  transfer: 'Transfer between your accounts',
};

/** The mark on one side of a pair: what it is, worked out from the amounts,
 *  and, while its category leaves it out of the totals, how to count it. It
 *  counts once its category is moved into a spending group (lib/spending.ts
 *  isTransfer: loan payments, say), and then says only what it is. */
export function pairedWords(t: Pick<Txn, 'paired' | 'transaction_code' | 'category' | 'category_kind'>): string | null {
  if (!t.paired) return null;
  const what = `${PAIRED_WORDS[t.paired]}, worked out from the amounts`;
  return isTransfer(t) ? `${what}: give it a category to count it` : what;
}

/** The name rules match a row by: the one it had before any rule named it. */
export const nameForRules = (t: Pick<Txn, 'name' | 'name_before_rules'>) => t.name_before_rules ?? t.name;

/**
 * What a transaction's sheet offers about leaving it out of budgets and
 * reports: the button to exclude it or put it back ("toggle"), or why not yet
 * ("wait"; "wait-rule" for one a rule hides). A pending row gets a new id
 * when it posts, and an exclusion or an include is kept by id: offered once
 * it has posted, so it can't quietly lapse.
 */
export function exclusionOffer(t: Pick<Txn, 'pending' | 'excluded' | 'excluded_by_rule'>): 'toggle' | 'wait' | 'wait-rule' {
  if (!t.pending) return 'toggle';
  if (t.excluded_by_rule) return 'wait-rule';
  return t.excluded === true ? 'toggle' : 'wait';
}

// Plaid categorizes with a confidence level; LOW/UNKNOWN rows are worth a
// glance, so the row nudges the user toward its category.
const LOW_CONFIDENCE = new Set(['LOW', 'UNKNOWN']);
export function isLowConfidence(t: { category_confidence?: string | null }): boolean {
  return !!t.category_confidence && LOW_CONFIDENCE.has(t.category_confidence);
}

/**
 * Plaid's doubt about a row's category, as the row and the list's chip mark
 * it. Information, not caution (docs/design/guidelines.md, Status and
 * honesty): nothing is wrong with any figure, Plaid only says it wasn't sure.
 * So the row's mark is neutral, with words for a screen reader, and it is
 * not an item in Home's Needs attention; the sheet still says "Check
 * category" with Looks right. Only on a row the sheet can answer it for: not
 * a pending one (a choice is kept by the row's id, and it gets a new one when
 * it posts), nor a split one's or a group's row, whose category is its parts'
 * or the group's. So answering every one brings the count to nothing.
 */
export function unsureCategory(t: { category_confidence?: string | null; pending?: boolean; split_parts?: unknown; group_outside?: unknown; group_members?: unknown }): boolean {
  return isLowConfidence(t) && !t.pending && !t.split_parts && !t.group_outside && !t.group_members;
}

/** Where a row came from, as a badge on its row: only what says the bank
 *  won't update it (typed in, or brought in from a file). A connector's rows
 *  say nothing here: their account says it, and the sheet's line names it. */
export function provenanceWords(source: string | undefined): string | null {
  if (source === 'manual') return 'Entered by hand';
  if (source?.startsWith('import:')) return 'Imported';
  return null;
}

type OnAccount = Pick<Txn, 'institution_name' | 'account_name'>;
const accountKey = (t: OnAccount) => `${t.institution_name}\u0000${t.account_name}`;

/**
 * Each account's name on a row of the list (lib/account-names.ts): its own
 * name, with its institution after it only where another account in the
 * rows loaded has the same name ("Plaid Checking, Tartan Bank"; the name
 * first, as the row's line may be cut). From every row loaded and every
 * group's transactions, so a name never changes as a filter narrows the
 * list. Accounts are told apart by institution and name, which every row
 * carries (a Plaid row has no account id here); an IOU's row is on no
 * account and is left out. Any account not found reads as its name.
 */
export function rowAccountNames(rows: readonly Txn[]): (t: OnAccount) => string {
  const seen = new Map<string, NamedAccount>();
  const add = (t: Txn) => {
    if (t.shared_iou || (!t.institution_name && !t.account_name)) return;
    const id = accountKey(t);
    if (!seen.has(id)) seen.set(id, { id, name: t.account_name, institution: t.institution_name });
  };
  for (const t of rows) {
    add(t);
    for (const m of t.group_members ?? []) add(m);
  }
  const names = distinctAccountNames([...seen.values()], { nameFirst: true });
  return (t) => names.get(accountKey(t)) ?? t.account_name;
}
