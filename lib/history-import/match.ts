// lib/history-import/match.ts
//
// Matching a file's rows against a LINKED account's own transactions (#52):
// the bank's rows, as Plaid synced them (lib/transactions.ts), and the rows
// earlier imports kept for it (lib/history-import/store.ts). Pure, no storage.
//
// AGAINST THE BANK, NEVER SILENTLY. Plaid has no FITID and names merchants its
// own way, so a bank's row and a file's version of it can only be told by what
// they have in common: exactly the same amount, in the same currency, dated
// within MATCH_DAYS of each other (a bank's export often dates a purchase the
// day it was made, Plaid the day it posted). The description is only a
// tiebreak, and a nudge to the confidence: a bank's CSV says
// "SQ *COFFEE 1234 SEATTLE WA" where Plaid says "Coffee Shop", so it is least
// reliable exactly where it is most needed. Each pair is a PROPOSAL with a
// confidence; the person sees every one, with the bank's row beside it, and
// says what it is before anything is stored (lib/history-import/plan.ts).
//
// ONE TO ONE. A bank's row is the match of one file row at most, and the other
// way round, so two identical coffees in a week are two in both: the closest
// pair first (the fewest days apart, then the most alike descriptions, then
// file order), each row taken once. A pending row is never a match: its amount
// can still change, and it is replaced by the posted row, which is.
//
// WHAT A DECISION LEAVES. A row the person says is the bank's is kept, never
// counted, as a DUPLICATE naming the bank's row by its key (bankKey: the day,
// the amount and the bank's own descriptor, which survive a re-link, where
// Plaid's transaction ids don't): that bank row is CLAIMED, so no other row
// can be matched to it later. A row the person says is a transaction of its
// own is kept and counted, and names the bank's row it is not
// (distinct_from): that bank row is MARKED, reviewed and kept apart, so
// nothing is matched to it later either.
//
// SUPERSEDED BY A LATER SYNC. When the bank later sends a period an import
// covered (a re-link that brings more history, or a row the bank hadn't sent
// yet when the file was read), its rows win: an imported row the bank's row
// matches by the same rule retires, uncounted, while the bank's row stays
// (supersede). Only bank rows no decision claimed or marked are matched, so a
// row the person reviewed is never matched again behind their back, and
// earlier imports' rows are matched first, so what an import showed in its
// review is what it does once committed. Worked out on every read, never
// stored: undoing an import, or the bank removing its row, puts the imported
// row back exactly as it was.

import { digitsOf, normalizeDescription } from '../import/normalize';

/** How far apart, in days, a file's row and a bank's row of the same amount
 *  may be dated and still be proposed as one transaction. Off by one to three
 *  days is routine between a purchase and its posting; a weekend or a holiday
 *  adds two. */
export const MATCH_DAYS = 5;

/** A bank's row (lib/transactions.ts StoredTxn) as matching reads it. */
export type BankRow = {
  transaction_id: string;
  /** The account it is on, by the id it is known by now
   *  (lib/link-core.ts resolveId). */
  account_id: string;
  /** Its posting day. */
  date: string;
  /** Plaid's sign: positive is money out. */
  amount: number;
  /** Its ISO code (or Plaid's unofficial one), or null when it says none,
   *  taken then to be in the row's currency (lib/spending.ts). */
  currency: string | null;
  /** The bank's own descriptor (Plaid's raw `name`). */
  name: string;
  merchant_name: string | null;
  pending: boolean;
};

/** A row an import kept for a linked account, as matching reads it
 *  (lib/history-import/store.ts ImportedTxn). */
export type HeldRow = {
  id: string;
  import_id: string;
  date: string;
  amount: number;
  currency: string;
  name: string;
  /** Kept as a duplicate of the bank's row with this key: never counted. */
  same_as?: string | null;
  /** The bank's rows (by key) the person said it is not. */
  distinct_from?: string[];
};

/** A file's row as matching reads it: its place among the records read, and
 *  a manual transaction's fields (lib/import/normalize.ts ImportRow). */
export type FileRow = { index: number; date: string; amount: number; currency: string; name: string };

export type Confidence = 'high' | 'medium' | 'low';

/** One file row and the bank's row it looks like. */
export type Pair = { bank: BankRow; days: number; similarity: number; confidence: Confidence };

/** The key a bank's row is claimed or marked by (see the header): its day, its
 *  amount in thousandths (enough for every currency's minor unit) and its
 *  descriptor, normalized. Kept inside an encrypted record, never a field
 *  name: it names a day, an amount and a merchant. */
export function bankKey(r: { date: string; amount: number; name: string }): string {
  return `${r.date}|${Math.round(r.amount * 1000)}|${normalizeDescription(r.name)}`;
}

const dayNumber = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;

/** Days between two calendar days, whatever their order. */
export function daysApart(a: string, b: string): number {
  return Math.abs(dayNumber(a) - dayNumber(b));
}

/** Whether two amounts are the same in a currency's minor unit (a cent, a
 *  yen): never a float compared exactly. */
function sameAmount(a: number, b: number, currency: string): boolean {
  const scale = 10 ** digitsOf(currency);
  return Math.round(a * scale) === Math.round(b * scale);
}

/** Words that say how a transaction was made rather than with whom, which
 *  banks and Plaid add or leave out at will: no help in telling two apart. */
const NOISE: ReadonlySet<string> = new Set([
  'ach', 'and', 'atm', 'card', 'check', 'checkcard', 'co', 'com', 'credit', 'dbt', 'debit', 'deposit', 'inc', 'llc', 'ltd', 'mastercard',
  'online', 'payment', 'pmt', 'pos', 'purchase', 'recurring', 'the', 'transaction', 'transfer', 'txn', 'visa', 'web', 'withdrawal', 'www',
]);

/** The words of a description that say who: letters and digits, three
 *  characters or more, not all digits (a store or card number), and not
 *  NOISE. */
function words(s: string): string[] {
  return [...new Set(normalizeDescription(s).split(' '))].filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !NOISE.has(w));
}

/** Whether two words name the same thing: equal, or one a start of the other
 *  of four letters or more ("starbuck" and "starbucks"). */
const alike = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/**
 * How alike two descriptions are, from 0 to 1: the share of their words
 * (see words) the other has too, as a Dice coefficient. A tiebreak and a
 * nudge to the confidence only (see the header).
 */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.length === 0 || y.length === 0) return 0;
  const taken = new Set<number>();
  let shared = 0;
  for (const w of x) {
    const at = y.findIndex((v, i) => !taken.has(i) && alike(w, v));
    if (at >= 0) {
      taken.add(at);
      shared++;
    }
  }
  return (2 * shared) / (x.length + y.length);
}

/** How alike a file row's description is to a bank's row: the closer of the
 *  bank's own descriptor and Plaid's merchant name. */
function likeness(name: string, bank: BankRow): number {
  return Math.max(similarity(name, bank.name), bank.merchant_name ? similarity(name, bank.merchant_name) : 0);
}

/** Descriptions this alike or more share a word that says who. */
export const SIMILAR = 0.34;

/**
 * How sure a pair is (see the header): `high` a day apart at most, or up to
 * three with descriptions that share a word that says who; `medium` up to
 * three days apart, or further with descriptions that share one; `low` four
 * or five days apart with nothing else in common.
 */
export function confidenceOf(days: number, similar: number): Confidence {
  if (days <= 1 || (days <= 3 && similar >= SIMILAR)) return 'high';
  if (days <= 3 || similar >= SIMILAR) return 'medium';
  return 'low';
}

/** Whether a bank's row could be a file row's: posted, the same amount in the
 *  same currency (or none), dated within MATCH_DAYS. */
export function couldBe(row: Pick<FileRow, 'date' | 'amount' | 'currency'>, bank: BankRow): boolean {
  if (bank.pending) return false;
  if (bank.currency !== null && bank.currency !== row.currency) return false;
  return sameAmount(row.amount, bank.amount, row.currency) && daysApart(row.date, bank.date) <= MATCH_DAYS;
}

/** The bank's rows by amount, so each row is compared only with the few of
 *  the same amount: a key per amount, rounded to thousandths. */
function byAmount(banks: readonly BankRow[]): Map<number, BankRow[]> {
  const out = new Map<number, BankRow[]>();
  for (const b of banks) {
    if (b.pending) continue;
    const k = Math.round(b.amount * 1000);
    const list = out.get(k);
    if (list) list.push(b);
    else out.set(k, [b]);
  }
  return out;
}

/**
 * The bank's row each file row looks like, one to one (see the header): of
 * every pair that couldBe, the closest first. `forbidden` leaves out a pair
 * the person said is not one. Rows and bank rows not in a pair are left out of
 * the answer.
 */
export function pairUp(rows: readonly FileRow[], banks: readonly BankRow[], forbidden?: (row: FileRow, bank: BankRow) => boolean): Map<number, Pair> {
  const index = byAmount(banks);
  const order = new Map(banks.map((b, i) => [b, i]));
  const candidates: { row: FileRow; bank: BankRow; days: number; similarity: number }[] = [];
  for (const row of rows) {
    for (const bank of index.get(Math.round(row.amount * 1000)) ?? []) {
      if (!couldBe(row, bank) || forbidden?.(row, bank)) continue;
      candidates.push({ row, bank, days: daysApart(row.date, bank.date), similarity: likeness(row.name, bank) });
    }
  }
  candidates.sort(
    (a, b) => a.days - b.days || b.similarity - a.similarity || a.row.index - b.row.index || order.get(a.bank)! - order.get(b.bank)!
  );
  const out = new Map<number, Pair>();
  const used = new Set<BankRow>();
  for (const c of candidates) {
    if (out.has(c.row.index) || used.has(c.bank)) continue;
    used.add(c.bank);
    out.set(c.row.index, { bank: c.bank, days: c.days, similarity: c.similarity, confidence: confidenceOf(c.days, c.similarity) });
  }
  return out;
}

/** A count of keys: two identical coffees on one day share a key, and are
 *  claimed (or marked) one at a time. */
type KeyCounts = Map<string, number>;

function countKeys(keys: Iterable<string>): KeyCounts {
  const out: KeyCounts = new Map();
  for (const k of keys) out.set(k, (out.get(k) ?? 0) + 1);
  return out;
}

/**
 * The bank's rows no decision has claimed or marked (see the header), in the
 * order given: for each key, as many of its rows as the duplicates claiming
 * it and the rows marked distinct from it don't account for.
 */
export function unclaimed(banks: readonly BankRow[], held: readonly HeldRow[]): BankRow[] {
  const taken = countKeys(held.flatMap((r) => [...(r.same_as ? [r.same_as] : []), ...(r.distinct_from ?? [])]));
  if (taken.size === 0) return [...banks];
  const out: BankRow[] = [];
  for (const b of banks) {
    const key = bankKey(b);
    const left = taken.get(key) ?? 0;
    if (left > 0) taken.set(key, left - 1);
    else out.push(b);
  }
  return out;
}

/**
 * Which of an account's kept rows a bank's row now supersedes (see the
 * header): its counted rows (not duplicates), matched one to one against the
 * bank's rows no decision claimed or marked, an import at a time in `order`
 * (the order they were made, earliest first), never against a bank row a row
 * said it is not. Answers each superseded row's id with the bank's row.
 * `banks` and `held` are one account's, every id it has had.
 */
export function supersede(held: readonly HeldRow[], banks: readonly BankRow[], order: readonly string[]): Map<string, BankRow> {
  const out = new Map<string, BankRow>();
  let free = unclaimed(banks, held);
  if (free.length === 0) return out;
  const counted = held.filter((r) => !r.same_as);
  if (counted.length === 0) return out;
  const rank = new Map(order.map((id, i) => [id, i]));
  const imports = [...new Set(counted.map((r) => r.import_id))].sort(
    (a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) || (a < b ? -1 : a > b ? 1 : 0)
  );
  for (const import_id of imports) {
    const rows = counted.filter((r) => r.import_id === import_id);
    const asFile = rows.map((r, index) => ({ index, date: r.date, amount: r.amount, currency: r.currency, name: r.name }));
    const pairs = pairUp(asFile, free, (row, bank) => (rows[row.index].distinct_from ?? []).includes(bankKey(bank)));
    if (pairs.size === 0) continue;
    const used = new Set<BankRow>();
    for (const [index, pair] of pairs) {
      out.set(rows[index].id, pair.bank);
      used.add(pair.bank);
    }
    free = free.filter((b) => !used.has(b));
  }
  return out;
}
