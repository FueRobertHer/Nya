// lib/user-restore/ids.ts
//
// The ids and bounds a restore shares between the page and the server
// (lib/user-restore/): pure, with nothing that reaches storage, so the page
// that reads the file can import it. The stores themselves are in
// lib/user-restore/store.ts.

import { RESTORED_TXN_PREFIX } from '../history-import/view';

/** Plaid's ids (an account's, a transaction's, an Item's): letters, digits
 *  and the seam's few marks, short enough that a restored row's id built on
 *  one is still an id the seam takes. */
export const PLAID_ID = /^[A-Za-z0-9_.:-]{1,150}$/;
export const isPlaidId = (v: unknown): v is string => typeof v === 'string' && PLAID_ID.test(v);

/** Rows in one book of restored rows, or one part of investment rows: far
 *  under the write ceiling even with every field, and a batch appends to the
 *  last book only, never recompressing years of rows. */
export const BOOK_ROWS = 5_000;

/** Books one restored account can have: 10,000 of 5,000 rows is far more
 *  than any bank has served one account. */
export const MAX_BOOKS = 10_000;

/** How long after it finishes a restore can be undone (decision 4). */
export const UNDO_DAYS = 7;

/** At most this many batches in one plan: 2,000 batches of 3.5 MB is far
 *  more than the largest download (docs/data-export.md, "How big"). */
export const MAX_BATCHES = 2_000;

/** The id a restored bank row is kept under: the imported rows' prefix and the
 *  bank's own id, so the same file always gives the same id (a batch sent
 *  twice writes the same rows) and every part of the file that names the row
 *  names it alike. */
export function restoredId(bankId: string): string {
  if (!isPlaidId(bankId)) throw new TypeError('A restored row needs a bank transaction id.');
  return `${RESTORED_TXN_PREFIX}${bankId}`;
}

export function isRestoredId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith(RESTORED_TXN_PREFIX) && isPlaidId(id.slice(RESTORED_TXN_PREFIX.length));
}

/** The bank's own id inside a restored row's id. */
export function bankIdOf(restored: string): string | null {
  return isRestoredId(restored) ? restored.slice(RESTORED_TXN_PREFIX.length) : null;
}

/** A book's id: the account's and its part. */
export const restoredBookId = (account_id: string, part: number): string => `${account_id}.${part}`;

/** The parts of investment rows of a connection, and its coverage. */
export const investmentPartId = (item_id: string, part: number): string => `${item_id}.${part}`;
export const investmentCoverageId = (item_id: string): string => `${item_id}.coverage`;

export const USER_RESTORE_ID = /^user-restore:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUserRestoreId = (v: unknown): v is string => typeof v === 'string' && USER_RESTORE_ID.test(v);
export const newUserRestoreId = (): string => `user-restore:${crypto.randomUUID()}`;

/** A part of a plan: a writer's name (lib/user-restore/plan.ts PART_ORDER). */
export const PART = /^[a-z_:-]{1,60}$/;
/** A batch's SHA-256, in hex. */
export const DIGEST = /^[0-9a-f]{64}$/;

/** The largest batch the page sends, in UTF-8 bytes of its JSON: under
 *  Vercel's 4.5 MB request limit with room to spare. */
export const BATCH_BYTES = 3.5 * 1024 * 1024;
/** What the batch route takes, declared or read, before parsing anything:
 *  a batch of one record a little over BATCH_BYTES still fits. */
export const MAX_BATCH_BODY = 4 * 1024 * 1024;
