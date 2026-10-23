// lib/annotate.ts
//
// What the person says about one transaction (lib/txn-annotations.ts):
// whether it is left out of budgets and reports, the tags put on it or taken
// off it, and its note. What app/api/transaction-annotations does once it has
// read a request, and what the API's writes do for a manual row's exclusion
// and tags (lib/api-writes.ts), in one place so the two never differ. The
// route's header says why each step is as it is.

import type { Ctx } from './containers';
import { changeAnnotation, stripTags, txnAnnotationStore, type AnnotationChange, type TxnAnnotation } from './txn-annotations';
import { ensureTag, liveTagIds, readTagSet, type Tag } from './tags';
import { finishDeleting } from './tag-delete';
import { editManualTxn, findManualTxn, isConnectorRow, MANUAL_TXN_PREFIX } from './manual-txns';

/** A change asked for, its fields checked by the caller. */
export type AnnotationAsk = {
  excluded?: boolean;
  /** Tag ids to put on: tags that must exist. */
  add: string[];
  /** Tag ids to take off: one that no longer exists is passed over. */
  remove: string[];
  /** Checked (lib/txn-annotations.ts checkNote); empty clears it. */
  note?: string;
  /** A tag's name: the tag with it is put on, made if there is none. */
  new_tag?: string;
  /** A manual row's account, so only that book is read. */
  account_id?: string;
};

/** What annotateTransaction answers: the record as it now reads, or why
 *  nothing was changed. */
export type Annotated =
  | { ok: true; excluded: boolean; tags: string[]; untagged: string[]; note: string | null; created_tag: Tag | null; record: TxnAnnotation | null; changed: boolean }
  | { ok: false; status: 404; message: string };

const MOVED = 'That transaction was deleted or moved since this page loaded. Reload to see it.';
const TAG_GONE = 'That tag no longer exists. Reload to see your tags as they are.';

/**
 * Makes one change to what is said about one transaction. Tags put on must
 * exist (a tag deleted on another device since the page loaded is refused,
 * never put back); a name typed is found or made; a tag being deleted is
 * dropped from the record as it changes, and one deleted while this put it on
 * is taken back off once the record is saved. A note on a row entered by hand
 * or imported into a manual account is the row's own, so it changes the row;
 * any other note is kept beside it. `expect` is a check of the record as it is
 * now, run inside its compare-and-set (lib/txn-annotations.ts changeAnnotation),
 * or on the record as read when there turns out to be nothing to change (a
 * tag to take off that no longer exists), which writes nothing (`changed`
 * false) and answers the record as it is.
 */
export async function annotateTransaction(
  ctx: Ctx,
  transaction_id: string,
  ask: AnnotationAsk,
  opts: { expect?: (current: TxnAnnotation | null) => void; now?: Date } = {}
): Promise<Annotated> {
  const add = [...ask.add];
  const manual = transaction_id.startsWith(MANUAL_TXN_PREFIX);
  let created: Tag | null = null;
  let live: Set<string> | undefined;
  let gone: Set<string> | undefined;
  if (add.length > 0 || ask.remove.length > 0 || ask.new_tag !== undefined) {
    await finishDeleting(ctx);
    if (ask.new_tag !== undefined) {
      const made = await ensureTag(ctx, { name: ask.new_tag });
      if (made.created) created = made.tag;
      if (!add.includes(made.tag.id)) add.push(made.tag.id);
    }
    const tagSet = await readTagSet(ctx);
    live = liveTagIds(tagSet);
    gone = new Set(tagSet?.deleting ?? []);
    if (add.some((id) => !live!.has(id))) return { ok: false, status: 404, message: TAG_GONE };
  }
  // Taking off a tag that no longer exists changes nothing.
  const off = live ? ask.remove.filter((id) => live!.has(id)) : ask.remove;

  // A note on a row entered by hand or imported into a manual account is the
  // row's own; one on a row SimpleFIN brought is kept beside it, as a bank
  // row's is, and so is one on a row imported into a linked account.
  let rowNote: string | null | undefined;
  let noteBeside = !manual;
  if (manual && ask.note !== undefined) {
    const found = await findManualTxn(ctx, transaction_id, ask.account_id);
    if (!found) return { ok: false, status: 404, message: MOVED };
    if (isConnectorRow(found.row)) noteBeside = true;
    else {
      const saved = await editManualTxn(ctx, transaction_id, { note: ask.note || null }, { from: found.account_id });
      if (!saved) return { ok: false, status: 404, message: MOVED };
      rowNote = saved.note;
    }
  }
  const change: AnnotationChange = {
    ...(ask.excluded !== undefined ? { excluded: ask.excluded } : {}),
    ...(add.length > 0 ? { add } : {}),
    ...(off.length > 0 ? { remove: off } : {}),
    ...(ask.note !== undefined && noteBeside ? { note: ask.note } : {}),
  };
  const changing = Object.keys(change).length > 0;
  let saved: TxnAnnotation | null;
  if (changing) saved = await changeAnnotation(ctx, transaction_id, { ...change, ...(gone?.size ? { gone } : {}) }, opts.now, opts.expect);
  else {
    saved = await txnAnnotationStore.get(ctx, transaction_id);
    opts.expect?.(saved);
  }
  // A tag deleted while this was saved: taken back off.
  if (saved && add.length > 0) {
    const now = liveTagIds(await readTagSet(ctx));
    const dropped = add.filter((id) => !now.has(id));
    if (dropped.length > 0) saved = await stripTags(ctx, transaction_id, dropped);
  }
  return {
    ok: true,
    excluded: saved?.excluded === true,
    tags: saved?.tags ?? [],
    untagged: saved?.untagged ?? [],
    note: rowNote !== undefined ? rowNote : (saved?.note ?? null),
    created_tag: created,
    record: saved,
    changed: changing || rowNote !== undefined,
  };
}
