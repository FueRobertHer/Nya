// lib/attachment-sweep.ts
//
// The nightly clean-up of receipts and documents (#47, lib/attachments.ts),
// run by its own cron (app/api/attachments/sweep) after the backup. Object
// storage has no foreign keys: this is what keeps the file store and the
// records saying the same, without ever deleting a file anyone may still
// need. Its outcome and where it got to are kept environment-wide
// (lib/backup.ts readAttachmentSweep), and the dashboard says when it failed,
// held back, or hasn't run (attachmentSweepProblem).
//
// PER ACCOUNT, active ones only, from where the last run stopped (the
// cursor), inside a time budget, so a run that can't reach every account
// carries on the next night rather than starting over and never reaching the
// same ones:
//   - an upload a day past its expiry: its objects, then its record;
//   - a file being deleted: its objects, then its record (a delete whose
//     store was out of reach);
//   - what is reserved (attachment-usage), worked out again from the records;
//   - the index, repaired from the records (an entry naming a record that
//     can't be read is left alone);
//   - where files are placed, checked against the stored transactions, but
//     only for an account a failed placement step marked, and every account
//     at least once a week otherwise (that check reads every bank's stored
//     transactions): a file on a pending id follows the posted row naming it,
//     one on a bank's row no Item holds waits on its earlier account by
//     content (or is not on a transaction), one on a manual or imported row
//     that is gone is not on a transaction; and a file a re-link placed is
//     marked "check" when two rows now have its content. Nothing is done when
//     a store of transactions can't be read.
//
// ACROSS THE STORE, weekly: one folded listing of the environment's folder,
// a folder per account, and NEVER WHILE A RECORD COULD COME BACK (B1):
//   - not while any account is being restored, nor while the backups are
//     failing or their setting is invalid;
//   - only in an active account's folder: an object no record names (by the
//     field names, so a record that can't be read still names its file) is
//     deleted only once it has been seen unnamed for BACKUP_KEEP_DAYS + 1
//     days (2 with no backups), counted from when it was first seen, the
//     longest a kept backup could bring back a record naming it; seen named
//     again, it is forgotten;
//   - a BREAKER: an account with objects and no record at all, or where more
//     than 20 percent of its files or more than 50 would go in one pass, has
//     nothing deleted; that is logged, recorded, and said on the dashboard;
//   - a deleted account's folder (its map entry says its key was destroyed,
//     or a tombstone names it, and the registry doesn't list it): every
//     object goes, unreadable already;
//   - a folder of an account neither in the registry nor deleted: logged,
//     never touched.

import type { Ctx, ContainerId } from './containers';
import { isContainerId, listContainers } from './containers';
import { readContainerEntries, readTombstones, ContainerKeyError } from './crypto';
import { backupProblem, backupRetention, readAttachmentSweep, recordAttachmentSweep, type AttachmentSweepStatus } from './backup';
import { attachmentStore, placeStore, sweepStateStore, usageStore, type Attachment, type Place, type SweepState } from './attachment-stores';
import { attachmentObjects, containerFolder, environmentFolder, parseObjectPath, withLimit, type AttachmentObjects } from './attachment-objects';
import { discardUpload, finishDelete, fieldOf, usageFromRecords } from './attachments';
import { findTransactions, LookupUnreadableError } from './txn-lookup';
import { contentKey, readStoredTxns, StateUnreadableError, type StoredTxn } from './transactions';
import { getItems } from './storage';
import { directoryIds } from './links';
import { MANUAL_TXN_PREFIX } from './manual-txn-input';
import { IMPORTED_TXN_PREFIX } from './history-import/view';
import { loggable } from './log-safe';

/** How long one run may take: under the route's maxDuration (300 s), with
 *  room to record the outcome. */
export const SWEEP_BUDGET_MS = 240_000;
export const CHECK_EVERY_MS = 7 * 86_400_000;
export const LIST_EVERY_MS = 7 * 86_400_000;
/** An upload is thrown away this long past its expiry. */
export const UPLOAD_GRACE_MS = 86_400_000;
/** The breaker: in one pass, at most this share of an account's files... */
export const BREAKER_SHARE = 0.2;
/** ...and at most this many. */
export const BREAKER_FILES = 50;

export type SweepResult = {
  containers: number;
  finished: boolean;
  uploads_discarded: number;
  deletes_finished: number;
  placements_moved: number;
  listed: boolean;
  orphans_deleted: number;
  deleted_folders: number;
  held: number;
  errors: number;
};

const emptyState = (): SweepState => ({ version: 1, unnamed: {} });

/** The days a kept backup could bring back a record: an object unnamed this
 *  long can go. Null when the setting is invalid (nothing goes then). */
function waitDays(): number | null {
  const b = backupRetention();
  if (b === null) return null;
  return b.kept ? b.keep_days + 1 : 2;
}

// ---- Per account ----

/** The index the records say there should be: field to ids. */
function expectedIndex(entries: ReadonlyMap<string, Attachment>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [id, a] of entries) {
    if (a.status === 'deleting') continue;
    const field = fieldOf(a.place);
    if (!field) continue;
    out.set(field, (out.get(field) ?? new Set()).add(id));
  }
  return out;
}

/** Puts the index right from the records. Answers how many entries changed. */
async function repairIndex(ctx: Ctx, entries: ReadonlyMap<string, Attachment>, unknown: ReadonlySet<string>): Promise<number> {
  const want = expectedIndex(entries);
  const have = await placeStore.getAllReport(ctx);
  let changed = 0;
  const fields = new Set([...want.keys(), ...have.entries.keys()]);
  for (const field of fields) {
    const should = want.get(field) ?? new Set<string>();
    const is = new Set(have.entries.get(field)?.ids ?? []);
    // Kept: what the records say, and any id whose record can't be read.
    const next = [...new Set([...[...is].filter((id) => should.has(id) || unknown.has(id)), ...should])].sort();
    if (next.length === is.size && next.every((id) => is.has(id))) continue;
    await placeStore.update(ctx, field, () => (next.length > 0 ? { ids: next } : null));
    changed++;
  }
  return changed;
}

/** Where a file is now, given every bank's stored rows, or null to leave it. */
function checkedPlace(a: Attachment, rows: readonly StoredTxn[] | null, directory: ReadonlySet<string> | null, found: ReadonlySet<string>, now: number): Place | null {
  const p = a.place;
  if (p.on !== 'transaction') return null;
  if (found.has(p.transaction_id)) {
    // A file a re-link placed: two rows with its content now mean the person
    // should check which one it is on.
    if (p.carried && !p.check && p.content && rows) {
      const alike = rows.filter((t) => !t.pending && contentKey(t.account_id, t) === p.content).length;
      if (alike >= 2) return { ...p, check: true };
    }
    return null;
  }
  const since = new Date(now).toISOString();
  const was = { transaction_id: p.transaction_id, account_id: p.account_id, content: p.content };
  const keepsId = p.transaction_id.startsWith(MANUAL_TXN_PREFIX) || p.transaction_id.startsWith(IMPORTED_TXN_PREFIX);
  if (keepsId) return { on: 'none', why: 'gone', since, was };
  if (rows === null) return null;
  // A pending row that posted while the sync's move failed.
  const posted = rows.find((t) => !t.pending && t.pending_transaction_id === p.transaction_id);
  if (posted) return { on: 'transaction', transaction_id: posted.transaction_id, account_id: posted.account_id, content: contentKey(posted.account_id, posted) };
  // A bank row no Item holds: its account disconnected (wait for a link), or
  // the bank removed it.
  const live = new Set(rows.map((t) => t.account_id));
  if (p.content && p.account_id && !live.has(p.account_id) && directory?.has(p.account_id)) {
    return { on: 'earlier', account_id: p.account_id, content: p.content, alike: 1, pending: false };
  }
  return { on: 'none', why: 'removed', since, was };
}

/** Every bank's stored rows, or null when one can't be read. */
async function allBankRows(ctx: Ctx): Promise<StoredTxn[] | null> {
  const out: StoredTxn[] = [];
  for (const item of await getItems(ctx)) {
    try {
      out.push(...(await readStoredTxns(ctx, item.item_id)));
    } catch (err) {
      if (err instanceof StateUnreadableError) return null;
      throw err;
    }
  }
  return out;
}

/** The placement check (see the header). Answers how many files moved, or
 *  null when what it rests on couldn't be read (the marker stays). */
async function checkPlacements(ctx: Ctx, entries: ReadonlyMap<string, Attachment>, now: number): Promise<number | null> {
  const placed = [...entries].filter(([, a]) => a.status !== 'deleting' && a.place.on === 'transaction');
  if (placed.length === 0) return 0;
  const ids = [...new Set(placed.map(([, a]) => (a.place as { transaction_id: string }).transaction_id))];
  let found: Set<string>;
  try {
    found = new Set((await findTransactions(ctx, ids)).keys());
  } catch (err) {
    if (err instanceof LookupUnreadableError) return null;
    throw err;
  }
  const rows = await allBankRows(ctx);
  const directory = await directoryIds(ctx).catch(() => null);
  let moved = 0;
  for (const [id, a] of placed) {
    const next = checkedPlace(a, rows, directory, found, now);
    if (!next) continue;
    let from: string | null = null;
    const after = await attachmentStore.update(ctx, id, (cur) => {
      if (!cur || cur.status === 'deleting' || JSON.stringify(cur.place) !== JSON.stringify(a.place)) return cur;
      from = fieldOf(cur.place);
      return { ...cur, place: next };
    });
    if (!after || JSON.stringify(after.place) !== JSON.stringify(next)) continue;
    const to = fieldOf(next);
    if (to !== from) {
      if (to) await placeStore.update(ctx, to, (cur) => (cur?.ids.includes(id) ? cur : { ids: [...(cur?.ids ?? []), id] }));
      if (from) await placeStore.update(ctx, from, (cur) => (cur && cur.ids.includes(id) ? (cur.ids.length > 1 ? { ids: cur.ids.filter((x) => x !== id) } : null) : cur));
    }
    moved++;
  }
  return moved;
}

/** One account's part of a run. */
async function sweepContainer(ctx: Ctx, now: number, result: SweepResult): Promise<void> {
  const [count, stateReport] = await Promise.all([attachmentStore.count(ctx), sweepStateStore.getReport(ctx)]);
  const usage = await usageStore.getReport(ctx);
  if (count === 0 && !usage.value && !usage.unreadable && !stateReport.value) return;
  const report = await attachmentStore.getAllReport(ctx);
  const unknown = new Set([...report.unreadable, ...report.unrecognised]);

  for (const [id, a] of report.entries) {
    if (a.status === 'uploading' && a.upload && Date.parse(a.upload.expires_at) + UPLOAD_GRACE_MS < now) {
      if (await discardUpload(ctx, id, now, { cancelled: true })) result.uploads_discarded++;
    } else if (a.status === 'deleting') {
      await finishDelete(ctx, id, a);
      result.deletes_finished++;
    }
  }

  const fresh = await attachmentStore.getAllReport(ctx);
  const state = stateReport.value ?? emptyState();
  const due = state.check !== undefined || !state.checked_at || Date.parse(state.checked_at) + CHECK_EVERY_MS < now;
  if (due) {
    const moved = await checkPlacements(ctx, fresh.entries, now);
    if (moved !== null) {
      result.placements_moved += moved;
      await sweepStateStore.update(ctx, (cur) => {
        const next: SweepState = { ...(cur ?? emptyState()), checked_at: new Date(now).toISOString() };
        delete next.check;
        return next;
      });
    }
  }
  const settled = await attachmentStore.getAllReport(ctx);
  await repairIndex(ctx, settled.entries, unknown);

  // What is reserved, worked out again from the records, keeping when the
  // files were last downloaded. A value whose bytes are damaged is replaced:
  // it is bookkeeping derived from the records, which say what it is, and
  // never the person's (one that is unrecognised is left for the release
  // that wrote it).
  const counted = await usageFromRecords(ctx, usage.value);
  if (usage.unreadable) {
    await usageStore.remove(ctx);
    await usageStore.set(ctx, counted);
  } else if (!usage.unrecognised) {
    await usageStore.update(ctx, (cur) => {
      const next = { ...counted, ...(cur?.zip_at ? { zip_at: cur.zip_at } : {}) };
      return cur && JSON.stringify(cur) === JSON.stringify(next) ? cur : next;
    });
  }
}

// ---- Across the store ----

/** One active account's folder: objects no record names, deleted once
 *  unnamed for the backups' window (see the header). */
async function orphansIn(ctx: Ctx, store: AttachmentObjects, wait: number, now: number, result: SweepResult): Promise<void> {
  const objects = await withLimit('a listing', 30_000, (signal) => store.list(containerFolder(ctx), signal));
  if (objects.length === 0) return;
  const named = new Set(await attachmentStore.ids(ctx));
  const byId = new Map<string, string[]>();
  for (const o of objects) {
    const p = parseObjectPath(ctx, o.pathname);
    if (!p) continue;
    byId.set(p.id, [...(byId.get(p.id) ?? []), o.pathname]);
  }
  const unnamed = [...byId.keys()].filter((id) => !named.has(id));
  const at = new Date(now).toISOString();
  const state = (await sweepStateStore.get(ctx)) ?? emptyState();
  const seen: Record<string, string> = {};
  for (const id of unnamed) seen[id] = state.unnamed[id] ?? at;
  const due = unnamed.filter((id) => Date.parse(seen[id]) + wait * 86_400_000 <= now);
  const held = (named.size === 0 && byId.size > 0 && due.length > 0) || due.length > BREAKER_FILES || due.length > Math.max(1, Math.floor(byId.size * BREAKER_SHARE));
  if (held) {
    result.held++;
    console.error(`Receipts sweep: the breaker held account ${ctx.container} (${due.length} of ${byId.size} files unnamed for ${wait} days); nothing deleted there`);
  } else if (due.length > 0) {
    const paths = due.flatMap((id) => byId.get(id)!);
    await withLimit('a delete', 30_000, (signal) => store.del(paths, signal));
    for (const id of due) delete seen[id];
    result.orphans_deleted += due.length;
  }
  await sweepStateStore.update(ctx, (cur) => ({ ...(cur ?? emptyState()), unnamed: seen }));
}

/** A deleted account's whole folder. */
async function deletedFolder(store: AttachmentObjects, folder: string): Promise<void> {
  const objects = await withLimit('a listing', 30_000, (signal) => store.list(folder, signal));
  for (let i = 0; i < objects.length; i += 100) {
    const page = objects.slice(i, i + 100).map((o) => o.pathname);
    await withLimit('a delete', 30_000, (signal) => store.del(page, signal));
  }
}

/** The store-wide pass, when it is safe (see the header). Answers false when
 *  it was held back. */
async function storeWide(store: AttachmentObjects, registry: { id: ContainerId; status: string }[], now: number, result: SweepResult): Promise<boolean> {
  const wait = waitDays();
  if (wait === null) return false;
  if (registry.some((c) => c.status === 'restoring')) return false;
  if (backupRetention()?.kept && (await backupProblem(new Date(now))) !== null) return false;
  const status = new Map(registry.map((c) => [c.id as string, c.status]));
  const entries = await readContainerEntries();
  const tombstoned = new Set([...(await readTombstones()).values()].map((t) => t.container));
  const root = environmentFolder();
  for (const folder of await withLimit('a listing', 30_000, (signal) => store.folders(root, signal))) {
    const id = folder.slice(root.length).replace(/\/$/, '');
    if (!isContainerId(id)) continue;
    const s = status.get(id);
    try {
      if (s === 'active') await orphansIn({ container: id }, store, wait, now, result);
      else if (s === undefined) {
        const entry = entries.get(id);
        const destroyed = (entry && !(entry instanceof ContainerKeyError) && 'destroyed' in entry) || tombstoned.has(id);
        if (destroyed) {
          await deletedFolder(store, folder);
          result.deleted_folders++;
        } else console.error(`Receipts sweep: a folder of account ${id}, neither listed nor deleted, was left alone`);
      }
    } catch (err) {
      result.errors++;
      console.error(`Receipts sweep: account ${id}'s folder was left for the next pass`, loggable(err));
    }
  }
  return true;
}

/**
 * One run (see the header): the accounts from where the last run stopped,
 * then, weekly and when it is safe, the store-wide pass. Records its outcome.
 * Throws only for what stops the whole run (no registry, the store's
 * listing), after recording that.
 */
export async function runAttachmentSweep(now: Date = new Date(), opts: { budgetMs?: number } = {}): Promise<SweepResult> {
  const result: SweepResult = { containers: 0, finished: false, uploads_discarded: 0, deletes_finished: 0, placements_moved: 0, listed: false, orphans_deleted: 0, deleted_folders: 0, held: 0, errors: 0 };
  const store = attachmentObjects();
  if (!store) return { ...result, finished: true };
  const started = Date.now();
  const budget = opts.budgetMs ?? SWEEP_BUDGET_MS;
  const before: AttachmentSweepStatus = (await readAttachmentSweep().catch(() => null)) ?? { last_ok: null, last_failed: null, reason: null, cursor: null, listed_at: null };
  let cursor = before.cursor;
  try {
    const registry = await listContainers();
    const active = registry.filter((c) => c.status === 'active').map((c) => c.id as string).sort();
    const start = cursor ? active.findIndex((id) => id > cursor!) : 0;
    const order = start < 0 ? active : [...active.slice(start), ...active.slice(0, start)];
    let finished = true;
    for (const id of order) {
      if (Date.now() - started > budget) {
        finished = false;
        break;
      }
      try {
        await sweepContainer({ container: id as ContainerId }, now.getTime(), result);
      } catch (err) {
        result.errors++;
        console.error(`Receipts sweep: account ${id} was left for the next run`, loggable(err));
      }
      result.containers++;
      cursor = id;
    }
    result.finished = finished;
    if (finished) cursor = null;

    let listed_at = before.listed_at;
    if (finished && (!listed_at || Date.parse(listed_at) + LIST_EVERY_MS <= now.getTime()) && Date.now() - started <= budget) {
      if (await storeWide(store, registry, now.getTime(), result)) {
        result.listed = true;
        listed_at = now.toISOString();
      }
    }
    await recordAttachmentSweep({
      last_ok: now.toISOString(),
      last_failed: null,
      reason: null,
      cursor,
      listed_at,
      ...(result.held > 0 ? { held: { at: now.toISOString(), containers: result.held } } : before.held ? { held: before.held } : {}),
    });
    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await recordAttachmentSweep({ ...before, cursor, last_failed: now.toISOString(), reason });
    throw err;
  }
}
