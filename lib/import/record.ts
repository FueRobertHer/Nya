// lib/import/record.ts
//
// The shape every source of imported transactions produces, and the limits on
// a file (#43, #52). Pure, safe to import from client code.
//
// THE PIPELINE. A source contributes only a parser that turns what it has (a
// file today: OFX or QFX, CSV, QIF; later SimpleFIN's answer or another app's
// export) into RawRecords. Everything after it is shared:
//
//   parse (ofx.ts, csv.ts, qif.ts)  ->  RawRecord[] and the rows it couldn't read
//   normalize (normalize.ts)        ->  each record as a manual row's fields, or why not
//   match (match.ts)                ->  new, already stored, or repeated in the file
//   commit (commit.ts)              ->  one compare-and-set on the account's book,
//                                       and the raw records kept in a store of their own
//
// Parsers, normalize and match are pure functions with no storage, so the
// import sheet runs the same code in the browser to show how a file reads
// before anything is sent, and the server runs it again on what it receives.
// Only commit.ts touches storage. Importing into a linked account (#52) adds a
// review stage between match and commit, and a SimpleFIN connector adds a
// parser; neither changes the rest.

/** Where a record came from. A file's format today; a connector's name later
 *  ('simplefin'), each with its own parser. */
export type SourceKind = 'ofx' | 'csv' | 'qif';

/** The formats a file can be in. QFX is OFX with Intuit's extra tags, read the
 *  same way. */
export const FILE_FORMATS = ['ofx', 'csv', 'qif'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

/** One transaction as its source had it, in the shape #52 defines, with a few
 *  optional fields a file can carry beyond it. */
export type RawRecord = {
  source: SourceKind;
  /** The source's own id for it (OFX's FITID), when it has one: what makes a
   *  re-import exact. */
  source_id?: string;
  /** The day it is on, YYYY-MM-DD, as the source wrote it. */
  date: string;
  /** The day it posted, when the source says so (OFX's DTPOSTED). */
  posted_date?: string;
  /** Plaid's sign, whatever the source's: positive is money out. */
  amount: number;
  description: string;
  /** The record as the source had it: kept, so that what a row was imported
   *  from can always be looked at again. */
  raw: unknown;
  /** Its currency's ISO code, when the source says (OFX's CURDEF). */
  currency?: string;
  category?: string | null;
  note?: string | null;
  /** Plaid's code for what the source says the transaction was, when it says
   *  so outright (an OFX file's TRNTYPE ATM is "atm"): what the spending
   *  rules read (lib/spending.ts), as they read a bank's. */
  transaction_code?: string | null;
  /** Where it starts in the file, counting from 1. */
  line?: number;
};

/** A record that could not be read, and why, in words for the person. */
export type Problem = { line: number; reason: string; raw?: unknown };

/** What a parser read: the records, and the rows it could not read. */
export type ParsedRecords = { records: RawRecord[]; problems: Problem[] };

// ---- Limits ----

/** The largest file taken, in bytes. A year of a busy checking account is
 *  about 300 KB of OFX; this holds some 12,000 OFX transactions, more for CSV
 *  and QIF. The request carrying it must fit Vercel's 4.5 MB limit on a
 *  function's request body, with room for the form around it. */
export const MAX_FILE_BYTES = 3 * 1024 * 1024;

/** The most transactions one file may hold. A file with more is refused whole
 *  (never cut short), so a person imports a shorter period instead. Four years
 *  of a busy account is about 7,000. */
export const MAX_IMPORT_ROWS = 10_000;

/** The most statements (OFX) or accounts (QIF) one file may hold, and the
 *  most columns a CSV file may have. A bank's export holds a few of each; a
 *  file with more is refused before anything is built from it, so neither the
 *  answer nor the sheet's list of them can grow with a hostile file. */
export const MAX_STATEMENTS = 50;
export const MAX_CSV_COLUMNS = 200;

/** The longest single field taken: a cell, an OFX value, a QIF line. Longer is
 *  not a bank's description but a damaged or hostile file, so the row is not
 *  read, and nothing longer is kept even in its raw record. */
export const MAX_FIELD_CHARS = 1_000;

/** A field cut to MAX_FIELD_CHARS, for what is kept of a row that wasn't read. */
export function capField(s: string): string {
  return s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) : s;
}

/** The source a row imported from a file of this format carries
 *  (lib/manual-txns.ts ManualTxn.source). */
export function sourceOf(format: SourceKind): string {
  return `import:${format}`;
}
