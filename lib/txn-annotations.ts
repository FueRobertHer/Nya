// lib/txn-annotations.ts
//
// What the person says about one transaction, Plaid's or one of their own
// (lib/manual-txns.ts), kept beside it rather than in it. Today one thing:
// that it is left out of budgets and reports (excluded). It is one record per
// transaction, not a store per flag, so a note, tags or a reviewed state can
// join it later as fields of the same record, and a rule (#36's hide action)
// can set the flag the way a tap does.
//
// A map store on the storage seam (lib/repo.ts), keyed by transaction_id:
// Plaid's own id, or a manual row's "manual-txn:<uuid>", both opaque as the
// seam requires of field names (Plaid's are in plaintext in the category
// overrides already). The values are encrypted.
//
// Applied on read, in /api/transactions, like a category override: nothing in
// the transaction stores changes, so clearing the flag puts the transaction
// back in every total exactly as it was. Which totals leave an excluded
// transaction out is decided in one place, lib/spending.ts. An annotation for a
// transaction that no longer exists (the bank removed it) is never shown.
//
// LATER FIELDS SURVIVE. A release that adds a field writes records this one
// doesn't fully know. isTxnAnnotation checks the fields it knows and lets the
// rest through, and setExcluded keeps them, so after a rollback the newer
// records still read (rather than all being unrecognised, which would stop
// every exclusion from showing) and an edit here doesn't drop a note.
//
// SIZE. /api/transactions reads every record (one HGETALL), which is cheap for
// what people exclude: a few one-offs, far under MAX_ANNOTATIONS. A state kept
// on every transaction (reviewed, say) would read only the shown rows' records
// instead (getMany).

import { defineMapStore } from './repo';
import type { Ctx } from './containers';

/** What is said about one transaction. Fields a later release adds ride along. */
export type TxnAnnotation = {
  /** Left out of budgets and reports. Absent when it isn't. */
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

export function isTxnAnnotation(v: unknown): v is TxnAnnotation {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const a = v as Record<string, unknown>;
  return typeof a.updated_at === 'string' && !Number.isNaN(Date.parse(a.updated_at)) && (a.excluded === undefined || typeof a.excluded === 'boolean');
}

export const txnAnnotationStore = defineMapStore<TxnAnnotation>('transaction-annotations', {
  what: 'transaction exclusions',
  isValid: isTxnAnnotation,
  exportable: true, // what the person said about their transactions
});

/** A count limit refused: nothing was saved. */
export class TooManyAnnotationsError extends Error {
  constructor() {
    super(`At most ${MAX_ANNOTATIONS.toLocaleString('en-US')} transactions can be excluded. Include some again first.`);
    this.name = 'TooManyAnnotationsError';
  }
}

/**
 * Sets or clears the exclude flag on one transaction, with whatever else is
 * said about it kept, and returns the record as saved (null when nothing is
 * left to say, so no record is kept). A compare-and-set (MapStore.update): a
 * rule setting it at the same moment doesn't lose either change. A record that
 * can't be read is refused (UnreadableEntriesError), never replaced.
 */
export async function setExcluded(ctx: Ctx, transaction_id: string, excluded: boolean, now: Date = new Date()): Promise<TxnAnnotation | null> {
  // A new record past the limit is refused; changing one there already never is.
  if (excluded && !(await txnAnnotationStore.has(ctx, transaction_id)) && (await txnAnnotationStore.count(ctx)) >= MAX_ANNOTATIONS) {
    throw new TooManyAnnotationsError();
  }
  return txnAnnotationStore.update(ctx, transaction_id, (current) => {
    const { excluded: _was, updated_at: _at, ...rest } = current ?? { updated_at: '' };
    if (!excluded && Object.keys(rest).length === 0) return null;
    return { ...rest, ...(excluded ? { excluded: true } : {}), updated_at: now.toISOString() };
  });
}

/**
 * Which transactions are excluded, for /api/transactions to mark: `excluded`,
 * and `unknown`, the ids whose record could not be read or isn't recognised.
 * A display read that never fails for the records' own sake (storage failing
 * still throws): a transaction in `unknown` counts in totals and is marked as
 * not known, so the screen says a total may include something the person
 * excluded. Nothing writes on this answer; a change to an unreadable record is
 * refused by setExcluded.
 */
export async function readExclusions(ctx: Ctx): Promise<{ excluded: Set<string>; unknown: Set<string> }> {
  const { entries, unreadable, unrecognised } = await txnAnnotationStore.getAllReport(ctx);
  const excluded = new Set<string>();
  for (const [id, a] of entries) if (a.excluded === true) excluded.add(id);
  return { excluded, unknown: new Set([...unreadable, ...unrecognised]) };
}

/** Forgets what was said about transactions that are gone (a deleted manual
 *  row, or every row of a deleted manual account), readable or not. */
export async function forgetAnnotations(ctx: Ctx, transaction_ids: string[]): Promise<void> {
  const ids = transaction_ids.filter(isTransactionId);
  for (let i = 0; i < ids.length; i += 1000) await txnAnnotationStore.remove(ctx, ...ids.slice(i, i + 1000));
}
