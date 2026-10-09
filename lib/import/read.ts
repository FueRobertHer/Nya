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

import { MAX_IMPORT_ROWS, type FileFormat, type Problem, type RawRecord } from './record';
import { detectFormat } from './text';
import { detectDateOrder, type DateDetection, type DateOrder } from './dates';
import { detectDecimalMark, type DecimalMark } from './amounts';
import { accountMask, ofxRecords, parseOfx, statementLabel, type OfxStatement } from './ofx';
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
        decimal: DecimalMark | null;
        /** OFX: most debits are positive, so the signs look reversed. */
        reversed_hint: boolean;
        table?: CsvSummary;
        /** CSV: lines with content before the column names, and where an
         *  unclosed quote stopped the reading. */
        skipped?: number;
        unterminated?: number | null;
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
  return { index: s.index, label: sectionLabel(s), kind: s.kind, account: null, currency: null, start: null, end: null, count: s.entries.length, ledger: null };
}

function summary(table: CsvTable): CsvSummary {
  return {
    delimiter: table.delimiter,
    header: table.header,
    header_line: table.header_line,
    skipped: table.skipped,
    sample: table.rows.slice(0, 8).map((r) => ({ line: r.line, cells: r.cells.map((c) => c.slice(0, 200)) })),
    rows: table.rows.length,
  };
}

/** The file read with the person's answers so far (see the header). `format`
 *  is detected from the text when not given; `thisYear` places two-digit
 *  years. */
export function readImport(text: string, opts: { format?: FileFormat; options: ImportOptions; thisYear: number }): ReadResult {
  const format = opts.format ?? detectFormat(text);
  const o = opts.options;
  if (format === 'ofx') {
    const file = parseOfx(text);
    if (file.error) return { status: 'error', format, error: file.error };
    if (file.statements.length > 1 && o.statement === undefined) return { status: 'statement', format, statements: file.statements.map(ofxInfo) };
    const s = file.statements[o.statement ?? 0];
    if (!s) return { status: 'error', format, error: 'That statement isn’t in this file. Choose the file again.' };
    if (s.transactions.length > MAX_IMPORT_ROWS) return tooMany(format);
    const read = ofxRecords(s, { flip: o.flip });
    return {
      status: 'ready',
      format,
      records: read.records,
      problems: [...file.problems, ...read.problems],
      statement: ofxInfo(s),
      read: { date_order: null, dates_ordered: false, decimal: null, reversed_hint: !o.flip && read.reversedHint },
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
    if ((detection.ambiguous || detection.mixed) && !o.date_order) return { status: 'date_order', format, detection, examples: dates.slice(0, 3) };
    const decimal = o.decimal ?? detectDecimalMark([...qifValues(s, 'T'), ...qifValues(s, 'U')]) ?? '.';
    const date_order = o.date_order ?? detection.order;
    const read = qifRecords(s, { date_order, decimal, flip: o.flip }, opts.thisYear);
    return {
      status: 'ready',
      format,
      records: read.records,
      problems: [...file.problems, ...read.problems],
      statement: file.sections.length > 1 ? qifInfo(s) : null,
      read: { date_order, dates_ordered: detection.ambiguous || detection.mixed || detection.order !== null, decimal, reversed_hint: false },
    };
  }
  const table = readCsvTable(text, { delimiter: o.csv?.delimiter, header_line: o.csv?.header_line });
  if ('error' in table) return { status: 'error', format, error: table.error };
  if (table.too_many) return tooMany(format);
  const shown = summary(table);
  if (!o.csv) return { status: 'mapping', format, table: shown, guess: guessColumns(table.header), problem: null };
  const problem = columnsProblem(o.csv.columns, table.header);
  if (problem) return { status: 'mapping', format, table: shown, guess: guessColumns(table.header), problem };
  const { columns } = o.csv;
  const dates = columnValues(table, columns.date);
  const detection = detectDateOrder(dates, opts.thisYear);
  if ((detection.ambiguous || detection.mixed) && !o.date_order) return { status: 'date_order', format, detection, examples: dates.slice(0, 3), table: shown };
  const amounts = [columns.amount, columns.debit, columns.credit].flatMap((at) => columnValues(table, at));
  // Semicolons separate fields where commas mark decimals.
  const decimal = o.decimal ?? detectDecimalMark(amounts) ?? (table.delimiter === ';' ? ',' : '.');
  const date_order = o.date_order ?? detection.order;
  const read = csvRecords(table, { columns, sign: o.csv.sign, decimal, date_order }, opts.thisYear);
  const problems = read.problems;
  if (table.unterminated !== null) {
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
      decimal,
      reversed_hint: false,
      table: shown,
      skipped: table.skipped,
      unterminated: table.unterminated,
    },
  };
}
