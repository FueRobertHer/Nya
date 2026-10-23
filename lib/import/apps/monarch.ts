// lib/import/apps/monarch.ts
//
// Monarch's transactions download (Accounts, an account, Edit, Download
// transactions; or every account at once from Settings, Data). Pure, safe to
// import from client code.
//
// THE COLUMNS: Date, Merchant, Category, Account, Original Statement, Notes,
// Amount, Tags. Where that comes from (Monarch publishes no specification):
//   - Forbidden Finance's help center recognises a Monarch export by exactly
//     that header row (help.403fin.io/transactions/import-from-monarch), and a
//     script converting YNAB registers into Monarch's format writes the same
//     eight columns (blog.tracefunc.com/notes/monarch-money.html);
//   - a tool that reads Monarch's download by position takes the date from
//     the first column as YYYY-MM-DD, the account from the fourth and the
//     amount from the seventh (github.com/ChrisQGeorge/
//     Monarch-Backfill-Balance-History-From-Transactions, main.py), which is
//     that order;
//   - Monarch's help center: downloading transactions
//     (help.monarch.com/hc/en-us/articles/15526600975764), its default
//     categories, with Paychecks, Interest, Business Income and Other Income
//     as income (360048883851), and its transfer categories, Transfer and
//     Credit Card Payment (with Buy and Sell when investment transactions are
//     on), left out of its budget and spending totals (360048393292).
//
// READ AS: Merchant is the payee (what the person sees in Monarch; Original
// Statement, the bank's own words, stays in the raw record); Notes the note;
// Tags the tags; Amount in Monarch's sign, money out negative (as the import
// guides above say), turned into Plaid's. The CSV has no category groups, so a
// category's kind comes from Monarch's own default categories by name (Transfer,
// Credit Card Payment, Buy and Sell as transfers; the income ones above as
// income), shown in the review as that, for the person to check: one they made
// themselves can't be told from the file. A row under Balance Adjustments is
// Monarch's own adjustment of an account's balance, read as an opening
// balance is (AppTxn.starting): nothing the bank moved, and in no total.
// Rows have no group key of their own beyond the bank's words, Original
// Statement, which one split's rows share (AppTxn.group_key).
//
// NOT CONFIRMED: how tags are separated (read as commas), whether newer files
// add columns (an Owner column, say: any other column is left in the raw
// record), and how a split transaction is written. Monarch's help says a split
// "will create individual transactions", and nothing in the file says which
// rows were one transaction, so each part comes in as a transaction of its own
// with its own category, which counts the same in every total; the review says
// so. Balance Adjustments is named a category of balance changes by a
// migration guide only (waypointbudget.com), not by Monarch.

import { cleanText } from '../normalize';
import { appAmount, cellOf, NO_PAYEE, problemOf, rawCells, readLine, tagsOf, textOrNull, type AppSpec } from './common';
import { newSplitReport } from './splits';
import type { AppCategory, AppTxn } from './types';
import type { CategoryKind } from '../../categories';

/** Monarch's default categories that aren't spending, by name. */
const KINDS: ReadonlyMap<string, CategoryKind> = new Map([
  ['transfer', 'transfer'],
  ['credit card payment', 'transfer'],
  ['buy', 'transfer'],
  ['sell', 'transfer'],
  ['paychecks', 'income'],
  ['interest', 'income'],
  ['business income', 'income'],
  ['other income', 'income'],
  ['dividends & capital gains', 'income'],
]);

export function monarchCategory(name: string): AppCategory | null {
  const n = cleanText(name);
  if (!n || n.toLowerCase() === 'uncategorized') return null;
  const kind = KINDS.get(n.toLowerCase()) ?? null;
  return { group: null, name: n, kind, ...(kind ? { from: 'name' as const } : {}) };
}

export const MONARCH: AppSpec = {
  app: 'monarch',
  aliases: {
    date: ['date'],
    payee: ['merchant'],
    category: ['category'],
    account: ['account'],
    original: ['original statement'],
    notes: ['notes'],
    amount: ['amount'],
    tags: ['tags'],
  },
  recognises: (found, keys) => found.payee !== undefined && found.amount !== undefined && found.date !== undefined && keys.has('original statement') && keys.has('merchant'),
  required: ['date', 'payee', 'amount'],
  amounts: ['amount'],
  parse(rows, columns, ctx) {
    const txns: AppTxn[] = [];
    const problems = [];
    for (const row of rows) {
      const base = readLine(row, columns, ctx);
      if (!base.ok) {
        problems.push(base.problem);
        continue;
      }
      const text = cellOf(row, columns, 'amount');
      const value = text ? appAmount(text, ctx.decimal) : null;
      if (value === null) {
        problems.push(problemOf(row, columns, text ? `Its amount (${text.slice(0, 40)}) can’t be read.` : 'It has no amount.'));
        continue;
      }
      const original = cleanText(cellOf(row, columns, 'original'));
      const payee = cleanText(cellOf(row, columns, 'payee')) || original || NO_PAYEE;
      const category = monarchCategory(cellOf(row, columns, 'category'));
      txns.push({
        line: row.line,
        lines: [row.line],
        account: base.account,
        date: base.date,
        // Monarch's sign: money out is negative.
        amount: -value,
        currency: null,
        payee,
        category,
        transfer: null,
        // Monarch's own balance adjustment: nothing the bank moved.
        starting: category?.name.toLowerCase() === 'balance adjustments',
        note: textOrNull(cellOf(row, columns, 'notes')),
        tags: tagsOf(cellOf(row, columns, 'tags')),
        parts: null,
        raw: rawCells(row),
        // A split's rows share the bank's own words for the transaction.
        group_key: original || payee,
      });
    }
    const splits = newSplitReport();
    splits.unmarked =
      'Monarch’s download doesn’t say which rows are the parts of a split transaction, so each part comes in as a transaction of its own, with its own category. They count the same in every total.';
    return { txns, problems, splits, variant: 'transactions', notes: [] };
  },
};
