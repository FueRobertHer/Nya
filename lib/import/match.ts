// lib/import/match.ts
//
// The pipeline's match stage: which of a file's rows an account already has.
// Pure, safe to import from client code.
//
// BY ID where the file has one: an OFX row whose FITID is already stored on
// the account (from an earlier OFX or QFX import) is already there, so
// re-importing a statement, or one that overlaps it, adds nothing. A FITID
// repeated within one file is the bank listing one transaction twice: the
// first is read, the rest are counted as repeats.
//
// BY CONTENT otherwise (lib/import/normalize.ts contentKey: day, currency,
// amount and description): a row from a CSV or QIF file, or an OFX row the
// account doesn't have by id, matches a stored row with the same key. Each
// stored row matches one incoming row at most, so two identical coffees on
// one day are two rows: a file holding both, imported into an account holding
// one, adds the other, and importing that file again adds nothing. An OFX row
// with an id is only matched by content to a stored row without one (typed by
// hand, or from a CSV or QIF file): two stored rows with different FITIDs are
// two transactions, however alike. A stored row from a CSV or QIF file is
// matched by the key it was imported with, so editing it doesn't make a later
// file bring it back; any other stored row by what it says now.
//
// Matching is exact, never fuzzy. A bank that describes a transaction one way
// in its CSV and another in its OFX file can't be matched across the two
// (that needs the review step of #52), so a person imports one format.

import { contentKey, ID_SOURCES, type ImportRow } from './normalize';

/** What matching needs of a row an account already has (a ManualTxn). */
export type StoredRow = {
  id: string;
  date: string;
  amount: number;
  currency: string;
  name: string;
  source: string;
  source_id: string | null;
};

/** What became of one incoming row. */
export type Outcome =
  | { outcome: 'new' }
  | { outcome: 'present'; row_id: string; by: 'id' | 'content' }
  | { outcome: 'repeated' };

/** Sources whose source_id is the content key their import recorded. */
const KEYED_SOURCES: ReadonlySet<string> = new Set(['import:csv', 'import:qif']);

const idKey = (source: string, id: string) => `${source}\u0000${id}`;

/** The key a stored row is matched by (see the header). */
function storedKey(r: StoredRow): string {
  return KEYED_SOURCES.has(r.source) && r.source_id ? r.source_id : contentKey(r);
}

/** The key an incoming row is matched by. */
function incomingKey(r: ImportRow): string {
  return KEYED_SOURCES.has(r.source) && r.source_id ? r.source_id : contentKey(r);
}

/** What becomes of each incoming row, in order, against the account's rows
 *  (see the header). */
export function matchRows(rows: readonly ImportRow[], existing: readonly StoredRow[]): Outcome[] {
  const byId = new Map<string, string>();
  const pool = new Map<string, { id: string; withId: boolean }[]>();
  for (const r of existing) {
    const withId = ID_SOURCES.has(r.source) && !!r.source_id;
    if (withId) byId.set(idKey(r.source, r.source_id!), r.id);
    const key = storedKey(r);
    const list = pool.get(key);
    if (list) list.push({ id: r.id, withId });
    else pool.set(key, [{ id: r.id, withId }]);
  }
  const used = new Set<string>();
  const seen = new Set<string>();
  return rows.map((row): Outcome => {
    const hasId = ID_SOURCES.has(row.source) && !!row.source_id;
    if (hasId) {
      const key = idKey(row.source, row.source_id!);
      if (seen.has(key)) return { outcome: 'repeated' };
      seen.add(key);
      const stored = byId.get(key);
      if (stored && !used.has(stored)) {
        used.add(stored);
        return { outcome: 'present', row_id: stored, by: 'id' };
      }
    }
    const candidates = pool.get(incomingKey(row)) ?? [];
    const match = candidates.find((c) => !used.has(c.id) && !(hasId && c.withId));
    if (match) {
      used.add(match.id);
      return { outcome: 'present', row_id: match.id, by: 'content' };
    }
    return { outcome: 'new' };
  });
}

/** How many of each outcome. */
export function countOutcomes(outcomes: readonly Outcome[]): { new: number; present: number; repeated: number } {
  const counts = { new: 0, present: 0, repeated: 0 };
  for (const o of outcomes) counts[o.outcome]++;
  return counts;
}
