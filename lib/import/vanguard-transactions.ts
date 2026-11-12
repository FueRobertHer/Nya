// lib/import/vanguard-transactions.ts
//
// Reading Vanguard's transactions download (Download center, "Transaction
// history", as a CSV) into each account's investment transactions, in the
// shape Plaid's come in (lib/investments.ts InvestmentTxn), so the same rules
// judge both. Pure and safe to import from client code: the server reads the
// file again for the import.
//
// THE FILE. Two tables, one under the other, every line ending in a comma:
//   - Holdings: "Account Number,Investment Name,Symbol,Shares,Share
//     Price,Total Value", then each account's positions, with a blank line
//     between accounts. Only which accounts it lists is read from it: an
//     account can be in the download with no transactions.
//   - Transactions: "Account Number,Trade Date,Settlement Date,Transaction
//     Type,Transaction Description,Investment Name,Symbol,Shares,Share
//     Price,Principal Amount,Commissions and Fees,Net Amount,Accrued
//     Interest,Account Type", then the rows, then blank lines.
// Every account in the Vanguard login is in it. Dates are YYYY-MM-DD and
// amounts plain decimals with a leading minus. Net Amount is the row's cash
// effect, positive into the account. The file has no row ids and doesn't say
// which days it covers.
//
// WHAT EACH ROW IS. By its Transaction Type, from a fixed list (KINDS); a
// type not in it makes that account's rows unreadable, said with the type's
// name, and is never guessed at. Amounts take Plaid's sign (positive when
// cash leaves), so `amount` is minus Net Amount on every row. A conversion
// (Roth or otherwise) is its own subtype, `conversion`: money moving in or
// out of the account, never a contribution, so a conversion is never counted
// as new savings. Its in-kind leg (shares moved, Share Price 0, their value
// in Net Amount) is type `transfer`, with that value as its amount. A row's
// day is its trade date.
//
// FAILING CLOSED. A file without the transactions table's heading is not this
// download ('not-this-file'). One with it whose columns or lines aren't laid
// out as this reader knows them ('unknown-layout': a column renamed, added
// or moved, a line wider or narrower than the heading, a line that is neither
// a holding nor a transaction) is refused whole, as is one with too many
// rows: nothing is read from either. A row that can't be read (a bad date or
// amount, a type not in the list, shares moved with no value, or a fee,
// accrued interest or a principal unlike its net amount, none of which a file
// Nya was checked on has had) makes its account's rows unreadable, said with
// its line, while the other accounts can still be read.
//
// PRIVATE. Account numbers are read only for their last four digits, the
// mask Plaid gives each account, which is what they are matched by. No full
// number and no holding leaves this module.

import { splitCsv } from './csv';
import { MAX_IMPORT_ROWS } from './record';
import type { InvestmentTxn } from '../investments';

export const HOLDINGS_HEADER = ['Account Number', 'Investment Name', 'Symbol', 'Shares', 'Share Price', 'Total Value'] as const;
export const TRANSACTIONS_HEADER = [
  'Account Number',
  'Trade Date',
  'Settlement Date',
  'Transaction Type',
  'Transaction Description',
  'Investment Name',
  'Symbol',
  'Shares',
  'Share Price',
  'Principal Amount',
  'Commissions and Fees',
  'Net Amount',
  'Accrued Interest',
  'Account Type',
] as const;

/** A row read from the file: an InvestmentTxn without the two ids an
 *  import gives it, plus its line and its Transaction Type as written. */
export type VanguardTxn = Omit<InvestmentTxn, 'investment_transaction_id' | 'account_id'> & {
  line: number;
  /** The Transaction Type, as Vanguard writes it. */
  kind: string;
};

/** Why none of an account's rows can be used: a Transaction Type not in the
 *  list, a row whose date or amount can't be read, shares moved with no
 *  value in the file, or a fee, accrued interest or a principal unlike the
 *  net amount, which no file Nya was checked on has had, so how they add up
 *  isn't known. `line` is the first such row's. */
export type Unreadable =
  | { reason: 'unknown-type'; type: string; line: number }
  | { reason: 'bad-row'; field: 'date' | 'amount'; line: number }
  | { reason: 'no-value'; type: string; line: number }
  | { reason: 'not-yet-read'; field: 'fees' | 'accrued-interest' | 'principal'; line: number };

export type VanguardAccount = {
  /** The account number's last four digits. */
  mask: string;
  /** Another account in the file ends in the same four digits, so the mask
   *  can't say which account in Nya is which. */
  repeated: boolean;
  /** Listed in the holdings table. */
  in_holdings: boolean;
  /** Its transactions, in the file's order; empty when unreadable. */
  rows: VanguardTxn[];
  /** How many transaction lines the file has for it, read or not. */
  lines: number;
  unreadable: Unreadable | null;
};

/** The file's first and last trade dates, across every account's rows. */
export type Span = { from: string; to: string };

export type LayoutProblem =
  /** A line before the transactions table that is neither the holdings
   *  heading nor a holding. */
  | { problem: 'line'; line: number }
  /** The transactions heading isn't the columns this reader knows. */
  | { problem: 'columns'; line: number }
  /** A transaction line that isn't as wide as the heading, or whose account
   *  number isn't one. */
  | { problem: 'row'; line: number }
  /** A quote never closed, or a line wider than any table. */
  | { problem: 'split'; line: number }
  /** A holdings heading but no transactions table. */
  | { problem: 'no-transactions' };

export type VanguardTransactionsRead =
  | { ok: true; accounts: VanguardAccount[]; span: Span | null; rows: number }
  | { ok: false; reason: 'not-this-file' }
  | { ok: false; reason: 'unknown-layout'; detail: LayoutProblem }
  | { ok: false; reason: 'too-many-rows'; rows: number };

type Kind = { type: string; subtype: string };
type KindRule = Kind | ((r: { shares: number }) => Kind);

/** Shares moved in kind (a conversion or transfer of a fund's shares, not
 *  cash) are type `transfer`; a cash leg is type `cash`. */
const inKindOr = (subtype: string): KindRule => (r) => (r.shares !== 0 ? { type: 'transfer', subtype } : { type: 'cash', subtype });

/**
 * Each Transaction Type Nya reads, as Plaid would type it. The first group is
 * in the files Nya has been checked on; the second is named the way Vanguard
 * names the rest of its types but not yet seen in a file. Anything else is
 * unreadable.
 */
export const KINDS: Record<string, KindRule> = {
  'Funds Received': { type: 'cash', subtype: 'deposit' },
  Contribution: { type: 'cash', subtype: 'contribution' },
  'Rollover (incoming)': { type: 'cash', subtype: 'rollover' },
  'Conversion (incoming)': inKindOr('conversion'),
  'Conversion (outgoing)': inKindOr('conversion'),
  Buy: { type: 'buy', subtype: 'buy' },
  'Sweep in': { type: 'buy', subtype: 'buy' },
  'Sweep out': { type: 'sell', subtype: 'sell' },
  Reinvestment: { type: 'buy', subtype: 'dividend reinvestment' },
  Dividend: { type: 'cash', subtype: 'dividend' },
  Interest: { type: 'cash', subtype: 'interest' },

  Sell: { type: 'sell', subtype: 'sell' },
  Withdrawal: { type: 'cash', subtype: 'withdrawal' },
  Distribution: { type: 'cash', subtype: 'distribution' },
  'Rollover (outgoing)': { type: 'cash', subtype: 'rollover' },
  'Transfer (incoming)': inKindOr('transfer'),
  'Transfer (outgoing)': inKindOr('transfer'),
  'Capital gain (LT)': { type: 'cash', subtype: 'long-term capital gain' },
  'Capital gain (ST)': { type: 'cash', subtype: 'short-term capital gain' },
  Fee: { type: 'fee', subtype: 'account fee' },
};

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
/** An account number: Vanguard's are 8 digits; a few older kinds are longer. */
const ACCOUNT_NUMBER = /^\d{4,12}$/;

function isDay(s: string): boolean {
  const m = ISO_DAY.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** A plain decimal, or null. Empty reads as 0 where `empty` allows it. */
function decimal(s: string, empty: boolean): number | null {
  const t = s.trim();
  if (t === '') return empty ? 0 : null;
  if (!DECIMAL.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Cents, as Plaid's amounts are: two decimals, and never -0. */
function money(n: number): number {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
}

/** The cells without the empty ones at the end (every line ends in a comma). */
function trimmed(cells: string[]): string[] {
  let w = cells.length;
  while (w > 0 && cells[w - 1].trim() === '') w--;
  return cells.slice(0, w).map((c) => c.trim());
}

function same(cells: string[], header: readonly string[]): boolean {
  return cells.length === header.length && header.every((h, i) => cells[i] === h);
}

/** A row's name for the activity list: its description, with its type in
 *  front when the description doesn't say it ("Rollover (incoming): ..."). A
 *  run of five or more digits (an account number, say: none of the
 *  descriptions seen has one) keeps only its last four. */
function nameOf(kind: string, description: string): string {
  const masked = description.replace(/\d{5,}/g, (digits) => `••${digits.slice(-4)}`);
  if (masked === '') return kind;
  return masked.toLowerCase().includes(kind.toLowerCase()) ? masked : `${kind}: ${masked}`;
}

/** Whether a file is laid out as Vanguard's transactions download: its
 *  transactions heading is in it, or it starts with the holdings heading.
 *  Cheap, for choosing which reader a file goes to, so a download that is
 *  missing its table is refused in this reader's words rather than read as
 *  some other CSV; readVanguardTransactions still checks the whole layout. */
export function isVanguardTransactions(text: string): boolean {
  const rows = splitCsv(text.replace(/^﻿/, ''), ',').rows;
  return headingLine(rows) !== -1 || (rows.length > 0 && same(trimmed(rows[0].cells), HOLDINGS_HEADER));
}

/** The index of the transactions heading's row: the first whose first two
 *  cells are its first two. -1 when there is none. */
function headingLine(rows: { cells: string[] }[]): number {
  return rows.findIndex((r) => r.cells[0]?.trim() === TRANSACTIONS_HEADER[0] && r.cells[1]?.trim() === TRANSACTIONS_HEADER[1]);
}

export function readVanguardTransactions(input: string): VanguardTransactionsRead {
  const text = input.replace(/^﻿/, '');
  // Blank lines are skipped by the split, so holdings separated by them and
  // the blank lines after the table need nothing of their own.
  const split = splitCsv(text, ',');
  const rows = split.rows;
  const at = headingLine(rows);
  const holdingsHeading = rows.length > 0 && same(trimmed(rows[0].cells), HOLDINGS_HEADER);
  if (at === -1 && !holdingsHeading) return { ok: false, reason: 'not-this-file' };
  // Before saying the table is missing: the split may have stopped short of
  // it, at a quote never closed.
  if (split.unterminated !== null || split.wide !== null) {
    return { ok: false, reason: 'unknown-layout', detail: { problem: 'split', line: (split.unterminated ?? split.wide)! } };
  }
  if (at === -1) return { ok: false, reason: 'unknown-layout', detail: { problem: 'no-transactions' } };
  if (!same(trimmed(rows[at].cells), TRANSACTIONS_HEADER)) {
    return { ok: false, reason: 'unknown-layout', detail: { problem: 'columns', line: rows[at].line } };
  }

  // The accounts the holdings table lists. Lines before the transactions
  // table must be its heading or its rows.
  const held = new Set<string>();
  for (let i = 0; i < at; i++) {
    const cells = trimmed(rows[i].cells);
    if (i === 0 && holdingsHeading) continue;
    if (!holdingsHeading || cells.length > HOLDINGS_HEADER.length || !ACCOUNT_NUMBER.test(cells[0] ?? '')) {
      return { ok: false, reason: 'unknown-layout', detail: { problem: 'line', line: rows[i].line } };
    }
    held.add(cells[0]);
  }

  const lines = rows.slice(at + 1);
  if (lines.length > MAX_IMPORT_ROWS) return { ok: false, reason: 'too-many-rows', rows: lines.length };
  const headingWidth = rows[at].cells.length;

  type Building = { number: string; rows: VanguardTxn[]; lines: number; unreadable: Unreadable | null };
  const byNumber = new Map<string, Building>();
  const days: string[] = [];
  for (const { line, cells: raw } of lines) {
    const cells = raw.map((c) => c.trim());
    // Exactly as wide as the heading's line, with nothing past its columns
    // but the empty field a line's last comma leaves (Vanguard ends every
    // line, the heading's too, with one). A narrower line has lost a field
    // somewhere, and every field after it would be read as the next column's.
    const wide = raw.length === headingWidth && cells.slice(TRANSACTIONS_HEADER.length).every((c) => c === '');
    if (!wide || !ACCOUNT_NUMBER.test(cells[0] ?? '')) {
      return { ok: false, reason: 'unknown-layout', detail: { problem: 'row', line } };
    }
    const cell = (name: (typeof TRANSACTIONS_HEADER)[number]) => cells[TRANSACTIONS_HEADER.indexOf(name)] ?? '';
    const number = cells[0];
    const account = byNumber.get(number) ?? byNumber.set(number, { number, rows: [], lines: 0, unreadable: null }).get(number)!;
    account.lines++;

    const date = cell('Trade Date');
    if (isDay(date)) days.push(date);
    if (account.unreadable) continue;
    const fail = (u: Unreadable) => {
      account.unreadable = u;
      account.rows = [];
    };
    if (!isDay(date)) {
      fail({ reason: 'bad-row', field: 'date', line });
      continue;
    }
    const kindText = cell('Transaction Type');
    // Its own keys only: a type named like one of an object's own methods
    // ("constructor") is a type Nya doesn't know.
    const rule = Object.hasOwn(KINDS, kindText) ? KINDS[kindText] : undefined;
    if (!rule) {
      fail({ reason: 'unknown-type', type: kindText, line });
      continue;
    }
    const net = decimal(cell('Net Amount'), false);
    const principal = decimal(cell('Principal Amount'), true);
    const shares = decimal(cell('Shares'), true);
    const price = decimal(cell('Share Price'), true);
    const fees = decimal(cell('Commissions and Fees'), true);
    const accrued = decimal(cell('Accrued Interest'), true);
    if (net === null || principal === null || shares === null || price === null || fees === null || accrued === null) {
      fail({ reason: 'bad-row', field: 'amount', line });
      continue;
    }
    // Every file Nya was checked on has no fees and no accrued interest, and
    // a principal that is the net amount. How they add up otherwise isn't
    // known, so such a row isn't read on a guess.
    const unread = fees !== 0 ? 'fees' : accrued !== 0 ? 'accrued-interest' : principal !== net ? 'principal' : null;
    if (unread) {
      fail({ reason: 'not-yet-read', field: unread, line });
      continue;
    }
    const kind = typeof rule === 'function' ? rule({ shares }) : rule;
    // Shares moved with no cash (in kind) are valued by Net Amount alone:
    // Vanguard writes their price as 0, and a value is never worked out from
    // elsewhere. A buy or sell's shares are bought or sold with its cash.
    if (shares !== 0 && net === 0 && kind.type !== 'buy' && kind.type !== 'sell') {
      fail({ reason: 'no-value', type: kindText, line });
      continue;
    }
    const symbol = cell('Symbol');
    account.rows.push({
      line,
      kind: kindText,
      date,
      name: nameOf(kindText, cell('Transaction Description')),
      type: kind.type,
      subtype: kind.subtype,
      quantity: shares,
      price,
      amount: money(-net),
      fees: 0,
      currency: 'USD',
      // A fund's row names it; a cash row's Investment Name is the account's
      // cash, which says nothing the row's type doesn't.
      security: symbol !== '' ? cell('Investment Name') || symbol : null,
    });
  }

  for (const number of held) if (!byNumber.has(number)) byNumber.set(number, { number, rows: [], lines: 0, unreadable: null });
  const masks = new Map<string, number>();
  for (const number of byNumber.keys()) masks.set(number.slice(-4), (masks.get(number.slice(-4)) ?? 0) + 1);
  const accounts: VanguardAccount[] = [...byNumber.values()].map((a) => ({
    mask: a.number.slice(-4),
    repeated: (masks.get(a.number.slice(-4)) ?? 0) > 1,
    in_holdings: held.has(a.number),
    rows: a.rows,
    lines: a.lines,
    unreadable: a.unreadable,
  }));
  days.sort();
  return {
    ok: true,
    accounts,
    span: days.length > 0 ? { from: days[0], to: days[days.length - 1] } : null,
    rows: lines.length,
  };
}
