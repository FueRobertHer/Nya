// lib/import/apps/common.ts
//
// What every app's export reader shares: matching column names, reading an
// amount the way these apps write them, splitting a cell of tags, and telling
// a transfer between the person's own accounts by the account it names. Pure,
// safe to import from client code.

import { readAmount, type DecimalMark } from '../amounts';
import { capField, MAX_FIELD_CHARS, type Problem } from '../record';
import { cleanText } from '../normalize';
import { dateFor, DATE_ORDER_NAMES, type DateOrder } from '../dates';
import type { CsvRow, CsvSign } from '../csv';
import type { AppColumns, AppId, AppRole, AppTxn, SplitReport } from './types';

/** A line that couldn't be read, with the account it is on when that could
 *  be read: an import into that account says its file had lines it lacks. */
export type AppProblem = Problem & { account: string | null };

/** What reading an export's rows needs to know. */
export type ParseContext = {
  header: readonly string[];
  date_order: DateOrder | null;
  decimal: DecimalMark;
  sign: CsvSign;
  thisYear: number;
};

/** What an app's reader makes of its rows. */
export type Parsed = {
  txns: AppTxn[];
  problems: AppProblem[];
  splits: SplitReport;
  /** Which of the app's export formats it is, for the review and the import's
   *  record ("register", "register-ynab4", "query-2026"). */
  variant: string;
  /** What the person should know about this export, in words. */
  notes: string[];
};

/** One app's export: the names its columns go by, how to tell its header,
 *  what the reader needs, and the reader. */
export type AppSpec = {
  app: AppId;
  aliases: Aliases;
  /** Whether a header is this app's, from the roles found by its aliases and
   *  every column name (headerKey). */
  recognises: (found: AppColumns, keys: ReadonlySet<string>) => boolean;
  /** The roles a mapping must give (an inner list is "one of these"). */
  required: readonly (AppRole | readonly AppRole[])[];
  /** The columns its amounts are in, for the decimal mark. */
  amounts: readonly AppRole[];
  /** It has one signed amount column whose direction the person confirms
   *  (Lunch Money's), and the way it is written unless they say otherwise. */
  sign?: CsvSign;
  parse: (rows: readonly CsvRow[], columns: AppColumns, ctx: ParseContext) => Parsed;
};

/** What a mapping lacks for this app, in words, or null. */
export function mappingProblem(spec: AppSpec, columns: AppColumns, width: number): string | null {
  for (const [role, at] of Object.entries(columns)) {
    if (!Number.isInteger(at) || (at as number) < 0 || (at as number) >= width) return 'Choose the columns again: one of them isn’t in this file.';
    void role;
  }
  const used = Object.values(columns);
  if (new Set(used).size !== used.length) return 'Each column can only be used once.';
  for (const need of spec.required) {
    const any = typeof need === 'string' ? [need] : need;
    if (!any.some((r) => columns[r] !== undefined)) return `Choose the ${any.map((r) => ROLE_WORDS[r]).join(' or the ')} column.`;
  }
  return null;
}

/** Roles in a sentence ("Choose the date column"). */
const ROLE_WORDS: Record<AppRole, string> = {
  date: 'date',
  account: 'account',
  payee: 'payee',
  amount: 'amount',
  outflow: 'outflow',
  inflow: 'inflow',
  category: 'category',
  group: 'category group',
  group_category: 'group and category',
  notes: 'notes',
  tags: 'tags',
  currency: 'currency',
  original: 'original description',
  flag: 'flag',
  type: 'type',
  parent: 'split parent',
  id: 'transaction id',
  split_amount: 'split amount',
};

/** A line's fields, read as every app's are, or why the line can't be read:
 *  too long a field, more fields than columns (an unquoted separator would
 *  shift every field after it), or a date that isn't one. */
export function readLine(
  row: CsvRow,
  columns: AppColumns,
  ctx: ParseContext
): { ok: true; date: string; account: string } | { ok: false; problem: AppProblem } {
  const raw = rawCells(row);
  const account = cleanText(cellOf(row, columns, 'account'));
  const fail = (reason: string) => ({ ok: false as const, problem: { line: row.line, reason, raw, account: account || null } });
  if (row.cells.some((c) => c.length > MAX_FIELD_CHARS)) return fail(`A field on this line is over ${MAX_FIELD_CHARS.toLocaleString('en-US')} characters long, so it can’t be read.`);
  let w = row.cells.length;
  while (w > 0 && row.cells[w - 1].trim() === '') w--;
  if (w > ctx.header.length) return fail(`This line has ${w} fields, but there are ${ctx.header.length} columns: a field may hold an unquoted separator.`);
  const text = cellOf(row, columns, 'date');
  if (!text) return fail('It has no date.');
  const date = dateFor(text, ctx.date_order, ctx.thisYear);
  if (!date) return fail(`Its date (${text.slice(0, 40)}) can’t be read${ctx.date_order ? ` as ${DATE_ORDER_NAMES[ctx.date_order]}` : ''}.`);
  return { ok: true, date, account };
}

/** A line's problem with its account, for a reader's own checks. */
export const problemOf = (row: CsvRow, columns: AppColumns, reason: string): AppProblem => ({
  line: row.line,
  reason,
  raw: rawCells(row),
  account: cleanText(cellOf(row, columns, 'account')) || null,
});

/** Money out and money in in separate columns (YNAB, ZeroSum), as Plaid's
 *  sign: positive is money out. Null, with why, when neither reads. */
export function outIn(row: CsvRow, columns: AppColumns, decimal: DecimalMark): { amount: number } | { reason: string } {
  const outText = cellOf(row, columns, 'outflow');
  const inText = cellOf(row, columns, 'inflow');
  const out = outText ? appAmount(outText, decimal) : 0;
  const into = inText ? appAmount(inText, decimal) : 0;
  if (out === null) return { reason: `Its outflow (${outText.slice(0, 40)}) can’t be read.` };
  if (into === null) return { reason: `Its inflow (${inText.slice(0, 40)}) can’t be read.` };
  if (!outText && !inText) return { reason: 'It has no amount.' };
  return { amount: Math.round((out - into) * 1e8) / 1e8 };
}

/** A column name as the readers compare it: Unicode-normalized, lower case,
 *  spaces, underscores and hyphens as one space ("Category_Group" and
 *  "Category Group" are one name). */
export function headerKey(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/^﻿/, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

/** The names a role's column goes by in one app's export, most specific
 *  first. */
export type Aliases = Partial<Record<AppRole, readonly string[]>>;

/** Each role's column in this header by its aliases (see headerKey), never
 *  two roles on one column. */
export function columnsByAlias(header: readonly string[], aliases: Aliases): AppColumns {
  const keys = header.map((h) => headerKey(h.replace(/\s*\(\d+\)$/, '')));
  const taken = new Set<number>();
  const out: AppColumns = {};
  for (const [role, names] of Object.entries(aliases) as [AppRole, readonly string[]][]) {
    for (const name of names) {
      const at = keys.findIndex((k, i) => !taken.has(i) && k === name);
      if (at >= 0) {
        out[role] = at;
        taken.add(at);
        break;
      }
    }
  }
  return out;
}

/** A row's cell in a role's column, trimmed; empty when there is none. An app
 *  that guards a cell a spreadsheet would run as a formula with a leading
 *  apostrophe (Actual Budget since 2026) has it taken off again, so the text
 *  is what the person wrote. */
export function cellOf(row: CsvRow, columns: AppColumns, role: AppRole): string {
  const at = columns[role];
  if (at === undefined) return '';
  const text = (row.cells[at] ?? '').trim();
  return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
}

/** A currency written beside an amount as letters ("kr", "CHF", "zł"): what
 *  YNAB and ZeroSum write in a budget whose currency has no symbol. Taken off
 *  before the amount is read; CR and DR, which say a direction, stay. */
const LETTERS_BEFORE = /^(\p{L}{1,4})\.?\s*(?=[\d.,(+\-−$€£¥₹₩₽¢₺₪฿₫₴₦₱])/u;
const LETTERS_AFTER = /(?<=[\d)])\s*(\p{L}{1,4})\.?$/u;

/** An amount as an app's export writes one, in this decimal mark: its value
 *  with its sign, or null when it isn't one. A currency's letters or symbol
 *  are left out (see above). */
export function appAmount(text: string, decimal: DecimalMark): number | null {
  let s = text.trim();
  const before = LETTERS_BEFORE.exec(s);
  if (before && !/^(cr|dr)$/i.test(before[1])) s = s.slice(before[0].length);
  const after = LETTERS_AFTER.exec(s);
  if (after && !/^(cr|dr)$/i.test(after[1])) s = s.slice(0, after.index).trim();
  const read = readAmount(s, decimal);
  if (!read) return null;
  if (read.direction) return read.direction === 'in' ? Math.abs(read.value) : -Math.abs(read.value);
  return read.value;
}

/** The text of an amount column's cells, for detecting the decimal mark,
 *  with a currency's letters left out as appAmount leaves them. */
export function amountTexts(rows: readonly CsvRow[], columns: AppColumns, roles: readonly AppRole[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    for (const role of roles) {
      const t = cellOf(row, columns, role);
      if (t) out.push(t.replace(LETTERS_BEFORE, '').replace(LETTERS_AFTER, ''));
    }
  }
  return out;
}

/** The tags a cell holds: these apps separate them with commas (Monarch,
 *  Lunch Money and ZeroSum, as far as their exports can be seen; none
 *  documents it), each name cleaned, empty ones and repeats left out. */
export function tagsOf(cell: string): string[] {
  if (!cell.trim()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of cell.split(',')) {
    const name = cleanText(part);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** A cell as text a row keeps, or null for an empty one. */
export const textOrNull = (s: string): string | null => {
  const t = cleanText(s);
  return t ? t : null;
};

/** A transaction with no payee keeps a name, so it is never refused for its
 *  label (lib/import/normalize.ts refuses a row with none): the app's own
 *  wording where it has one, else this, which says the app gave none. */
export const NO_PAYEE = '(no payee)';

/** The cells of a line as its raw record keeps them, each within the field
 *  limit. */
export const rawCells = (row: CsvRow): string[] => row.cells.map(capField);

/** A day's number, for how far apart two days are. */
const dayNumber = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;

/** How many days apart a transfer's two sides may be dated and still be one
 *  move between the person's accounts: a bank posts the second a day or two
 *  later. */
export const TRANSFER_DAYS = 4;

/**
 * Marks the rows whose payee is one of the file's own accounts as transfers
 * (Actual Budget and ZeroSum name a transfer's payee after the account the
 * money went to or came from), in place. A payee that only happens to be
 * written like an account ("Amazon" beside an account called "Amazon") is
 * one only when the row has no category of its own, or the account it names
 * holds the other side: the opposite amount within TRANSFER_DAYS. `prefixes`
 * are words an app may put before the account's name ("Transfer : "), and
 * `explicit` those of them only a transfer is written with, which mark one
 * even when the account they name isn't in the file (an export of one
 * account). Run over every line, a split's too, before splits are rebuilt,
 * so a split's line that moved money to another account is a transfer.
 */
export function markTransfersByPayee(txns: AppTxn[], prefixes: readonly RegExp[] = [], explicit: readonly RegExp[] = []): void {
  const accounts = new Map<string, string>();
  for (const t of txns) if (t.account) accounts.set(t.account.toLowerCase(), t.account);
  const byAccount = new Map<string, AppTxn[]>();
  for (const t of txns) {
    const list = byAccount.get(t.account.toLowerCase()) ?? [];
    list.push(t);
    byAccount.set(t.account.toLowerCase(), list);
  }
  for (const t of txns) {
    if (t.transfer !== null || t.starting) continue;
    let named = t.payee;
    for (const p of prefixes) named = named.replace(p, '');
    const key = named.trim().toLowerCase();
    // Words only the app's transfers are written with ("Transfer : Savings")
    // name one whether or not the other account is in the file.
    if (key && key !== t.account.toLowerCase() && !accounts.has(key) && explicit.some((p) => p.test(t.payee))) {
      t.transfer = named.trim();
      continue;
    }
    if (!key || key === t.account.toLowerCase() || !accounts.has(key)) continue;
    const otherSide = (byAccount.get(key) ?? []).some((o) => Math.abs(o.amount + t.amount) < 1e-9 && Math.abs(dayNumber(o.date) - dayNumber(t.date)) <= TRANSFER_DAYS);
    if (t.category && !otherSide) continue;
    t.transfer = accounts.get(key)!;
  }
}
