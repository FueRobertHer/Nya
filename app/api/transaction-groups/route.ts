import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { storeFailure } from '@/lib/store-failure';
import { categoryById, indexTaxonomy } from '@/lib/categories';
import { ensureTaxonomy } from '@/lib/category-store';
import { changeGroup, checkGroupName, checkMemberIds, checkMembers, createGroup, GroupError, groupStore, isGroupId, memberIndex, MIN_MEMBERS, removeGroup, type TxnGroup } from '@/lib/groups';
import { splitStore } from '@/lib/splits';
import { findTransactions, importedStoodFor, LookupUnreadableError, type FoundTxn } from '@/lib/txn-lookup';
import { isSplitOrGroupId } from '@/lib/split-rows';

// Groups of transactions that count as one net amount (#39, lib/groups.ts):
// a dinner and what a friend paid back, a trip and its reimbursement. Applied
// on read in the layer every reader shares (lib/split-rows.ts), so nothing
// cached is dropped and nothing stored about a transaction itself changes.
//
// POST { name, category_id, members: [transaction ids] }
//   makes a group of two or more posted transactions, each stored, in one
//   currency, within a year of each other, none split (its parts count on
//   their own: a group would count it twice) and none in another group;
//   its net is filed under the category (by id). Answers { id, group }. A
//   bank row standing for a row imported from a file that is split, or in a
//   group, is split or in that group already (it shows that split, or counts
//   in that group in its place), and refused as such: a group of its own
//   would hide them.
// PATCH { id, name?, category_id?, add?: [ids], remove?: [ids] }
//   renames it, refiles it, or puts transactions in or takes them out, by
//   the same rules; one that is no longer stored stays in it until the bank's
//   removal takes it out (lib/split-gone.ts).
// DELETE { id }
//   ungroups: its transactions count on their own again, exactly as before.
// A bank row standing for a row imported from a file counts in that row's
// place in its group (lib/split-rows.ts group_carried_from), and is taken
// out by that row's id, which the group holds.
//
// What can't be read is never taken for nothing: a group, a split, the
// categories or a store of transactions that can't be read answers 409 and
// changes nothing.

const MAX_BODY_CHARS = 16 * 1024;

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

/** A group's category, as it is now (following a merge). */
async function categoryOf(ctx: Ctx, raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || raw.length > 80) throw new GroupError('Choose a category for the group.');
  const c = categoryById(indexTaxonomy(await ensureTaxonomy(ctx)), raw);
  if (!c) throw new GroupError('That category no longer exists. Reload to see your categories as they are.', 404);
  return c.id;
}

/** Transaction ids to put in a group, refused if one is a split's part or a
 *  group's own row: not a transaction. */
function joining(raw: unknown, what: string): string[] {
  const ids = checkMemberIds(raw, what);
  if (ids.some(isSplitOrGroupId)) {
    throw new GroupError('A part of a split transaction can’t join a group: the transaction counts through its parts. Unsplit it first, then group the whole transaction.');
  }
  return ids;
}

const quoted = (t: FoundTxn) => `“${t.name}”`;

/**
 * Checks transactions joining a group (`group`, or a new one when absent):
 * each stored (404), not split (409), in no other group (409), and, for a
 * posted bank row standing for a row imported from a file, that row neither
 * split nor in any group, this one too (409: the bank row shows that split,
 * or counts in that group in its place, lib/split-rows.ts, and a place of its
 * own would hide them). Groups, splits and what a bank row stands for are
 * read strictly: one that can't be read could hold any of them.
 */
async function checkJoining(ctx: Ctx, ids: readonly string[], found: ReadonlyMap<string, FoundTxn>, group?: string): Promise<void> {
  if (ids.length === 0) return;
  const missing = ids.find((id) => !found.has(id));
  if (missing) throw new GroupError('One of those transactions is no longer stored. Reload to see your transactions as they are.', 404);
  const [splits, groups] = await Promise.all([splitStore.getMany(ctx, ids), groupStore.getAll(ctx)]);
  const split = ids.find((id) => splits.has(id));
  if (split) {
    throw new GroupError(`${quoted(found.get(split)!)} is split, and its parts count on their own, so a group would count it twice. Unsplit it first.`, 409);
  }
  const inGroup = memberIndex(new Map([...groups].filter(([id]) => id !== group)));
  const taken = ids.find((id) => inGroup.has(id));
  if (taken) throw new GroupError(`${quoted(found.get(taken)!)} is already in the group “${groups.get(inGroup.get(taken)!)!.name}”: take it out of that group first.`, 409);
  // A pending one is refused as pending (checkMembers).
  const stood = await importedStoodFor(
    ctx,
    ids.map((id) => found.get(id)!).filter((t) => !t.pending)
  );
  if (stood.size === 0) return;
  const carried = await splitStore.getMany(ctx, [...new Set([...stood.values()].flat())]);
  const everyGroup = memberIndex(groups);
  for (const [id, rows] of stood) {
    if (rows.some((r) => carried.has(r))) {
      throw new GroupError(
        `${quoted(found.get(id)!)} is split as you split the row you imported for it from your bank’s file, and its parts count on their own, so a group would count it twice. Unsplit it first.`,
        409
      );
    }
    const held = rows.map((r) => everyGroup.get(r)).find((g) => g !== undefined);
    if (held) {
      throw new GroupError(
        `${quoted(found.get(id)!)} is already in the group “${groups.get(held)!.name}”, in place of the row you imported for it from your bank’s file: take it out of that group first.`,
        409
      );
    }
  }
}

function failure(err: unknown, fallback: string): NextResponse {
  if (err instanceof GroupError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof LookupUnreadableError) return NextResponse.json({ error: err.message, unreadable: true }, { status: err.status });
  return storeFailure(err, fallback);
}

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    const name = checkGroupName(body.name);
    const members = joining(body.members, 'transactions');
    if (members.length < MIN_MEMBERS) throw new GroupError(`A group has at least ${MIN_MEMBERS} transactions.`);
    const category_id = await categoryOf(ctx, body.category_id);
    const found = await findTransactions(ctx, members);
    await checkJoining(ctx, members, found);
    const { date, currency } = checkMembers(members.map((id) => found.get(id)!));
    const made = await createGroup(ctx, { name, category_id, members, date, currency });
    return NextResponse.json(made);
  } catch (err) {
    return failure(err, 'Failed to make the group');
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    if (!isGroupId(body.id)) throw new GroupError('Invalid group id');
    const id = body.id;
    const name = body.name === undefined ? undefined : checkGroupName(body.name);
    const category_id = body.category_id === undefined ? undefined : await categoryOf(ctx, body.category_id);
    const add = joining(body.add, 'transactions to add');
    const remove = checkMemberIds(body.remove, 'transactions to take out');
    if (name === undefined && category_id === undefined && add.length === 0 && remove.length === 0) throw new GroupError('Say what to change');

    // The group as it is, read strictly; then what joins it, checked.
    const current = await groupStore.get(ctx, id);
    if (!current) throw new GroupError('That group no longer exists. Reload to see your transactions as they are.', 404);
    const members = [...current.members.filter((m) => !remove.includes(m)), ...add.filter((m) => !current.members.includes(m))];
    if (members.length < MIN_MEMBERS) throw new GroupError(`A group has at least ${MIN_MEMBERS} transactions: to break it up, ungroup it.`);
    let date = current.date;
    let currency = current.currency;
    if (add.length > 0 || remove.length > 0) {
      // Every transaction it will hold that is still stored: one the bank
      // removed stays until its removal is saved, and says so meanwhile; one
      // joining it must be stored.
      const found = await findTransactions(ctx, members);
      await checkJoining(ctx, add, found, id);
      const here = members.filter((m) => found.has(m)).map((m) => found.get(m)!);
      if (here.length >= MIN_MEMBERS) ({ date, currency } = checkMembers(here));
      else if (here.length === 1) ({ date, currency } = { date: here[0].date, currency: here[0].currency });
    }
    const group = await changeGroup(ctx, id, (latest): TxnGroup => {
      // Built on what is stored now: a transaction another device put in or
      // took out meanwhile stays as it did.
      const next = [...latest.members.filter((m) => !remove.includes(m)), ...add.filter((m) => !latest.members.includes(m))];
      return {
        ...latest,
        ...(name !== undefined ? { name } : {}),
        ...(category_id !== undefined ? { category_id } : {}),
        members: next,
        date: next.length === members.length && next.every((m) => members.includes(m)) ? date : latest.date < date ? latest.date : date,
        currency,
      };
    });
    if (!group) throw new GroupError('That group no longer exists. Reload to see your transactions as they are.', 404);
    return NextResponse.json({ id, group });
  } catch (err) {
    return failure(err, 'Failed to change the group');
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    if (!isGroupId(body.id)) throw new GroupError('Invalid group id');
    const removed = await removeGroup(ctx, body.id);
    return NextResponse.json({ id: body.id, removed });
  } catch (err) {
    return failure(err, 'Failed to ungroup it');
  }
}
