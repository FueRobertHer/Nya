import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { categoryById, indexTaxonomy, type CategoryIndex } from '@/lib/categories';
import { ensureTaxonomy } from '@/lib/category-store';
import { isTransactionId } from '@/lib/txn-annotations';
import { isManualTxnId, MANUAL_TXN_PREFIX } from '@/lib/manual-txns';
import { changePart, checkPartNote, checkParts, removeSplit, saveSplit, SplitError, type PartChange } from '@/lib/splits';
import { groupStore, memberIndex } from '@/lib/groups';
import { findTransactions, LookupUnreadableError } from '@/lib/txn-lookup';
import { isSplitOrGroupId } from '@/lib/split-rows';

// Splitting one transaction into parts (#39, lib/splits.ts), applied on read
// in the layer every reader shares (lib/split-rows.ts), so nothing cached is
// dropped and nothing stored about the transaction itself changes.
//
// PUT { transaction_id, parts: [{ id?, amount, category_id, note?, excluded? }] }
//   splits it, replacing any split it had: at least two parts, each of the
//   transaction's own sign, adding up to its amount exactly in its
//   currency's minor units, each under one of the person's categories (by
//   id, kept as the category it is now, following a merge). Refused for a
//   transaction still pending (409: it gets a new id when it posts), one in a
//   group (409: the group counts it whole), one that isn't stored (404).
// PATCH { transaction_id, part_id, category_id?, note?, excluded? }
//   changes one part, its amount left as it is: its category, its note
//   (empty clears it), or whether it alone is left out of budgets and
//   reports. So a split whose transaction's amount the bank changed since can
//   still be changed a part at a time; placing what changed is a PUT.
// DELETE { transaction_id }
//   unsplits it: it shows and counts whole again, exactly as before.
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
    const ix = indexTaxonomy(await ensureTaxonomy(ctx));
    for (const p of parts) p.category_id = categoryOf(ix, p.category_id);
    const split = await saveSplit(ctx, transaction_id, found, parts);
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
    const removed = await removeSplit(ctx, transaction_id);
    return NextResponse.json({ transaction_id, removed });
  } catch (err) {
    return failure(err, 'Failed to unsplit it');
  }
}
