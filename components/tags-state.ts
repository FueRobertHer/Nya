'use client';

// Your tags on the dashboard (lib/tags.ts): the list each transactions answer
// carries (app/api/transactions), a tag made on a transaction as it is typed,
// and the list the Tags screen answers with after a change
// (components/TagsCard.tsx). The rows hold tag ids; the chips, the filter, the
// search and spend by tag read names and colors from here, so a rename shows
// everywhere at once.

import { useCallback, useState } from 'react';
import { isTagSet, type Tag } from '@/lib/tags';

export type TagListState = {
  tags: Tag[];
  /** Takes the list an answer carried: a transactions load (`tags`, a list)
   *  or a change on the Tags screen (`tags`, the stored set). Anything else
   *  is passed over. */
  accept: (v: unknown) => void;
  /** One tag made on a transaction as it was typed. */
  add: (tag: Tag) => void;
};

export function useTagList(): TagListState {
  const [tags, setTags] = useState<Tag[]>([]);
  const accept = useCallback((v: unknown) => {
    const set = Array.isArray(v) ? { version: 1, tags: v } : v;
    if (isTagSet(set)) setTags(set.tags);
  }, []);
  const add = useCallback((tag: Tag) => setTags((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag])), []);
  return { tags, accept, add };
}

/** The names of the tags a row carries, in the list's order. */
export function tagNames(ids: readonly string[] | undefined, tags: readonly Tag[]): string[] {
  if (!ids?.length) return [];
  const byId = new Map(tags.map((t) => [t.id, t.name]));
  return ids.map((id) => byId.get(id)).filter((n): n is string => !!n);
}
