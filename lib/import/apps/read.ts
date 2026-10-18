// lib/import/apps/read.ts
//
// Another app's export read as far as it can be without the person's Nya
// accounts and categories: which app it is from, the one question to answer
// first when there is one (which column is which, for a header this code
// doesn't know; which order the dates are in, when the file's own dates don't
// settle it), and otherwise every transaction in it (lib/import/apps/
// types.ts AppTxn) with the lines that couldn't be read. Pure, safe to import
// from client code; app/api/migration runs it on the file it receives, for the
// review and again for the import, so both read the same.
//
// THE SIGN OF LUNCH MONEY'S AMOUNTS. Its export has one amount column, and
// nothing in this code's sources pins which way it is written (its API keeps
// a debit positive). So it is read Lunch Money's way unless the file's own
// income rows (a category group named Income) come out mostly as money out
// that way, which says it is written the other way; the review shows which,
// and why, and the person can turn it round (`sign`).

import { detectDecimalMark } from '../amounts';
import { cleanText } from '../normalize';
import { columnValues, readCsvTable, type CsvSign, type CsvTable } from '../csv';
import { dateStyle, detectDateOrder, type DateDetection, type DateOrder, type DateStyle } from '../dates';
import { amountTexts, mappingProblem, type Parsed } from './common';
import { columnsFor, detectApp, specOf } from './detect';
import type { AppColumns, AppId, AppReadOptions } from './types';

/** The most rows one export may hold: every account's years of history at
 *  once, within the request's 3 MB (about 100 characters a row). Each account
 *  it goes into takes at most MAX_IMPORT_ROWS of them (lib/migration/plan.ts). */
export const MAX_APP_ROWS = 30_000;

/** The column names and first rows of a file, for the mapping step: every
 *  cell cut short and cleaned, so a question stays small whatever the file. */
export type TableSample = { header: string[]; sample: { line: number; cells: string[] }[]; rows: number };

const SAMPLE_ROWS = 6;
const shown = (s: string, max: number) => cleanText(s.slice(0, max * 2)).slice(0, max);

function sampleOf(table: CsvTable): TableSample {
  return {
    header: table.header.map((h) => shown(h, 100)),
    sample: table.rows.slice(0, SAMPLE_ROWS).map((r) => ({ line: r.line, cells: r.cells.slice(0, table.header.length).map((c) => shown(c, 60)) })),
    rows: table.rows.length,
  };
}

export type AppRead =
  | { status: 'error'; error: string }
  /** The header isn't one this code knows (or the person's mapping lacks
   *  something): which app, and which column is which. */
  | { status: 'mapping'; app: AppId | null; columns: AppColumns; table: TableSample; problem: string | null }
  | { status: 'date_order'; app: AppId; detection: DateDetection; examples: string[] }
  | {
      status: 'ready';
      app: AppId;
      /** Whether the header said which app (else the person did). */
      detected: boolean;
      columns: AppColumns;
      header: string[];
      parsed: Parsed;
      read: {
        date_order: DateOrder | null;
        /** The order was the person's to choose (the dates fit both, or
         *  contradict each other). */
        order_open: boolean;
        date_style: DateStyle | null;
        decimal: '.' | ',';
        /** How a one-column amount was read, and why: the app's own way, the
         *  file's income rows, or the person's choice. Null for an app with
         *  money out and in in columns of their own. */
        sign: CsvSign | null;
        sign_from: 'app' | 'file' | 'chosen' | null;
        delimiter: string;
        header_line: number;
        skipped: number;
      };
    };

/**
 * The file read with the person's answers so far (see the header). `thisYear`
 * places two-digit years.
 */
export function readAppFile(text: string, opts: { options: AppReadOptions; thisYear: number }): AppRead {
  const o = opts.options;
  const table = readCsvTable(text, { max_rows: MAX_APP_ROWS });
  if ('error' in table) return { status: 'error', error: table.error };
  if (table.too_many) {
    return {
      status: 'error',
      error: `This file holds more than ${MAX_APP_ROWS.toLocaleString('en-US')} transactions, more than one import takes. Export a shorter period, or some of its accounts at a time, and import it in parts.`,
    };
  }
  if (table.unterminated !== null) {
    return { status: 'error', error: `A quote opened on line ${table.unterminated} is never closed, so the file can’t be read past it. Export it again.` };
  }

  // Which app: the person's answer, else the header's.
  let app: AppId;
  let columns: AppColumns;
  let detected = false;
  if (o.app) {
    app = o.app;
    columns = o.columns ?? columnsFor(app, table.header);
  } else {
    const found = detectApp(table.header);
    if (!found) return { status: 'mapping', app: null, columns: {}, table: sampleOf(table), problem: null };
    app = found.app;
    columns = o.columns ?? found.columns;
    detected = !o.columns;
  }
  const spec = specOf(app);
  const problem = mappingProblem(spec, columns, table.header.length);
  if (problem) return { status: 'mapping', app, columns, table: sampleOf(table), problem };

  // The order of the dates: the file's when its dates settle it.
  const dates = columnValues(table, columns.date);
  const detection = detectDateOrder(dates, opts.thisYear);
  const open = detection.ambiguous || detection.mixed;
  const date_order = open ? (o.date_order ?? null) : detection.order;
  if (open && !date_order) return { status: 'date_order', app, detection, examples: dates.slice(0, 3).map((d) => shown(d, 40)) };

  const decimal = o.decimal ?? detectDecimalMark(amountTexts(table.rows, columns, spec.amounts)) ?? (table.delimiter === ';' ? ',' : '.');
  const ctx = (sign: CsvSign) => ({ header: table.header, date_order, decimal, sign, thisYear: opts.thisYear });

  let parsed: Parsed;
  let sign: CsvSign | null = null;
  let sign_from: 'app' | 'file' | 'chosen' | null = null;
  if (spec.sign) {
    parsed = spec.parse(table.rows, columns, ctx(spec.sign));
    if (o.sign) {
      sign = o.sign;
      sign_from = 'chosen';
    } else {
      // The file's income rows, read the app's way: mostly money out says
      // the file is written the other way round.
      const income = parsed.txns.filter((t) => t.category?.kind === 'income');
      const out = income.filter((t) => t.amount > 0).length;
      const flipped = income.length > 0 && out > income.length / 2;
      sign = flipped ? (spec.sign === 'positive-out' ? 'negative-out' : 'positive-out') : spec.sign;
      sign_from = flipped ? 'file' : 'app';
    }
    if (sign !== spec.sign) parsed = spec.parse(table.rows, columns, ctx(sign));
  } else {
    parsed = spec.parse(table.rows, columns, ctx('negative-out'));
  }

  return {
    status: 'ready',
    app,
    detected,
    columns,
    header: table.header,
    parsed,
    read: {
      date_order,
      order_open: open,
      date_style: dateStyle(dates, date_order, opts.thisYear),
      decimal,
      sign,
      sign_from,
      delimiter: table.delimiter,
      header_line: table.header_line,
      skipped: table.skipped,
    },
  };
}
