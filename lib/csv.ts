// lib/csv.ts
//
// CSV for the download of my data (lib/user-export.ts): RFC 4180, with a guard
// against spreadsheet formula injection. No dependencies, so it is easy to
// read whole.
//
// RFC 4180: every record ends in CRLF, and a field holding a comma, a double
// quote, a CR or an LF is enclosed in double quotes, with each double quote
// inside it doubled. Nothing else is quoted.
//
// UTF-8, starting with a byte order mark (UTF8_BOM). These files are offered
// for a spreadsheet, and Excel on Windows reads a CSV without one in the
// system's old code page, garbling every accented or non-Latin merchant name.
// Spreadsheets and most CSV readers drop the mark; a script reading the file
// as plain UTF-8 may need to (Python's "utf-8-sig" does).
//
// THE GUARD. A spreadsheet that opens a CSV runs a cell starting with =, +, -
// or @ as a formula, and a leading tab or carriage return can smuggle one in
// too. Merchant names and bank descriptors come from banks, and from whoever
// named the merchant, so a transaction can carry "=HYPERLINK(...)" or worse.
// Such a cell gets a ' in front, which makes a spreadsheet treat the rest as
// text. A number is the one exception: -12.5 is an amount, not a formula, and
// prefixing it would stop it adding up. Only text that is exactly a number,
// as JavaScript writes one, counts.

export type CsvValue = string | number | boolean | null | undefined;

/** What a CSV file starts with (see the header). */
export const UTF8_BOM = '\uFEFF';

/** Starts a cell a spreadsheet may run as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;
/** A plain number, as String() writes a finite one. */
const NUMBER = /^-?\d+(\.\d+)?(e[-+]\d+)?$/;

/** One field: guarded, then quoted if it needs to be. Empty for null, and for a
 *  number that isn't finite, which no amount should ever be. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value);
  if (FORMULA_START.test(text) && !NUMBER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One record, with its CRLF. */
export function csvRow(values: readonly CsvValue[]): string {
  return values.map(csvCell).join(',') + '\r\n';
}
