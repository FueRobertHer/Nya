// lib/tags-store.ts
//
// The stored tags: the `tags` store on the storage seam (lib/repo.ts) and its
// reads and edits. Apart from lib/tags.ts, which says what a tag is and is
// safe in the browser, so a client component importing it never pulls the
// storage seam into its bundle.

import { defineValueStore } from './repo';
import type { Ctx } from './containers';
import { addTag, checkTagName, emptyTagSet, isTagSet, newTagId, tagByName, type Tag, type TagSet } from './tags';

export const tagStore = defineValueStore<TagSet>('tags', {
  what: 'tags',
  isValid: isTagSet,
  exportable: true, // the person's own tags
});

/** Strict: the stored list, or null when none was ever saved. */
export function readTagSet(ctx: Ctx): Promise<TagSet | null> {
  return tagStore.get(ctx);
}

/**
 * The list for showing transactions (lib/activity.ts): the stored one, or
 * none, with a note when it can't be read (damaged, or saved by a version this
 * one doesn't know): every transaction then shows without tags until it can
 * be, and nothing writes on this answer. Storage that can't be reached
 * throws, as every read does.
 */
export async function tagsForDisplay(ctx: Ctx): Promise<{ set: TagSet | null; note: string | null }> {
  const report = await tagStore.getReport(ctx);
  if (report.unreadable || report.unrecognised) {
    console.error(`Stored tags ${report.unreadable ? 'unreadable' : 'unrecognised'}`);
    return { set: null, note: "Your tags couldn't be read, so transactions show without them until they can be." };
  }
  return { set: report.value, note: null };
}

/** Changes the list with `op` (from an empty one when none was saved), in one
 *  compare-and-set: `op` may run more than once and throws TagError to
 *  refuse. Returns the list as saved. A list that can't be read is refused
 *  (StoredDataUnreadableError), never replaced. */
export async function changeTagSet(ctx: Ctx, op: (set: TagSet) => TagSet): Promise<TagSet> {
  return (await tagStore.update(ctx, (cur) => op(cur ?? emptyTagSet())))!;
}

/** Makes a tag, or finds the one with that name (in any case): for "create a
 *  tag as you type" on a transaction, so a name typed twice is one tag. */
export async function ensureTag(ctx: Ctx, input: { name: unknown; color?: unknown }): Promise<{ tag: Tag; created: boolean }> {
  const name = checkTagName(input.name);
  let result: { tag: Tag; created: boolean } | null = null;
  await changeTagSet(ctx, (set) => {
    const there = tagByName(set, name);
    if (there) {
      result = { tag: there, created: false };
      return set;
    }
    const made = addTag(set, { name, color: input.color }, newTagId);
    result = { tag: made.tag, created: true };
    return made.set;
  });
  return result!;
}
