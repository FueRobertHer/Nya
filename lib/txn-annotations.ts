// lib/txn-annotations.ts
//
// What the person says about one transaction, Plaid's or one of their own
// (lib/manual-txns.ts), kept beside it rather than in it: whether it is left
// out of budgets and reports, the tags they put on it or took off it (#40,
// lib/tags.ts), and a bank row's note. It is one record per transaction, not a
// store per flag, so a reviewed state can join it later as a field of the same
// record, and everything below (pruning, carrying, forgetting) covers every
// field at once.
//
// A map store on the storage seam (lib/repo.ts), keyed by transaction_id:
// Plaid's own id, or a manual row's "manual-txn:<uuid>", both opaque as the
// seam requires of field names (Plaid's are in plaintext in the category
// overrides already). The values are encrypted.
//
// Applied on read, in /api/transactions, like a category override: nothing in
// the transaction stores changes, so clearing the flag puts the transaction
// back in every total exactly as it was. Which totals leave an excluded
// transaction out is decided in one place, lib/spending.ts.
//
// A TAP IS ALWAYS RECORDED, both ways. Excluding stores `excluded: true`, and
// including one again stores `excluded: false` rather than deleting the
// record: rules (#36, lib/rules.ts) apply on read, below what a person sets on
// one transaction, and an explicit include has to be there to beat a rule
// that would hide it, as it beats an exclusion carried across a re-link
// (below). Tags work the same way: a tag taken off a transaction is kept under
// `untagged`, so a rule that would add it doesn't put it back; and a note
// cleared on a bank row is kept as an empty note, so a note carried across a
// re-link doesn't come back.
//
// NOTES. A bank row's note is kept here. A manual or imported row has a note
// of its own, written with it (lib/manual-txns.ts): an edit of that note
// changes the row (app/api/transaction-annotations), so a row never has two.
//
// GONE WITH ITS TRANSACTION. A bank transaction's record goes once no stored
// Item holds the transaction (pruneOrphanAnnotations, by the rules of the
// category overrides' own prune: nothing goes while a store can't be read or
// is behind, nor a record this release doesn't recognise): after a sync that
// saved the bank's removal of it (lib/transactions.ts), after a disconnect,
// and after an earlier account is forgotten. A manual row's goes with its row.
//
// CARRIED ACROSS A RE-LINK, as categories are (#46, lib/overrides.ts). A
// disconnect records what was said about the Item's posted transactions
// (an exclusion or an include, tags put on or taken off, a note) by content
// key (account, date, amount, the bank's descriptor: lib/transactions.ts
// contentKey) before their ids die with the Item, and prunes the Item's own
// records once it is gone (pruneOrphanAnnotations). Once the person links the
// old account to the re-added one (lib/links.ts), the new account's rows with
// the same key carry it again. The keys name a date, an amount and a
// merchant, so they live inside one encrypted record per earlier account (the
// `carried-annotations` store), never in a field name. A key whose identical
// rows disagreed carries nothing rather than guessing; a record on the new
// row itself wins, field by field (its tags on top of the carried ones);
// unlinking stops the carry; forgetting the earlier account forgets it.
//
// LATER FIELDS SURVIVE. A release that adds a field writes records this one
// doesn't fully know. isTxnAnnotation checks the fields it knows and lets the
// rest through, and every edit here keeps them, so after a rollback the newer
// records still read (rather than all being unrecognised, which would stop
// every exclusion from showing) and an edit here doesn't drop what a later
// release said. The release before tags and notes reads these records the
// same way: it sees the exclusion and keeps the rest.
//
// SIZE. /api/transactions reads every record (one HGETALL) on each request,
// which is cheap for what people say about transactions by hand: one-offs
// excluded, a few tagged or noted, far under MAX_ANNOTATIONS. Rules tag many
// transactions without a record each (they apply on read). A state kept on
// every transaction (reviewed, say) would read only the shown rows' records
// instead (getMany).

import { defineMapStore } from './repo';
import type { Ctx } from './containers';
import { resolveId, type Link } from './link-core';
import { MANUAL_TXN_PREFIX, MAX_NOTE_CHARS } from './manual-txn-input';
import { isTagId, MAX_TAGS_PER_TRANSACTION } from './tags';

/** What is said about one transaction. Fields a later release adds ride along. */
export type TxnAnnotation = {
  /** True: left out of budgets and reports. False: the person put it back
   *  (which beats a carried exclusion, and a rule's hide). Absent: nothing said. */
  excluded?: boolean;
  /** Tags the person put on it, by id (lib/tags.ts). */
  tags?: string[];
  /** Tags the person took off it, by id: a rule that would add one, or a tag
   *  carried across a re-link, doesn't put it back. */
  untagged?: string[];
  /** A bank row's note. Empty: the person cleared it (which beats a note
   *  carried across a re-link). A manual row's note is the row's own. */
  note?: string;
  /** When it last changed. */
  updated_at: string;
  [later: string]: unknown;
};

/** A transaction id as the seam keeps it in a field name: Plaid's, or a manual
 *  row's (lib/manual-txns.ts isManualTxnId). */
export function isTransactionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(id) && id !== '__proto__';
}

/** How many transactions can carry an annotation: far beyond what anyone
 *  excludes, tags or notes by hand, and a bound on the one read
 *  /api/transactions makes. */
export const MAX_ANNOTATIONS = 20_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A list of tag ids as stored: the bound is the stored shape's, wider than
 *  an edit may make, so a list saved under other limits still reads. */
const isTagList = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= 200 && v.every(isTagId));
/** A note as stored: text, within a bound wider than an edit may make. */
const isNote = (v: unknown) => v === undefined || (typeof v === 'string' && v.length <= 10_000);

export function isTxnAnnotation(v: unknown): v is TxnAnnotation {
  if (!isRecord(v)) return false;
  return (
    typeof v.updated_at === 'string' &&
    !Number.isNaN(Date.parse(v.updated_at)) &&
    (v.excluded === undefined || typeof v.excluded === 'boolean') &&
    isTagList(v.tags) &&
    isTagList(v.untagged) &&
    isNote(v.note)
  );
}

export const txnAnnotationStore = defineMapStore<TxnAnnotation>('transaction-annotations', {
  what: 'notes, tags and exclusions',
  isValid: isTxnAnnotation,
  exportable: true, // what the person said about their transactions
});

/** A count limit refused: nothing was saved. */
export class TooManyAnnotationsError extends Error {
  constructor() {
    super(`At most ${MAX_ANNOTATIONS.toLocaleString('en-US')} transactions can be excluded, tagged or noted by hand. Clear some first.`);
    this.name = 'TooManyAnnotationsError';
  }
}

/** A change to one transaction refused for what it asked: nothing was saved. */
export class AnnotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnnotationError';
  }
}

/** Changes one transaction's record with `fn`, with whatever else is said
 *  about it kept, and returns it as saved: a compare-and-set
 *  (MapStore.update), so a change made at the same moment on another device
 *  doesn't lose either. A new record past the limit is refused; changing one
 *  there already never is. A record that can't be read is refused
 *  (UnreadableEntriesError), never replaced. */
async function changeRecord(ctx: Ctx, transaction_id: string, fn: (current: TxnAnnotation | null) => TxnAnnotation): Promise<TxnAnnotation> {
  if (!(await txnAnnotationStore.has(ctx, transaction_id)) && (await txnAnnotationStore.count(ctx)) >= MAX_ANNOTATIONS) {
    throw new TooManyAnnotationsError();
  }
  return (await txnAnnotationStore.update(ctx, transaction_id, fn))!;
}

/** A change to what is said about one transaction: any of an exclusion
 *  (true or false), tags put on or taken off (by id), a bank row's note
 *  (empty clears it). */
export type AnnotationChange = { excluded?: boolean; add?: readonly string[]; remove?: readonly string[]; note?: string };

/**
 * The record after a change, with whatever else is said kept: a tag put on
 * leaves `untagged`, a tag taken off joins it (so a rule or a carried tag
 * doesn't put it back) and leaves `tags`. Whether the ids are tags that exist
 * is the route's to check (lib/tags.ts). More than MAX_TAGS_PER_TRANSACTION
 * put on by hand is refused (AnnotationError). Pure.
 */
export function changedRecord(current: TxnAnnotation | null, change: AnnotationChange, now: Date): TxnAnnotation {
  const next: TxnAnnotation = { ...(current ?? {}), updated_at: now.toISOString() };
  if (change.excluded !== undefined) next.excluded = change.excluded;
  if (change.add?.length || change.remove?.length) {
    const add = [...new Set(change.add ?? [])];
    const remove = [...new Set(change.remove ?? [])].filter((id) => !add.includes(id));
    const tags = [...(current?.tags ?? []).filter((id) => !remove.includes(id) && !add.includes(id)), ...add];
    const untagged = [...(current?.untagged ?? []).filter((id) => !add.includes(id) && !remove.includes(id)), ...remove];
    if (tags.length > MAX_TAGS_PER_TRANSACTION) {
      throw new AnnotationError(`A transaction can carry at most ${MAX_TAGS_PER_TRANSACTION} tags put on by hand.`);
    }
    if (tags.length > 0) next.tags = tags;
    else delete next.tags;
    if (untagged.length > 0) next.untagged = untagged;
    else delete next.untagged;
  }
  if (change.note !== undefined) next.note = change.note;
  return next;
}

/** Changes what is said about one transaction, in one compare-and-set (see
 *  changeRecord), and returns the record as saved. */
export function changeAnnotation(ctx: Ctx, transaction_id: string, change: AnnotationChange, now: Date = new Date()): Promise<TxnAnnotation> {
  return changeRecord(ctx, transaction_id, (current) => changedRecord(current, change, now));
}

/**
 * Excludes one transaction, or includes it again, with whatever else is said
 * about it kept, and returns the record as saved. Either way it is recorded
 * (see the header).
 */
export function setExcluded(ctx: Ctx, transaction_id: string, excluded: boolean, now: Date = new Date()): Promise<TxnAnnotation> {
  return changeAnnotation(ctx, transaction_id, { excluded }, now);
}

/** Puts tags on one transaction and takes others off, by id (changedRecord). */
export function changeTags(
  ctx: Ctx,
  transaction_id: string,
  change: { add?: readonly string[]; remove?: readonly string[] },
  now: Date = new Date()
): Promise<TxnAnnotation> {
  return changeAnnotation(ctx, transaction_id, change, now);
}

/** A note as an edit takes it: trimmed, at most MAX_NOTE_CHARS (as a manual
 *  row's, lib/manual-txn-input.ts), no control characters but line breaks
 *  and tabs. Empty clears it. */
export function checkNote(raw: unknown): string {
  if (typeof raw !== 'string') throw new AnnotationError('A note is text.');
  const note = raw.normalize('NFC').trim();
  if (note.length > MAX_NOTE_CHARS) throw new AnnotationError(`A note can be at most ${MAX_NOTE_CHARS} characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) throw new AnnotationError('A note can’t hold control characters.');
  return note;
}

/** A bank row's note, set or cleared (an empty note is kept: see the header).
 *  A manual row's note is the row's own, changed on the row. */
export function setNote(ctx: Ctx, transaction_id: string, note: string, now: Date = new Date()): Promise<TxnAnnotation> {
  return changeAnnotation(ctx, transaction_id, { note }, now);
}

/**
 * Every record, for /api/transactions and the read-only API: `records`, and
 * `unknown`, the ids whose record could not be read or isn't recognised. A
 * display read that never fails for the records' own sake (storage failing
 * still throws): a transaction in `unknown` counts in totals and is marked as
 * not known, so the screen says a total may include something the person
 * excluded. Nothing writes on this answer; a change to an unreadable record
 * is refused by every edit here.
 */
export async function readAnnotations(ctx: Ctx): Promise<{ records: Map<string, TxnAnnotation>; unknown: Set<string> }> {
  const { entries, unreadable, unrecognised } = await txnAnnotationStore.getAllReport(ctx);
  return { records: entries, unknown: new Set([...unreadable, ...unrecognised]) };
}

/**
 * What each transaction's own record says about excluding it: `records` (true
 * excluded, false put back), and `unknown`, as readAnnotations says it.
 */
export async function readExclusions(ctx: Ctx): Promise<{ records: Map<string, boolean>; unknown: Set<string> }> {
  const { records: all, unknown } = await readAnnotations(ctx);
  const records = new Map<string, boolean>();
  for (const [id, a] of all) if (typeof a.excluded === 'boolean') records.set(id, a.excluded);
  return { records, unknown };
}

/** Forgets what was said about transactions that are gone (a deleted manual
 *  row, every row of a deleted manual account, an Item disconnected),
 *  readable or not. */
export async function forgetAnnotations(ctx: Ctx, transaction_ids: string[]): Promise<void> {
  const ids = transaction_ids.filter(isTransactionId);
  for (let i = 0; i < ids.length; i += 1000) await txnAnnotationStore.remove(ctx, ...ids.slice(i, i + 1000));
}

/**
 * Takes deleted tags' ids off every record that holds them (lib/tag-delete.ts),
 * each in its own compare-and-set. A record left with nothing said is
 * removed. A record that can't be read, or isn't recognised, is left as it
 * is: nothing shows an id no tag has, so what it holds is never seen. Returns
 * how many records changed.
 */
export async function sweepAnnotationTags(ctx: Ctx, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const gone = new Set(ids);
  const holds = (a: { tags?: string[]; untagged?: string[] }) => !!a.tags?.some((t) => gone.has(t)) || !!a.untagged?.some((t) => gone.has(t));
  const { entries } = await txnAnnotationStore.getAllReport(ctx);
  let changed = 0;
  for (const [id, record] of entries) {
    if (!holds(record)) continue;
    await txnAnnotationStore.update(ctx, id, (current) => {
      if (!current || !holds(current)) return current;
      const next: TxnAnnotation = { ...current };
      const tags = (current.tags ?? []).filter((t) => !gone.has(t));
      const untagged = (current.untagged ?? []).filter((t) => !gone.has(t));
      if (tags.length > 0) next.tags = tags;
      else delete next.tags;
      if (untagged.length > 0) next.untagged = untagged;
      else delete next.untagged;
      // Nothing left said about it: the record goes rather than stay empty.
      return Object.keys(next).every((k) => k === 'updated_at') ? null : next;
    });
    changed++;
  }
  // Carried from earlier accounts too: a tag deleted never comes back on a
  // re-linked account's row.
  const carried = await carriedAnnotationStore.getAllReport(ctx);
  for (const [account_id, record] of carried.entries) {
    if (!Object.values(record.rows).some((r) => r !== null && holds(r))) continue;
    await carriedAnnotationStore.update(ctx, account_id, (current) => {
      if (!current) return current;
      const rows: Record<string, CarriedAnnotation | null> = {};
      for (const [key, r] of Object.entries(current.rows)) {
        if (r === null || !holds(r)) {
          rows[key] = r;
          continue;
        }
        const next: CarriedAnnotation = { ...r };
        const tags = (r.tags ?? []).filter((t) => !gone.has(t));
        const untagged = (r.untagged ?? []).filter((t) => !gone.has(t));
        if (tags.length > 0) next.tags = tags;
        else delete next.tags;
        if (untagged.length > 0) next.untagged = untagged;
        else delete next.untagged;
        // A key that carried only the deleted tags carries nothing now.
        if (Object.keys(next).length > 0) rows[key] = next;
      }
      return { ...current, rows };
    });
  }
  return changed;
}

// ---- Carried across a re-link ----

/** What one content key carries: what was said about its transaction. */
export type CarriedAnnotation = {
  excluded?: boolean;
  tags?: string[];
  untagged?: string[];
  note?: string;
  [later: string]: unknown;
};
/** One earlier account's record: by content key, what carries, or null where
 *  identical rows disagreed, so nothing does. */
export type CarriedAnnotations = { version: 1; rows: Record<string, CarriedAnnotation | null> };

function isCarriedRow(r: unknown): r is CarriedAnnotation {
  return isRecord(r) && (r.excluded === undefined || typeof r.excluded === 'boolean') && isTagList(r.tags) && isTagList(r.untagged) && isNote(r.note);
}

export function isCarriedAnnotations(v: unknown): v is CarriedAnnotations {
  if (!isRecord(v) || v.version !== 1 || !isRecord(v.rows)) return false;
  return Object.values(v.rows).every((r) => r === null || isCarriedRow(r));
}

export const carriedAnnotationStore = defineMapStore<CarriedAnnotations>('carried-annotations', {
  what: 'notes, tags and exclusions carried from earlier accounts',
  isValid: isCarriedAnnotations,
  exportable: true, // what the person said, kept for a re-link
});

/** One transaction of an Item being disconnected: its id, its account, its
 *  content key (lib/transactions.ts contentKey) and whether it is pending. */
export type RetiringTxn = { transaction_id: string; account_id: string; key: string; pending: boolean };

/** What a record carries across a re-link: what the person said on the row,
 *  or null when nothing. Tags in a fixed order, so two rows that say the same
 *  compare equal. */
function carriable(a: TxnAnnotation | undefined): CarriedAnnotation | null {
  if (!a) return null;
  const out: CarriedAnnotation = {};
  if (typeof a.excluded === 'boolean') out.excluded = a.excluded;
  if (a.tags?.length) out.tags = [...a.tags].sort();
  if (a.untagged?.length) out.untagged = [...a.untagged].sort();
  if (typeof a.note === 'string') out.note = a.note;
  return Object.keys(out).length > 0 ? out : null;
}

const same = (a: CarriedAnnotation | null, b: CarriedAnnotation | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Records what was said about a disconnecting Item's transactions (an
 * exclusion or an include, tags, a note), by content key under each of its
 * accounts, merged with anything recorded for the same account before (a key
 * recorded two ways carries nothing). The Item's own records stay until it is
 * gone: pruneOrphanAnnotations drops them after, so a disconnect that fails
 * part way leaves the Item with everything it had. Posted rows only, as for
 * categories: a pending row's key is not the posted row's. Every posted row
 * with the key is counted, said about or not, so a key that can't be pinned
 * to one answer carries nothing. A record that can't be read carries nothing
 * (it isn't shown today either). Sent again, it records the same. Returns how
 * many keys it recorded. Throws if storage fails; the caller must not let
 * that stop the disconnect.
 */
export async function retireAnnotations(ctx: Ctx, txns: RetiringTxn[]): Promise<number> {
  const mine = new Set(txns.map((t) => t.transaction_id).filter(isTransactionId));
  if (mine.size === 0) return 0;
  // Every record, which is few (see SIZE above), rather than one per row of
  // the Item: a damaged one is passed over instead of failing the rest.
  const report = await txnAnnotationStore.getAllReport(ctx);
  const records = new Map([...report.entries].filter(([id]) => mine.has(id)));
  if (records.size === 0) return 0;
  const groups = new Map<string, { account_id: string; states: (CarriedAnnotation | null)[] }>();
  for (const t of txns) {
    if (t.pending) continue;
    const g = groups.get(t.key) ?? { account_id: t.account_id, states: [] };
    g.states.push(carriable(records.get(t.transaction_id)));
    groups.set(t.key, g);
  }
  const byAccount = new Map<string, Record<string, CarriedAnnotation | null>>();
  for (const [key, g] of groups) {
    if (!g.states.some((s) => s !== null)) continue;
    const rows = byAccount.get(g.account_id) ?? {};
    rows[key] = g.states.every((s) => same(s, g.states[0])) ? g.states[0] : null;
    byAccount.set(g.account_id, rows);
  }
  let n = 0;
  for (const [account_id, rows] of byAccount) {
    await carriedAnnotationStore.update(ctx, account_id, (current) => {
      const merged: Record<string, CarriedAnnotation | null> = { ...(current?.rows ?? {}) };
      for (const [key, value] of Object.entries(rows)) {
        merged[key] = key in merged && JSON.stringify(merged[key]) !== JSON.stringify(value) ? null : value;
      }
      return { version: 1, rows: merged };
    });
    n += Object.keys(rows).length;
  }
  return n;
}

/**
 * Forgets the records of bank transactions no stored Item holds any more (an
 * Item disconnected, rows the bank removed): they can never be shown again.
 * As lib/overrides.ts pruneOrphanOverrides does for categories. `readKnown`
 * reads every transaction id the stored Items hold (lib/transactions.ts
 * storedTransactionIds), or null when a store couldn't be read or is behind,
 * and then nothing is pruned. The records are read first and the stores
 * after, so a record set meanwhile on a newly stored row is checked against a
 * read that has the row. A manual row's record goes with its row, never here;
 * one this release doesn't recognise is left for the release that wrote it.
 * `among` keeps it to the records of those transactions (the ones a sync just
 * saw the bank remove), and the stores are read only if one of them has a
 * record: almost never, since a pending transaction can't be excluded, tagged
 * or noted, and a bank rarely removes a posted one. Returns how many it
 * forgot.
 */
export async function pruneOrphanAnnotations(
  ctx: Ctx,
  readKnown: () => Promise<Set<string> | null>,
  opts: { among?: ReadonlySet<string> } = {}
): Promise<number> {
  const { entries, unreadable } = await txnAnnotationStore.getAllReport(ctx);
  const ids = [...entries.keys(), ...unreadable].filter((id) => !id.startsWith(MANUAL_TXN_PREFIX) && (!opts.among || opts.among.has(id)));
  if (ids.length === 0) return 0;
  const known = await readKnown();
  if (!known) return 0;
  const orphans = ids.filter((id) => !known.has(id));
  await forgetAnnotations(ctx, orphans);
  return orphans.length;
}

/**
 * The records of the given earlier accounts (the old ids of active links),
 * for /api/transactions. `ok` is false when they couldn't be read: nothing is
 * carried then (the rows count, as a carried category falls back to Plaid's),
 * the failure is logged, and the route doesn't cache that answer, so the
 * next load tries again.
 */
export async function getCarriedAnnotations(ctx: Ctx, account_ids: string[]): Promise<{ carried: Map<string, CarriedAnnotations>; ok: boolean }> {
  if (account_ids.length === 0) return { carried: new Map(), ok: true };
  try {
    return { carried: await carriedAnnotationStore.getMany(ctx, account_ids), ok: true };
  } catch (err) {
    console.warn('txn-annotations: could not read what was carried from earlier accounts', err instanceof Error ? err.message : err);
    return { carried: new Map(), ok: false };
  }
}

/** The content key under the account's current id (following the links), or
 *  null when the account isn't linked to anything: nothing is carried until
 *  the person has said it is the same account. As lib/overrides.ts does for
 *  categories. */
function currentKey(key: string, account_id: string, links: Map<string, Link>): string | null {
  const current = resolveId(account_id, links);
  if (current === account_id || !key.startsWith(`${account_id}|`)) return null;
  return current + key.slice(account_id.length);
}

/**
 * What carries across a re-link, by content key under each account's current
 * id. Two earlier ids of one account that disagree on a key carry nothing
 * for it.
 */
export function carriedAnnotations(carried: Map<string, CarriedAnnotations>, links: Map<string, Link>): Map<string, CarriedAnnotation> {
  const out = new Map<string, CarriedAnnotation>();
  const clash = new Set<string>();
  for (const [account_id, record] of carried) {
    for (const [key, value] of Object.entries(record.rows)) {
      const k = currentKey(key, account_id, links);
      if (!k) continue;
      if (value === null || (out.has(k) && !same(out.get(k)!, value))) {
        clash.add(k);
        continue;
      }
      out.set(k, value);
    }
  }
  for (const k of clash) out.delete(k);
  return out;
}

/** The content keys, under each account's current id, whose transactions
 *  carry an exclusion across a re-link. Two earlier ids of one account that
 *  disagree on a key carry nothing for it. */
export function carriedExclusions(carried: Map<string, CarriedAnnotations>, links: Map<string, Link>): Set<string> {
  const out = new Set<string>();
  for (const [k, value] of carriedAnnotations(carried, links)) if (value.excluded === true) out.add(k);
  return out;
}

/** What a row carries beside an exclusion (which is marked on the row
 *  itself): an include, tags, a note. Null when nothing. */
export function carriedExtras(value: CarriedAnnotation | undefined): CarriedRowFacts | null {
  if (!value) return null;
  const out: CarriedRowFacts = {};
  if (value.excluded === false) out.excluded = false;
  if (value.tags?.length) out.tags = value.tags;
  if (value.untagged?.length) out.untagged = value.untagged;
  if (typeof value.note === 'string') out.note = value.note;
  return Object.keys(out).length > 0 ? out : null;
}

/** What a bank row carries from an earlier account besides an exclusion, as
 *  the cached rows hold it until lib/activity.ts applies it (never sent). */
export type CarriedRowFacts = { excluded?: false; tags?: string[]; untagged?: string[]; note?: string };

/** Forgets one earlier account's carried records (forgetting it). */
export async function forgetCarriedAnnotations(ctx: Ctx, account_id: string): Promise<void> {
  await carriedAnnotationStore.remove(ctx, account_id);
}
