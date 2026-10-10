// lib/txn-annotations.ts
//
// What the person says about one transaction, Plaid's or one of their own
// (lib/manual-txns.ts), kept beside it rather than in it. Today one thing:
// whether it is left out of budgets and reports. It is one record per
// transaction, not a store per flag, so a note, tags or a reviewed state can
// join it later as fields of the same record.
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
// record: rules (#36) will apply on read, below what a person sets on one
// transaction, and an explicit include has to be there to beat a rule that
// would hide it, as it beats an exclusion carried across a re-link (below).
//
// GONE WITH ITS TRANSACTION. A bank transaction's record goes once no stored
// Item holds the transaction (pruneOrphanAnnotations, by the rules of the
// category overrides' own prune: nothing goes while a store can't be read or
// is behind, nor a record this release doesn't recognise): after a sync that
// saved the bank's removal of it (lib/transactions.ts), after a disconnect,
// and after an earlier account is forgotten. A manual row's goes with its row.
//
// CARRIED ACROSS A RE-LINK, as categories are (#46, lib/overrides.ts). A
// disconnect records the excluded transactions of the Item's accounts by
// content key (account, date, amount, the bank's descriptor:
// lib/transactions.ts contentKey) before their ids die with the Item, and
// prunes the Item's own records once it is gone (pruneOrphanAnnotations).
// Once the person links the old account to the re-added one (lib/links.ts),
// the new account's rows with the same key are excluded again. The keys name a date, an amount and a merchant, so they
// live inside one encrypted record per earlier account (the
// `carried-annotations` store), never in a field name. A key whose identical
// rows disagreed carries nothing rather than guessing; a record on the new
// row itself wins; unlinking stops the carry; forgetting the earlier account
// forgets it.
//
// LATER FIELDS SURVIVE. A release that adds a field writes records this one
// doesn't fully know. isTxnAnnotation checks the fields it knows and lets the
// rest through, and setExcluded keeps them, so after a rollback the newer
// records still read (rather than all being unrecognised, which would stop
// every exclusion from showing) and an edit here doesn't drop a note.
//
// SIZE. /api/transactions reads every record (one HGETALL) on each request,
// which is cheap for what people exclude: a few one-offs, far under
// MAX_ANNOTATIONS. A state kept on every transaction (reviewed, say) would
// read only the shown rows' records instead (getMany).

import { defineMapStore } from './repo';
import type { Ctx } from './containers';
import { resolveId, type Link } from './link-core';
import { MANUAL_TXN_PREFIX } from './manual-txn-input';

/** What is said about one transaction. Fields a later release adds ride along. */
export type TxnAnnotation = {
  /** True: left out of budgets and reports. False: the person put it back
   *  (which beats a carried exclusion, and later a rule). Absent: nothing said. */
  excluded?: boolean;
  /** When it last changed. */
  updated_at: string;
  [later: string]: unknown;
};

/** A transaction id as the seam keeps it in a field name: Plaid's, or a manual
 *  row's (lib/manual-txns.ts isManualTxnId). */
export function isTransactionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(id) && id !== '__proto__';
}

/** How many transactions can carry an annotation: far beyond the one-offs
 *  anyone excludes, and a bound on the one read /api/transactions makes. */
export const MAX_ANNOTATIONS = 20_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isTxnAnnotation(v: unknown): v is TxnAnnotation {
  if (!isRecord(v)) return false;
  return typeof v.updated_at === 'string' && !Number.isNaN(Date.parse(v.updated_at)) && (v.excluded === undefined || typeof v.excluded === 'boolean');
}

export const txnAnnotationStore = defineMapStore<TxnAnnotation>('transaction-annotations', {
  what: 'transaction exclusions',
  isValid: isTxnAnnotation,
  exportable: true, // what the person said about their transactions
});

/** A count limit refused: nothing was saved. */
export class TooManyAnnotationsError extends Error {
  constructor() {
    super(`At most ${MAX_ANNOTATIONS.toLocaleString('en-US')} transactions can be excluded or included by hand. Clear some first.`);
    this.name = 'TooManyAnnotationsError';
  }
}

/**
 * Excludes one transaction, or includes it again, with whatever else is said
 * about it kept, and returns the record as saved. Either way it is recorded
 * (see the header). A compare-and-set (MapStore.update): a rule setting it at
 * the same moment doesn't lose either change. A record that can't be read is
 * refused (UnreadableEntriesError), never replaced.
 */
export async function setExcluded(ctx: Ctx, transaction_id: string, excluded: boolean, now: Date = new Date()): Promise<TxnAnnotation> {
  // A new record past the limit is refused; changing one there already never is.
  if (!(await txnAnnotationStore.has(ctx, transaction_id)) && (await txnAnnotationStore.count(ctx)) >= MAX_ANNOTATIONS) {
    throw new TooManyAnnotationsError();
  }
  const saved = await txnAnnotationStore.update(ctx, transaction_id, (current) => ({
    ...(current ?? {}),
    excluded,
    updated_at: now.toISOString(),
  }));
  return saved!;
}

/**
 * What each transaction's own record says about excluding it, for
 * /api/transactions: `records` (true excluded, false put back), and `unknown`,
 * the ids whose record could not be read or isn't recognised. A display read
 * that never fails for the records' own sake (storage failing still throws):
 * a transaction in `unknown` counts in totals and is marked as not known, so
 * the screen says a total may include something the person excluded. Nothing
 * writes on this answer; a change to an unreadable record is refused by
 * setExcluded.
 */
export async function readExclusions(ctx: Ctx): Promise<{ records: Map<string, boolean>; unknown: Set<string> }> {
  const { entries, unreadable, unrecognised } = await txnAnnotationStore.getAllReport(ctx);
  const records = new Map<string, boolean>();
  for (const [id, a] of entries) if (typeof a.excluded === 'boolean') records.set(id, a.excluded);
  return { records, unknown: new Set([...unreadable, ...unrecognised]) };
}

/** Forgets what was said about transactions that are gone (a deleted manual
 *  row, every row of a deleted manual account, an Item disconnected),
 *  readable or not. */
export async function forgetAnnotations(ctx: Ctx, transaction_ids: string[]): Promise<void> {
  const ids = transaction_ids.filter(isTransactionId);
  for (let i = 0; i < ids.length; i += 1000) await txnAnnotationStore.remove(ctx, ...ids.slice(i, i + 1000));
}

// ---- Carried across a re-link ----

/** What one content key carries: today, that its transaction was excluded. */
export type CarriedAnnotation = { excluded?: boolean; [later: string]: unknown };
/** One earlier account's record: by content key, what carries, or null where
 *  identical rows disagreed, so nothing does. */
export type CarriedAnnotations = { version: 1; rows: Record<string, CarriedAnnotation | null> };

export function isCarriedAnnotations(v: unknown): v is CarriedAnnotations {
  if (!isRecord(v) || v.version !== 1 || !isRecord(v.rows)) return false;
  return Object.values(v.rows).every((r) => r === null || (isRecord(r) && (r.excluded === undefined || typeof r.excluded === 'boolean')));
}

export const carriedAnnotationStore = defineMapStore<CarriedAnnotations>('carried-annotations', {
  what: 'exclusions carried from earlier accounts',
  isValid: isCarriedAnnotations,
  exportable: true, // what the person said, kept for a re-link
});

/** One transaction of an Item being disconnected: its id, its account, its
 *  content key (lib/transactions.ts contentKey) and whether it is pending. */
export type RetiringTxn = { transaction_id: string; account_id: string; key: string; pending: boolean };

/**
 * Records which of a disconnecting Item's transactions were excluded, by
 * content key under each of its accounts, merged with anything recorded for
 * the same account before (a key recorded both ways carries nothing). The
 * Item's own records stay until it is gone: pruneOrphanAnnotations drops them
 * after, so a disconnect that fails part way leaves the Item with every
 * exclusion it had. Posted rows only, as for categories: a pending row's key
 * is not the posted row's. Every posted row with the key is counted, excluded
 * or not, so a key that can't be pinned to one answer carries nothing. A
 * record that can't be read carries nothing (it isn't shown today either).
 * Sent again, it records the same. Returns how many keys it recorded. Throws
 * if storage fails; the caller must not let that stop the disconnect.
 */
export async function retireAnnotations(ctx: Ctx, txns: RetiringTxn[]): Promise<number> {
  const mine = new Set(txns.map((t) => t.transaction_id).filter(isTransactionId));
  if (mine.size === 0) return 0;
  // Every record, which is few (see SIZE above), rather than one per row of
  // the Item: a damaged one is passed over instead of failing the rest.
  const report = await txnAnnotationStore.getAllReport(ctx);
  const records = new Map([...report.entries].filter(([id]) => mine.has(id)));
  if (records.size === 0) return 0;
  const groups = new Map<string, { account_id: string; states: boolean[] }>();
  for (const t of txns) {
    if (t.pending) continue;
    const g = groups.get(t.key) ?? { account_id: t.account_id, states: [] };
    g.states.push(records.get(t.transaction_id)?.excluded === true);
    groups.set(t.key, g);
  }
  const byAccount = new Map<string, Record<string, CarriedAnnotation | null>>();
  for (const [key, g] of groups) {
    if (!g.states.some(Boolean)) continue;
    const rows = byAccount.get(g.account_id) ?? {};
    rows[key] = g.states.every(Boolean) ? { excluded: true } : null;
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
 * record: almost never, since a pending transaction can't be excluded and a
 * bank rarely removes a posted one. Returns how many it forgot.
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
    console.warn('txn-annotations: could not read exclusions carried from earlier accounts', err instanceof Error ? err.message : err);
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

/** The content keys, under each account's current id, whose transactions
 *  carry an exclusion across a re-link. Two earlier ids of one account that
 *  disagree on a key carry nothing for it. */
export function carriedExclusions(carried: Map<string, CarriedAnnotations>, links: Map<string, Link>): Set<string> {
  const out = new Set<string>();
  const clash = new Set<string>();
  for (const [account_id, record] of carried) {
    for (const [key, value] of Object.entries(record.rows)) {
      const k = currentKey(key, account_id, links);
      if (!k) continue;
      if (value?.excluded === true) out.add(k);
      else clash.add(k);
    }
  }
  for (const k of clash) out.delete(k);
  return out;
}

/** Forgets one earlier account's carried exclusions (forgetting it). */
export async function forgetCarriedAnnotations(ctx: Ctx, account_id: string): Promise<void> {
  await carriedAnnotationStore.remove(ctx, account_id);
}
