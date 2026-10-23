// lib/import/apps/actual.ts
//
// Actual Budget's transactions export (an account, or All accounts, then
// Export from its menu). Pure, safe to import from client code.
//
// THE COLUMNS, from Actual's own source (github.com/actualbudget/actual,
// packages/loot-core/src/server/transactions/export/export-to-csv.ts,
// exportQueryToCSV, what the account page's Export calls):
//   - from v26.6: Account, Date, Payee, Notes, Category_Group, Category,
//     Amount, Split_Amount, Cleared, and a cell a spreadsheet would run as a
//     formula guarded with a leading apostrophe;
//   - v24.8 to v26.1: the same without Category_Group;
//   - before v24.8: Account, Date, Payee, Notes, Category, Amount (and Cleared
//     from v24.6), with a split's own row left out and its parts carrying its
//     payee, so each part is a transaction of its own;
//   - exportToCSV, the older export of chosen transactions: Account, Date,
//     Payee, Notes, Category written "Group: Category", Amount, Cleared,
//     Reconciled.
// Dates are YYYY-MM-DD and amounts plain numbers in Actual's sign (money out
// negative: integerToAmount of what it stores). Cleared is "Cleared", "Not
// cleared" or "Reconciled" and isn't kept beyond the raw record.
//
// SPLITS. From v24.8 a split transaction is written as its own row, its notes
// starting "(SPLIT INTO 3)", its Amount 0 and its total under Split_Amount,
// then its parts, each "(SPLIT 1 OF 3)" before its notes. They are rebuilt
// into one transaction when its parts follow it, add up to its total and fit
// a split in Nya (lib/import/apps/splits.ts); else the parts come in as rows
// and the transaction's own row, which moves no money of its own, is left
// out.
//
// TRANSFERS AND OPENING BALANCES. Actual names a transfer's payee after the
// account at its other end, so a row whose payee is another account in the
// file is money moved between the person's own accounts (export All accounts
// for both sides to be there). "Starting Balance" (its payee, filed under the
// Starting Balances category of its Income group) opens an account: neither
// income nor spending.
//
// THE FULL EXPORT (Settings, Export data) is a zip of the budget's SQLite
// database (db.sqlite) and metadata.json (actualbudget.org/docs/backup-
// restore/restore). Reading it would take a zip reader (lib/import/apps/
// zip.ts has one) and an SQLite reader, which Nya doesn't have without a new
// dependency (sql.js, about a megabyte of WebAssembly; or Node's experimental
// node:sqlite, on a file written out first), and Actual's schema (accounts,
// categories and groups, payees, transactions with their split parents, tags
// in notes) followed release to release. The CSV holds the same transactions,
// so that is what the review asks for (lib/import/apps/read.ts).

import { cleanText } from '../normalize';
import { appAmount, cellOf, markTransfersByPayee, NO_PAYEE, problemOf, rawCells, readLine, textOrNull, type AppSpec } from './common';
import { fromLines, keepLines, linesOf, newSplitReport, noteRebuilt, WHY } from './splits';
import type { AppCategory, AppTxn } from './types';

export function actualCategory(group: string, name: string, combined: boolean): AppCategory | null {
  let g = cleanText(group);
  let n = cleanText(name);
  if (combined && !g) {
    const at = n.indexOf(': ');
    if (at > 0) {
      g = n.slice(0, at);
      n = n.slice(at + 2);
    }
  }
  if (!n) return null;
  // Actual's own Income group holds its income categories; without the
  // group (an older export), its default Income category by name.
  const income = g ? g.toLowerCase() === 'income' : n.toLowerCase() === 'income';
  return { group: g || null, name: n, kind: income ? 'income' : null, ...(income ? { from: g ? ('app' as const) : ('name' as const) } : {}) };
}

/** "(SPLIT INTO 3)" before a split transaction's notes, "(SPLIT 1 OF 3)"
 *  before each part's. */
const PARENT = /^\(SPLIT INTO (\d{1,3})\)\s*(.*)$/s;
const CHILD = /^\(SPLIT (\d{1,3}) OF (\d{1,3})\)\s*(.*)$/s;

export const ACTUAL: AppSpec = {
  app: 'actual',
  aliases: {
    account: ['account'],
    date: ['date'],
    payee: ['payee'],
    notes: ['notes'],
    group: ['category group'],
    category: ['category'],
    amount: ['amount'],
    split_amount: ['split amount'],
  },
  recognises: (found, keys) =>
    found.date !== undefined &&
    found.payee !== undefined &&
    found.amount !== undefined &&
    found.account !== undefined &&
    keys.has('notes') &&
    keys.has('category') &&
    !keys.has('currency') &&
    !keys.has('merchant') &&
    !keys.has('original statement'),
  required: ['date', 'payee', 'amount'],
  amounts: ['amount', 'split_amount'],
  parse(rows, columns, ctx) {
    const combined = columns.group === undefined && ctx.header.some((h) => /^reconciled$/i.test(h.trim()));
    type Line = AppTxn & { parent?: { n: number; total: number }; child?: { i: number; n: number } };
    const lines: Line[] = [];
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
      const notes = cellOf(row, columns, 'notes');
      const asParent = PARENT.exec(notes);
      const asChild = asParent ? null : CHILD.exec(notes);
      let parent: Line['parent'];
      if (asParent) {
        const totalText = cellOf(row, columns, 'split_amount');
        const total = totalText ? appAmount(totalText, ctx.decimal) : null;
        if (total === null) {
          problems.push(problemOf(row, columns, `Its split amount (${totalText.slice(0, 40)}) can’t be read.`));
          continue;
        }
        parent = { n: Number(asParent[1]), total: -total };
      }
      const payee = cleanText(cellOf(row, columns, 'payee'));
      const category = actualCategory(cellOf(row, columns, 'group'), cellOf(row, columns, 'category'), combined);
      lines.push({
        line: row.line,
        lines: [row.line],
        account: base.account,
        date: base.date,
        // Actual's sign: money out is negative.
        amount: -value,
        currency: null,
        payee: payee || NO_PAYEE,
        category,
        transfer: null,
        starting: payee.toLowerCase() === 'starting balance' || category?.name.toLowerCase() === 'starting balances',
        note: textOrNull(asParent ? asParent[2] : asChild ? asChild[3] : notes),
        tags: [],
        parts: null,
        raw: rawCells(row),
        ...(parent ? { parent } : {}),
        ...(asChild ? { child: { i: Number(asChild[1]), n: Number(asChild[2]) } } : {}),
      });
    }

    // Every line, a split's parts too, before splits are rebuilt: a part
    // whose payee is another account moved money there.
    markTransfersByPayee(lines);
    // Each split transaction's row, then its parts after it: rebuilt, or the
    // parts as rows and its own row (0, moving nothing) left out, each part
    // marked with the transaction as Actual gives it, its total.
    const splits = newSplitReport();
    const txns: AppTxn[] = [];
    const plain = (l: Line): AppTxn => {
      const { parent: _p, child: _c, ...rest } = l;
      return rest;
    };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.parent) {
        // A part with no split row before it stands on its own: the file
        // doesn't hold its transaction.
        if (l.child) {
          keepLines(splits, WHY.together, [l.line]);
          txns.push(...linesOf([plain(l)], `split:${l.line}`, null));
        } else txns.push(plain(l));
        continue;
      }
      const run: Line[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].child && lines[j].child!.n === l.parent.n && lines[j].child!.i === run.length + 1 && run.length < l.parent.n) {
        run.push(lines[j]);
        j++;
      }
      // A part without a payee of its own has its transaction's.
      const parts = run.map((r) => plain(r.payee === NO_PAYEE ? { ...r, payee: l.payee } : r));
      const whole = { date: l.date, amount: l.parent.total, payee: l.payee, note: l.note, currency: null };
      if (run.length !== l.parent.n) {
        keepLines(splits, WHY.together, [l.line, ...run.map((r) => r.line)]);
        txns.push(...linesOf(parts, `split:${l.line}`, whole));
      } else {
        const built = fromLines({ account: l.account, date: l.date, currency: null, payee: l.payee, note: l.note, tags: [], total: l.parent.total, raw: [l.raw, ...run.map((r) => r.raw)] }, parts);
        if ('reason' in built) {
          keepLines(splits, built.reason, [l.line, ...run.map((r) => r.line)]);
          txns.push(...linesOf(parts, `split:${l.line}`, whole));
        } else {
          noteRebuilt(splits, built, parts);
          // The split's own line is one of its lines too.
          built.txn.lines = [l.line, ...built.txn.lines];
          built.txn.line = l.line;
          txns.push(built.txn);
        }
      }
      i = j - 1;
    }
    // A transfer's category is the money moving between the person's own
    // accounts (Actual lets one to an off-budget account carry one).
    for (const t of txns) {
      if (t.transfer !== null) t.category = null;
      for (const p of t.parts ?? []) if (p.transfer !== null) p.category = null;
    }
    const variant = columns.group !== undefined ? 'export-2026' : columns.split_amount !== undefined ? 'export-2024' : combined ? 'export-selected' : 'export-early';
    // Before 24.8 a split's parts are rows of their own, each with its
    // transaction's payee: what a linked account's plan finds them by.
    if (variant === 'export-early') for (const t of txns) t.group_key = t.payee;
    const notes =
      variant === 'export-early'
        ? ['This export is from a version of Actual before 24.8, which writes the parts of a split transaction as transactions of their own: they come in that way, each with its own category.']
        : [];
    return { txns, problems, splits, variant, notes };
  },
};
