// lib/import/qif.ts
//
// QIF, Quicken's old interchange format, which many banks and older money apps
// still export (#43). Pure, safe to import from client code.
//
// A file is sections, each starting with a "!Type:" line, of records ended by
// "^", each line a one-letter code and its value: D the date, T the amount (U
// the same, written more precisely by newer Quicken), P the payee, M a memo,
// L the category (or "[Account]" for a transfer to another account), N a
// check number or reference, C whether it cleared, A address lines, and S, E
// and $ for each part of a split. Bank, cash and credit card sections are read
// (Bank, Cash, CCard, and Oth A and Oth L, which are written the same way);
// lists of categories, classes, securities and memorized payees are skipped,
// and an investment section is skipped and said so. Quicken writes several
// accounts into one file as "!Account" blocks naming each, followed by its
// section: a file with more than one asks which to import, as an OFX file
// with several statements does. A file of more than MAX_STATEMENTS accounts
// is refused as soon as the one past it starts, before anything is built
// from it.
//
// DATES are Quicken's: "1/2'26" (the apostrophe means a year from 2000 on),
// "1/ 2/26" padded with spaces, "01/02/2026", and day first in exports made
// with European settings. Read by lib/import/dates.ts, which asks rather than
// guesses when every date would fit either order.
//
// SIGNS. T is the account's own: negative is money out, a payment from a bank
// account or a charge on a card. Plaid's sign is the opposite, so it is
// negated (the sheet can flip a file written the other way). A transfer to or
// from another of the person's accounts ("L[Savings]") is a transfer in or
// out, as the file says, so it stays out of spending. Quicken's "Opening
// Balance" record is the account's starting balance, not a transaction, and is
// not imported.

import { capField, MAX_FIELD_CHARS, MAX_STATEMENTS, type Problem, type RawRecord } from './record';
import { dateFor, DATE_ORDER_NAMES, type DateOrder } from './dates';
import { readAmount, type DecimalMark } from './amounts';

export type QifSection = {
  /** Its place among the file's sections, counting from 0. */
  index: number;
  /** As the file names it: Bank, Cash, CCard, Oth A or Oth L. */
  type: string;
  kind: 'bank' | 'creditcard';
  /** The account its "!Account" block names, when there is one. */
  account_name: string | null;
  line: number;
  entries: { line: number; lines: string[] }[];
};

export type QifFile = { sections: QifSection[]; problems: Problem[]; error: string | null };

const READ_TYPES: Record<string, QifSection['kind']> = { bank: 'bank', cash: 'bank', 'oth a': 'bank', ccard: 'creditcard', 'oth l': 'bank' };

/** The sections of a QIF file (see the header). */
export function parseQif(text: string): QifFile {
  const lines = text.split(/\r\n|\n|\r/);
  const sections: QifSection[] = [];
  const problems: Problem[] = [];
  let mode: 'none' | 'account' | 'txn' | 'skip' = 'none';
  let section: QifSection | null = null;
  let entry: { line: number; lines: string[] } | null = null;
  let accountName: string | null = null;
  let pendingName: string | null = null;
  const endEntry = () => {
    if (entry && section && entry.lines.length > 0) section.entries.push(entry);
    entry = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    const l = lines[i].trim();
    if (l === '') continue;
    if (l.startsWith('!')) {
      endEntry();
      const header = l.slice(1).trim();
      const type = /^type\s*:\s*(.*)$/i.exec(header)?.[1]?.trim() ?? null;
      if (type !== null) {
        const key = type.toLowerCase().replace(/\s+/g, ' ');
        if (key in READ_TYPES) {
          if (sections.length >= MAX_STATEMENTS) {
            return {
              sections: [],
              problems,
              error: `This file holds more than ${MAX_STATEMENTS} accounts, more than one import can choose from. Export one account at a time.`,
            };
          }
          section = { index: sections.length, type, kind: READ_TYPES[key], account_name: accountName, line, entries: [] };
          sections.push(section);
          accountName = null;
          mode = 'txn';
        } else {
          if (key === 'invst') problems.push({ line, reason: 'An investment account’s transactions start here; they can’t be imported, so they were skipped.' });
          section = null;
          mode = 'skip';
        }
      } else if (/^account\b/i.test(header)) {
        mode = 'account';
        pendingName = null;
      } else if (/^(option|clear)\s*:/i.test(header)) {
        // Quicken's AutoSwitch markers change nothing here.
      } else {
        section = null;
        mode = 'skip';
      }
      continue;
    }
    if (mode === 'account') {
      // An account's details: its name is the N line.
      if (l === '^') {
        accountName = pendingName;
        pendingName = null;
      } else if (l[0] === 'N') pendingName = l.slice(1).trim() || null;
      continue;
    }
    if (mode !== 'txn') continue;
    if (l[0] === '^') {
      endEntry();
      continue;
    }
    entry ??= { line, lines: [] };
    entry.lines.push(lines[i].replace(/^\s+|\s+$/g, ''));
  }
  // The last record of a file that doesn't end in "^".
  endEntry();
  if (sections.length === 0) {
    return { sections, problems, error: problems.length > 0 ? 'This file holds only investment transactions, which can’t be imported yet.' : 'This QIF file holds no bank, cash or credit card transactions.' };
  }
  return { sections, problems, error: null };
}

/** The values of every line with this code in a section, for detecting how
 *  its dates and amounts are written. */
export function qifValues(section: QifSection, code: 'D' | 'T' | 'U'): string[] {
  return section.entries.flatMap((e) => e.lines.filter((l) => l[0] === code).map((l) => l.slice(1).trim()));
}

/** A section as the import sheet lists it when a file holds several. */
export function sectionLabel(s: Pick<QifSection, 'type' | 'kind' | 'account_name'>): string {
  if (s.account_name) return s.account_name;
  return s.kind === 'creditcard' ? 'Credit card' : s.type.toLowerCase() === 'cash' ? 'Cash' : 'Bank account';
}

export type QifReadOptions = { date_order: DateOrder | null; decimal: DecimalMark; flip?: boolean };

/** A section's records as RawRecords, and the ones that can't be read, each
 *  with its line and why. */
export function qifRecords(section: QifSection, opts: QifReadOptions, thisYear: number): { records: RawRecord[]; problems: Problem[] } {
  const records: RawRecord[] = [];
  const problems: Problem[] = [];
  for (const e of section.entries) {
    const raw = e.lines.map(capField);
    const fail = (reason: string) => problems.push({ line: e.line, reason, raw });
    if (e.lines.some((l) => l.length > MAX_FIELD_CHARS)) {
      fail(`A line of this transaction is over ${MAX_FIELD_CHARS.toLocaleString('en-US')} characters long, so it can’t be read.`);
      continue;
    }
    // The first line with each code (address and split lines repeat; they are
    // kept in the raw record).
    const field = (code: string) => {
      const l = e.lines.find((x) => x[0] === code);
      return l === undefined ? null : l.slice(1).trim();
    };
    const dateText = field('D');
    if (!dateText) {
      fail('It has no date.');
      continue;
    }
    const date = dateFor(dateText, opts.date_order, thisYear);
    if (!date) {
      fail(`Its date (${dateText.slice(0, 40)}) can’t be read${opts.date_order ? ` as ${DATE_ORDER_NAMES[opts.date_order]}` : ''}.`);
      continue;
    }
    const amountText = field('U') || field('T');
    const read = amountText ? readAmount(amountText, opts.decimal) : null;
    if (!read) {
      fail(amountText ? `Its amount (${amountText.slice(0, 40)}) can’t be read.` : 'It has no amount.');
      continue;
    }
    // The account's own sign: negative is money out. Plaid's is the other.
    const amount = opts.flip ? read.value : -read.value;
    const payee = field('P') || null;
    const memo = field('M') || null;
    const number = field('N') || null;
    const category = field('L') || null;
    if (payee && /^opening balance$/i.test(payee) && category && /^\[.*\]$/.test(category)) {
      fail('This is Quicken’s opening balance for the account, not a transaction, so it isn’t imported.');
      continue;
    }
    const description = payee ?? memo ?? (number && /^\d+$/.test(number) ? `Check ${number}` : null);
    if (!description) {
      fail('It has no payee.');
      continue;
    }
    records.push({
      source: 'qif',
      date,
      amount,
      description,
      raw,
      category: categoryOf(category, amount),
      note: payee && memo && memo.toLowerCase() !== payee.toLowerCase() ? memo : null,
      line: e.line,
    });
  }
  return { records, problems };
}

/** A QIF category as a row's: a class after "/" is left out (the raw record
 *  keeps it), and "[Account]" is a transfer, in or out by the sign. */
function categoryOf(L: string | null, amount: number): string | null {
  if (!L) return null;
  if (/^\[.*\]/.test(L)) return amount > 0 ? 'transfer out' : 'transfer in';
  const name = L.split('/')[0].trim();
  return name || null;
}
