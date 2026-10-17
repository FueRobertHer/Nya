// lib/import/apps/zerosum.ts
//
// ZeroSum's transactions export: the Export CSV button above the
// transactions (every transaction in the view as filtered), or
// transactions.csv in the zip its budget menu exports. Pure, safe to import
// from client code.
//
// THE COLUMNS. ZeroSum's help lists the Export CSV button's: Date, Account,
// Payee, Category Group, Category, Memo, Tags, Outflow, Inflow and Cleared,
// with a Balance column when the running balance is on, and says income rows
// carry Income as their category group
// (help.zerosumapp.com/articles/0267935-transactions). The budget menu's zip
// holds transactions.csv, "date, account, payee, category, memo, tags,
// outflow, inflow, and cleared status", and budget.csv, each month's budget by
// category (help.zerosumapp.com/articles/9065302-backups-and-data-exports).
// Its release notes for 1.8.2 say split lines are exported each on its own
// row (zerosum.userjot.com/updates), and its help says a transfer's payee is
// the account at its other end (help.zerosumapp.com/en/articles/
// 9843146-accounts-and-transfers).
//
// READ AS: Outflow less Inflow is the amount (as YNAB's, which ZeroSum
// follows), dates in the order the file's own dates settle (else asked), Memo
// the note, Tags the tags; a row whose payee is another account in the file is
// a transfer between the person's own accounts; Income as the group says
// income; "Starting Balance" opens an account.
//
// NOT CONFIRMED against a file: the date format, how tags are separated (read
// as commas), the words a transfer's payee is written with (the account's name,
// with or without "Transfer : " or "Transfer to" before it: all are read), and
// how a split's lines are tied to their transaction. Nothing found says, so
// each line comes in as a transaction of its own with its own category (which
// counts the same in every total), unless the lines carry YNAB's "Split (1/3)"
// marks, which are then rebuilt as YNAB's are.

import { cleanText } from '../normalize';
import { cellOf, markTransfersByPayee, NO_PAYEE, outIn, problemOf, rawCells, readLine, tagsOf, textOrNull, type AppSpec } from './common';
import { newSplitReport, rebuildMarked, splitMark } from './splits';
import type { AppCategory, AppTxn } from './types';

export function zeroSumCategory(group: string, name: string): AppCategory | null {
  const n = cleanText(name);
  if (!n) return null;
  const g = cleanText(group) || null;
  const income = g?.toLowerCase() === 'income';
  return { group: g, name: n, kind: income ? 'income' : null, ...(income ? { from: 'app' as const } : {}) };
}

const TRANSFER_WORDS = [/^transfer\s*:\s*/i, /^transfer (?:to|from)\s+/i, /^payment (?:to|from)\s+/i];

export const ZEROSUM: AppSpec = {
  app: 'zerosum',
  aliases: {
    date: ['date'],
    account: ['account'],
    payee: ['payee'],
    group: ['category group'],
    category: ['category'],
    notes: ['memo', 'note', 'notes'],
    tags: ['tags'],
    outflow: ['outflow'],
    inflow: ['inflow'],
  },
  recognises: (found, keys) =>
    found.date !== undefined &&
    found.payee !== undefined &&
    found.outflow !== undefined &&
    found.inflow !== undefined &&
    keys.has('tags') &&
    !keys.has('flag') &&
    !keys.has('category group/category'),
  required: ['date', 'payee', 'outflow', 'inflow'],
  amounts: ['outflow', 'inflow'],
  parse(rows, columns, ctx) {
    const lines: (AppTxn & { mark: ReturnType<typeof splitMark> })[] = [];
    const problems = [];
    for (const row of rows) {
      const base = readLine(row, columns, ctx);
      if (!base.ok) {
        problems.push(base.problem);
        continue;
      }
      const money = outIn(row, columns, ctx.decimal);
      if ('reason' in money) {
        problems.push(problemOf(row, columns, money.reason));
        continue;
      }
      const payee = cleanText(cellOf(row, columns, 'payee'));
      const memo = textOrNull(cellOf(row, columns, 'notes'));
      lines.push({
        line: row.line,
        lines: [row.line],
        account: base.account,
        date: base.date,
        amount: money.amount,
        currency: null,
        payee: payee || NO_PAYEE,
        category: zeroSumCategory(cellOf(row, columns, 'group'), cellOf(row, columns, 'category')),
        transfer: null,
        starting: payee.toLowerCase() === 'starting balance',
        note: memo,
        tags: tagsOf(cellOf(row, columns, 'tags')),
        parts: null,
        raw: rawCells(row),
        mark: splitMark(memo),
      });
    }
    const splits = newSplitReport();
    const marked = lines.some((l) => l.mark);
    const txns = rebuildMarked(lines, splits);
    markTransfersByPayee(txns, TRANSFER_WORDS);
    // A transfer's category is the money moving between the person's own
    // accounts, whatever ZeroSum filed it under.
    for (const t of txns) if (t.transfer !== null) t.category = null;
    if (!marked) {
      splits.unmarked =
        'ZeroSum’s export writes each line of a split transaction as a row of its own, and nothing in it says which rows were one transaction, so each line comes in as a transaction of its own, with its own category. They count the same in every total.';
    }
    return { txns, problems, splits, variant: columns.group !== undefined ? 'transactions' : 'budget-transactions', notes: [] };
  },
};
