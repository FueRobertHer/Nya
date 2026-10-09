// lib/import/normalize.ts
//
// The pipeline's normalize stage: each RawRecord, whatever its source, as the
// fields of a manual transaction (lib/manual-txn-input.ts), checked by the
// same rules a transaction entered by hand is, or the reason it can't be one.
// Pure, safe to import from client code: the import sheet shows how a file
// reads with exactly the rules the server will apply.
//
// THE RULES, as for a row typed in (app/api/manual-transactions): a real
// calendar day, from 1900 on and no later than tomorrow (the server counts
// days in UTC, and someone east of it is already in tomorrow); an amount other
// than zero, within the bound on any balance, and a whole number of its
// currency's minor units (a cent, a yen; an amount more precise than that is
// not read, never rounded); a currency this runtime knows. Text is cleaned of
// control characters and of the invisible marks that can make text display
// in another order than it is stored, and its spaces made single. A payee
// longer than a typed one may be is shortened to fit, and the row says so:
// bank descriptions run long, the full text stays in the import's raw record,
// and refusing the row would lose a real transaction over its label. A
// category or note is shortened the same way.
//
// TEXT STAYS TEXT. A description like "=HYPERLINK(...)" is stored exactly as
// written. Nothing here or downstream evaluates it; the data download's CSV
// files guard every cell that a spreadsheet would run as a formula
// (lib/csv.ts).
//
// THE CONTENT KEY: what identifies a transaction from a file without ids of
// its own (CSV, QIF), and a row entered by hand: its day, currency, amount in
// minor units and its description, normalized (lower case, letters and digits
// only, single spaces). A row imported from such a file keeps the key it was
// imported with as its source_id, so a later file with the same transaction
// finds it even after the person edited the row (lib/import/match.ts).

import {
  addDays,
  amountUnitsError,
  EARLIEST_DATE,
  isCalendarDay,
  knownCurrency,
  MAX_AMOUNT,
  MAX_CATEGORY_CHARS,
  MAX_FUTURE_DAYS,
  MAX_NOTE_CHARS,
  MAX_PAYEE_CHARS,
  minorDigits,
  type TxnFields,
} from '../manual-txn-input';
import { sourceOf, type Problem, type RawRecord } from './record';

/** A row an import would add: a manual transaction's fields, where it came
 *  from, and the source's id for it (or its content key, see the header). */
export type ImportRow = TxnFields & { source: string; source_id: string | null };

export type NormalizedRecord = {
  /** Its place among the records read, counting from 0. */
  index: number;
  line: number | null;
  record: RawRecord;
  row: ImportRow;
  /** Its payee, category or note was longer than a row's may be, and cut. */
  shortened: boolean;
};

/** Sources whose ids identify a transaction exactly (lib/import/match.ts). */
export const ID_SOURCES: ReadonlySet<string> = new Set(['import:ofx']);

// Control characters, and the marks that reorder or hide text: zero-width
// spaces and joiners, directional marks, embeddings and overrides, isolates.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Text as a row keeps it: no control characters or invisible marks, single
 *  spaces, trimmed. */
export function cleanText(s: string): string {
  return s.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

/** At most `max` characters as JavaScript counts them, never cutting a
 *  character in two. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.trim();
}

/** A description as matching compares it (see the header). */
export function normalizeDescription(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// What Intl says of each currency, worked out once: a formatter per row
// would make a large file several times slower to read.
const DIGITS = new Map<string, number>();
const KNOWN = new Map<string, boolean>();
const digitsOf = (code: string) => {
  let d = DIGITS.get(code);
  if (d === undefined) DIGITS.set(code, (d = minorDigits(code)));
  return d;
};
const isKnown = (code: string) => {
  let k = KNOWN.get(code);
  if (k === undefined) KNOWN.set(code, (k = knownCurrency(code)));
  return k;
};

/** The content key of a transaction (see the header). */
export function contentKey(t: { date: string; amount: number; currency: string; name: string }): string {
  const minor = Math.round(t.amount * 10 ** digitsOf(t.currency));
  return `${t.date}|${t.currency}|${minor}|${normalizeDescription(t.name)}`;
}

/**
 * Each record as a row, or as a problem with its line and why (see the
 * header). `today` is the server's day (UTC) on the server, the viewer's in
 * the sheet; `currency` is the import's, for records whose source didn't say.
 */
export function normalizeRecords(records: RawRecord[], opts: { today: string; currency: string }): { rows: NormalizedRecord[]; problems: Problem[] } {
  const rows: NormalizedRecord[] = [];
  const problems: Problem[] = [];
  const latest = addDays(opts.today, MAX_FUTURE_DAYS);
  records.forEach((record, index) => {
    const line = record.line ?? null;
    const fail = (reason: string) => problems.push({ line: line ?? 0, reason, raw: record.raw });
    if (!isCalendarDay(record.date)) return fail('Its date isn’t a real day.');
    if (record.date < EARLIEST_DATE) return fail(`It is dated ${record.date}, before ${EARLIEST_DATE.slice(0, 4)}.`);
    if (record.date > latest) return fail(`It is dated ${record.date}, in the future.`);
    const currency = (record.currency ?? opts.currency).trim().toUpperCase();
    if (!isKnown(currency)) return fail(`Its currency (${currency.slice(0, 12)}) isn’t one Nya knows.`);
    const amount = record.amount;
    if (!Number.isFinite(amount)) return fail('Its amount can’t be read.');
    if (amount === 0) return fail('Its amount is zero.');
    if (Math.abs(amount) > MAX_AMOUNT) return fail('Its amount is too large.');
    // Whole minor units, as lib/manual-txn-input.ts inMinorUnits checks, with
    // its message when not.
    const scale = 10 ** digitsOf(currency);
    const scaled = Math.abs(amount) * scale;
    if (Math.abs(scaled - Math.round(scaled)) >= 1e-6) return fail(`${amountUnitsError(amount, currency)}, and this one has more.`);
    const fullName = cleanText(record.description);
    if (!fullName) return fail('It has no description.');
    const fullCategory = record.category ? cleanText(record.category).toLowerCase() : '';
    const fullNote = record.note ? cleanText(record.note) : '';
    const name = cut(fullName, MAX_PAYEE_CHARS);
    const category = cut(fullCategory, MAX_CATEGORY_CHARS) || null;
    const note = cut(fullNote, MAX_NOTE_CHARS) || null;
    // Rounded to its minor unit (half away from zero), as toMinorUnits does.
    const rounded = (Math.sign(amount) * Math.round(Math.abs(amount) * scale)) / scale;
    const fields: TxnFields = { date: record.date, amount: rounded, currency, name, category, note };
    const source = sourceOf(record.source);
    // A file without ids of its own keeps the content key it was imported
    // with, from the description as the file wrote it (see the header).
    const source_id = record.source_id ?? (ID_SOURCES.has(source) ? null : contentKey({ ...fields, name: fullName }));
    rows.push({
      index,
      line,
      record,
      row: { ...fields, source, source_id },
      shortened: name !== fullName || (category ?? '') !== fullCategory || (note ?? '') !== fullNote,
    });
  });
  return { rows, problems };
}
