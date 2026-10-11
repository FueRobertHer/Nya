// What the Activity tab's search and its filter by tag keep of a month's
// rows (#40): a row whose merchant, category, account, institution, note or
// tag names hold the text typed, in any case, among those carrying the tag
// chosen. A part of a split transaction is found by its transaction's note
// too, and a group's row by its transactions' names and notes (#39). Pure,
// so the views and the tests share it.

import { displayName } from '@/lib/categories';
import type { Tag } from '@/lib/tags';
import { tagNames } from './tags-state';

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
  group_members?: readonly { name: string; note?: string | null }[];
};

/** The rows the search and the filter keep, in their order. `tag` is a
 *  tag's id, or "" for every row. */
export function searchRows<T extends Searchable>(rows: readonly T[], opts: { query: string; tag: string }, tags: readonly Tag[]): readonly T[] {
  const q = opts.query.trim().toLowerCase();
  const tagged = opts.tag ? rows.filter((t) => t.tags?.includes(opts.tag)) : rows;
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
