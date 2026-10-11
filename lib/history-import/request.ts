// lib/history-import/request.ts
//
// What a request to import history into a linked account says
// (app/api/history-import), checked strictly before anything is read: every
// field's type, length, range and count, as the manual account's import route
// checks its own (app/api/import), and the same answers to a file's questions
// (lib/import/read.ts ImportOptions). Pure.

import { isCalendarDay, knownCurrency, EARLIEST_DATE } from '../manual-txn-input';
import { MAX_IMPORT_ROWS } from '../import/record';
import { DATE_ORDERS, type DateOrder } from '../import/dates';
import { COLUMN_ROLES, DELIMITERS, type CsvColumns, type Delimiter } from '../import/csv';
import type { ImportOptions } from '../import/read';
import { CONFLICT_CHOICES, PROPOSAL_CHOICES, type Choices, type HistoryChoices } from './plan';

/** The most per-row choices a request may carry: far more than the listed
 *  proposals and conflicts; the rest follow `all`. */
export const MAX_CHOICES = 5_000;
/** An account id, as Plaid writes one (and the seam takes as a field name). */
const ACCOUNT_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type HistoryMeta = {
  action: 'preview' | 'import';
  account_id: string;
  file_name: string | null;
  options: ImportOptions;
  choices: HistoryChoices;
  /** The period the person says the file covers, wider than its rows. */
  covers: { from: string; to: string } | null;
  /** The review the person saw (an import): its digest. */
  review: string | null;
  acknowledge_account: boolean;
  /** The person says the file's lines that couldn't be read aren't
   *  transactions, so its period may be drawn through (Covers.whole). */
  whole: boolean;
};

const OPTION_KEYS = new Set(['statement', 'flip', 'currency', 'date_order', 'decimal', 'csv']);

/** The answers to a file's questions, checked strictly, or why not. */
export function readOptions(v: unknown): ImportOptions | string {
  if (v === undefined || v === null) return {};
  if (!isRecord(v) || Object.keys(v).some((k) => !OPTION_KEYS.has(k))) return 'Invalid options';
  const out: ImportOptions = {};
  if (v.statement !== undefined) {
    if (typeof v.statement !== 'number' || !Number.isInteger(v.statement) || v.statement < 0 || v.statement > 999) return 'Invalid statement';
    out.statement = v.statement;
  }
  if (v.flip !== undefined) {
    if (typeof v.flip !== 'boolean') return 'Invalid options';
    out.flip = v.flip;
  }
  if (v.currency !== undefined) {
    const code = typeof v.currency === 'string' ? v.currency.trim().toUpperCase() : '';
    if (!knownCurrency(code)) return 'Enter a currency as its three-letter code, like USD or EUR';
    out.currency = code;
  }
  if (v.date_order !== undefined) {
    if (!(DATE_ORDERS as readonly unknown[]).includes(v.date_order)) return 'Invalid date order';
    out.date_order = v.date_order as DateOrder;
  }
  if (v.decimal !== undefined) {
    if (v.decimal !== '.' && v.decimal !== ',') return 'Invalid decimal mark';
    out.decimal = v.decimal;
  }
  if (v.csv !== undefined) {
    const csv = v.csv;
    if (!isRecord(csv) || Object.keys(csv).some((k) => !['delimiter', 'header_line', 'columns', 'sign'].includes(k))) return 'Invalid columns';
    if (csv.delimiter !== undefined && !(DELIMITERS as readonly unknown[]).includes(csv.delimiter)) return 'Invalid separator';
    if (csv.header_line !== undefined && (typeof csv.header_line !== 'number' || !Number.isInteger(csv.header_line) || csv.header_line < 1 || csv.header_line > 10_000_000)) {
      return 'Invalid line for the column names';
    }
    if (csv.sign !== 'negative-out' && csv.sign !== 'positive-out') return 'Say how money out is written';
    if (!isRecord(csv.columns)) return 'Invalid columns';
    const columns: Partial<CsvColumns> = {};
    for (const [role, at] of Object.entries(csv.columns)) {
      if (!(COLUMN_ROLES as readonly string[]).includes(role) || typeof at !== 'number' || !Number.isInteger(at) || at < 0 || at > 1000) return 'Invalid columns';
      columns[role as keyof CsvColumns] = at;
    }
    if (columns.date === undefined || columns.description === undefined) return 'Choose the date and description columns';
    out.csv = {
      ...(csv.delimiter !== undefined ? { delimiter: csv.delimiter as Delimiter } : {}),
      ...(csv.header_line !== undefined ? { header_line: csv.header_line as number } : {}),
      columns: columns as CsvColumns,
      sign: csv.sign,
    };
  }
  return out;
}

/** Choices of one kind, checked strictly: `all`, and `each` by the row's place
 *  among the records read. */
function readChoiceSet<T extends string>(v: unknown, allowed: readonly T[]): Choices<T> | string {
  if (v === undefined || v === null) return {};
  if (!isRecord(v) || Object.keys(v).some((k) => k !== 'all' && k !== 'each')) return 'Invalid choices';
  const out: Choices<T> = {};
  if (v.all !== undefined) {
    if (!(allowed as readonly unknown[]).includes(v.all)) return 'Invalid choices';
    out.all = v.all as T;
  }
  if (v.each !== undefined) {
    if (!isRecord(v.each)) return 'Invalid choices';
    const entries = Object.entries(v.each);
    if (entries.length > MAX_CHOICES) return 'Too many choices';
    const each: Record<string, T> = {};
    for (const [index, choice] of entries) {
      if (!/^\d{1,5}$/.test(index) || Number(index) >= MAX_IMPORT_ROWS || !(allowed as readonly unknown[]).includes(choice)) return 'Invalid choices';
      each[String(Number(index))] = choice as T;
    }
    out.each = each;
  }
  return out;
}

/** A file's name as the device gave it: no path, no control characters, and
 *  short. Shown in the list of imports; never anything else. */
export function cleanFileName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 200);
  return name || null;
}

/** The request, checked strictly, or why not. */
export function readHistoryMeta(v: unknown): HistoryMeta | string {
  if (!isRecord(v)) return 'Invalid request';
  const known = new Set(['action', 'account_id', 'file_name', 'options', 'choices', 'covers', 'review', 'acknowledge_account', 'whole']);
  if (Object.keys(v).some((k) => !known.has(k))) return 'Invalid request';
  if (v.action !== 'preview' && v.action !== 'import') return 'Invalid request';
  if (typeof v.account_id !== 'string' || !ACCOUNT_ID.test(v.account_id)) return 'Choose one of your linked accounts';
  if (v.file_name !== undefined && v.file_name !== null && typeof v.file_name !== 'string') return 'Invalid request';
  if (v.acknowledge_account !== undefined && typeof v.acknowledge_account !== 'boolean') return 'Invalid request';
  if (v.whole !== undefined && typeof v.whole !== 'boolean') return 'Invalid request';
  const options = readOptions(v.options);
  if (typeof options === 'string') return options;
  let choices: HistoryChoices = {};
  if (v.choices !== undefined && v.choices !== null) {
    if (!isRecord(v.choices) || Object.keys(v.choices).some((k) => k !== 'proposals' && k !== 'conflicts')) return 'Invalid choices';
    const proposals = readChoiceSet(v.choices.proposals, PROPOSAL_CHOICES);
    if (typeof proposals === 'string') return proposals;
    const conflicts = readChoiceSet(v.choices.conflicts, CONFLICT_CHOICES);
    if (typeof conflicts === 'string') return conflicts;
    choices = { proposals, conflicts };
  }
  let covers: HistoryMeta['covers'] = null;
  if (v.covers !== undefined && v.covers !== null) {
    const c = v.covers;
    if (!isRecord(c) || Object.keys(c).some((k) => k !== 'from' && k !== 'to') || !isCalendarDay(c.from) || !isCalendarDay(c.to) || c.from > c.to) {
      return 'Give the period the file covers as two dates, the first no later than the second';
    }
    if (c.from < EARLIEST_DATE) return `The period the file covers can’t begin before ${EARLIEST_DATE.slice(0, 4)}`;
    covers = { from: c.from, to: c.to };
  }
  let review: string | null = null;
  if (v.review !== undefined && v.review !== null) {
    if (typeof v.review !== 'string' || !/^[0-9a-f]{32}$/.test(v.review)) return 'Invalid review';
    review = v.review;
  }
  if (v.action === 'import' && review === null) return 'Review the file before importing it';
  return {
    action: v.action,
    account_id: v.account_id,
    file_name: cleanFileName(v.file_name),
    options,
    choices,
    covers,
    review,
    acknowledge_account: v.acknowledge_account === true,
    whole: v.whole === true,
  };
}
