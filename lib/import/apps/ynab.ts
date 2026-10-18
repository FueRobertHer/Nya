// lib/import/apps/ynab.ts
//
// YNAB's register, from its web app's Export Budget Data (a zip of the
// register and the plan as CSV files; either can be imported, the register
// alone or the zip), and YNAB 4's register export. Pure, safe to import from
// client code.
//
// THE COLUMNS. YNAB publishes no specification of its export. A YNAB export
// kept as a test fixture (github.com/plantfansam/ynab-csv-ruby,
// test/fixtures/register.csv) reads:
//   "Account","Flag","Date","Payee","Category Group/Category","Category Group",
//   "Category","Memo","Outflow","Inflow","Cleared"
//   "Checking","","08/01/2017","Groceries, Inc.","Mandatory Expenses: Groceries",
//   "Mandatory Expenses","Groceries","Chicken a la king ingredients",$21.05,$0.00,"Cleared"
//   "Savings","","08/01/2017","Uncle Herb","Inflow: To be Budgeted","Inflow",
//   "To be Budgeted","Birthday Present from Uncle Herb",$0.00,$75.00,"Cleared"
// and its plan file: "Month","Category Group/Category","Category Group",
// "Category","Budgeted","Activity","Available" (Assigned in place of Budgeted
// in later exports, as a converter for today's files reads it:
// gist.github.com/StephenBrown2/1d1cdf5710a917d7ef1c09314d097fe3, which also
// reads a transfer by its payee, "Transfer : <account>", and Inflow / Ready to
// Assign as money to budget). YNAB's help calls that category "Inflow: Ready to
// Assign" on the web (support.ynab.com, "How to Add Income and Other Inflows").
// YNAB 4's register has Master Category and Sub Category instead of the
// group columns, and a Check Number and Running Balance
// (thriveinlifekit.com, "Import financial data from YNAB").
//
// READ AS: Outflow less Inflow is the amount (each written in the budget's
// currency format, "$21.05" or "21,05 €": the decimal mark is the file's),
// the date in the order the budget's date format writes it (settled by the
// file's own dates, else asked); Memo the note; Flag a tag ("Red flag"); the
// category with its group; Inflow (Ready to Assign, To be Budgeted) as income.
// A payee "Transfer : Savings" is money moved to or from the person's own
// account, whatever category it carries (YNAB categorizes a transfer to an
// account it tracks off budget, which counts as spending there; both
// accounts are the person's, so in Nya it is a transfer). "Starting Balance"
// and "Reconciliation Balance Adjustment" are YNAB's opening balance and its
// corrections: neither income nor spending.
//
// SPLITS. Each line of a split transaction is a row of its own, its memo
// starting "Split (1/3)" (and YNAB 4's "(Split 1/3)"). The lines of one,
// one after another in the file, are rebuilt into one transaction
// (lib/import/apps/splits.ts).
//
// NOT CONFIRMED against a file: the "Split (1/3)" prefix (the brief this was
// built from describes it; no published file shows it), whether a flag YNAB
// lets you name is written by its color or its name (either is kept as the
// tag's name), and YNAB 4's split marks.

import { cleanText } from '../normalize';
import { cellOf, NO_PAYEE, outIn, problemOf, rawCells, readLine, textOrNull, type AppSpec } from './common';
import { newSplitReport, rebuildMarked, splitMark } from './splits';
import type { AppCategory, AppTxn } from './types';

/** YNAB's flag colors: a flag is kept as a tag named for it. */
const COLORS = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple']);

export function flagTag(flag: string): string | null {
  const f = cleanText(flag);
  if (!f) return null;
  return COLORS.has(f.toLowerCase()) ? `${f[0].toUpperCase()}${f.slice(1).toLowerCase()} flag` : f;
}

/** The groups YNAB keeps money to budget in: Inflow on the web (Ready to
 *  Assign, To be Budgeted before 2021), Income in YNAB 4. */
const INCOME_GROUPS = new Set(['inflow', 'income']);

/** A row's category: its group and name, from the columns of each, else the
 *  combined "Group: Category" one. */
export function ynabCategory(group: string, name: string, combined: string): AppCategory | null {
  let g = cleanText(group);
  let n = cleanText(name);
  if (!n && combined) {
    const at = combined.indexOf(':');
    if (at > 0) {
      g = cleanText(combined.slice(0, at));
      n = cleanText(combined.slice(at + 1));
    } else n = cleanText(combined);
  }
  if (!n) return null;
  const income = INCOME_GROUPS.has(g.toLowerCase());
  return { group: g || null, name: n, kind: income ? 'income' : null, ...(income ? { from: 'app' as const } : {}) };
}

/** YNAB's own payees for a balance that isn't a transaction. */
const OPENING = new Set(['starting balance', 'reconciliation balance adjustment', 'manual balance adjustment']);

const TRANSFER = /^Transfer\s*:\s*(.*)$/i;

export const YNAB: AppSpec = {
  app: 'ynab',
  aliases: {
    account: ['account'],
    flag: ['flag'],
    date: ['date'],
    payee: ['payee'],
    // The combined column first: YNAB 4 calls it Category, and today's
    // exports call their plain category column that.
    group_category: ['category group/category', 'category'],
    group: ['category group', 'master category'],
    category: ['sub category', 'category'],
    notes: ['memo'],
    outflow: ['outflow'],
    inflow: ['inflow'],
  },
  recognises: (found, keys) =>
    found.date !== undefined &&
    found.payee !== undefined &&
    found.outflow !== undefined &&
    found.inflow !== undefined &&
    keys.has('memo') &&
    (keys.has('flag') || keys.has('category group/category') || keys.has('master category')),
  required: ['date', 'payee', 'outflow', 'inflow'],
  amounts: ['outflow', 'inflow'],
  parse(rows, columns, ctx) {
    const lines: (AppTxn & { mark: ReturnType<typeof splitMark> })[] = [];
    const problems = [];
    let categorizedTransfers = 0;
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
      const transfer = TRANSFER.exec(payee);
      const memo = textOrNull(cellOf(row, columns, 'notes'));
      const mark = splitMark(memo);
      const tag = flagTag(cellOf(row, columns, 'flag'));
      // The combined column is YNAB 4's only category; today's exports have
      // the group and the name in columns of their own beside it.
      const separate = columns.group !== undefined && columns.category !== undefined;
      const category = ynabCategory(
        separate ? cellOf(row, columns, 'group') : '',
        separate ? cellOf(row, columns, 'category') : '',
        separate ? '' : cellOf(row, columns, 'group_category')
      );
      if (transfer && category) categorizedTransfers++;
      lines.push({
        line: row.line,
        lines: [row.line],
        account: base.account,
        date: base.date,
        amount: money.amount,
        currency: null,
        payee: payee || NO_PAYEE,
        category: transfer ? null : category,
        transfer: transfer ? cleanText(transfer[1]) : null,
        starting: !transfer && OPENING.has(payee.toLowerCase()),
        note: memo,
        tags: tag ? [tag] : [],
        parts: null,
        raw: rawCells(row),
        mark,
      });
    }
    const splits = newSplitReport();
    const txns = rebuildMarked(lines, splits);
    const ynab4 = columns.group !== undefined && ctx.header[columns.group] !== undefined && /master/i.test(ctx.header[columns.group]);
    const notes =
      categorizedTransfers > 0
        ? [
            `${categorizedTransfers.toLocaleString('en-US')} ${categorizedTransfers === 1 ? 'transfer has' : 'transfers have'} a category in YNAB (a move to an account it tracks off budget counts as spending there). Both accounts are yours, so ${categorizedTransfers === 1 ? 'it comes in as a transfer' : 'they come in as transfers'}, left out of spending.`,
          ]
        : [];
    return { txns, problems, splits, variant: ynab4 ? 'register-ynab4' : 'register', notes };
  },
};
