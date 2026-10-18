import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { categoryById, indexTaxonomy, type CategoryIndex } from '@/lib/categories';
import { ensureTaxonomy } from '@/lib/category-store';
import { isTransactionId } from '@/lib/txn-annotations';
import { isManualTxnId, MANUAL_TXN_PREFIX } from '@/lib/manual-txns';
import type { Ctx } from '@/lib/containers';
import { changePart, checkPartNote, checkParts, removeSplit, saveSplit, SplitError, splitStore, type PartChange } from '@/lib/splits';
import { groupStore, memberIndex, type TxnGroup } from '@/lib/groups';
import { findTransactions, importedStoodFor, LookupUnreadableError, splitsAndGroupsOn, type FoundTxn } from '@/lib/txn-lookup';
import { isSplitOrGroupId } from '@/lib/split-rows';

// Splitting one transaction into parts (#39, lib/splits.ts), applied on read
// in the layer every reader shares (lib/split-rows.ts), so nothing cached is
// dropped and nothing stored about the transaction itself changes.
//
// PUT { transaction_id, parts: [{ id?, amount, category_id, note?, excluded? }], updated_at? }
//   splits it, replacing any split it had: at least two parts, each of the
//   transaction's own sign, adding up to its amount exactly in its
//   currency's minor units, each under one of the person's categories (by
//   id, kept as the category it is now, following a merge). Refused for a
//   transaction still pending (409: it gets a new id when it posts), one in a
//   group (409: the group counts it whole), one that isn't stored (404), and
//   a bank row standing for a row imported from a file that is split or in a
//   group (409: the bank row shows that split, or counts in that group, and a
//   split of its own would hide it; change that one instead).
//   `updated_at` is the split the edit was opened on (null: none): one
//   changed since, on another device, is refused (409), nothing lost.
// PATCH { transaction_id, part_id, category_id?, note?, excluded? }
//   changes one part, its amount left as it is: its category, its note
//   (empty clears it), or whether it alone is left out of budgets and
//   reports. So a split whose transaction's amount the bank changed since can
//   still be changed a part at a time; placing what changed is a PUT.
// DELETE { transaction_id, updated_at? }
//   unsplits it: it shows and counts whole again, exactly as before.
// A row imported into a linked account from its bank's files is named by its
// own id; a bank row standing for one shows that row's split
// (lib/split-rows.ts split_carried_from), and an edit of it names the
// imported row, where it is kept.
// GET ?item_id=
//   how many of a connection's transactions are split, and how many are in a
//   group: what disconnecting it takes, which the confirmation says first.
//
// What can't be read is never taken for nothing: a split, a group, the
// categories or a store of transactions that can't be read answers 409 and
// changes nothing (lib/store-failure.ts, LookupUnreadableError).

const MAX_BODY_CHARS = 32 * 1024;
const PART_ID = /^[A-Za-z0-9-]{1,64}$/;

/** The request's JSON object, or why not. */
async function bodyOf(req: Request): Promise<Record<string, unknown> | NextResponse> {
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: 'Request too large' }, { status: 413 });
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

/** The split an edit was opened on, as a request says it (lib/splits.ts
 *  SeenSplit): its time, null for none, absent for not said. */
function seenOf(body: Record<string, unknown>): string | null | undefined {
  const v = body.updated_at;
  if (v === undefined || v === null) return v;
  if (typeof v !== 'string' || v.length > 40 || Number.isNaN(Date.parse(v))) throw new SplitError('Invalid updated_at');
  return v;
}

/** The transaction id a request names: a transaction's, never a part's or a
 *  group's row's. */
function transactionIdOf(body: Record<string, unknown>): string {
  const id = body.transaction_id;
  if (!isTransactionId(id) || (id.startsWith(MANUAL_TXN_PREFIX) && !isManualTxnId(id))) throw new SplitError('Invalid transaction id');
  if (isSplitOrGroupId(id)) throw new SplitError('That is a part of a split or a group, not a transaction: change the split or the group instead.');
  return id;
}

/** The category a part is under, as it is now (following a merge), or a
 *  refusal: one no category has is gone. */
function categoryOf(ix: CategoryIndex, id: string): string {
  const c = categoryById(ix, id);
  if (!c) throw new SplitError('That category no longer exists. Reload to see your categories as they are.', 404);
  return c.id;
}

/**
 * Refuses a split of its own on a bank row that stands for a row imported
 * from a file (lib/txn-lookup.ts importedStoodFor) which is split, or in a
 * group: the bank row shows that split, or counts in that group in its place
 * (lib/split-rows.ts), and its own split would hide them. Read strictly. One
 * the bank row already has is its own to change.
 */
async function refuseHiding(ctx: Ctx, found: FoundTxn, groups: ReadonlyMap<string, TxnGroup>): Promise<void> {
  if (await splitStore.has(ctx, found.transaction_id)) return;
  const stood = (await importedStoodFor(ctx, [found])).get(found.transaction_id) ?? [];
  if (stood.length === 0) return;
  const splits = await splitStore.getMany(ctx, stood);
  if (stood.some((id) => splits.has(id))) {
    throw new SplitError('This transaction is split as the row imported for it is: change that split instead, with Edit split.', 409);
  }
  const index = memberIndex(groups);
  const group = stood.map((id) => index.get(id)).find((id) => id !== undefined);
  if (group) {
    throw new SplitError(
      `This transaction counts in the group “${groups.get(group)!.name}”, in place of the row imported for it, and the group counts it whole: take it out of the group to split it.`,
      409
    );
  }
}

/** What a failure answers (see the header). */
function failure(err: unknown, fallback: string): NextResponse {
  if (err instanceof SplitError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof LookupUnreadableError) return NextResponse.json({ error: err.message, unreadable: true }, { status: err.status });
  return storeFailure(err, fallback);
}

export async function PUT(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    const transaction_id = transactionIdOf(body);
    if (!Array.isArray(body.parts)) throw new SplitError('Say what the parts are.');

    // A grouped transaction counts whole in its group: split it there and it
    // would count twice. Groups read strictly: one that can't be read could
    // hold it.
    const groups = await groupStore.getAll(ctx);
    const group = memberIndex(groups).get(transaction_id);
    if (group) {
      throw new SplitError(`This transaction is in a group (“${groups.get(group)!.name}”), which counts it whole: take it out of the group to split it.`, 409);
    }
    const found = (await findTransactions(ctx, [transaction_id])).get(transaction_id);
    if (!found) throw new SplitError('That transaction is no longer stored. Reload to see your transactions as they are.', 404);
    const parts = checkParts(body.parts, found);
    await refuseHiding(ctx, found, groups);
    const ix = indexTaxonomy(await ensureTaxonomy(ctx));
    for (const p of parts) p.category_id = categoryOf(ix, p.category_id);
    const split = await saveSplit(ctx, transaction_id, found, parts, new Date(), seenOf(body));
    return NextResponse.json({ transaction_id, split });
  } catch (err) {
    return failure(err, 'Failed to save the split');
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    const transaction_id = transactionIdOf(body);
    if (typeof body.part_id !== 'string' || !PART_ID.test(body.part_id)) throw new SplitError('Invalid part id');
    const change: PartChange = {};
    if (body.category_id !== undefined) {
      if (typeof body.category_id !== 'string' || body.category_id.length > 80) throw new SplitError('Invalid category');
      change.category_id = categoryOf(indexTaxonomy(await ensureTaxonomy(ctx)), body.category_id);
    }
    if (body.note !== undefined) change.note = checkPartNote(body.note) ?? '';
    if (body.excluded !== undefined) {
      if (typeof body.excluded !== 'boolean') throw new SplitError('Say whether to leave the part out.');
      change.excluded = body.excluded;
    }
    if (Object.keys(change).length === 0) throw new SplitError('Say what to change');
    const split = await changePart(ctx, transaction_id, body.part_id, change);
    if (!split) throw new SplitError('That part no longer exists: the split was changed or undone. Reload to see it as it is.', 404);
    return NextResponse.json({ transaction_id, split });
  } catch (err) {
    return failure(err, 'Failed to change that part');
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    const transaction_id = transactionIdOf(body);
    const removed = await removeSplit(ctx, transaction_id, seenOf(body));
    return NextResponse.json({ transaction_id, removed });
  } catch (err) {
    return failure(err, 'Failed to unsplit it');
  }
}

/** A Plaid Item's id, as the disconnect route takes it. */
const ITEM_ID = /^[A-Za-z0-9_-]{1,128}$/;

export async function GET(req: Request) {
  try {
    const ctx = await dataCtx();
    const item_id = new URL(req.url).searchParams.get('item_id');
    if (!item_id || !ITEM_ID.test(item_id)) return NextResponse.json({ error: 'Say which connection.' }, { status: 400 });
    return NextResponse.json(await splitsAndGroupsOn(ctx, item_id));
  } catch (err) {
    return failure(err, 'Could not read your splits');
  }
}
