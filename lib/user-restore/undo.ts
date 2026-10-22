// lib/user-restore/undo.ts
//
// Undoing a restore, and emptying an account first (docs/data-export.md,
// "Bringing it back"; decisions 4 and 7): every key of the container but the
// machinery that is independent of the data (lib/user-restore/classes.ts
// keptWhenEmptied: counters, sessions, caches, locks, the person's API
// tokens, record of showings and weekly summary key) deleted, through one
// sweep beside account deletion's (lib/account-deletion.ts
// sweepContainerExcept). What is derived from the data (the holdings index,
// the walk's record, a connection's markers) goes with it. The container,
// its key, its registry entry and the sign-in stay.
//
// BOUNDED. Undo is offered while a restore is unfinished and for UNDO_DAYS
// after it finished, and then it is gone: past that it would erase real
// history measured since, and everything made since, behind a lighter
// ceremony than deleting the account. Emptying is for an account that holds
// data no restore brought (one tried first, the shared password's one
// container), behind a typed confirmation. Both are refused while a
// connection holds a credential (a Plaid item still billed at Plaid, a
// SimpleFIN connection with its Access URL: deleting their keys would leave
// them running at the provider), and when another sign-in owns the container
// too, as deleting the account is. The routes ask for a fresh sign-in first
// and email the owner after.
//
// A BATCH IN FLIGHT. A batch re-reads the record just before it writes, but
// one that passed that read as the undo began could still land after the
// sweep: so the record says `undoing` first (every batch is refused from
// then), the container is swept, and swept once more after a pause longer
// than a batch can run (UNDO_PAUSE_MS), the record last of all. An undo that
// stops part way stays `undoing`, holding totals as an unfinished restore
// does, and running it again finishes it.

import type { Ctx, ContainerId } from '../containers';
import { getItems } from '../storage';
import { secretsStore } from '../connectors/store';
import { sweepContainerExcept } from '../account-deletion';
import { ownersOf } from '../owners';
import { clearCaches } from '../cache';
import { keptWhenEmptied } from './classes';
import { userRestoreStore, UNDO_DAYS, type UserRestoreRecord } from './store';
import { unfinished } from './restored';

/** Longer than a batch can run (app/api/user-restore/batch maxDuration). */
export const UNDO_PAUSE_MS = 65_000;

/** The pause the routes take: UNDO_PAUSE_MS, but under test (NODE_ENV=test)
 *  RESTORE_UNDO_PAUSE_MS when set, since a test run can't wait a minute. */
export function undoPauseMs(): number {
  const set = process.env.NODE_ENV === 'test' ? Number(process.env.RESTORE_UNDO_PAUSE_MS ?? NaN) : NaN;
  return Number.isFinite(set) && set >= 0 ? set : UNDO_PAUSE_MS;
}

/** Why an undo or an emptying can't go ahead, in words for the person. */
export class UndoRefused extends Error {
  constructor(
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = 'UndoRefused';
  }
}

/** Whether the restore can still be undone now (see BOUNDED). */
export function undoable(record: UserRestoreRecord, now: number): boolean {
  if (unfinished(record)) return true;
  return record.undo_until !== null && now <= Date.parse(record.undo_until);
}

/** The refusals both share (see the header): a credential stored, another
 *  sign-in. `userId` is the signed-in account, null with the shared password. */
async function mayEmpty(ctx: Ctx, userId: string | null): Promise<void> {
  const [items, secrets] = await Promise.all([getItems(ctx), secretsStore.count(ctx)]);
  if (items.length > 0) {
    const names = [...new Set(items.map((i) => i.institution_name))].join(', ');
    throw new UndoRefused(`Disconnect ${names} first (Manage), then try again: emptying the account would leave ${items.length === 1 ? 'that connection' : 'those connections'} running at Plaid.`);
  }
  if (secrets > 0) throw new UndoRefused('Disconnect SimpleFIN first (Manage), then try again: emptying the account would leave its connection working at SimpleFIN.');
  if (userId !== null && (await ownersOf(ctx.container as ContainerId)).some((other) => other !== userId)) {
    throw new UndoRefused('This account’s data belongs to another sign-in too, so it can’t be emptied from the app. Ask whoever runs this copy of Nya.');
  }
}

/** Keeps the machinery that is independent of the data (classes.ts
 *  keptWhenEmptied), and, until the end of an undo, its record: what is
 *  derived from the data (the holdings index, the walk's record) goes with
 *  it, so a later restore never reads it as its own. */
const keepMachinery = keptWhenEmptied;

/**
 * Undoes the restore `id` (see the header): refused unless it is this
 * container's and still undoable. Answers how many keys went.
 */
export async function undoRestore(
  ctx: Ctx,
  id: string,
  opts: { userId: string | null; now?: number; sleep?: (ms: number) => Promise<void>; pauseMs?: number }
): Promise<{ deleted: number }> {
  const now = opts.now ?? Date.now();
  const record = await userRestoreStore.get(ctx);
  if (!record || record.id !== id) throw new UndoRefused('There is no restore here to undo.', 404);
  if (!undoable(record, now)) throw new UndoRefused(`This restore finished more than ${UNDO_DAYS} days ago, so it can no longer be undone. Download what is in this account first, then empty it (Manage, Bring back a download).`);
  await mayEmpty(ctx, opts.userId);
  // Every batch is refused from here (lib/user-restore/check.ts).
  await userRestoreStore.update(ctx, (cur) => (cur && cur.id === id ? { ...cur, status: 'undoing' } : cur));
  const keep = (key: string) => keepMachinery(key) || key === userRestoreStore.name;
  let deleted = await sweepContainerExcept(ctx, keep);
  await (opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(opts.pauseMs ?? undoPauseMs());
  deleted += await sweepContainerExcept(ctx, keep);
  await userRestoreStore.remove(ctx);
  await clearCaches(ctx);
  return { deleted: deleted + 1 };
}

/** The words the person types to empty the account. */
export const EMPTY_WORDS = 'empty my account';

/**
 * Empties the account (see the header): everything but the machinery,
 * a finished restore's record too. Refused while a restore is unfinished
 * (undo it instead, which says what it brought). Answers how many keys went.
 */
export async function emptyAccount(ctx: Ctx, opts: { userId: string | null }): Promise<{ deleted: number }> {
  const report = await userRestoreStore.getReport(ctx);
  if (report.value && unfinished(report.value)) throw new UndoRefused('A restore hasn’t finished here: undo it instead (Manage, Bring back a download).');
  await mayEmpty(ctx, opts.userId);
  const deleted = await sweepContainerExcept(ctx, keepMachinery);
  await clearCaches(ctx);
  return { deleted };
}
