import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { AnnotationError, checkNote, isTransactionId, TooManyAnnotationsError } from '@/lib/txn-annotations';
import { isTagId, MAX_TAGS_PER_TRANSACTION, TagError } from '@/lib/tags';
import { InvalidTxnError, isManualTxnId, MANUAL_TXN_PREFIX } from '@/lib/manual-txns';
import { isManualId } from '@/lib/manual';
import { storeFailure } from '@/lib/store-failure';
import { annotateTransaction } from '@/lib/annotate';

// What the person says about one transaction (lib/txn-annotations.ts), one
// transaction per request: whether it is left out of budgets and reports, the
// tags they put on it or take off it, and its note. Any transaction, Plaid's,
// a manual one, or one imported into a linked account from its bank's files
// (#52), by its transaction_id, and recorded either way (an
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
// A NOTE ON A ROW ENTERED BY HAND OR IMPORTED is the row's own
// (lib/manual-txns.ts), written with it and shown in its edit form, the
// download and its CSV: an edit here changes the row, so a row never has two
// notes. A bank row's is kept beside it, in its record, and so is one on a
// row SimpleFIN brought, which stays as the bank gave it (lib/manual-txns.ts
// refuses a change to its note, as to its payee), and one on a row imported
// into a linked account, which stays as its file gave it (its file's memo
// shows until a note is written: lib/txn-layers.ts). Either way the Activity
// tab shows it the same.
//
// Everything said here about a bank row's record is one compare-and-set, so
// a change from another device at the same moment is never lost.
//
// TAGS THAT EXIST. Tags put on must exist; tags taken off that no longer do
// are passed over, and the id of a tag being deleted (noted under
// `deleting`) is dropped from the record as it changes. Only those: a tag the
// tags read here don't have may have been made on another device a moment
// ago and put on this transaction there, and the compare-and-set keeps what
// that change wrote. A tag deleted while this request put it on, whose
// deletion swept the records before this one landed (lib/tag-delete.ts), is
// taken back off once the record is saved, so the two end with no record
// holding it, whichever lands first.
//
// The change itself is lib/annotate.ts, which the API's writes call too.

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

    const done = await annotateTransaction(ctx, transaction_id, {
      excluded: excluded as boolean | undefined,
      add,
      remove,
      note,
      new_tag: body.new_tag as string | undefined,
      account_id: account_id as string | undefined,
    });
    if (!done.ok) return NextResponse.json({ error: done.message }, { status: done.status });
    return NextResponse.json({
      transaction_id,
      excluded: done.excluded,
      tags: done.tags,
      untagged: done.untagged,
      note: done.note,
      ...(done.created_tag ? { created_tag: done.created_tag } : {}),
    });
  } catch (err) {
    if (err instanceof TooManyAnnotationsError || err instanceof AnnotationError || err instanceof InvalidTxnError) return NextResponse.json({ error: err.message }, { status: 400 });
    if (err instanceof TagError) return NextResponse.json({ error: err.message }, { status: err.status });
    return storeFailure(err, 'Failed to save that');
  }
}
