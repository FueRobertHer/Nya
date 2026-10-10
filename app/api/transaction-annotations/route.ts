import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import {
  AnnotationError,
  changeAnnotation,
  checkNote,
  isTransactionId,
  TooManyAnnotationsError,
  type AnnotationChange,
} from '@/lib/txn-annotations';
import { ensureTag, isTagId, liveTagIds, MAX_TAGS_PER_TRANSACTION, readTagSet, TagError, type Tag } from '@/lib/tags';
import { finishDeleting } from '@/lib/tag-delete';
import { editManualTxn, isManualTxnId, MANUAL_TXN_PREFIX } from '@/lib/manual-txns';
import { isManualId } from '@/lib/manual';
import { storeFailure } from '@/lib/store-failure';

// What the person says about one transaction (lib/txn-annotations.ts), one
// transaction per request: whether it is left out of budgets and reports, the
// tags they put on it or take off it, and its note. Any transaction, Plaid's
// or a manual one, by its transaction_id, and recorded either way (an
// include too, so it beats an exclusion carried across a re-link and a
// rule's hide; a tag taken off, so a rule doesn't put it back). The
// transactions route reads these on every request, after its cache, so
// nothing cached is dropped.
//
// PATCH { transaction_id, ...any of:
//   excluded:    true or false
//   add_tags:    tag ids to put on (tags that exist)
//   remove_tags: tag ids to take off
//   new_tag:     a name: the tag with it (in any case), made if there is none,
//                is put on ("create a tag as you type")
//   note:        text, empty to clear it
//   account_id:  a manual row's account, so only that book is read }
//
// A NOTE ON A MANUAL OR IMPORTED ROW is the row's own (lib/manual-txns.ts),
// written with it and shown in its edit form, the download and its CSV: an
// edit here changes the row, so a row never has two notes. A bank row's is
// kept beside it, in its record. Either way the Activity tab shows it the
// same.
//
// Everything said here about a bank row's record is one compare-and-set, so
// a change from another device at the same moment is never lost.

const MAX_BODY_CHARS = 8 * 1024;

/** A list of tag ids from the body, or a refusal. */
function tagIds(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_TAGS_PER_TRANSACTION || !v.every(isTagId)) throw new AnnotationError(`Invalid ${what}`);
  return v;
}

export async function PATCH(req: Request) {
  try {
    const ctx = await dataCtx();
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: 'Request too large' }, { status: 413 });
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed;
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    const { transaction_id, excluded, account_id } = body;
    if (!isTransactionId(transaction_id)) return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
    const manual = transaction_id.startsWith(MANUAL_TXN_PREFIX);
    if (manual && !isManualTxnId(transaction_id)) return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
    if (excluded !== undefined && typeof excluded !== 'boolean') return NextResponse.json({ error: 'Say whether to exclude it' }, { status: 400 });
    if (account_id !== undefined && (typeof account_id !== 'string' || account_id.length > 80 || !isManualId(account_id))) {
      return NextResponse.json({ error: 'Invalid account id' }, { status: 400 });
    }
    const add = tagIds(body.add_tags, 'tags to put on');
    const remove = tagIds(body.remove_tags, 'tags to take off');
    const note = body.note === undefined ? undefined : checkNote(body.note);
    if (body.new_tag !== undefined && typeof body.new_tag !== 'string') return NextResponse.json({ error: 'Invalid tag name' }, { status: 400 });
    if (excluded === undefined && add.length === 0 && remove.length === 0 && note === undefined && body.new_tag === undefined) {
      return NextResponse.json({ error: 'Say what to change' }, { status: 400 });
    }

    // Tags put on must exist (a tag deleted on another device since the page
    // loaded is refused, never put back); a name typed is found or made.
    let created: Tag | null = null;
    if (add.length > 0 || body.new_tag !== undefined) {
      await finishDeleting(ctx);
      if (body.new_tag !== undefined) {
        const made = await ensureTag(ctx, { name: body.new_tag });
        if (made.created) created = made.tag;
        if (!add.includes(made.tag.id)) add.push(made.tag.id);
      }
      const live = liveTagIds(await readTagSet(ctx));
      if (add.some((id) => !live.has(id))) {
        return NextResponse.json({ error: 'That tag no longer exists. Reload to see your tags as they are.' }, { status: 404 });
      }
    }

    // A manual row's note is the row's own.
    let rowNote: string | null | undefined;
    if (manual && note !== undefined) {
      const saved = await editManualTxn(ctx, transaction_id, { note: note || null }, { from: account_id as string | undefined });
      if (!saved) return NextResponse.json({ error: 'That transaction was deleted or moved since this page loaded. Reload to see it.' }, { status: 404 });
      rowNote = saved.note;
    }
    const change: AnnotationChange = {
      ...(excluded !== undefined ? { excluded } : {}),
      ...(add.length > 0 ? { add } : {}),
      ...(remove.length > 0 ? { remove } : {}),
      ...(note !== undefined && !manual ? { note } : {}),
    };
    const saved = Object.keys(change).length > 0 ? await changeAnnotation(ctx, transaction_id, change) : null;
    return NextResponse.json({
      transaction_id,
      excluded: saved?.excluded === true,
      tags: saved?.tags ?? [],
      untagged: saved?.untagged ?? [],
      note: rowNote !== undefined ? rowNote : (saved?.note ?? null),
      ...(created ? { created_tag: created } : {}),
    });
  } catch (err) {
    if (err instanceof TooManyAnnotationsError || err instanceof AnnotationError) return NextResponse.json({ error: err.message }, { status: 400 });
    if (err instanceof TagError) return NextResponse.json({ error: err.message }, { status: err.status });
    return storeFailure(err, 'Failed to save that');
  }
}
