// lib/import/csv.ts
//
// CSV exports, the fallback every bank offers (#43). Unlike OFX there is no
// schema: each bank names and orders its columns its own way, so the person
// maps them in the import sheet (date, description, and either one amount
// column or separate money-out and money-in columns; optionally a category,
// notes and a currency), and the mapping is remembered per account, so the
// next file from the same bank imports in one tap. Pure, safe to import from
// client code.
//
// READING (RFC 4180, tolerant): fields separated by commas, semicolons, tabs
// or vertical bars, whichever splits the first lines most consistently (the
// sheet can change it); a quoted field may hold the separator, a doubled
// quote and line breaks; spaces before an opening quote and text after a
// closing one are kept as part of the field rather than failing the file;
// lines end in CRLF, LF or a lone CR; blank lines are skipped. A quote that
// is never closed would swallow the rest of the file, so the file stops being
// read there, and says so.
//
// THE COLUMN NAMES are required: the first line that is as wide as the widest
// lines near the top of the file, so a bank's summary lines above the table
// (an account number, a date range) are skipped and counted. The sheet can
// pick another line. A data line with more fields than there are columns is
// not read (an unquoted separator in a description would shift every column
// after it, and a shifted amount column reads as a wrong amount); one with
// fewer is read with the missing fields empty, as some exporters drop
// trailing empty fields.
//
// SIGNS. With one amount column, the person says whether money out is written
// negative (most bank accounts) or positive (many card exports), and the
// preview shows how the first rows read; a CR or DR after an amount says its
// direction outright. With separate columns, the column says the direction
// and the amount's own sign is ignored.

import { capField, MAX_FIELD_CHARS, MAX_IMPORT_ROWS, type Problem, type RawRecord } from './record';
import { dateFor, DATE_ORDER_NAMES, type DateOrder } from './dates';
import { readAmount, type DecimalMark } from './amounts';

export type Delimiter = ',' | ';' | '\t' | '|';
export const DELIMITERS: readonly Delimiter[] = [',', ';', '\t', '|'];
export const DELIMITER_NAMES: Record<Delimiter, string> = { ',': 'commas', ';': 'semicolons', '\t': 'tabs', '|': 'vertical bars' };

export type CsvRow = { line: number; cells: string[] };

/** Line breaks in a piece of text: CRLF once, a lone CR or LF each once. */
function breaks(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10) n++;
    else if (c === 13 && s.charCodeAt(i + 1) !== 10) n++;
  }
  return n;
}

/**
 * The text split into records (see the header), at most `limit` of them:
 * each with the line it starts on. `unterminated` is the line of a quote that
 * is never closed, where reading stopped.
 */
export function splitCsv(text: string, delimiter: Delimiter, limit: number = Infinity): { rows: CsvRow[]; unterminated: number | null; more: boolean } {
  const rows: CsvRow[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  /** The end of an unquoted run: the next separator or line break. */
  const runEnd = (from: number) => {
    let j = from;
    while (j < n) {
      const c = text[j];
      if (c === delimiter || c === '\n' || c === '\r') break;
      j++;
    }
    return j;
  };
  while (i < n) {
    if (rows.length >= limit) return { rows, unterminated: null, more: true };
    const start = line;
    const cells: string[] = [];
    for (;;) {
      let field = '';
      // Spaces before an opening quote belong to no field.
      let j = i;
      while (text[j] === ' ') j++;
      if (text[j] === '"') {
        i = j + 1;
        let closed = false;
        while (i < n) {
          const q = text.indexOf('"', i);
          if (q < 0) break;
          const part = text.slice(i, q);
          field += part;
          line += breaks(part);
          if (text[q + 1] === '"') {
            field += '"';
            i = q + 2;
            continue;
          }
          i = q + 1;
          closed = true;
          break;
        }
        if (!closed) return { rows, unterminated: start, more: false };
        // Anything after the closing quote, up to the separator, is kept.
        const end = runEnd(i);
        field += text.slice(i, end);
        i = end;
      } else {
        const end = runEnd(i);
        field = text.slice(i, end);
        i = end;
      }
      cells.push(field);
      if (i >= n) break;
      const c = text[i];
      if (c === delimiter) {
        i++;
        // A separator at the very end of the text leaves one empty field.
        if (i >= n) {
          cells.push('');
          break;
        }
        continue;
      }
      // A line break ends the record.
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line++;
      break;
    }
    if (cells.some((c) => c.trim() !== '')) rows.push({ line: start, cells });
  }
  return { rows, unterminated: null, more: false };
}

/** A row's width: its fields, less the empty ones at its end. */
function width(cells: string[]): number {
  let w = cells.length;
  while (w > 0 && cells[w - 1].trim() === '') w--;
  return w;
}

/** The separator that splits the first lines most consistently into more
 *  than one field: most rows of one width, then the widest. */
export function detectDelimiter(text: string): Delimiter {
  const sample = text.slice(0, 64 * 1024);
  let best: Delimiter = ',';
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const widths = splitCsv(sample, d, 40).rows.map((r) => width(r.cells));
    const counts = new Map<number, number>();
    for (const w of widths) if (w > 1) counts.set(w, (counts.get(w) ?? 0) + 1);
    let score = 0;
    for (const [w, c] of counts) score = Math.max(score, c * 1000 + w);
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** The line holding the column names (see the header): the first among the
 *  top rows as wide as the widest width at least two of them share. */
function headerIndex(rows: CsvRow[]): number {
  const top = rows.slice(0, 50).map((r) => width(r.cells));
  const counts = new Map<number, number>();
  for (const w of top) counts.set(w, (counts.get(w) ?? 0) + 1);
  const shared = [...counts].filter(([, c]) => c >= 2).map(([w]) => w);
  const wide = shared.length > 0 ? Math.max(...shared) : Math.max(0, ...top);
  const at = top.findIndex((w) => w >= wide);
  return at < 0 ? 0 : at;
}

export type CsvTable = {
  delimiter: Delimiter;
  /** The column names, trimmed: an empty one is named by its place, and a
   *  repeated one numbered. */
  header: string[];
  header_line: number;
  /** Lines with content before the column names, skipped. */
  skipped: number;
  rows: CsvRow[];
  /** Where a quote opened and was never closed, so reading stopped there. */
  unterminated: number | null;
  /** More rows than a file may hold (MAX_IMPORT_ROWS). */
  too_many: boolean;
};

/**
 * The file as a table: its separator (detected unless given), the column
 * names (on the line given, else found as the header says), and the rows
 * after them. An error, in words for the person, when it isn't a table of
 * transactions at all.
 */
export function readCsvTable(text: string, opts: { delimiter?: Delimiter; header_line?: number } = {}): CsvTable | { error: string } {
  const delimiter = opts.delimiter ?? detectDelimiter(text);
  // Enough rows to tell a file over the limit, and no more: a file of nothing
  // but line breaks and separators is bounded by its size, and stops here.
  const split = splitCsv(text, delimiter, MAX_IMPORT_ROWS + 200);
  const rows = split.rows;
  if (rows.length === 0) {
    return { error: split.unterminated !== null ? `A quote opened on line ${split.unterminated} is never closed, so nothing could be read.` : 'This file is empty.' };
  }
  let at = headerIndex(rows);
  if (opts.header_line !== undefined) {
    at = rows.findIndex((r) => r.line === opts.header_line);
    if (at < 0) return { error: `Line ${opts.header_line} has no column names.` };
  }
  const names = rows[at].cells.slice(0, width(rows[at].cells));
  if (names.length < 3) {
    return { error: 'This doesn’t look like a table of transactions: it needs at least a date, a description and an amount in columns of their own.' };
  }
  const seen = new Map<string, number>();
  const header = names.map((raw, i) => {
    const base = raw.trim().slice(0, 100) || `Column ${i + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} (${n})`;
  });
  const data = rows.slice(at + 1);
  return {
    delimiter,
    header,
    header_line: rows[at].line,
    skipped: at,
    rows: data.slice(0, MAX_IMPORT_ROWS + 1),
    unterminated: split.unterminated,
    too_many: data.length > MAX_IMPORT_ROWS || split.more,
  };
}

/** Which column holds what: by its place in the header. */
export type CsvColumns = {
  date: number;
  description: number;
  /** One column of amounts, signed (see `sign`). */
  amount?: number;
  /** Separate columns: money out, and money in. */
  debit?: number;
  credit?: number;
  category?: number;
  note?: number;
  currency?: number;
};

export const COLUMN_ROLES = ['date', 'description', 'amount', 'debit', 'credit', 'category', 'note', 'currency'] as const;
export type ColumnRole = (typeof COLUMN_ROLES)[number];

/** How money out is written in one amount column. */
export type CsvSign = 'negative-out' | 'positive-out';

export type CsvReadOptions = {
  columns: CsvColumns;
  sign: CsvSign;
  decimal: DecimalMark;
  date_order: DateOrder | null;
};

/** What is wrong with a mapping for this header, in words, or null. */
export function columnsProblem(columns: CsvColumns, header: string[]): string | null {
  const roles = COLUMN_ROLES.filter((r) => columns[r] !== undefined);
  for (const r of roles) {
    const at = columns[r]!;
    if (!Number.isInteger(at) || at < 0 || at >= header.length) return 'Choose the columns again: one of them isn’t in this file.';
  }
  const used = roles.map((r) => columns[r]);
  if (new Set(used).size !== used.length) return 'Each column can only be used once.';
  const separate = columns.debit !== undefined || columns.credit !== undefined;
  if (columns.amount !== undefined && separate) return 'Choose one amount column, or separate money-out and money-in columns, not both.';
  if (columns.amount === undefined && (columns.debit === undefined || columns.credit === undefined)) {
    return separate ? 'Choose both the money-out and the money-in column.' : 'Choose the amount column.';
  }
  return null;
}

/** The cell of a row in a column, trimmed; empty when the row is short. */
const cell = (row: CsvRow, at: number | undefined) => (at === undefined ? '' : (row.cells[at] ?? '').trim());

/**
 * The table's rows as RawRecords, read with the mapping, and the rows that
 * can't be read, each with its line and why. `thisYear` places two-digit
 * years (lib/import/dates.ts).
 */
export function csvRecords(table: CsvTable, opts: CsvReadOptions, thisYear: number): { records: RawRecord[]; problems: Problem[] } {
  const records: RawRecord[] = [];
  const problems: Problem[] = [];
  const { columns } = opts;
  const columnsCount = table.header.length;
  // How many fields most lines have: the columns, or one more on a file that
  // ends every line with a separator.
  const counts = new Map<number, number>();
  for (const r of table.rows) counts.set(r.cells.length, (counts.get(r.cells.length) ?? 0) + 1);
  const usual = Math.max(columnsCount, [...counts].reduce((best, [n, c]) => (c > best[1] ? [n, c] : best), [0, 0])[0]);
  const separator = table.delimiter === '\t' ? 'tab' : `"${table.delimiter}"`;
  for (const row of table.rows) {
    const raw = row.cells.map(capField);
    const fail = (reason: string) => problems.push({ line: row.line, reason, raw });
    if (row.cells.some((c) => c.length > MAX_FIELD_CHARS)) {
      fail(`A field on this line is over ${MAX_FIELD_CHARS.toLocaleString('en-US')} characters long, so it can’t be read.`);
      continue;
    }
    // A line wider than the rest has a separator its fields shouldn't: every
    // field after it would be read from the wrong column.
    const w = width(row.cells);
    if (w > columnsCount) {
      fail(`This line has ${w} fields, but there are ${columnsCount} columns: a description may hold an unquoted ${separator}.`);
      continue;
    }
    if (row.cells.length > usual) {
      fail(`This line has ${row.cells.length} fields where the others have ${usual}: a description may hold an unquoted ${separator}.`);
      continue;
    }
    const dateText = cell(row, columns.date);
    if (!dateText) {
      fail('It has no date.');
      continue;
    }
    const date = dateFor(dateText, opts.date_order, thisYear);
    if (!date) {
      fail(`Its date (${dateText.slice(0, 40)}) can’t be read${opts.date_order ? ` as ${DATE_ORDER_NAMES[opts.date_order]}` : ''}.`);
      continue;
    }
    let amount: number;
    if (columns.amount !== undefined) {
      const text = cell(row, columns.amount);
      const read = text ? readAmount(text, opts.decimal) : null;
      if (!read) {
        fail(text ? `Its amount (${text.slice(0, 40)}) can’t be read.` : 'It has no amount.');
        continue;
      }
      // Plaid's sign: positive is money out.
      if (read.direction) amount = read.direction === 'out' ? Math.abs(read.value) : -Math.abs(read.value);
      else amount = opts.sign === 'negative-out' ? -read.value : read.value;
    } else {
      const outText = cell(row, columns.debit);
      const inText = cell(row, columns.credit);
      const out = outText ? readAmount(outText, opts.decimal) : null;
      const into = inText ? readAmount(inText, opts.decimal) : null;
      if ((outText && !out) || (inText && !into)) {
        fail(`Its amount (${(outText && !out ? outText : inText).slice(0, 40)}) can’t be read.`);
        continue;
      }
      const o = out ? Math.abs(out.value) : 0;
      const n = into ? Math.abs(into.value) : 0;
      if (o !== 0 && n !== 0) {
        fail('It has both money out and money in.');
        continue;
      }
      if (!out && !into) {
        fail('It has no amount.');
        continue;
      }
      amount = o !== 0 ? o : -n;
    }
    const note = cell(row, columns.note) || null;
    const description = cell(row, columns.description) || note || '';
    const currency = cell(row, columns.currency).toUpperCase();
    records.push({
      source: 'csv',
      date,
      amount,
      description,
      raw,
      ...(currency ? { currency } : {}),
      category: cell(row, columns.category) || null,
      note: description === note ? null : note,
      line: row.line,
    });
  }
  return { records, problems };
}

// ---- Proposing a mapping ----

const NAMES: Record<ColumnRole, RegExp[]> = {
  // Most specific first: the first pattern a column matches decides.
  date: [
    /^date$/,
    /^(transaction|trans\.?|txn|booking|buchungs?)[ _-]?(date|tag|datum)$/,
    /^(buchung|buchungstag|datum|fecha|data|date op[ée]ration)$/,
    /^(posted|posting|post|value)[ _-]?date$/,
    /^(valuta|wertstellung)$/,
    /date|datum|fecha/,
  ],
  description: [/^(description|payee|merchant|name|details|narrative|transaction|beschreibung|auftraggeber\/empf[aä]nger|empf[aä]nger|concepto|libell[ée])$/, /description|payee|merchant|beschreibung|empf[aä]nger|concepto|libell/],
  amount: [/^(amount|betrag|importe|montant|value|sum|transaction amount)$/, /^amount\b|amount$|betrag|importe|montant/],
  debit: [/^(debit|debits|withdrawal|withdrawals|money out|paid out|outflow|spent|soll|ausgang)$/, /debit|withdrawal|money out|paid out|outflow/],
  credit: [/^(credit|credits|deposit|deposits|money in|paid in|inflow|received|haben|eingang)$/, /credit|deposit|money in|paid in|inflow/],
  category: [/^(category|categories|kategorie|categor[ií]a|cat[ée]gorie)$/, /category|kategorie/],
  note: [/^(memo|notes?|verwendungszweck)$/, /^(reference|referenz|buchungstext)$/, /memo|note|verwendungszweck/],
  currency: [/^(currency|ccy|currency code|w[aä]hrung|moneda|devise)$/, /currency|w[aä]hrung/],
};

/**
 * A mapping proposed from the column names, as far as they say: only roles
 * whose column is plain from its name, never two roles on one column. The
 * sheet shows it for the person to check.
 */
export function guessColumns(header: string[]): Partial<CsvColumns> {
  const names = header.map((h) => h.trim().toLowerCase().replace(/\s*\(\d+\)$/, ''));
  const taken = new Set<number>();
  const out: Partial<CsvColumns> = {};
  for (const role of COLUMN_ROLES) {
    for (const pattern of NAMES[role]) {
      const at = names.findIndex((n, i) => !taken.has(i) && pattern.test(n));
      if (at >= 0) {
        out[role] = at;
        taken.add(at);
        break;
      }
    }
  }
  // One amount column, or both separate ones; never a mix.
  if (out.debit !== undefined && out.credit !== undefined) delete out.amount;
  else {
    delete out.debit;
    delete out.credit;
  }
  return out;
}

/** A mapping by column name, as it is remembered for an account. */
export type NamedColumns = Partial<Record<ColumnRole, string>>;

export function namesOf(columns: CsvColumns, header: string[]): NamedColumns {
  const out: NamedColumns = {};
  for (const role of COLUMN_ROLES) if (columns[role] !== undefined) out[role] = header[columns[role]!];
  return out;
}

/** A remembered mapping applied to this file's header: every column it names
 *  must be there (by name, ignoring case and spaces at the ends), else null. */
export function columnsFromNames(named: NamedColumns, header: string[]): CsvColumns | null {
  const find = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase());
  const out: Partial<CsvColumns> = {};
  for (const role of COLUMN_ROLES) {
    const name = named[role];
    if (name === undefined) continue;
    const at = find(name);
    if (at < 0) return null;
    out[role] = at;
  }
  if (out.date === undefined || out.description === undefined) return null;
  const columns = out as CsvColumns;
  return columnsProblem(columns, header) ? null : columns;
}

/** The values of a column, for detecting how its dates or amounts are written. */
export function columnValues(table: CsvTable, at: number | undefined): string[] {
  if (at === undefined) return [];
  return table.rows.map((r) => (r.cells[at] ?? '').trim()).filter((v) => v !== '');
}
