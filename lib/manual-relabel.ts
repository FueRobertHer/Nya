// lib/manual-relabel.ts
//
// Moving the transactions typed on a manual account into the currency it was
// corrected to (lib/manual.ts setManualCurrency), only on the person's
// confirmation ("Also move the 14 transactions entered on it to EUR"). A
// typed amount is never relabelled otherwise: correcting an account changes
// only its own currency, and its rows keep the one they were entered in.
//
// WHICH ROWS. Only those entered by hand on the account (source 'manual') in
// the currency it was in: never one imported from a file (its currency is
// the file's) or brought by SimpleFIN or Lunch Flow (the bank's), never one
// the person split (its parts are kept in the whole's currency,
// lib/splits.ts) or put in a group (a group is of one currency,
// lib/groups.ts), and never one more precise than the new currency allows
// (12.34 can't be in yen without changing its number): those keep their
// currency, and are counted (`kept`) so the person is told. The number of
// each row moved stays as typed.
//
// ONE WRITE of the account's book (lib/manual-txns.ts), compare-and-set, so
// a row added or edited meanwhile on another device is read again, never
// written over. Strict: a book, a split or a group that can't be read
// refuses the whole (the route answers 409), never a partial move.

import type { Ctx } from './containers';
import { manualTxnStore, type ManualTxn } from './manual-txns';
import { splitStore } from './splits';
import { groupStore } from './groups';
import { inMinorUnits } from './manual-txn-input';

/** What a move did: rows moved, and rows that stayed for being split, in a
 *  group, or more precise than the new currency allows. */
export type RelabelResult = { moved: number; kept: number };

/** Of an account's rows, those the move would take, and those it would
 *  leave in their currency for the reasons above (`held`: the ids split or
 *  in a group). Pure: what the form counts and the write applies. */
export function relabelPlan(rows: readonly Pick<ManualTxn, 'id' | 'source' | 'currency' | 'amount'>[], from: string, to: string, held: ReadonlySet<string>) {
  const typed = rows.filter((r) => r.source === 'manual' && r.currency === from);
  const move = typed.filter((r) => !held.has(r.id) && inMinorUnits(r.amount, to));
  return { move, kept: typed.length - move.length };
}

/** Moves the rows typed on `account_id` in `from` into `to` (see the
 *  header), in one compare-and-set write of its book. */
export async function relabelTypedRows(ctx: Ctx, account_id: string, from: string, to: string, now: Date = new Date()): Promise<RelabelResult> {
  if (from === to) return { moved: 0, kept: 0 };
  const book = await manualTxnStore.get(ctx, account_id);
  const typed = (book?.rows ?? []).filter((r) => r.source === 'manual' && r.currency === from).map((r) => r.id);
  if (typed.length === 0) return { moved: 0, kept: 0 };
  // Split ones and grouped ones keep their currency: theirs is the parts' and
  // the group's too.
  const [splits, groups] = await Promise.all([splitStore.getMany(ctx, typed), groupStore.getAll(ctx)]);
  const held = new Set<string>([...splits.keys(), ...[...groups.values()].flatMap((g) => g.members)]);
  let result: RelabelResult = { moved: 0, kept: 0 };
  const at = now.toISOString();
  await manualTxnStore.updateMany(ctx, [account_id], (books) => {
    const current = books.get(account_id);
    if (!current) {
      result = { moved: 0, kept: 0 };
      return new Map();
    }
    const plan = relabelPlan(current.rows, from, to, held);
    const moving = new Set(plan.move.map((r) => r.id));
    result = { moved: moving.size, kept: plan.kept };
    if (moving.size === 0) return new Map();
    return new Map([[account_id, { ...current, rows: current.rows.map((r) => (moving.has(r.id) ? { ...r, currency: to, updated_at: at } : r)) }]]);
  });
  return result;
}
