// lib/tag-totals.ts
//
// Spending by tag (#40), by the rule every total follows (lib/spending.ts
// countsInTotals): one currency, what the person excluded and what a rule
// hides left out, transfers, cash withdrawals and loan payments left out.
// Each counted outflow is added under every tag its row carries, exactly the
// amount it adds to its category's spending (lib/totals.ts), so a tag's total
// is the sum of its rows' category totals, never more or less. A row with two
// tags is in both, so the tags together can come to more than the spending
// they cover: the views say so. Pure, safe to import from client code.

import { countsInTotals, type Countable } from './spending';
import { tidy } from './totals';

/** What these totals read of a transaction. */
export type TaggedRow = Countable & { date: string; amount: number; tags?: readonly string[] };

/** One tag's spending: what its rows spent, and how many rows. */
export type TagTotal = { tag: string; spent: number; transactions: number };

/**
 * Spending per tag over the rows whose date `inRange` takes, kept in
 * `currency`: each outflow (a positive amount, Plaid's sign) that counts in
 * totals, under each tag its row carries. Most first, then by id. Tags with
 * no spending are left out.
 */
export function spendingByTag(rows: readonly TaggedRow[], inRange: (date: string) => boolean, currency: string | null): TagTotal[] {
  const by = new Map<string, { spent: number; transactions: number }>();
  for (const t of rows) {
    if (!t.tags?.length || !inRange(t.date) || t.amount <= 0 || !countsInTotals(t, currency)) continue;
    for (const tag of new Set(t.tags)) {
      const s = by.get(tag) ?? { spent: 0, transactions: 0 };
      s.spent += t.amount;
      s.transactions++;
      by.set(tag, s);
    }
  }
  return [...by]
    .map(([tag, s]) => ({ tag, spent: tidy(s.spent), transactions: s.transactions }))
    .sort((a, b) => b.spent - a.spent || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}
