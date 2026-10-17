// lib/import/apps/lunchmoney.ts
//
// Lunch Money's transactions export (Transactions, the Export to CSV icon
// above the table: every transaction in the view as filtered). Pure, safe to
// import from client code.
//
// THE COLUMNS. Lunch Money's help lists them: Date, Category Group, Category,
// Payee, Amount, Currency, Notes, Tags, Account Name, Original Name (if split
// or grouped), Transaction number, Type (split, group, or recurring), Parent
// ID (if split), Recurring ID and a Created At timestamp
// (support.lunchmoney.app/finances/transactions/other-features). Its
// changelog added the original name, the id and the type
// (feedback.lunchmoney.app/changelog/159), then "a category_group column" and
// "a created_at column" (changelog/251), which suggests the header is written
// in snake case; both spellings are read (lib/import/apps/common.ts headerKey).
// Its API keeps a debit as a positive amount (lunchmoney.dev, v1
// transactions).
//
// READ AS: Payee the payee, Notes the note, Tags the tags, Currency each
// row's own; Amount in the direction the review shows and the person
// confirms: Lunch Money's own way (money out positive) unless the file's
// income rows say otherwise (lib/import/apps/read.ts). A category's kind:
// income for a group named Income, a transfer for one whose name says so
// ("Transfer", "Payment, Transfer", "Credit Card Payment"), as proposals the
// person checks: the export doesn't carry a category's "treat as income" or
// "exclude from totals" settings, so the review asks for each new category's
// kind instead.
//
// SPLITS. A split transaction's parts each name its parent's id (Parent ID);
// those with one parent are rebuilt into one transaction, the parent's own row
// used for its payee and note when the file has it (and never counted beside
// its parts). Parts on different days are kept as rows. A row whose type is
// group is Lunch Money's group of transactions, kept at its net, one row, as
// the export writes it.
//
// NOT CONFIRMED against a file: the exact spelling of the header, the sign of
// Amount (asked), how tags are separated (read as commas), and whether a
// group's own transactions are in the file beside it (the help names no
// column that would tie them to it, so they are taken not to be).

import { cleanText } from '../normalize';
import { appAmount, cellOf, NO_PAYEE, problemOf, rawCells, readLine, tagsOf, textOrNull, type AppSpec } from './common';
import { fromLines, keepLines, linesOf, newSplitReport, noteRebuilt } from './splits';
import type { AppCategory, AppTxn } from './types';

export function lunchMoneyCategory(group: string, name: string): AppCategory | null {
  const n = cleanText(name);
  if (!n || n.toLowerCase() === 'uncategorized') return null;
  const g = cleanText(group) || null;
  const income = g?.toLowerCase() === 'income' || n.toLowerCase() === 'income';
  const transfer = /\btransfers?\b/i.test(n) || /^credit card payments?$/i.test(n);
  const kind = income ? 'income' : transfer ? 'transfer' : null;
  return { group: g, name: n, kind, ...(kind ? { from: 'name' as const } : {}) };
}

export const LUNCH_MONEY: AppSpec = {
  app: 'lunchmoney',
  aliases: {
    date: ['date'],
    payee: ['payee', 'name'],
    amount: ['amount'],
    currency: ['currency'],
    group: ['category group', 'category group name'],
    category: ['category', 'category name'],
    notes: ['notes', 'note'],
    tags: ['tags'],
    account: ['account name', 'account', 'account display name', 'asset', 'asset name', 'plaid account', 'plaid account name'],
    original: ['original name', 'original payee'],
    type: ['type'],
    parent: ['parent id'],
    id: ['transaction number', 'transaction id', 'id'],
  },
  recognises: (found, keys) =>
    found.date !== undefined &&
    found.payee !== undefined &&
    found.amount !== undefined &&
    found.currency !== undefined &&
    ['original name', 'parent id', 'recurring id', 'created at', 'transaction number'].filter((k) => keys.has(k)).length >= 2,
  required: ['date', 'payee', 'amount'],
  amounts: ['amount'],
  sign: 'positive-out',
  parse(rows, columns, ctx) {
    const txns: AppTxn[] = [];
    const problems = [];
    // Each part by its parent's id, and each row by its own, in file order.
    const parts = new Map<string, AppTxn[]>();
    const byId = new Map<string, AppTxn>();
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
      const type = cellOf(row, columns, 'type').toLowerCase();
      const currency = cellOf(row, columns, 'currency').toUpperCase() || null;
      const txn: AppTxn = {
        line: row.line,
        lines: [row.line],
        account: base.account,
        date: base.date,
        amount: ctx.sign === 'positive-out' ? value : -value,
        currency,
        payee: cleanText(cellOf(row, columns, 'payee')) || cleanText(cellOf(row, columns, 'original')) || NO_PAYEE,
        category: lunchMoneyCategory(cellOf(row, columns, 'group'), cellOf(row, columns, 'category')),
        transfer: null,
        starting: false,
        note: textOrNull(cellOf(row, columns, 'notes')),
        tags: tagsOf(cellOf(row, columns, 'tags')),
        parts: null,
        ...(type === 'group' ? { grouped: true } : {}),
        raw: rawCells(row),
      };
      const id = cellOf(row, columns, 'id');
      if (id) byId.set(id, txn);
      const parent = cellOf(row, columns, 'parent');
      if (parent) {
        const list = parts.get(parent) ?? [];
        list.push(txn);
        parts.set(parent, list);
      } else txns.push(txn);
    }
    const splits = newSplitReport();
    for (const [parentId, lines] of parts) {
      // The parent's own row, when the file has it: its payee and note, and
      // never counted beside its parts.
      const parent = byId.get(parentId);
      const at = parent ? txns.indexOf(parent) : -1;
      if (at >= 0) txns.splice(at, 1);
      const original = lines.map((l) => cleanText(cellOf({ line: l.line, cells: l.raw as string[] }, columns, 'original'))).find((o) => !!o);
      const head = {
        account: parent?.account ?? lines[0].account,
        date: parent?.date ?? lines[0].date,
        currency: parent?.currency ?? lines[0].currency,
        payee: parent?.payee ?? original ?? lines[0].payee,
        note: parent?.note ?? null,
        tags: [...new Set([...(parent?.tags ?? []), ...lines.flatMap((l) => l.tags)])],
        total: parent ? parent.amount : null,
        raw: lines.map((l) => l.raw),
      };
      const built = fromLines(head, lines);
      if ('reason' in built) {
        keepLines(splits, built.reason, lines.map((l) => l.line));
        // The parent's row is the transaction whole, as its bank has it;
        // without it the file doesn't say what the whole was.
        txns.push(...linesOf(lines, `split:${parentId}`, parent ? { date: parent.date, amount: parent.amount, payee: parent.payee, note: parent.note, currency: parent.currency } : null));
      } else {
        noteRebuilt(splits, built, lines);
        txns.push(built.txn);
      }
    }
    txns.sort((a, b) => a.line - b.line);
    const grouped = txns.filter((t) => t.grouped).length;
    const notes = [
      'Lunch Money’s export doesn’t carry a category’s “treat as income” or “exclude from totals” settings: check the kind of each new category below.',
      ...(grouped > 0
        ? [
            `${grouped.toLocaleString('en-US')} ${grouped === 1 ? 'row is a group' : 'rows are groups'} of transactions in Lunch Money, written as one row at ${grouped === 1 ? 'its' : 'their'} net: ${grouped === 1 ? 'it comes in as one transaction' : 'each comes in as one transaction'}, but into a linked account where its bank’s own transactions, or a file imported before, already have them one by one.`,
          ]
        : []),
    ];
    return { txns, problems, splits, variant: 'transactions', notes };
  },
};
