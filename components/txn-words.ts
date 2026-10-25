// What a transaction of the Activity tab's list says of itself, on its row
// and in its sheet (components/MonthBreakdown.tsx, components/TransactionSheet.tsx):
// kept apart from both so each reads them without importing the other.

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
export function isLowConfidence(t: Pick<Txn, 'category_confidence'>): boolean {
  return !!t.category_confidence && LOW_CONFIDENCE.has(t.category_confidence);
}
