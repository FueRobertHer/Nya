// lib/tag-actions.ts
//
// The changes to your tags (lib/tags.ts) that app/api/tags makes, one action
// per request, and that the API's writes make (lib/api-writes.ts), in one
// place so the two never differ. Each is one compare-and-set on the list
// (changeTagSet) running the same pure operations, after a deletion cut off
// part way is finished (lib/tag-delete.ts finishDeleting); a change refused
// throws TagError (400 a bad request, 404 a tag gone since, 409 a name another
// tag has, or too many tags).

import type { Ctx } from './containers';
import { addTag, newTagId, recolorTag, renameTag, type Tag, type TagSet } from './tags';
import { changeTagSet } from './tags-store';
import { deleteTag, finishDeleting } from './tag-delete';

/**
 * Makes the one change a request names by `action`, and answers the tags as
 * they are after it, with the id of a tag it made; null for an action there
 * is none of. Whatever an earlier deletion left to sweep goes first, for any
 * request.
 */
export async function changeTags(ctx: Ctx, body: Record<string, unknown>): Promise<{ set: TagSet; made?: string } | null> {
  await finishDeleting(ctx);
  switch (body.action) {
    case 'add': {
      const { set, tag } = await addTagAs(ctx, { name: body.name, color: body.color }, newTagId());
      return { set, made: tag.id };
    }
    case 'rename':
      return { set: await changeTagSet(ctx, (s) => renameTag(s, body.id, body.name)) };
    case 'recolor':
      return { set: await changeTagSet(ctx, (s) => recolorTag(s, body.id, body.color)) };
    case 'delete':
      return { set: (await deleteTag(ctx, body.id)).set };
    default:
      return null;
  }
}

/**
 * Adds a tag under `id` (minted by the caller, so a create sent again finds
 * its own: `created` false), in one compare-and-set. `check`, run inside it on
 * the list as read, may refuse by throwing (the API keeps room for the
 * person's own tags). The caller finishes any deletion first.
 */
export async function addTagAs(
  ctx: Ctx,
  input: { name: unknown; color?: unknown },
  id: string,
  check?: (set: TagSet) => void,
  now: Date = new Date()
): Promise<{ set: TagSet; tag: Tag; created: boolean }> {
  let created = false;
  const set = await changeTagSet(ctx, (s) => {
    created = false; // this may run more than once
    if (s.tags.some((t) => t.id === id)) return s;
    check?.(s);
    created = true;
    return addTag(s, input, () => id, now).set;
  });
  return { set, tag: set.tags.find((t) => t.id === id)!, created };
}

/**
 * Renames and recolors one tag, either or both, in one compare-and-set:
 * `check` runs inside it on the tag as read (the API's version), and may
 * refuse by throwing. The caller finishes any deletion first.
 */
export async function editTag(ctx: Ctx, id: string, edit: { name?: unknown; color?: unknown }, check?: (tag: Tag | null) => void): Promise<TagSet> {
  return changeTagSet(ctx, (s0) => {
    check?.(s0.tags.find((t) => t.id === id) ?? null);
    let s = s0;
    if (edit.name !== undefined) s = renameTag(s, id, edit.name);
    if (edit.color !== undefined) s = recolorTag(s, id, edit.color);
    return s;
  });
}
