// lib/tag-delete.ts
//
// Deleting a tag (lib/tags.ts, DELETING): it comes off every transaction and
// out of every rule, by a sequence that can't leave half a state.
//
//   1. One compare-and-set on the tags: the tag leaves the list and its id is
//      noted under `deleting`. From this moment nothing shows it: every read
//      shows only the ids of tags that exist, so no row, filter, total, rule
//      or answer has it, whatever happens next.
//   2. The sweep, each record in its own compare-and-set: the id comes off
//      what the person said about each transaction and what was carried from
//      earlier accounts (lib/txn-annotations.ts sweepAnnotationTags), and out
//      of every rule (lib/rules.ts sweepRuleTags; a rule left adding nothing
//      else does nothing, and says so).
//   3. One compare-and-set on the tags: the note under `deleting` goes.
//
// A sweep that stops part way (a request cut off, storage failing) leaves the
// note, and ids that nothing shows; the next change to the tags runs the
// sweep again for every noted id (finishDeleting) before its own. Only noted
// ids are swept, so a tag made meanwhile on another device, whose id this
// request has never seen, is never taken for a deleted one. A record that
// can't be read, or that this release doesn't recognise, is left as it is:
// what it holds is never shown either way.

import type { Ctx } from './containers';
import { changeTagSet, emptyTagSet, markDeleted, readTagSet, sweptAway, type TagSet } from './tags';
import { sweepAnnotationTags } from './txn-annotations';
import { sweepRuleTags } from './rules';

/** Deletes a tag (see the header) and returns the tags as they are after, and
 *  how many transactions' records and rules it came off. TagError (404) for
 *  a tag that doesn't exist. */
export async function deleteTag(ctx: Ctx, id: unknown): Promise<{ set: TagSet; transactions: number; rules: number }> {
  const set = await changeTagSet(ctx, (s) => markDeleted(s, id));
  return finishDeleting(ctx, set);
}

/** Sweeps every id noted under `deleting`, then drops the note: the end of
 *  every deletion begun, this one's or one cut off earlier. Nothing to do
 *  when none is noted. */
export async function finishDeleting(ctx: Ctx, known?: TagSet | null): Promise<{ set: TagSet; transactions: number; rules: number }> {
  const set = known === undefined ? await readTagSet(ctx) : known;
  const ids = set?.deleting ?? [];
  if (!set || ids.length === 0) return { set: set ?? emptyTagSet(), transactions: 0, rules: 0 };
  const transactions = await sweepAnnotationTags(ctx, ids);
  const rules = await sweepRuleTags(ctx, ids);
  const after = await changeTagSet(ctx, (s) => sweptAway(s, ids));
  return { set: after, transactions, rules };
}
