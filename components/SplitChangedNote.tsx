'use client';

// On the Budgets tab (#39): a split transaction whose amount changed since it
// was split (the bank's change, or an edit of one entered by hand) counts as
// it was split, with the difference as a part of its own, until the split is
// edited (lib/split-rows.ts). When the amount went down, or turned into money
// in, a budget can show more spent than the bank's figure until then, so the
// tab says so among the Spent card's notes (components/BudgetsTab.tsx); the
// Activity tab marks the row itself.

import type { Txn } from './MonthBreakdown';

/** What the Budgets tab says of this month's split transactions whose amount
 *  changed since they were split, or null when none did. */
export function splitChangedText(txns: readonly Pick<Txn, 'date' | 'split_of' | 'split_remainder'>[], month: string): string | null {
  const changed = new Set(txns.filter((t) => t.split_remainder && t.split_of !== undefined && t.date.slice(0, 7) === month).map((t) => t.split_of!));
  const n = changed.size;
  if (n === 0) return null;
  return n === 1
    ? 'A split transaction’s amount changed since it was split. Its parts count as you split them, and the difference on its own, until you edit the split on the Activity tab.'
    : `${n} split transactions’ amounts changed since they were split. Their parts count as you split them, and the differences on their own, until you edit the splits on the Activity tab.`;
}
