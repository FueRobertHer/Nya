// lib/import/apps/types.ts
//
// Reading another app's export (M2, "Migration importers"): what a person
// switching to Nya brings with them, from Monarch, YNAB, Lunch Money, Actual
// Budget or ZeroSum. Pure, safe to import from client code.
//
// ON THE SAME PIPELINE. An app's export is a CSV file (lib/import/csv.ts reads
// it as a table) holding every account at once, with what the app knew about
// each transaction beyond a bank's file: the person's own categories and their
// groups, tags, notes, transfers between their accounts and split
// transactions. Each app has a module here that knows its columns (the header
// row says which app it is: lib/import/apps/detect.ts) and reads its rows into
// AppTxns; lib/migration/ turns those into the pipeline's RawRecords
// (lib/import/record.ts) for each Nya account the person chose, and the
// existing stages (normalize, match, commit; and for a linked account the
// review against the bank's rows, lib/history-import/) take them from there.
// Nothing here knows about Nya's accounts or categories.
//
// WHAT IS CONFIRMED AND WHAT ISN'T. None of these apps publishes a
// specification of its export. Each module says where its columns come from
// (help pages, the app's own source where it is open, files people post) and
// which details could not be confirmed, as the SimpleFIN connector does; the
// mapping step (the person says which column is which) is the fallback when a
// header isn't one this code knows.
//
// FILES, NOT THE APPS' APIs. YNAB's and Lunch Money's APIs are left out: each
// takes the person's personal access token (full access to their budget
// there, to change as well as read), and nothing here could be tested against
// either without real credentials, while the exports carry the same
// transactions, categories, tags, notes and splits (docs/features.md,
// "What isn't brought over").

import type { CategoryKind } from '../../categories';
import type { CsvSign } from '../csv';

export const APPS = ['monarch', 'ynab', 'lunchmoney', 'actual', 'zerosum'] as const;
export type AppId = (typeof APPS)[number];

/** The apps by the names people know them by. */
export const APP_NAMES: Record<AppId, string> = {
  monarch: 'Monarch',
  ynab: 'YNAB',
  lunchmoney: 'Lunch Money',
  actual: 'Actual Budget',
  zerosum: 'ZeroSum',
};

/** What a column of an app's export can hold. Not every app has every one. */
export const APP_ROLES = [
  'date',
  'account',
  'payee',
  'amount',
  'outflow',
  'inflow',
  'category',
  'group',
  'group_category',
  'notes',
  'tags',
  'currency',
  'original',
  'flag',
  'type',
  'parent',
  'id',
  'split_amount',
] as const;
export type AppRole = (typeof APP_ROLES)[number];

/** Which column holds each role, by its place in the header. */
export type AppColumns = Partial<Record<AppRole, number>>;

/** The roles, as the mapping step names them. */
export const ROLE_NAMES: Record<AppRole, string> = {
  date: 'Date',
  account: 'Account',
  payee: 'Payee or merchant',
  amount: 'Amount',
  outflow: 'Money out (outflow)',
  inflow: 'Money in (inflow)',
  category: 'Category',
  group: 'Category group',
  group_category: 'Group and category in one',
  notes: 'Notes or memo',
  tags: 'Tags',
  currency: 'Currency',
  original: 'Original description',
  flag: 'Flag',
  type: 'Type',
  parent: 'Split parent',
  id: 'Transaction id',
  split_amount: 'Split amount',
};

/** An app's category as a row carries it, with the kind the app says it is
 *  (income, a transfer), where it says so. */
export type AppCategory = {
  group: string | null;
  name: string;
  /** The kind the app gives it (YNAB's Inflow, an Income group), or what its
   *  default categories are known to be (Monarch's Transfer): `from` says
   *  which. Null when the app says nothing, and it counts as spending. */
  kind: CategoryKind | null;
  from?: 'app' | 'name';
};

/** One part of a split transaction rebuilt from the app's lines. Plaid's
 *  sign, as the transaction's. */
export type AppPart = {
  amount: number;
  category: AppCategory | null;
  /** The account a transfer part moved money to or from (YNAB lets a split
   *  line be a transfer). */
  transfer: string | null;
  note: string | null;
  /** The line's own payee, for the transaction of its own it becomes when
   *  the split can't be held (lib/import/apps/splits.ts explode). */
  payee: string;
  line: number;
};

/** One transaction as the app had it, in Nya's terms: Plaid's sign (positive
 *  is money out), a day, the app's own account and category names. */
export type AppTxn = {
  /** The first line it came from, and every one (a split is several). */
  line: number;
  lines: number[];
  /** The app's name for its account: what the person maps to a Nya account.
   *  Empty when the file has no account column. */
  account: string;
  date: string;
  amount: number;
  /** Its currency's code when the file says, else null (the import's). */
  currency: string | null;
  payee: string;
  category: AppCategory | null;
  /** The app says it is money moved between the person's own accounts: the
   *  other account's name (empty when the app doesn't name it). */
  transfer: string | null;
  /** The app's opening balance for an account, or its balance adjustment:
   *  neither income nor spending. */
  starting: boolean;
  note: string | null;
  tags: string[];
  /** A split transaction rebuilt from its lines, or null. */
  parts: AppPart[] | null;
  /** A row the app groups several of its own into (Lunch Money's
   *  transaction groups), kept at its net. */
  grouped?: boolean;
  /** As the file had it: the line's cells, or every line's for a split. */
  raw: unknown;
};

/** What became of the split transactions an export holds. */
export type SplitReport = {
  /** Rebuilt: one transaction with its parts. */
  rebuilt: number;
  parts: number;
  /** Lines of nothing (YNAB allows a split line of 0.00) left out of the
   *  splits they were in: they move no money, and a part in Nya can't be
   *  nothing. */
  dropped: number[];
  /** Not rebuilt: their lines come in as transactions of their own, each with
   *  why (a reason per kind, with the lines it concerns). */
  kept: { reason: string; lines: number[] }[];
  /** When the export doesn't say which rows are a split's parts at all, what
   *  that means for the person (Monarch's). */
  unmarked: string | null;
};

/** What reading an export needs answered or chose: the app (a header this
 *  code doesn't know is mapped by the person), the order of its dates, its
 *  decimal mark, and for an app whose export has one signed amount column of
 *  its own convention, which way it is written. */
export type AppReadOptions = {
  app?: AppId;
  columns?: AppColumns;
  date_order?: 'mdy' | 'dmy';
  decimal?: '.' | ',';
  sign?: CsvSign;
};
