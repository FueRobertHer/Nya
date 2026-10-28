// What the Activity tab's search and its filter by tag keep of a month's
// rows (#40): a row whose merchant, category, account, institution, note or
// tag names hold the text typed, in any case, among those carrying the tag
// chosen, and, with the To review chip on, among those that need review
// (lib/review-layer.ts needsReview: a part of a transaction that does, a
// group's row holding one); with the Unsure category chip on, among those
// whose category Plaid wasn't sure of (txn-words.ts unsureCategory). A part
// of a split transaction is found by its transaction's note too, and a
// group's row by its transactions' names and notes (#39). Pure, so the views
// and the tests share it.

import { displayName } from '@/lib/categories';
import type { Tag } from '@/lib/tags';
import { needsReview } from '@/lib/review-layer';
import { tagNames } from './tags-state';
import { unsureCategory } from './txn-words';

/** What the search reads of a row. */
export type Searchable = {
  name: string;
  category: string | null;
  category_name?: string | null;
  account_name: string;
  institution_name: string;
  note?: string | null;
  tags?: string[];
  split_parent?: { note?: string | null };
  group_members?: readonly { name: string; note?: string | null; needs_review?: true }[];
  needs_review?: true;
  // For the Unsure category chip (unsureCategory); optional, as other
  // callers' rows don't carry them.
  category_confidence?: string | null;
  pending?: boolean;
  split_parts?: unknown;
  group_outside?: unknown;
};

/**
 * The rows the search and the filter keep, as the Activity tab lists them:
 * with a part of a split transaction, every other part of it too (#39), so
 * the transaction is listed whole, all its parts under it, and editing its
 * split starts from all of them. In the rows' order.
 */
export function searchEntries<T extends Searchable & { split_of?: string }>(rows: readonly T[], opts: { query: string; tag: string; review?: boolean; unsure?: boolean }, tags: readonly Tag[]): readonly T[] {
  const kept = searchRows(rows, opts, tags);
  const split = new Set(kept.flatMap((t) => (t.split_of !== undefined ? [t.split_of] : [])));
  if (split.size === 0) return kept;
  const keep = new Set<T>(kept);
  return rows.filter((t) => keep.has(t) || (t.split_of !== undefined && split.has(t.split_of)));
}

/** The rows the search and the filters keep, in their order. `tag` is a
 *  tag's id, or "" for every row; `review`, only those that need review;
 *  `unsure`, only those whose category Plaid wasn't sure of. */
export function searchRows<T extends Searchable>(rows: readonly T[], opts: { query: string; tag: string; review?: boolean; unsure?: boolean }, tags: readonly Tag[]): readonly T[] {
  const q = opts.query.trim().toLowerCase();
  const reviewed = opts.review ? rows.filter(needsReview) : rows;
  const waiting = opts.unsure ? reviewed.filter(unsureCategory) : reviewed;
  const tagged = opts.tag ? waiting.filter((t) => t.tags?.includes(opts.tag)) : waiting;
  if (!q) return tagged;
  return tagged.filter((t) => {
    const category = t.category_name !== undefined ? t.category_name : t.category;
    return (
      t.name.toLowerCase().includes(q) ||
      (category ? displayName(category) : '').toLowerCase().includes(q) ||
      t.account_name.toLowerCase().includes(q) ||
      t.institution_name.toLowerCase().includes(q) ||
      (t.note ?? '').toLowerCase().includes(q) ||
      (t.split_parent?.note ?? '').toLowerCase().includes(q) ||
      (t.group_members ?? []).some((m) => m.name.toLowerCase().includes(q) || (m.note ?? '').toLowerCase().includes(q)) ||
      tagNames(t.tags, tags).some((n) => n.toLowerCase().includes(q))
    );
  });
}
