// lib/import/match.ts
//
// The pipeline's match stage: which of a file's rows an account already has.
// Pure, safe to import from client code.
//
// BY ID where the file has one, but never on the id alone. An OFX row is
// already there when the account has a row with the same FITID (from an
// earlier OFX or QFX import) that is the same transaction: the same amount in
// the same currency, dated within FITID_DAYS of it (a pending charge posts a
// day or two after it was made), or exactly what that row was imported as
// (its source_key: lib/import/normalize.ts), whatever the person changed on it
// since. So re-importing a statement, or one that overlaps it, adds nothing.
// A FITID repeated within one file on the same transaction is the bank
// listing it twice: the first is read, the rest are counted as repeats.
//
// A FITID IS NOT TRUSTED BLINDLY. Banks reuse them: some number a download's
// transactions from 1, so September's "1" and October's "1" are different
// purchases, and some keep a pending charge's FITID when it posts at another
// amount (a tip added). So a row whose FITID the account has, on a row that
// isn't the same transaction, is never dropped as already there:
//   - when a stored row is the same transaction by its content (below), that
//     is the match, and the FITID was only reused;
//   - otherwise it is a conflict (lib/import/commit.ts lets the person import
//     it as a new row, replace the stored row with the file's version, or
//     skip it): `suggested` is "new" when the payee, the amount and the date
//     all differ (a bank numbering per download), and null, asking, when only
//     some differ (a pending charge that posted at a new amount);
//   - a row repeating a FITID earlier in the same file that isn't the same
//     transaction is a transaction of its own, and says which row it shares
//     the id with (`shares_id_with`), for the preview to name.
//
// BY CONTENT otherwise (lib/import/normalize.ts contentKey: day, currency,
// amount and description): a row from a CSV or QIF file, or an OFX row no
// stored row matched by id, matches a stored row with the same key. Each
// stored row matches one incoming row at most, so two identical coffees on
// one day are two rows: a file holding both, imported into an account holding
// one, adds the other, and importing that file again adds nothing. A stored
// row that matched by id is taken, so it can't also match another row by
// content: two OFX rows with their own FITIDs both in the file are two
// transactions, however alike. A stored row from a CSV or QIF file is matched
// by the key it was imported with or by what it says now, either one, still
// once: editing it doesn't make a later file bring it back, and correcting it
// to what the bank later says (a pending amount that posted at another) makes
// that file's row match it. Any other stored row is matched by what it says
// now.
//
// Matching is exact, never fuzzy. A bank that describes a transaction one way
// in its CSV and another in its OFX file can't be matched across the two
// (that needs the review step of #52), so a person imports one format.

import { contentKey, digitsOf, ID_SOURCES, normalizeDescription, type ImportRow } from './normalize';

/** How far apart, in days, two rows with the same FITID may be dated and
 *  still be the same transaction: a pending charge posts a few days on. */
export const FITID_DAYS = 5;

/** What matching needs of a row an account already has (a ManualTxn). */
export type StoredRow = {
  id: string;
  date: string;
  amount: number;
  currency: string;
  name: string;
  source: string;
  source_id: string | null;
  /** The hashed key it was imported with, from a file with ids. */
  source_key?: string | null;
};

/** Which of a stored row and an incoming one with the same FITID differ. */
export type Differs = { name: boolean; amount: boolean; date: boolean };

/** What became of one incoming row. */
export type Outcome =
  | { outcome: 'new'; shares_id_with?: number }
  | { outcome: 'present'; row_id: string; by: 'id' | 'content' }
  | { outcome: 'repeated'; of: number }
  | { outcome: 'conflict'; row_id: string; differs: Differs; suggested: 'new' | null };

/** Sources whose source_id is the content key their import recorded. */
const KEYED_SOURCES: ReadonlySet<string> = new Set(['import:csv', 'import:qif']);

const idKey = (source: string, id: string) => `${source}\u0000${id}`;

/** The keys a stored row is matched by (see the header). */
function storedKeys(r: StoredRow): string[] {
  const now = contentKey(r);
  if (!KEYED_SOURCES.has(r.source) || !r.source_id || r.source_id === now) return [now];
  return [r.source_id, now];
}

/** The key an incoming row is matched by. */
function incomingKey(r: ImportRow): string {
  return KEYED_SOURCES.has(r.source) && r.source_id ? r.source_id : contentKey(r);
}

const dayNumber = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;
const minor = (r: { amount: number; currency: string }) => Math.round(r.amount * 10 ** digitsOf(r.currency));

type Comparable = { date: string; amount: number; currency: string; source_key?: string | null };

/** Whether two rows with the same FITID are the same transaction (see the
 *  header): the same amount in the same currency, dated within FITID_DAYS,
 *  or both what was imported for one of them. */
export function sameTransaction(a: Comparable, b: Comparable): boolean {
  if (a.source_key && a.source_key === b.source_key) return true;
  return a.currency === b.currency && minor(a) === minor(b) && Math.abs(dayNumber(a.date) - dayNumber(b.date)) <= FITID_DAYS;
}

/** What differs between a stored row and an incoming one. */
export function differsFrom(stored: StoredRow, row: ImportRow): Differs {
  return {
    name: normalizeDescription(stored.name) !== normalizeDescription(row.name),
    amount: stored.currency !== row.currency || minor(stored) !== minor(row),
    date: stored.date !== row.date,
  };
}

/** What becomes of each incoming row, in order, against the account's rows
 *  (see the header). */
export function matchRows(rows: readonly ImportRow[], existing: readonly StoredRow[]): Outcome[] {
  const byFitid = new Map<string, StoredRow[]>();
  const pool = new Map<string, string[]>();
  for (const r of existing) {
    if (ID_SOURCES.has(r.source) && r.source_id) {
      const key = idKey(r.source, r.source_id);
      const list = byFitid.get(key);
      if (list) list.push(r);
      else byFitid.set(key, [r]);
    }
    for (const key of storedKeys(r)) {
      const list = pool.get(key);
      if (list) list.push(r.id);
      else pool.set(key, [r.id]);
    }
  }
  const used = new Set<string>();
  const out: (Outcome | null)[] = rows.map(() => null);
  const sharesWith = new Map<number, number>();
  const hasId = (row: ImportRow) => ID_SOURCES.has(row.source) && !!row.source_id;

  // By id, first for every row, so a stored row matched by its id is taken
  // before any row could match it by content.
  const inFile = new Map<string, number[]>();
  rows.forEach((row, i) => {
    if (!hasId(row)) return;
    const key = idKey(row.source, row.source_id!);
    const earlier = inFile.get(key) ?? [];
    const twin = earlier.find((e) => sameTransaction(rows[e], row));
    if (twin !== undefined) {
      out[i] = { outcome: 'repeated', of: twin };
      return;
    }
    if (earlier.length > 0) sharesWith.set(i, earlier[0]);
    inFile.set(key, [...earlier, i]);
    const stored = (byFitid.get(key) ?? []).find((s) => !used.has(s.id) && sameTransaction(s, row));
    if (stored) {
      used.add(stored.id);
      out[i] = { outcome: 'present', row_id: stored.id, by: 'id' };
    }
  });

  // By content, for the rest.
  rows.forEach((row, i) => {
    if (out[i]) return;
    const match = (pool.get(incomingKey(row)) ?? []).find((id) => !used.has(id));
    if (match) {
      used.add(match);
      out[i] = { outcome: 'present', row_id: match, by: 'content' };
    }
  });

  // What is left is new, unless a stored row nothing else matched has its
  // FITID: then the person decides.
  return rows.map((row, i): Outcome => {
    const done = out[i];
    if (done) return done;
    if (hasId(row)) {
      const candidates = (byFitid.get(idKey(row.source, row.source_id!)) ?? []).filter((s) => !used.has(s.id));
      if (candidates.length > 0) {
        // The closest: the same day first, then the same amount.
        const scored = candidates.map((s) => ({ s, d: differsFrom(s, row) }));
        scored.sort((a, b) => Number(a.d.date) - Number(b.d.date) || Number(a.d.amount) - Number(b.d.amount) || Number(a.d.name) - Number(b.d.name));
        const { s, d } = scored[0];
        used.add(s.id);
        return { outcome: 'conflict', row_id: s.id, differs: d, suggested: d.name && d.amount && d.date ? 'new' : null };
      }
    }
    const shares = sharesWith.get(i);
    return shares === undefined ? { outcome: 'new' } : { outcome: 'new', shares_id_with: shares };
  });
}

/** How many of each outcome. */
export function countOutcomes(outcomes: readonly Outcome[]): { new: number; present: number; repeated: number; conflict: number } {
  const counts = { new: 0, present: 0, repeated: 0, conflict: 0 };
  for (const o of outcomes) counts[o.outcome]++;
  return counts;
}
