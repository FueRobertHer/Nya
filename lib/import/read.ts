// lib/import/read.ts
//
// A file read as far as the pipeline can take it without the account: which
// format it is in, and either its records or the one question the person must
// answer first (which statement, which columns, which order its dates are
// in). Pure, safe to import from client code: the import sheet calls this on
// the file in the browser to ask its questions and show how the first rows
// read, and app/api/import calls it again, with the answers, on the file it
// receives. Both run the same code on the same text, so the preview the
// server answers with is the one the sheet showed.
//
// THE ORDER OF NUMERIC DATES comes from the file whenever its dates settle it
// (some fit only one order): an order the person chose for an earlier file,
// remembered for the account, is only a default for a file whose dates all
// fit both, and the sheet shows it, changeable, as it shows the question. A
// file whose dates contradict each other (some fit only one order, others
// only the other) is read in the order the person chose, or failing that the
// one remembered for the account, shown and changeable the same way, and the
// dates that don't fit it are listed as lines that can't be read; with
// neither, the person is asked.
//
// WHAT AN ANSWER HOLDS is bounded whatever the file: at most MAX_STATEMENTS
// statements or accounts, MAX_CSV_COLUMNS column names of at most 100
// characters, and the first rows of a CSV file with each cell cut short, all
// without control characters, so a question the sheet asks stays small.

import { MAX_IMPORT_ROWS, type FileFormat, type Problem, type RawRecord } from './record';
import { cleanText } from './normalize';
import { detectFormat } from './text';
import { dateStyle, detectDateOrder, type DateDetection, type DateOrder, type DateStyle } from './dates';
import { detectDecimalMark, type DecimalMark } from './amounts';
import { accountMask, ofxRecords, parseOfx, repairNotes, statementLabel, type OfxStatement } from './ofx';
import { parseQif, qifRecords, qifValues, sectionLabel, type QifSection } from './qif';
import {
  columnsProblem,
  columnValues,
  csvRecords,
  guessColumns,
  readCsvTable,
  type CsvColumns,
  type CsvSign,
  type CsvTable,
  type Delimiter,
} from './csv';

/** The person's answers, and how they chose to read the file. */
export type ImportOptions = {
  /** Which statement (OFX) or account (QIF) of a file that holds several. */
  statement?: number;
  /** OFX and QIF: read every amount the other way round, for a bank that
   *  writes them so. */
  flip?: boolean;
  /** The currency of rows whose file doesn't say (CSV and QIF always, OFX
   *  without CURDEF). */
  currency?: string;
  /** The order of numeric dates, when the file's don't settle it. */
  date_order?: DateOrder;
  /** The decimal mark, when the file's amounts don't settle it, or to
   *  correct what they seemed to say. */
  decimal?: DecimalMark;
  csv?: { delimiter?: Delimiter; header_line?: number; columns: CsvColumns; sign: CsvSign };
};

/** A statement or account in a file, as the sheet lists it. */
export type StatementInfo = {
  index: number;
  label: string;
  kind: 'bank' | 'creditcard';
  /** OFX: what identifies the account it is for, never its full number. */
  account: { bank_id: string | null; mask: string | null; type: string | null } | null;
  currency: string | null;
  start: string | null;
  end: string | null;
  count: number;
  /** OFX: the statement's ledger balance as written, and the day it is as of. */
  ledger: { amount: number; as_of: string | null } | null;
};

/** A CSV file's table, as the mapping step shows it: the column names, the
 *  first rows, and what was found about it. */
export type CsvSummary = {
  delimiter: Delimiter;
  header: string[];
  header_line: number;
  skipped: number;
  sample: { line: number; cells: string[] }[];
  rows: number;
};

export type ReadResult =
  | { status: 'error'; format: FileFormat; error: string }
  | { status: 'statement'; format: FileFormat; statements: StatementInfo[] }
  | { status: 'mapping'; format: 'csv'; table: CsvSummary; guess: Partial<CsvColumns>; problem: string | null }
  | { status: 'date_order'; format: FileFormat; detection: DateDetection; examples: string[]; table?: CsvSummary }
  | {
      status: 'ready';
      format: FileFormat;
      records: RawRecord[];
      problems: Problem[];
      statement: StatementInfo | null;
      /** How it was read: what the sheet shows beside the preview. */
      read: {
        date_order: DateOrder | null;
        /** Whether the order mattered: some dates depend on one. */
        dates_ordered: boolean;
        /** Whether the order is the person's to choose: the file's dates
         *  all fit both orders, or contradict each other. When false, the
         *  file's dates settled it (or none needed one). */
        order_open: boolean;
        /** How most of the dates are written, as read (CSV and QIF). */
        date_style: DateStyle | null;
        decimal: DecimalMark | null;
        /** OFX: most debits are positive, so the signs look reversed. */
        reversed_hint: boolean;
        table?: CsvSummary;
        /** CSV: lines with content before the column names, and where an
         *  unclosed quote stopped the reading. */
        skipped?: number;
        unterminated?: number | null;
        /** OFX: where the file's structure had to be repaired, in words. */
        repairs: string[];
      };
    };

const tooMany = (format: FileFormat): ReadResult => ({
  status: 'error',
  format,
  error: `This file holds more than ${MAX_IMPORT_ROWS.toLocaleString('en-US')} transactions, which is more than one import takes. Export a shorter period and import it in parts.`,
});

function ofxInfo(s: OfxStatement): StatementInfo {
  return {
    index: s.index,
    label: statementLabel(s),
    kind: s.kind,
    account: { bank_id: s.account.bank_id, mask: accountMask(s.account.account_id), type: s.account.account_type },
    currency: s.currency,
    start: s.start,
    end: s.end,
    count: s.transactions.length,
    ledger: s.ledger,
  };
}

function qifInfo(s: QifSection): StatementInfo {
  return { index: s.index, label: shown(sectionLabel(s), 100), kind: s.kind, account: null, currency: null, start: null, end: null, count: s.entries.length, ledger: null };
}

/** Text for an answer: without control characters or invisible marks, and
 *  at most `max` characters. */
const shown = (s: string, max: number) => cleanText(s.slice(0, max * 2)).slice(0, max);

/** The first rows of a CSV file shown with its column names, and how long a
 *  cell of them may be. */
const SAMPLE_ROWS = 8;
const SAMPLE_CELL_CHARS = 80;

function summary(table: CsvTable): CsvSummary {
  return {
    delimiter: table.delimiter,
    header: table.header.map((h) => shown(h, 100)),
    header_line: table.header_line,
    skipped: table.skipped,
    sample: table.rows.slice(0, SAMPLE_ROWS).map((r) => ({ line: r.line, cells: r.cells.slice(0, table.header.length + 1).map((c) => shown(c, SAMPLE_CELL_CHARS)) })),
    rows: table.rows.length,
  };
}

/** What a table's columns say about how their dates and amounts are written,
 *  worked out once per table and column: the sheet reads a file again on
 *  every tap of its mapping step, always from the same table, and a column
 *  of 10,000 dates takes longer to scan than the rest of a tap. */
const columnCache = new WeakMap<CsvTable, Map<string, unknown>>();
function cached<T>(table: CsvTable, key: string, make: () => T): T {
  let found = columnCache.get(table);
  if (!found) columnCache.set(table, (found = new Map()));
  if (!found.has(key)) found.set(key, make());
  return found.get(key) as T;
}

/** The order to read numeric dates in (see the header): the file's own when
 *  its dates settle it, else the person's, or a question when they gave none. */
function orderOf(detection: DateDetection, chosen: DateOrder | undefined): { open: boolean; order: DateOrder | null; ask: boolean } {
  const open = detection.ambiguous || detection.mixed;
  if (!open) return { open, order: detection.order, ask: false };
  return { open, order: chosen ?? null, ask: !chosen };
}

/**
 * The file read with the person's answers so far (see the header). `format`
 * is detected from the text when not given; `thisYear` places two-digit
 * years. For the sheet, which reads a CSV file again as each answer changes:
 * `table` is the file already read as a table with the same separator and
 * header line (readCsvTable), and `limit` reads only the first rows' records
 * (the dates and amounts are still detected from every row).
 */
export function readImport(
  text: string,
  opts: { format?: FileFormat; options: ImportOptions; thisYear: number; table?: CsvTable | { error: string }; limit?: number }
): ReadResult {
  const format = opts.format ?? detectFormat(text);
  const o = opts.options;
  if (format === 'ofx') {
    const file = parseOfx(text);
    if (file.error) return { status: 'error', format, error: file.error };
    if (file.statements.length > 1 && o.statement === undefined) return { status: 'statement', format, statements: file.statements.map(ofxInfo) };
    const s = file.statements[o.statement ?? 0];
    if (!s) return { status: 'error', format, error: 'That statement isn’t in this file. Choose the file again.' };
    if (Math.max(s.transactions.length, s.listed) > MAX_IMPORT_ROWS) return tooMany(format);
    const read = ofxRecords(s, { flip: o.flip });
    return {
      status: 'ready',
      format,
      records: read.records,
      problems: [...file.problems, ...read.problems],
      statement: ofxInfo(s),
      read: {
        date_order: null,
        dates_ordered: false,
        order_open: false,
        date_style: null,
        decimal: null,
        reversed_hint: !o.flip && read.reversedHint,
        repairs: repairNotes(file.repairs),
      },
    };
  }
  if (format === 'qif') {
    const file = parseQif(text);
    if (file.error) return { status: 'error', format, error: file.error };
    if (file.sections.length > 1 && o.statement === undefined) return { status: 'statement', format, statements: file.sections.map(qifInfo) };
    const s = file.sections[o.statement ?? 0];
    if (!s) return { status: 'error', format, error: 'That account isn’t in this file. Choose the file again.' };
    if (s.entries.length > MAX_IMPORT_ROWS) return tooMany(format);
    const dates = qifValues(s, 'D');
    const detection = detectDateOrder(dates, opts.thisYear);
    const order = orderOf(detection, o.date_order);
    if (order.ask) return { status: 'date_order', format, detection, examples: dates.slice(0, 3).map((d) => shown(d, 40)) };
    const decimal = o.decimal ?? detectDecimalMark([...qifValues(s, 'T'), ...qifValues(s, 'U')]) ?? '.';
    const date_order = order.order;
    const read = qifRecords(s, { date_order, decimal, flip: o.flip }, opts.thisYear);
    return {
      status: 'ready',
      format,
      records: read.records,
      problems: [...file.problems, ...read.problems],
      statement: file.sections.length > 1 ? qifInfo(s) : null,
      read: {
        date_order,
        dates_ordered: detection.ambiguous || detection.mixed || detection.order !== null,
        order_open: order.open,
        date_style: dateStyle(dates, date_order, opts.thisYear),
        decimal,
        reversed_hint: false,
        repairs: [],
      },
    };
  }
  const table = opts.table ?? readCsvTable(text, { delimiter: o.csv?.delimiter, header_line: o.csv?.header_line });
  if ('error' in table) return { status: 'error', format, error: table.error };
  if (table.too_many) return tooMany(format);
  const sample = cached(table, 'summary', () => summary(table));
  if (!o.csv) return { status: 'mapping', format, table: sample, guess: guessColumns(table.header), problem: null };
  const problem = columnsProblem(o.csv.columns, table.header);
  if (problem) return { status: 'mapping', format, table: sample, guess: guessColumns(table.header), problem };
  const { columns } = o.csv;
  const dates = cached(table, `dates ${columns.date}`, () => columnValues(table, columns.date));
  const detection = cached(table, `order ${columns.date} ${opts.thisYear}`, () => detectDateOrder(dates, opts.thisYear));
  const order = orderOf(detection, o.date_order);
  if (order.ask) return { status: 'date_order', format, detection, examples: dates.slice(0, 3).map((d) => shown(d, 40)), table: sample };
  const amountColumns = [columns.amount, columns.debit, columns.credit];
  // Semicolons separate fields where commas mark decimals.
  const found = cached(table, `decimal ${amountColumns.join(' ')}`, () => detectDecimalMark(amountColumns.flatMap((at) => columnValues(table, at))));
  const decimal = o.decimal ?? found ?? (table.delimiter === ';' ? ',' : '.');
  const date_order = order.order;
  const rows = opts.limit === undefined ? table : { ...table, rows: table.rows.slice(0, opts.limit) };
  const read = csvRecords(rows, { columns, sign: o.csv.sign, decimal, date_order }, opts.thisYear);
  const problems = read.problems;
  if (table.unterminated !== null && opts.limit === undefined) {
    problems.push({ line: table.unterminated, reason: 'A quote opened on this line is never closed, so nothing from here on could be read.' });
  }
  return {
    status: 'ready',
    format,
    records: read.records,
    problems,
    statement: null,
    read: {
      date_order,
      dates_ordered: detection.ambiguous || detection.mixed || detection.order !== null,
      order_open: order.open,
      date_style: cached(table, `style ${columns.date} ${date_order} ${opts.thisYear}`, () => dateStyle(dates, date_order, opts.thisYear)),
      decimal,
      reversed_hint: false,
      table: sample,
      skipped: table.skipped,
      unterminated: table.unterminated,
      repairs: [],
    },
  };
}
