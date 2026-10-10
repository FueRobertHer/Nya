// lib/ofx-export.ts
//
// One account's transactions as an OFX statement, a format of the download of
// my data (app/api/my-data, docs/data-export.md): for another money app, or to
// bring them back into Nya through its own file import (lib/import/).
//
// OFX 1.0.2, IN SGML. It is what most banks' downloads are (QFX, Quicken's
// Web Connect, is the same with a tag of Quicken's), so it is what money
// apps' importers are built and tested against: GnuCash (libofx), Actual
// Budget and YNAB read it, and so does Nya's own parser (lib/import/ofx.ts).
// An app that reads OFX 2 (XML) reads 1.x too, while some readers only take
// 1.x. Written as banks write it: the headers, then one tag a line, leaf
// elements without an end tag, aggregates with one, lines ending CRLF.
//
// THE STATEMENT. A depository account is a bank statement (STMTRS), a credit
// account a card statement (CCSTMTRS); loans and investment accounts have no
// statement here (lib/download-options.ts ofxRefusal). It lists the account's
// posted transactions, oldest first:
//   - FITID is the transaction's own id: Plaid's transaction id, or a manual
//     row's "manual-txn:..." id. It never changes, so importing the same file
//     twice, into Nya's import or any app that honours FITIDs, adds nothing.
//   - Pending transactions are left out, and a note says how many: the bank
//     gives a transaction a new id when it posts, so an app holding the
//     pending one would count it twice.
//   - TRNAMT is the account holder's sign, OFX's: positive is money in, on a
//     card as on a bank account. Nya keeps Plaid's (positive is money out), so
//     each amount is negated. Written with the currency's own decimals, or
//     more where the amount has them: never rounded.
//   - TRNTYPE is CREDIT or DEBIT by that sign, unless the bank said more
//     through Plaid's transaction code (an ATM withdrawal, a fee, a transfer,
//     a check, interest): what it says outright, never a guess from a
//     category.
//   - Dates are the days as the bank gave them (Plaid's are days at the bank,
//     not instants), written at 10:59 with no time zone. OFX reads that as
//     10:59 GMT, which is the same day in every time zone from UTC-10 to
//     UTC+13, so an app that turns it into its own time still shows the
//     bank's day from Hawaii to New Zealand, Tonga and Samoa (noon would move
//     it a day at UTC+12 and beyond). Only at UTC-11 (American Samoa, Niue)
//     or past UTC+13 (Kiribati's Line Islands, the Chatham Islands in summer)
//     would such an app move it a day; one that reads the date as written
//     shows it everywhere. DTUSER is when it happened, where Plaid says and
//     that differs from when it posted.
//   - NAME is the payee as the app shows it (your name for the merchant, else
//     Plaid's, else the bank's words), within OFX's 32 characters; a longer
//     one is cut, and given whole in the memo. MEMO (255 characters) holds,
//     in order: "Excluded from budgets and reports in Nya" for a transaction
//     you left out (it is still listed: the money moved, and the statement
//     must add up to the balance), the whole name if it was cut, the bank's
//     own words where they aren't the name, and your note. Categories have no
//     field in OFX; they are in the CSV and JSON files.
//   - A transaction in another currency than the account's is in a statement
//     of its own, for the same account, in that currency: OFX has one
//     currency per statement, and a rate to convert at isn't Nya's to invent.
//   - The ledger balance (LEDGERBAL) is the latest balance Nya knows and the
//     day it is as of, a day where the person is (the time zone their device
//     sends; UTC without one): for a linked account, its newest recorded
//     balance, never an estimate, on the day Nya recorded it; for a manual
//     account, the balance as set, on the day it was set. History is kept by
//     UTC day, so a linked account's is that UTC day where Nya didn't keep
//     the moment (lib/history.ts snapshotTakenAt), or the balance was
//     measured on a day the snapshot was partial. A card's is negative while
//     money is owed, as OFX writes it. Without one known, in the statement's
//     currency, there is none, and a note says so; OFX asks for one, and an
//     app that insists on it may refuse the file.
//   - ACCTID is an id made for the account (Nya never has its full number):
//     "NYA-", 12 characters derived from the id Nya first knew it by, and its
//     last digits where the bank gave them. The first id is where the
//     account's links start (lib/link-core.ts), so a bank reconnected, and
//     its new account linked to the old, still writes the same ACCTID. Its
//     transactions come back with new ids from the bank then, though, so
//     their FITIDs change: an app that matches by FITID may add again what a
//     file from before the reconnection gave it.
//   - BANKID is "NYA". It is not a routing number, which Nya doesn't know,
//     but OFX requires the element in a bank statement, and a strict reader
//     refuses a statement without it. A card statement has none.
//
// TEXT. The file is Windows-1252, as its header says and as US banks write
// it, which every reader takes. A character it lacks is written as its plain
// letter where it has one (an accent it lacks dropped, "ł" as "l") and as "?"
// otherwise, and a note counts the transactions that touched; the JSON and CSV
// files have every character. Control characters are spaces, and &, < and >
// are escaped.
//
// NOTHING MISSING WITHOUT A WORD (lib/user-export.ts, rule 1). Built from the
// document the route already read, so whatever couldn't be read is known: a
// manual account's transactions, or whether a transaction was excluded, that
// couldn't be read are said in a note and in the parts the file is short of
// (`incomplete`), never left out quietly.

import { createHash } from 'node:crypto';
import { cleanText } from './import/normalize';
import { contentKey } from './transactions';
import { carriedExclusions, isCarriedAnnotations, txnAnnotationStore, carriedAnnotationStore, type CarriedAnnotations } from './txn-annotations';
import { effectiveLinks, resolveId, sameAccountIds, type Link } from './link-core';
import { manualTxnStore } from './manual-txns';
import { MANUAL_CURRENCY } from './manual';
import { minorDigits } from './manual-txn-input';
import { ofxFilename, ofxKindOf, ofxRefusal, type OfxKind } from './download-options';
import { missingIds, manualTransactionsIn, type ExportFile, type UserData, type UserExport } from './user-export';

// ---- Text ----

/** Windows-1252's bytes for the characters it puts at 0x80 to 0x9F; from
 *  0xA0 to 0xFF it is Latin-1. Code points, not characters, so no dash or
 *  quote is written here. */
const CP1252: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
  [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91],
  [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98],
  [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

/** A character's byte in Windows-1252, or -1. */
function byteOf(cp: number): number {
  if (cp < 0x80) return cp;
  if (cp >= 0xa0 && cp <= 0xff) return cp;
  return CP1252.get(cp) ?? -1;
}

/** Letters Unicode doesn't decompose, as their plain letter. */
const PLAIN: Record<string, string> = { Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', Ħ: 'H', ħ: 'h', ı: 'i', Ŀ: 'L', ŀ: 'l', Ŧ: 'T', ŧ: 't', Ŋ: 'N', ŋ: 'n', ĸ: 'k', ſ: 's' };

/** Text in Windows-1252's characters (see TEXT in the header), and whether
 *  any had to be written as "?". */
export function to1252(text: string): { text: string; lossy: boolean } {
  let out = '';
  let lossy = false;
  for (const ch of cleanText(text)) {
    if (byteOf(ch.codePointAt(0)!) >= 0) {
      out += ch;
      continue;
    }
    const plain = PLAIN[ch] ?? ch.normalize('NFKD').replace(/\p{M}/gu, '');
    if (plain && [...plain].every((c) => byteOf(c.codePointAt(0)!) >= 0)) out += plain;
    else {
      out += '?';
      lossy = true;
    }
  }
  return { text: out, lossy };
}

/** The file's bytes: every character is in Windows-1252 by now (to1252, and
 *  the tags are ASCII). */
export function encode1252(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const b = byteOf(text.charCodeAt(i));
    if (b < 0) throw new Error('A character of the OFX file is not in Windows-1252');
    out[i] = b;
  }
  return out;
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** At most `max` characters, the end trimmed. */
const cut = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max).trimEnd());

/** OFX's limits (1.0.2): a payee's name, a memo, a check number. */
export const NAME_MAX = 32;
export const MEMO_MAX = 255;
const CHECKNUM_MAX = 12;

// ---- Values ----

/** A day (YYYY-MM-DD) as OFX writes it, at 10:59 (see the header). */
export const ofxDate = (day: string) => `${day.slice(0, 4)}${day.slice(5, 7)}${day.slice(8, 10)}105900`;

/** BANKID, where a bank statement needs one (see the header). */
export const BANK_ID = 'NYA';

/** The day an instant falls on in `timeZone`. */
export function dayIn(iso: string, timeZone: string): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The id an account was first known by: where its chain of links starts
 *  (lib/link-core.ts), its own when it was never linked to an earlier one.
 *  Of two that both start it (two earlier accounts linked into one), the
 *  first by id, so the choice is the same in every file. */
export function firstIdOf(account_id: string, links: Map<string, Link>): string {
  const same = sameAccountIds(account_id, links);
  const linkedTo = new Set(same.map((id) => links.get(id)?.to));
  return same.filter((id) => !linkedTo.has(id)).sort()[0] ?? account_id;
}

/** An instant, in GMT, as OFX writes one. */
function ofxInstant(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}.${iso.slice(20, 23)}[0:GMT]`;
}

/** An amount as OFX writes it: a point, the currency's decimals at least, as
 *  many as the amount has, never an exponent. */
export function ofxAmount(value: number, currency: string): string {
  const digits = minorDigits(currency);
  const abs = Math.abs(value);
  let text = String(abs);
  if (/e/i.test(text)) text = abs.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
  const [whole, fraction = ''] = text.split('.');
  const decimals = fraction.padEnd(digits, '0');
  const sign = value < 0 && abs > 0 ? '-' : '';
  return decimals ? `${sign}${whole}.${decimals}` : `${sign}${whole}`;
}

/** What the bank said a transaction was, through Plaid's transaction code,
 *  as OFX's type: only where the code says it outright. */
const BANK_CODES: Record<string, string> = {
  atm: 'ATM',
  'bank charge': 'FEE',
  cheque: 'CHECK',
  'direct debit': 'DIRECTDEBIT',
  interest: 'INT',
  transfer: 'XFER',
  'standing order': 'REPEATPMT',
};

// ---- The statement ----

/** One transaction as a statement lists it. */
export type OfxRow = {
  /** FITID: the transaction's own id. */
  id: string;
  /** The day it posted. */
  date: string;
  /** The day it happened, where the bank says. */
  user_date: string | null;
  /** Plaid's sign: positive is money out. */
  amount: number;
  /** Its currency, or null for the account's. */
  currency: string | null;
  /** The payee, as the app shows it. */
  name: string;
  /** The bank's own words, when they aren't the name. */
  description: string | null;
  note: string | null;
  check_number: string | null;
  /** Plaid's code for what the bank said it was ("atm"). */
  transaction_code: string | null;
  /** Left out of budgets and reports, as the app reads it. */
  excluded: boolean;
};

/** One account, ready to be written as statements. */
export type OfxAccount = {
  account_id: string;
  /** The id ACCTID is made from (firstIdOf): `account_id` when not given. */
  first_id?: string;
  kind: OfxKind;
  subtype: string | null;
  mask: string | null;
  /** The account's own currency, where something stored says. */
  currency: string | null;
  /** The latest balance known, as Nya keeps it (owed is positive on a
   *  card), the day it is as of, and its currency (null when unknown). */
  balance: { amount: number; as_of: string; currency: string | null } | null;
  /** Why there is no balance, when there is none. */
  no_balance?: string;
  rows: OfxRow[];
};

/** One statement of the file: one currency of one account. */
export type OfxStatement = {
  currency: string;
  rows: OfxRow[];
  /** The ledger balance as OFX writes it (a card's negative while owed). */
  ledger: { amount: number; as_of: string } | null;
};

const ISO_CODE = /^[A-Z]{3}$/;
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The account's id in the file (see the header). */
export function ofxAccountId(account_id: string, mask: string | null): string {
  const token = createHash('sha256').update(`nya-ofx:${account_id}`).digest('hex').slice(0, 12).toUpperCase();
  const digits = (mask ?? '').replace(/[^A-Za-z0-9]/g, '').slice(-4);
  return digits ? `NYA-${token}-${digits}` : `NYA-${token}`;
}

/**
 * The account's statements, one per currency its transactions are in (its
 * own first, always, even with no transactions), and what the person should
 * know about them. Pure.
 */
export function statementsOf(account: OfxAccount): { statements: OfxStatement[]; notes: string[] } {
  const notes: string[] = [];
  const counts = new Map<string, number>();
  for (const r of account.rows) if (r.currency && ISO_CODE.test(r.currency)) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  let common: string | null = null;
  for (const [c, n] of counts) if (common === null || n > counts.get(common)! || (n === counts.get(common)! && c < common)) common = c;
  const own = account.currency && ISO_CODE.test(account.currency) ? account.currency : null;
  const primary = own ?? common ?? account.balance?.currency ?? 'USD';
  if (!own && !common && !account.balance?.currency) {
    notes.push('Nothing stored says which currency this account is in, so the statement says US dollars (USD): check that this is right before you import it.');
  }
  const groups = new Map<string, OfxRow[]>([[primary, []]]);
  for (const r of account.rows) {
    const c = r.currency && ISO_CODE.test(r.currency) ? r.currency : primary;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(r);
  }
  const order = [primary, ...[...groups.keys()].filter((c) => c !== primary).sort()];
  if (order.length > 1) {
    notes.push(
      `This account’s transactions are in more than one currency (${order.join(', ')}), and an OFX statement has one, so the file has a statement for each, in that order. Nothing is converted.`
    );
  }
  const balance = account.balance;
  const ledgerIn = balance && balance.currency === primary ? primary : null;
  if (!balance) {
    notes.push(`The statement has no balance: ${account.no_balance ?? 'Nya has no balance for this account.'}`);
  } else if (!ledgerIn) {
    notes.push(
      balance.currency
        ? `The statement has no balance: the account’s balance is in ${balance.currency}, and its transactions are in ${primary}.`
        : 'The statement has no balance: nothing stored says which currency the account’s balance is in.'
    );
  }
  const statements = order.map(
    (currency): OfxStatement => ({
      currency,
      rows: [...groups.get(currency)!].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      // OFX's sign: a card's balance is owed, so negative.
      ledger: currency === ledgerIn && balance ? { amount: account.kind === 'creditcard' ? -balance.amount : balance.amount, as_of: balance.as_of } : null,
    })
  );
  return { statements, notes };
}

const ACCOUNT_TYPES: Record<string, string> = { savings: 'SAVINGS', 'money market': 'MONEYMRKT' };

/**
 * The file's text, a piece at a time, and what the person should know about
 * how it was written. Pure but for `now`, the time the file says it was made.
 */
export function ofxDocument(account: OfxAccount, now: Date): { pieces: string[]; notes: string[] } {
  const { statements, notes } = statementsOf(account);
  const bank = account.kind === 'bank';
  const acctId = ofxAccountId(account.first_id ?? account.account_id, account.mask);
  let lossy = 0;
  let shortened = 0;
  const line = (tag: string, value: string) => `<${tag}>${escape(value)}\r\n`;
  const status = '<STATUS>\r\n<CODE>0\r\n<SEVERITY>INFO\r\n</STATUS>\r\n';
  const pieces: string[] = [
    'OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nSECURITY:NONE\r\nENCODING:USASCII\r\nCHARSET:1252\r\nCOMPRESSION:NONE\r\nOLDFILEUID:NONE\r\nNEWFILEUID:NONE\r\n\r\n',
    `<OFX>\r\n<SIGNONMSGSRSV1>\r\n<SONRS>\r\n${status}${line('DTSERVER', ofxInstant(now))}${line('LANGUAGE', 'ENG')}</SONRS>\r\n</SIGNONMSGSRSV1>\r\n`,
    bank ? '<BANKMSGSRSV1>\r\n' : '<CREDITCARDMSGSRSV1>\r\n',
  ];
  statements.forEach((s, index) => {
    const from = bank
      ? `<BANKACCTFROM>\r\n${line('BANKID', BANK_ID)}${line('ACCTID', acctId)}${line('ACCTTYPE', ACCOUNT_TYPES[account.subtype ?? ''] ?? 'CHECKING')}</BANKACCTFROM>\r\n`
      : `<CCACCTFROM>\r\n${line('ACCTID', acctId)}</CCACCTFROM>\r\n`;
    pieces.push(`<${bank ? 'STMTTRNRS' : 'CCSTMTTRNRS'}>\r\n${line('TRNUID', String(index + 1))}${status}<${bank ? 'STMTRS' : 'CCSTMTRS'}>\r\n${line('CURDEF', s.currency)}${from}`);
    if (s.rows.length > 0) {
      pieces.push(`<BANKTRANLIST>\r\n${line('DTSTART', ofxDate(s.rows[0].date))}${line('DTEND', ofxDate(s.rows[s.rows.length - 1].date))}`);
      for (const r of s.rows) {
        const amount = -r.amount;
        const name = to1252(r.name);
        const shownName = cut(name.text, NAME_MAX);
        const memo: string[] = [];
        let touched = name.lossy;
        if (r.excluded) memo.push('Excluded from budgets and reports in Nya');
        if (shownName !== name.text) {
          memo.push(name.text);
          shortened++;
        }
        for (const extra of [r.description, r.note]) {
          if (!extra) continue;
          const t = to1252(extra);
          if (!t.text || t.text.toLowerCase() === name.text.toLowerCase()) continue;
          memo.push(t.text);
          touched ||= t.lossy;
        }
        if (touched) lossy++;
        const memoText = memo.join('; ');
        const check = r.check_number ? to1252(r.check_number).text.slice(0, CHECKNUM_MAX) : '';
        const type = (r.transaction_code && BANK_CODES[r.transaction_code]) || (check ? 'CHECK' : amount > 0 ? 'CREDIT' : amount < 0 ? 'DEBIT' : 'OTHER');
        pieces.push(
          '<STMTTRN>\r\n' +
            line('TRNTYPE', type) +
            line('DTPOSTED', ofxDate(r.date)) +
            (r.user_date && r.user_date !== r.date ? line('DTUSER', ofxDate(r.user_date)) : '') +
            line('TRNAMT', ofxAmount(amount, s.currency)) +
            line('FITID', r.id) +
            (check ? line('CHECKNUM', check) : '') +
            (shownName ? line('NAME', shownName) : '') +
            (memoText ? line('MEMO', memoText.length > MEMO_MAX ? `${memoText.slice(0, MEMO_MAX - 3).trimEnd()}...` : memoText) : '') +
            '</STMTTRN>\r\n'
        );
      }
      pieces.push('</BANKTRANLIST>\r\n');
    }
    if (s.ledger) {
      pieces.push(`<LEDGERBAL>\r\n${line('BALAMT', ofxAmount(s.ledger.amount, s.currency))}${line('DTASOF', ofxDate(s.ledger.as_of))}</LEDGERBAL>\r\n`);
    }
    pieces.push(`</${bank ? 'STMTRS' : 'CCSTMTRS'}>\r\n</${bank ? 'STMTTRNRS' : 'CCSTMTTRNRS'}>\r\n`);
  });
  pieces.push(bank ? '</BANKMSGSRSV1>\r\n</OFX>\r\n' : '</CREDITCARDMSGSRSV1>\r\n</OFX>\r\n');
  if (shortened > 0) {
    notes.push(`${plural(shortened, 'payee’s name is', 'payees’ names are')} longer than OFX’s ${NAME_MAX} characters, so each is cut there and given whole in its memo.`);
  }
  if (lossy > 0) {
    notes.push(
      `${plural(lossy, 'transaction has', 'transactions have')} characters OFX’s character set (Windows-1252) doesn’t have, such as letters of non-Latin scripts, written as ?. The JSON and CSV downloads have them as they are.`
    );
  }
  return { pieces, notes };
}

// ---- From the download's document ----

/** Why an account can't be written as OFX, and the route's status for it. */
export type OfxRefused = { refused: string; status: 400 | 404 | 409 };

/** A store on the seam's entries in the document ({ id, value }), whatever
 *  else is there. */
function entriesOf(doc: UserExport, key: string): { id: string; value: unknown }[] {
  const section = doc[key];
  if (!Array.isArray(section)) return [];
  return section.filter((e): e is { id: string; value: unknown } => !!e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string');
}

const UNCHANGED = 'Nothing was changed: what could not be read is still stored as it was.';

/** Pieces joined up to about 64K characters, as the other formats hand them
 *  to the stream (lib/user-export.ts): one per transaction would be
 *  thousands of tiny writes. */
function* gathered(pieces: readonly string[]): Generator<string> {
  let buffer = '';
  for (const piece of pieces) {
    buffer += piece;
    if (buffer.length >= 64 * 1024) {
      yield buffer;
      buffer = '';
    }
  }
  if (buffer) yield buffer;
}

/** Where the person is, and what the route read for the balance's day. */
export type OfxOptions = {
  /** The time zone the person's device sent (lib/access-log.ts timeZoneOf),
   *  or null: then days are UTC days. */
  timeZone: string | null;
  /** When the snapshot of a linked account's newest recorded balance was
   *  taken (lib/history.ts snapshotTakenAt), where Nya kept it. */
  balanceTakenAt: string | null;
};

/**
 * The account's statement as a file of the download (lib/user-export.ts
 * ExportFile), from what the route read (`data`) and the document built from
 * it (`doc`), or why it can't be one: an account that isn't among the
 * person's, one whose record couldn't be read, or one of a kind OFX has no
 * statement for.
 */
export function ofxFile(
  data: UserData,
  doc: UserExport,
  account_id: string,
  now: Date,
  opts: OfxOptions = { timeZone: null, balanceTakenAt: null }
): { file: ExportFile } | OfxRefused {
  const linked = doc.accounts.find((a) => a.account_id === account_id);
  const manual = doc.manual_accounts.find((m) => m.account_id === account_id);
  if (!linked && !manual) {
    if (missingIds(doc.problems, 'manual_accounts').includes(account_id)) {
      return { refused: 'This manual account couldn’t be read, so Nya can’t tell what kind of account it is, and nothing was written. Its transactions are in the JSON download.', status: 409 };
    }
    return { refused: 'That account isn’t among yours: it may have been removed. Choose it again.', status: 404 };
  }
  const type = linked ? linked.type : manual!.type;
  const kind = ofxKindOf(type);
  if (!kind) return { refused: ofxRefusal(type)!, status: 400 };

  const notes: string[] = [];
  const incomplete = new Set<string>();
  // A moment as the day it was where the person is (see the header); a
  // stored day, or any moment without a time zone sent, as it is.
  const dayOf = (iso: string) => (opts.timeZone && iso.length > 10 ? dayIn(iso, opts.timeZone) : iso.slice(0, 10));
  // What was said about each transaction (lib/txn-annotations.ts): its own
  // record, and on a linked account's posted rows, an exclusion carried from
  // an earlier account linked to this one, as the app applies them.
  const own = new Map<string, boolean>();
  for (const { id, value } of entriesOf(doc, txnAnnotationStore.name)) {
    const excluded = (value as { excluded?: unknown } | null)?.excluded;
    if (typeof excluded === 'boolean') own.set(id, excluded);
  }
  const unknown = new Set(missingIds(doc.problems, txnAnnotationStore.name));
  const links = effectiveLinks(data.links, data.live);
  const records = new Map<string, CarriedAnnotations>();
  for (const { id, value } of entriesOf(doc, carriedAnnotationStore.name)) if (isCarriedAnnotations(value)) records.set(id, value);
  const carried = carriedExclusions(records, links);

  let rows: OfxRow[];
  let pending = 0;
  let account: Omit<OfxAccount, 'rows'>;
  if (linked) {
    rows = [];
    for (const t of doc.transactions) {
      if (t.account_id !== account_id) continue;
      if (t.pending) {
        pending++;
        continue;
      }
      const shown = t.your_merchant_name || t.merchant_name || t.name || '';
      rows.push({
        id: t.transaction_id,
        date: t.date,
        user_date: t.authorized_date ?? null,
        amount: t.amount,
        currency: t.iso_currency_code ?? t.unofficial_currency_code ?? null,
        name: shown,
        description: t.name && t.name !== shown ? t.name : null,
        note: null,
        check_number: t.check_number ?? null,
        transaction_code: t.transaction_code ?? null,
        excluded: own.get(t.transaction_id) ?? carried.has(contentKey(t.account_id, t)),
      });
    }
    if (missingIds(doc.problems, carriedAnnotationStore.name).some((old) => old !== account_id && resolveId(old, links) === account_id)) {
      notes.push(
        `Exclusions carried to this account from an earlier one linked to it could not be read, so the transactions they apply to aren’t marked as excluded. The JSON download lists them under problems. ${UNCHANGED}`
      );
      incomplete.add(carriedAnnotationStore.name);
    }
    const store = data.stores.find((s) => s.item_id === linked.item_id);
    if (store?.behind) {
      notes.push(
        `Nya could not save the newest transactions from ${linked.institution_name ?? 'this institution'} (a storage limit, or a write that failed), so ones the app showed recently may be missing from this file. They are saved again once a sync can store them.`
      );
    }
    // The newest recorded balance's day: the UTC day it is kept under, or
    // the day where the person is of the moment its snapshot was taken, when
    // Nya kept that and it is this balance's (inside that UTC day, and not a
    // partial measurement made after it).
    const latest = linked.latest_balance;
    const newest = (data.history.accounts.get(account_id) ?? []).findLast((p) => !p.estimated);
    const taken = opts.balanceTakenAt;
    const asOf = latest && taken && taken.slice(0, 10) === latest.date && newest?.date === latest.date && !newest.partial ? dayOf(taken) : latest?.date;
    account = {
      account_id,
      first_id: firstIdOf(account_id, links),
      kind,
      subtype: linked.subtype,
      mask: linked.mask,
      currency: linked.currency,
      balance: latest && asOf ? { amount: latest.balance, as_of: asOf, currency: linked.currency } : null,
      no_balance: 'Nya has no recorded balance for this account.',
    };
  } else {
    const m = manual!;
    rows = manualTransactionsIn(doc)
      .filter((r) => r.account_id === account_id)
      .map(
        (r): OfxRow => ({
          id: r.id,
          date: r.date,
          user_date: null,
          amount: r.amount,
          currency: r.currency,
          name: r.name,
          description: null,
          note: r.note,
          check_number: null,
          transaction_code: r.transaction_code ?? null,
          excluded: own.get(r.id) ?? false,
        })
      );
    if (missingIds(doc.problems, manualTxnStore.name).includes(account_id)) {
      notes.push(`This account’s transactions could not be read, so the statement has none of them. The JSON download lists them under problems. ${UNCHANGED}`);
      incomplete.add(manualTxnStore.name);
    }
    account = {
      account_id,
      kind,
      subtype: m.subtype,
      mask: null,
      currency: null,
      // As set, and when: kept in US dollars (lib/manual.ts).
      balance: m.updated_at ? { amount: m.balance, as_of: dayOf(m.updated_at), currency: MANUAL_CURRENCY } : null,
      no_balance: 'Nya doesn’t know when this account’s balance was set.',
    };
  }
  const unmarked = rows.filter((r) => unknown.has(r.id)).length;
  if (unmarked > 0) {
    notes.push(
      `Whether ${plural(unmarked, 'of these transactions is', 'of these transactions are')} excluded from budgets and reports could not be read, so ${unmarked === 1 ? 'it isn’t' : 'they aren’t'} marked either way. The JSON download lists them under problems. ${UNCHANGED}`
    );
    incomplete.add(txnAnnotationStore.name);
  }
  if (pending > 0) {
    notes.push(
      `${plural(pending, 'pending transaction is', 'pending transactions are')} left out: the bank gives a transaction a new id when it posts, so an app that imported ${pending === 1 ? 'it' : 'them'} now would count ${pending === 1 ? 'it' : 'them'} twice. Download again once ${pending === 1 ? 'it has' : 'they have'} posted.`
    );
  }

  const written = ofxDocument({ ...account, rows }, now);
  const name = linked ? { institution_name: linked.institution_name, name: linked.name, mask: linked.mask } : { institution_name: manual!.institution_name, name: manual!.name, mask: null };
  return {
    file: {
      filename: ofxFilename(name, dayOf(now.toISOString())),
      contentType: 'application/x-ofx',
      pieces: () => gathered(written.pieces),
      notes: [...notes, ...written.notes],
      incomplete: [...incomplete],
      encode: encode1252,
    },
  };
}
