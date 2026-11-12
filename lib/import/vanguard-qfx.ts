// lib/import/vanguard-qfx.ts
//
// Reading Vanguard's transactions download as QFX (or OFX: the same file
// without Quicken's tag) into each account's investment transactions, in the
// shape Plaid's come in (lib/investments.ts InvestmentTxn) and the rows the
// CSV reader gives (lib/import/vanguard-transactions.ts), so the same rules
// judge all three. Pure and safe to import from client code: the server reads
// the file again for the import. lib/import/ofx.ts parseInvestmentOfx reads
// the file's structure; this module says what each transaction is.
//
// THE FILE. OFX 1.02 SGML, every aggregate ended, nearly all on one line: a
// signon from Vanguard, then one investment statement (INVSTMTRS) per account
// in the login, each with the account number (ACCTID, under BROKERID
// vanguard.com), USD, its positions, and a transaction list that states the
// days it covers (DTSTART to DTEND, which is when the file was made), then the
// security list. Every statement states the same days.
//
// WHAT EACH TRANSACTION IS, by its element:
//   - BUYMF (BUYTYPE BUY): a buy of a fund's shares, the settlement fund's
//     (a sweep) too. TOTAL is the cash spent, negative.
//   - SELLMF (SELLTYPE SELL): a sell. UNITS is negative, TOTAL positive.
//   - REINVEST: a distribution reinvested, one element for two of the CSV's
//     lines, so it is two rows: the income (cash in) and the buy (cash out).
//     Vanguard writes the amount reinvested in FEES as well as TOTAL; FEES
//     equal to TOTAL is read as that, never as a fee.
//   - INCOME: a distribution paid in cash, by INCOMETYPE (DIV, INTEREST,
//     CGLONG, CGSHORT).
//   - INVBANKTRAN: cash into or out of the account. Vanguard's says only
//     that (TRNTYPE OTHER, no name or memo): not whether it was a
//     contribution, a rollover, a deposit or a conversion's cash. So it is its
//     own subtype, `unlabeled`: money in or out of the account, never a
//     contribution, so it is never counted as new savings.
// What the QFX leaves out, compared with the CSV: conversions' and transfers'
// shares moved in kind. A TRANSFER, or any element, type or income kind not
// above, makes that account's rows unreadable, said with its name, never
// guessed at. Amounts take Plaid's sign (positive when cash leaves). A row's
// day is its trade date (an INVBANKTRAN's, its posted date), as written.
//
// FAILING CLOSED, as the CSV's reader does. A file with no investment
// statement from Vanguard is not this download ('not-this-file'). One whose
// statements aren't as this reader knows them ('unknown-layout': a structure
// that had to be repaired, no account number, no stated days, different
// ones or a start after the end, a currency other than USD, the file's or a
// transaction's, a bank statement beside them, a transaction with a field
// twice or one too long, a transaction outside the stated days) is refused
// whole, as is one with too many rows. A row that can't be read (a bad date or amount, a kind
// not above, a fee, tax withheld or accrued interest, none of which a file
// Nya was checked on has had) makes its account's rows unreadable, said with
// its place among the account's transactions.
//
// PRIVATE. Account numbers are read only for their last four digits. No full
// number, no position and no balance leaves this module.

import { parseInvestmentOfx, ofxAmount, type OfxInvestmentTxn } from './ofx';
import { ofxDay } from './dates';
import { MAX_IMPORT_ROWS } from './record';
import type { Unreadable, VanguardAccount, VanguardTxn } from './vanguard-transactions';

export type QfxLayoutProblem =
  /** A statement without an account number Nya can read. */
  | { problem: 'account'; line: number }
  /** A statement that doesn't state its days, or states other days than the
   *  rest. */
  | { problem: 'days'; line: number }
  /** A statement in another currency than USD. */
  | { problem: 'currency'; line: number }
  /** Bank or card statements in the same file. */
  | { problem: 'mixed' }
  /** A structure that had to be repaired to be read: an aggregate never
   *  ended, or an end with no start. */
  | { problem: 'repaired' }
  /** A transaction with a field twice or too long, or outside the stated
   *  days. */
  | { problem: 'row'; line: number };

export type VanguardQfxRead =
  | {
      ok: true;
      accounts: VanguardAccount[];
      /** The days every statement states: `end` is the day the file was made,
       *  which can be partial. */
      stated: { from: string; end: string };
      rows: number;
    }
  | { ok: false; reason: 'not-this-file' }
  | { ok: false; reason: 'unknown-layout'; detail: QfxLayoutProblem }
  | { ok: false; reason: 'too-many-rows'; rows: number };

const ACCOUNT_NUMBER = /^\d{4,12}$/;

/** Whether a file is Vanguard's download as QFX or OFX: an investment
 *  statement whose account is at vanguard.com. Cheap, for choosing which
 *  reader a file goes to; readVanguardQfx checks the whole layout. */
export function isVanguardQfx(text: string): boolean {
  return /<INVSTMTRS>/i.test(text) && /<BROKERID>\s*vanguard\.com\b/i.test(text);
}

/** Cents, as Plaid's amounts are: two decimals, and never -0. */
function money(n: number): number {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
}

/** A name with any run of five or more digits cut to its last four, as the
 *  CSV's reader writes descriptions. */
const masked = (s: string) => s.replace(/\d{5,}/g, (digits) => `••${digits.slice(-4)}`);

/** Each INCOMETYPE Nya reads: its subtype for income paid in cash, and for a
 *  reinvestment's buy, as Plaid names them. */
const INCOME: Record<string, { word: string; subtype: string; reinvested: string }> = {
  DIV: { word: 'Dividend', subtype: 'dividend', reinvested: 'dividend reinvestment' },
  INTEREST: { word: 'Interest', subtype: 'interest', reinvested: 'interest reinvestment' },
  CGLONG: { word: 'Capital gain (LT)', subtype: 'long-term capital gain', reinvested: 'long-term capital gain reinvestment' },
  CGSHORT: { word: 'Capital gain (ST)', subtype: 'short-term capital gain', reinvested: 'short-term capital gain reinvestment' },
};

/** An INVBANKTRAN's TRNTYPE: the one Vanguard writes, cash in or out with
 *  nothing more said. Any other is a kind Nya doesn't know. */
const BANK_TYPES: Record<string, { subtype: string; word?: string } | undefined> = {
  OTHER: { subtype: 'unlabeled' },
};

/** Fields that would be a cost or a tax: none is read yet. */
const FEE_FIELDS = ['COMMISSION', 'FEES', 'LOAD', 'TAXES', 'PENALTY', 'MARKUP', 'MARKDOWN'] as const;
const WITHHOLDING_FIELDS = ['WITHHOLDING', 'STATEWITHHOLDING'] as const;

type Built = { rows: Omit<VanguardTxn, 'line'>[] } | { unreadable: Unreadable };

/** One transaction as rows, or why its account's rows can't be read. */
function rowsOf(t: OfxInvestmentTxn, security: (id: string | undefined) => string | null): Built {
  const f = t.fields;
  const place = { line: t.nth, place: 'transaction' as const };
  const unknown = (type: string): Built => ({ unreadable: { reason: 'unknown-type', type, ...place } });
  const badDate: Built = { unreadable: { reason: 'bad-row', field: 'date', ...place } };
  const badAmount: Built = { unreadable: { reason: 'bad-row', field: 'amount', ...place } };
  const amount = (name: string, empty = false): number | null => (f[name] === undefined || f[name] === '' ? (empty ? 0 : null) : ofxAmount(f[name]));
  const fee = (allowed = 0): Built | null => {
    for (const name of FEE_FIELDS) {
      const v = amount(name, true);
      if (v === null) return badAmount;
      if (v !== 0 && !(name === 'FEES' && Math.abs(v - allowed) < 0.005)) return { unreadable: { reason: 'not-yet-read', field: 'fees', ...place } };
    }
    for (const name of WITHHOLDING_FIELDS) {
      const v = amount(name, true);
      if (v === null) return badAmount;
      if (v !== 0) return { unreadable: { reason: 'not-yet-read', field: 'withholding', ...place } };
    }
    const accrued = amount('ACCRDINT', true);
    if (accrued === null) return badAmount;
    if (accrued !== 0) return { unreadable: { reason: 'not-yet-read', field: 'accrued-interest', ...place } };
    return null;
  };
  const base = { fees: 0, currency: 'USD', security: security(f.UNIQUEID) ?? (f.MEMO ? masked(f.MEMO) : null) };

  if (t.element === 'INVBANKTRAN') {
    const type = (f.TRNTYPE ?? '').toUpperCase();
    const kind = BANK_TYPES[type];
    if (!kind || !Object.hasOwn(BANK_TYPES, type)) return unknown(type || 'INVBANKTRAN');
    const date = f.DTPOSTED ? ofxDay(f.DTPOSTED) : null;
    if (!date) return badDate;
    const value = amount('TRNAMT');
    if (value === null) return badAmount;
    const said = f.NAME || f.MEMO;
    const name = said ? masked(said) : (kind.word ?? (value >= 0 ? 'Money in' : 'Money out'));
    return { rows: [{ kind: t.element, date, name, type: 'cash', subtype: kind.subtype, quantity: 0, price: 0, amount: money(-value), fees: 0, currency: 'USD', security: null }] };
  }

  const date = f.DTTRADE ? ofxDay(f.DTTRADE) : null;
  if (t.element === 'BUYMF' || t.element === 'SELLMF' || t.element === 'REINVEST' || t.element === 'INCOME') {
    if (!date) return badDate;
  }
  if (t.element === 'BUYMF' || t.element === 'SELLMF') {
    const buy = t.element === 'BUYMF';
    const how = (buy ? f.BUYTYPE : f.SELLTYPE)?.toUpperCase() ?? '';
    if (how !== (buy ? 'BUY' : 'SELL')) return unknown(how || t.element);
    const units = amount('UNITS');
    const price = amount('UNITPRICE', true);
    const total = amount('TOTAL');
    if (units === null || price === null || total === null) return badAmount;
    // A buy spends cash and a sell brings it in: one the other way round is
    // a reversal or a correction, which isn't read on a guess.
    if (buy ? total > 0 || units < 0 : total < 0 || units > 0) return badAmount;
    const cost = fee();
    if (cost) return cost;
    return { rows: [{ kind: t.element, date: date!, name: buy ? 'Buy' : 'Sell', type: buy ? 'buy' : 'sell', subtype: buy ? 'buy' : 'sell', quantity: units, price, amount: money(-total), ...base }] };
  }
  if (t.element === 'REINVEST' || t.element === 'INCOME') {
    const type = (f.INCOMETYPE ?? '').toUpperCase();
    const income = Object.hasOwn(INCOME, type) ? INCOME[type] : undefined;
    if (!income) return unknown(type || t.element);
    const total = amount('TOTAL');
    if (total === null) return badAmount;
    if (total < 0) return badAmount;
    if (t.element === 'INCOME') {
      const cost = fee();
      if (cost) return cost;
      return { rows: [{ kind: t.element, date: date!, name: income.word, type: 'cash', subtype: income.subtype, quantity: 0, price: 0, amount: money(-total), ...base }] };
    }
    const units = amount('UNITS');
    const price = amount('UNITPRICE', true);
    if (units === null || price === null || units < 0) return badAmount;
    const cost = fee(total);
    if (cost) return cost;
    return {
      rows: [
        { kind: t.element, date: date!, name: income.word, type: 'cash', subtype: income.subtype, quantity: 0, price: 0, amount: money(-total), ...base },
        { kind: t.element, date: date!, name: 'Reinvestment', type: 'buy', subtype: income.reinvested, quantity: units, price, amount: money(total), ...base },
      ],
    };
  }
  return unknown(t.element);
}

export function readVanguardQfx(text: string): VanguardQfxRead {
  if (!isVanguardQfx(text)) return { ok: false, reason: 'not-this-file' };
  const file = parseInvestmentOfx(text);
  if (file.statements.length === 0 || file.statements.some((s) => (s.broker_id ?? '').toLowerCase() !== 'vanguard.com')) return { ok: false, reason: 'not-this-file' };
  if (file.other_statements > 0) return { ok: false, reason: 'unknown-layout', detail: { problem: 'mixed' } };
  if (file.repairs > 0) return { ok: false, reason: 'unknown-layout', detail: { problem: 'repaired' } };

  const first = file.statements[0];
  if (!first.start || !first.end || first.start > first.end) return { ok: false, reason: 'unknown-layout', detail: { problem: 'days', line: first.line } };
  const stated = { from: first.start, end: first.end };
  let rows = 0;
  for (const s of file.statements) {
    if (!s.account_id || !ACCOUNT_NUMBER.test(s.account_id)) return { ok: false, reason: 'unknown-layout', detail: { problem: 'account', line: s.line } };
    if (s.start !== stated.from || s.end !== stated.end) return { ok: false, reason: 'unknown-layout', detail: { problem: 'days', line: s.line } };
    if (s.currency !== 'USD') return { ok: false, reason: 'unknown-layout', detail: { problem: 'currency', line: s.line } };
    for (const t of s.transactions) {
      if (t.repeated || t.long) return { ok: false, reason: 'unknown-layout', detail: { problem: 'row', line: t.line } };
      // A transaction in its own currency (OFX's CURRENCY or ORIGCURRENCY).
      const own = t.fields.CURSYM;
      if (own !== undefined && own.trim().toUpperCase() !== 'USD') return { ok: false, reason: 'unknown-layout', detail: { problem: 'currency', line: t.line } };
      rows += t.element === 'REINVEST' ? 2 : 1;
    }
  }
  if (rows > MAX_IMPORT_ROWS) return { ok: false, reason: 'too-many-rows', rows };

  const security = (id: string | undefined) => {
    if (!id || !Object.hasOwn(file.securities, id)) return null;
    return file.securities[id].name ?? file.securities[id].ticker;
  };
  const masks = new Map<string, number>();
  for (const s of file.statements) masks.set(s.account_id!.slice(-4), (masks.get(s.account_id!.slice(-4)) ?? 0) + 1);
  const accounts: VanguardAccount[] = [];
  for (const s of file.statements) {
    const mask = s.account_id!.slice(-4);
    const account: VanguardAccount = { mask, repeated: (masks.get(mask) ?? 0) > 1, in_holdings: true, rows: [], lines: 0, unreadable: null };
    for (const t of s.transactions) {
      account.lines += t.element === 'REINVEST' ? 2 : 1;
      if (account.unreadable) continue;
      const built = rowsOf(t, security);
      if ('unreadable' in built) {
        account.unreadable = built.unreadable;
        account.rows = [];
        continue;
      }
      for (const r of built.rows) {
        // Inside the days the file states, as every file Nya was checked on
        // is: one outside them is a file laid out some other way.
        if (r.date < stated.from || r.date > stated.end) return { ok: false, reason: 'unknown-layout', detail: { problem: 'row', line: t.line } };
        account.rows.push({ ...r, line: t.nth });
      }
    }
    accounts.push(account);
  }
  return { ok: true, accounts, stated, rows };
}
