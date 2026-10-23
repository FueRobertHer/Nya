// lib/api-changes.ts
//
// The record of changes made with API tokens: every write a token sends
// through the API or the MCP server, and every undo of one, with what it
// changed, so the person can see it, undo it, or forget it (Manage, API
// tokens, components/ApiChanges.tsx), and a token that can write can read its
// own (/api/v1/changes, list_changes). Two stores on the storage seam
// (lib/repo.ts), inside the container:
//
//   api-changes      a map store, one entry per change. Its id is
//                    `<YYYYMMDD>.<token ref, or app>.<12 hex>`: the UTC day it
//                    was made, which token made it (the app, for an undo the
//                    person made there), and a random part. So the ids alone
//                    say which to read for a day or a token, and which are
//                    past the window (MapStore.ids), without a value read.
//                    A token is named by its REF (tokenRef): 16 hex of a
//                    SHA-256 of its id, never the id or its hint, which are
//                    part of the token and never in the download
//                    (lib/user-export.ts); a token tells its own changes by
//                    its ref, worked out from its id when it calls.
//                    Encrypted; in the person's download (it is their own
//                    record about their data) and in backups (it describes the
//                    data a backup holds); never brought back with a download
//                    (lib/user-restore/parts.ts: its tokens aren't there).
//   api-change-keys  a map store keyed by token id: the Idempotency-Keys that
//                    token's creates were sent with in the last
//                    IDEMPOTENCY_HOURS, each as a SHA-256 beside the SHA-256
//                    of its request, the change it is for, and `made` once
//                    what it made is there (so a key sent again after the
//                    person deleted it never makes it again). Small (a few
//                    hundred claims at most), changed with a compare-and-set
//                    per token. Bookkeeping: never exported, never backed up.
//
// A CHANGE is written `pending` before what it changes is written, then
// settled `done` (with what it changed, before and after) or `failed`, so one
// that stopped part way is shown as "may not have been made", never left out.
// One the app's own rules refused before writing anything (a name another
// category has, a version that no longer matches) is taken back out, and its
// key with it: nothing was changed. Settling is best effort: the write's
// answer is sent whatever it does, and a create's key, sent again, finds the
// target and settles it.
//
// KEPT CHANGES_KEEP_DAYS (30): reads leave out anything older, and the
// nightly snapshot prunes it (lib/snapshot-job.ts pruneChanges), as the app's
// list does whenever it is read. Forgetting a change (forgetChange,
// forgetTokenChanges) drops its copies of what it changed at once; its line
// stays, with what it was and when, and it can no longer be undone.
//
// THE STORED STATES are the records as their own stores hold them (a row and
// what is said about it, an account, a category, a group, a tag, a balance):
// as open as those stores are, since they keep fields a later release adds.
// The change around them is closed and versioned: an entry a later release
// writes reads as unrecognised here, never as something it isn't.
//
// READS. Every read that decides something (a key's claim, an undo) is
// strict: a change that can't be read refuses the write, rather than risk a
// second create. The app's list names a change it can't read.

import { createHash, randomBytes } from 'node:crypto';
import { defineMapStore, UnreadableEntriesError } from './repo';
import type { Ctx } from './containers';
import { CHANGES_KEEP_DAYS, IDEMPOTENCY_HOURS } from './api-limits';
import { ApiFailure } from './api-spec';

export type ChangeOp =
  | 'manual-account.create'
  | 'manual-account.update'
  | 'manual-account.balance'
  | 'transaction.create'
  | 'transaction.update'
  | 'transaction.delete'
  | 'category.create'
  | 'category.update'
  | 'group.create'
  | 'group.update'
  | 'tag.create'
  | 'tag.update'
  | 'undo';

export const CHANGE_OPS: readonly ChangeOp[] = [
  'manual-account.create',
  'manual-account.update',
  'manual-account.balance',
  'transaction.create',
  'transaction.update',
  'transaction.delete',
  'category.create',
  'category.update',
  'group.create',
  'group.update',
  'tag.create',
  'tag.update',
  'undo',
];

export type TargetKind = 'manual-account' | 'transaction' | 'category' | 'group' | 'tag' | 'change';
const TARGET_KINDS: readonly TargetKind[] = ['manual-account', 'transaction', 'category', 'group', 'tag', 'change'];

/** A transaction's stored state: its row and what is said beside it. */
export type TxnState = { row: Record<string, unknown>; said: Record<string, unknown> | null };

export type Change = {
  v: 1;
  at: string;
  via: 'api' | 'mcp' | 'app';
  /** The token that made it (its ref, to tell tokens apart: see the
   *  header; its name as it was), or null for the app. */
  token: { ref: string; label: string } | null;
  op: ChangeOp;
  target: { kind: TargetKind; id: string; account_id?: string };
  state: 'pending' | 'done' | 'failed';
  /** What it changed, as stored before and after (null: there was none, or
   *  there is none since); absent while pending, or once forgotten. */
  before?: unknown;
  after?: unknown;
  /** The change an undo undid; the undo that undid this one. */
  undoes?: string;
  undone_by?: string;
  /** Why it failed, as an error code. */
  error?: string;
  /** When the person forgot its copies of what it changed. */
  forgotten_at?: string;
  /** An undo of it under way (its id), until it is done: one cut off part
   *  way is taken up again by the next undo asked (lib/api-undo.ts). */
  undoing?: string;
  /** For an undo of an account made, the step it had reached (lib/api-undo.ts
   *  undoAccountMade), while it is under way. */
  progress?: 'deleting' | 'folding' | 'forgetting';
};

const KEYS = new Set(['v', 'at', 'via', 'token', 'op', 'target', 'state', 'before', 'after', 'undoes', 'undone_by', 'error', 'forgotten_at', 'undoing', 'progress']);
const ID = /^(\d{8})\.([0-9a-f]{16}|app)\.([0-9a-f]{12})$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInstant = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && !Number.isNaN(Date.parse(v));
const isText = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
/** A stored state: a record, a number (a balance's state is a record too),
 *  or null; whatever its store keeps (see the header). */
const isState = (v: unknown) => v === undefined || v === null || isRecord(v);

/** A change's id: when, who, and a random part. */
export const isChangeId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

export function isChange(v: unknown): v is Change {
  if (!isRecord(v) || !Object.keys(v).every((k) => KEYS.has(k)) || v.v !== 1) return false;
  const t = v.token;
  const target = v.target;
  return (
    isInstant(v.at) &&
    (v.via === 'api' || v.via === 'mcp' || v.via === 'app') &&
    (t === null || (isRecord(t) && Object.keys(t).every((k) => k === 'ref' || k === 'label') && /^[0-9a-f]{16}$/.test(String(t.ref)) && isText(t.label, 200))) &&
    (CHANGE_OPS as readonly unknown[]).includes(v.op) &&
    isRecord(target) &&
    Object.keys(target).every((k) => k === 'kind' || k === 'id' || k === 'account_id') &&
    (TARGET_KINDS as readonly unknown[]).includes(target.kind) &&
    isText(target.id, 200) &&
    (target.account_id === undefined || isText(target.account_id, 200)) &&
    (v.state === 'pending' || v.state === 'done' || v.state === 'failed') &&
    isState(v.before) &&
    isState(v.after) &&
    (v.undoes === undefined || isChangeId(v.undoes)) &&
    (v.undone_by === undefined || isChangeId(v.undone_by)) &&
    (v.undoing === undefined || isChangeId(v.undoing)) &&
    (v.progress === undefined || v.progress === 'deleting' || v.progress === 'folding' || v.progress === 'forgetting') &&
    (v.error === undefined || isText(v.error, 60)) &&
    (v.forgotten_at === undefined || isInstant(v.forgotten_at))
  );
}

export const changeStore = defineMapStore<Change>('api-changes', {
  what: 'changes made with API tokens',
  isValid: isChange,
  exportable: true, // the person's own record about their data
});

/** One token's key claims (see the header). */
export type Claim = { key: string; request: string; change: string; at: string; made?: true };
export type Claims = { v: 1; claims: Claim[] };

const HEX64 = /^[0-9a-f]{64}$/;
export function isClaims(v: unknown): v is Claims {
  if (!isRecord(v) || v.v !== 1 || !Array.isArray(v.claims) || v.claims.length > 5000) return false;
  return v.claims.every(
    (c) =>
      isRecord(c) &&
      Object.keys(c).every((k) => k === 'key' || k === 'request' || k === 'change' || k === 'at' || k === 'made') &&
      HEX64.test(String(c.key)) &&
      HEX64.test(String(c.request)) &&
      isChangeId(c.change) &&
      isInstant(c.at) &&
      (c.made === undefined || c.made === true)
  );
}

export const claimStore = defineMapStore<Claims>('api-change-keys', {
  what: 'keys of changes made with API tokens',
  isValid: isClaims,
  exportable: false, // bookkeeping: digests of keys
  backup: false, // names changes of tokens a restore ends
});

const DAY_MS = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');

/** The oldest day (YYYYMMDD) the record keeps at `now`. */
export const firstKeptDay = (now: number) => dayOf(now - (CHANGES_KEEP_DAYS - 1) * DAY_MS);

/** How the record names a token (see the header): never its id. */
export const tokenRef = (tokenId: string): string => createHash('sha256').update(`nya-api-change-token:${tokenId}`, 'utf8').digest('hex').slice(0, 16);

/** A new change's id, made `now` by the token with this ref (null: the app). */
export function newChangeId(now: number, ref: string | null): string {
  return `${dayOf(now)}.${ref ?? 'app'}.${randomBytes(6).toString('hex')}`;
}

/** Which token made a change, by its ref from the change's id: null for the
 *  app. */
export function changeMaker(id: string): string | null {
  const m = ID.exec(id);
  return m && m[2] !== 'app' ? m[2] : null;
}

/** Whether a change is inside the window the record keeps. */
export const kept = (id: string, now: number) => {
  const m = ID.exec(id);
  return !!m && m[1] >= firstKeptDay(now);
};

/** One change, strictly, or null: none, or past the window. */
export async function getChange(ctx: Ctx, id: string, now: number = Date.now()): Promise<Change | null> {
  if (!isChangeId(id) || !kept(id, now)) return null;
  return changeStore.get(ctx, id);
}

/** Writes a change as it begins. */
export async function beginChange(ctx: Ctx, id: string, change: Change): Promise<void> {
  await changeStore.set(ctx, id, change);
}

/** Settles a change: done or failed, with what it changed. Best effort (see
 *  the header): a failure here is logged, and the answer stands. */
export async function settleChange(ctx: Ctx, id: string, patch: Partial<Change>): Promise<void> {
  try {
    await changeStore.update(ctx, id, (cur) => (cur ? { ...cur, ...patch } : null));
  } catch (err) {
    console.error('API changes: a change could not be settled', err instanceof Error ? err.name : typeof err);
  }
}

/** Takes back a change that changed nothing (see the header), and its key. */
export async function dropChange(ctx: Ctx, id: string, tokenId: string | null): Promise<void> {
  try {
    await changeStore.remove(ctx, id);
    if (tokenId) await claimStore.update(ctx, tokenId, (cur) => (cur ? { ...cur, claims: cur.claims.filter((c) => c.change !== id) } : null));
  } catch (err) {
    console.error('API changes: a refused change could not be taken back', err instanceof Error ? err.name : typeof err);
  }
}

/** The SHA-256 of a text, hex: a key's or a request's, as the claims keep
 *  them inside their encrypted value. */
export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** What claiming a key came to: a new claim (the change id to write), or the
 *  claim found for it. */
export type ClaimOutcome = { kind: 'new'; change: string } | { kind: 'found'; claim: Claim };

/**
 * Claims an Idempotency-Key for a token's create, in one compare-and-set on
 * the token's claims: claims past IDEMPOTENCY_HOURS go, and the key is found
 * among the rest, or added with the id of the change it is to make.
 */
export async function claimKey(ctx: Ctx, tokenId: string, key: string, request: string, now: number = Date.now()): Promise<ClaimOutcome> {
  const keyHash = sha256(key);
  const since = now - IDEMPOTENCY_HOURS * 3_600_000;
  let outcome: ClaimOutcome | null = null;
  await claimStore.update(ctx, tokenId, (cur) => {
    outcome = null; // this may run more than once
    const live = (cur?.claims ?? []).filter((c) => Date.parse(c.at) >= since);
    const found = live.find((c) => c.key === keyHash);
    if (found) {
      outcome = { kind: 'found', claim: found };
      return live.length === (cur?.claims.length ?? 0) ? cur : { v: 1, claims: live };
    }
    const change = newChangeId(now, tokenRef(tokenId));
    outcome = { kind: 'new', change };
    return { v: 1, claims: [...live, { key: keyHash, request, change, at: new Date(now).toISOString() }] };
  });
  return outcome!;
}

/**
 * Points a claim at another change (a takeover's), only while it still names
 * `from`, in one compare-and-set: of two takeovers at once, one wins, and the
 * other is told so (false), never making the thing a second time.
 */
export async function reclaim(ctx: Ctx, tokenId: string, keyHash: string, from: string, change: string, now: number = Date.now()): Promise<boolean> {
  let won = false;
  await claimStore.update(ctx, tokenId, (cur) => {
    won = false; // this may run more than once
    const claim = cur?.claims.find((c) => c.key === keyHash);
    if (!cur || !claim || claim.change !== from) return cur;
    won = true;
    return { ...cur, claims: cur.claims.map((c) => (c.key === keyHash ? { key: c.key, request: c.request, change, at: new Date(now).toISOString() } : c)) };
  });
  return won;
}

/** Notes on a key's claim that what its change made is there. Best effort,
 *  as settling is: logged, and the answer stands. */
export async function markMade(ctx: Ctx, tokenId: string, keyHash: string, change: string): Promise<void> {
  try {
    await claimStore.update(ctx, tokenId, (cur) =>
      cur?.claims.some((c) => c.key === keyHash && c.change === change)
        ? { ...cur, claims: cur.claims.map((c) => (c.key === keyHash && c.change === change ? { ...c, made: true as const } : c)) }
        : cur
    );
  } catch (err) {
    console.error('API changes: a key could not be marked made', err instanceof Error ? err.name : typeof err);
  }
}

/** A token's claims go with it (lib/api-tokens.ts revokeToken). */
export async function forgetClaims(ctx: Ctx, tokenId: string): Promise<void> {
  await claimStore.remove(ctx, tokenId);
}

/** Every change id in the window, newest day first; one token's alone
 *  (`maker`: a token's ref, or 'app'), when asked. */
export async function changeIds(ctx: Ctx, opts: { maker?: string; now?: number } = {}): Promise<string[]> {
  const now = opts.now ?? Date.now();
  return (await changeStore.ids(ctx))
    .filter((id) => kept(id, now) && (opts.maker === undefined || ID.exec(id)?.[2] === opts.maker))
    .sort((a, b) => (a.slice(0, 8) < b.slice(0, 8) ? 1 : a.slice(0, 8) > b.slice(0, 8) ? -1 : a < b ? -1 : 1));
}

/** A page of changes, newest first: (`at`, id) of the last one shown, for the
 *  next page. */
export type ChangePage = { changes: [string, Change][]; next: { at: string; id: string } | null; unreadable: string[]; unrecognised: string[] };

/**
 * A page of changes, newest first, read a day at a time: one token's
 * (`maker`), or every one (the app's list). Strict for a token's own page
 * (an entry that can't be read is refused); `report` names those instead
 * (the app's list, which offers to remove a damaged one).
 */
export async function listChanges(
  ctx: Ctx,
  opts: { maker?: string; limit: number; after?: { at: string; id: string } | null; now?: number; report?: boolean }
): Promise<ChangePage> {
  const ids = await changeIds(ctx, { maker: opts.maker, now: opts.now });
  const byDay = new Map<string, string[]>();
  for (const id of ids) byDay.set(id.slice(0, 8), [...(byDay.get(id.slice(0, 8)) ?? []), id]);
  const out: [string, Change][] = [];
  const unreadable: string[] = [];
  const unrecognised: string[] = [];
  const after = opts.after ?? null;
  const beyond = (at: string, id: string) => !after || at < after.at || (at === after.at && id > after.id);
  let more = false;
  for (const [day, dayIds] of byDay) {
    if (after && day > after.at.slice(0, 10).replaceAll('-', '')) continue;
    let read: Map<string, Change>;
    try {
      read = await changeStore.getMany(ctx, dayIds);
    } catch (err) {
      if (!opts.report || !(err instanceof UnreadableEntriesError)) throw err;
      unreadable.push(...err.unreadable);
      unrecognised.push(...err.unrecognised);
      const bad = new Set([...err.unreadable, ...err.unrecognised]);
      read = await changeStore.getMany(ctx, dayIds.filter((id) => !bad.has(id)));
    }
    const sorted = [...read].filter(([id, c]) => beyond(c.at, id)).sort(([ia, a], [ib, b]) => (a.at < b.at ? 1 : a.at > b.at ? -1 : ia < ib ? -1 : 1));
    for (const entry of sorted) {
      if (out.length === opts.limit) {
        more = true;
        break;
      }
      out.push(entry);
    }
    if (more) break;
  }
  const last = out[out.length - 1];
  return { changes: out, next: more && last ? { at: last[1].at, id: last[0] } : null, unreadable, unrecognised };
}

const UNDO_UNDER_WAY = 'An undo of this change is under way, or stopped part way, and needs what the change kept to finish: undo the change again, then forget it.';
const UNDO_UNDER_WAY_TOKEN = 'An undo of one of this token’s changes is under way, or stopped part way, and needs what that change kept to finish: undo it again, then forget them.';

/** Whether an undo of this change, or this undo, is under way or stopped
 *  part way (Change.undoing): what the change kept is what it finishes with. */
async function undoUnderWay(ctx: Ctx, id: string, c: Change, now: number): Promise<boolean> {
  if (c.undoing) return true;
  if (c.op !== 'undo' || !c.undoes || !kept(c.undoes, now)) return false;
  return (await changeStore.get(ctx, c.undoes))?.undoing === id;
}

/** Forgets one entry's copies, alone; never one an undo under way needs. */
async function forgetOne(ctx: Ctx, id: string, now: number): Promise<Change | null> {
  return changeStore.update(ctx, id, (cur) => {
    if (!cur) return null;
    if (cur.undoing) throw new ApiFailure(409, 'conflict', UNDO_UNDER_WAY);
    if (cur.forgotten_at) return cur;
    const next: Change = { ...cur, forgotten_at: new Date(now).toISOString() };
    delete next.before;
    delete next.after;
    return next;
  });
}

/** Forgets one change's copies of what it changed (see the header), and the
 *  copies kept by its undo, or by the change it undid: an undo keeps what it
 *  took back (all of a created row, say), so forgetting either forgets both.
 *  False when there is no such change; refused (409) while an undo of it is
 *  under way or stopped part way, which needs those copies to finish. */
export async function forgetChange(ctx: Ctx, id: string, now: number = Date.now()): Promise<boolean> {
  if (!isChangeId(id)) return false;
  const c = await changeStore.get(ctx, id);
  if (!c) return false;
  if (await undoUnderWay(ctx, id, c, now)) throw new ApiFailure(409, 'conflict', UNDO_UNDER_WAY);
  const written = await forgetOne(ctx, id, now);
  if (!written) return false;
  for (const linked of [written.undone_by, written.undoes, written.undoing]) {
    if (linked && kept(linked, now)) await forgetOne(ctx, linked, now);
  }
  return true;
}

/** Forgets every change one token made (`maker`: its ref), and the copies
 *  their undos keep, whoever made those. Answers how many of the token's. */
export async function forgetTokenChanges(ctx: Ctx, maker: string, now: number = Date.now()): Promise<number> {
  const ids = await changeIds(ctx, { maker, now });
  // Refused before any is forgotten while an undo of one is under way.
  for (const [id, c] of await changeStore.getMany(ctx, ids)) {
    if (await undoUnderWay(ctx, id, c, now)) throw new ApiFailure(409, 'conflict', UNDO_UNDER_WAY_TOKEN);
  }
  let n = 0;
  for (const id of ids) if (await forgetChange(ctx, id, now)) n++;
  return n;
}

/**
 * Drops what is past the window: changes older than CHANGES_KEEP_DAYS, by
 * their ids, and claims past IDEMPOTENCY_HOURS (a token's whole entry once
 * none is left, compared and set, so a claim made meanwhile stays). Never
 * throws: the nightly snapshot calls it for every container, and a failure is
 * only logged, to be tried again the next night.
 */
export async function pruneChanges(ctx: Ctx, now: number = Date.now()): Promise<void> {
  try {
    const old = (await changeStore.ids(ctx)).filter((id) => !kept(id, now));
    for (let i = 0; i < old.length; i += 500) await changeStore.remove(ctx, ...old.slice(i, i + 500));
    const since = now - IDEMPOTENCY_HOURS * 3_600_000;
    for (const tokenId of await claimStore.ids(ctx)) {
      await claimStore
        .update(ctx, tokenId, (cur) => {
          if (!cur) return null;
          const live = cur.claims.filter((c) => Date.parse(c.at) >= since);
          return live.length === 0 ? null : live.length === cur.claims.length ? cur : { v: 1, claims: live };
        })
        .catch(() => {}); // one that can't be read stays, for the person's own removal
    }
  } catch (err) {
    console.error('API changes: old changes could not be pruned', err instanceof Error ? err.name : typeof err);
  }
}
