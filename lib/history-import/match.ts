// lib/history-import/match.ts
//
// Matching a file's rows against a LINKED account's own transactions (#52):
// the bank's rows, as Plaid synced them (lib/transactions.ts), and the rows
// earlier imports kept for it (lib/history-import/store.ts). Pure, no storage.
//
// NEVER SILENTLY. Plaid has no FITID and names merchants its own way, and a
// bank's CSV and its OFX file describe one transaction differently, so two
// rows can only be told to be one transaction by what they have in common:
// exactly the same amount, in the same currency, dated within MATCH_DAYS of
// each other (a bank's export often dates a purchase the day it was made,
// Plaid the day it posted). The description is only a tiebreak, and a nudge
// to the confidence: a bank's CSV says "SQ *COFFEE 1234 SEATTLE WA" where
// Plaid says "Coffee Shop", so it is least reliable exactly where it is most
// needed. Each pair is a PROPOSAL with a confidence; the person sees every
// one, with the row it looks like beside it, and says what it is before
// anything is stored (lib/history-import/plan.ts).
//
// ONE TO ONE, AS MANY AS CAN BE. A row is the match of one row at most, the
// other way round too, so two identical coffees in a week are two in both.
// Of every way to pair a run of one amount, the one with the most pairs
// wins, and of those the one whose pairs are fewest days apart in all, then
// the most alike, so no row is left without a twin because a closer pair
// took it: with a daily fare dated by purchase in the file and by posting at
// the bank, every one of the bank's fares finds one in the file (pairUp).
// Where a review knows the edges of each side's days (see ACROSS AN EDGE),
// the pairs inside both sides' days come first, as many as can be, and pairs
// across an edge are made only among the rows and twins left over: a file
// exported up to the bank's first day, dated as the bank posts, has its last
// day's fare proposed as the bank's first, never pushed out by a lag of days
// across the edge. A pending row is never a match: its amount can still
// change, and it is replaced by the posted row, which is.
//
// WHAT A DECISION LEAVES. A row the person says is a transaction already
// there is kept, never counted, as a DUPLICATE naming its twin: the bank's
// row by its key (`same_as`, bankKey: the day, the amount and the bank's own
// descriptor, which survive a re-link, where Plaid's transaction ids don't),
// or a row an earlier import kept (`same_as_row`, by its id). A duplicate
// STANDS for its twin only while the twin is there: once the bank no longer
// holds that row (a re-link whose window starts later, a row the bank took
// back), or that earlier import is undone, the duplicate is a transaction
// like any other again, so nothing a later change does can lose it (settle).
// A row the person says is a transaction of its own is kept and counted, and
// names the bank's row it is not (`distinct_from`): that pair is never made
// again behind their back, and the bank's row stays free for its real twin.
//
// SUPERSEDED BY A LATER SYNC. Where the bank's window reaches, its rows win:
// an imported row a free bank row matches by the same rule retires,
// uncounted, while the bank's row stays (settle). Earlier imports' rows are
// matched first, so what an import showed in its review is what it does once
// committed. Worked out on every read: undoing an import, or the bank
// removing its row, puts the imported row back exactly as it was.
//
// KEPT ONCE MADE. A pair the rule made holds while the bank's row is there,
// whatever the bank changes on that row later: Plaid keeps a transaction's
// id when it modifies it (a tip added, a currency settled, a merchant's name
// corrected), and a pair worked out again from the new amount would let the
// imported row count beside it, the one transaction twice. So the sync that
// changes a bank row, before it saves the change, keeps which of the
// connection's rows stood for which imported row (lib/history-import/twins.ts,
// the imported-twins store), and settle takes those pairs first (`twins`), by
// the bank row's id: a bank row that stood for a row still stands for it, as
// a duplicate's twin or as the row that superseded it, until the bank removes
// it. Nothing is paired by them that the rule didn't pair; a read never
// writes them. A pair the rule made is worked out from the amounts, as it
// always was, until a sync changes its bank row, which keeps it first; one
// the bank changed before pairs were kept is lost to it. A disconnect carries
// the pairs by their bank rows' content, which the re-added connection's
// syncs make again once the person links the accounts.
//
// ACROSS AN EDGE (a row dated before the bank's earliest posted row, or a
// bank row dated outside the period the row's file covers) two rows can only
// be one transaction through a posting lag: a file dated by purchase (many a
// CSV) beside the bank's posting dates. Whether there is one, the dates of
// rows of one amount can't tell: a daily fare reads as well with a lag of two
// days as with none. So such a pair is only ever the person's to answer: the
// review shows it as possibly the same, and why (lib/history-import/plan.ts;
// for an OFX file, dated by posting as the bank's rows are, it isn't made at
// all), only for rows the pairs inside both sides' days left over, and a read
// never makes one, so an answer that a row is its own stands, and nothing is
// absorbed behind the person's back. What that costs: a file dated by
// purchase, with one amount day after day, may count a lag's worth of rows at
// an edge beside the bank's (the fares inside both sides' days pair up on
// the same day, leaving those at the edges), in plain sight on the Activity
// tab, rather than lose any.

import { digitsOf, normalizeDescription } from '../import/normalize';

/** How far apart, in days, two rows of the same amount may be dated and
 *  still be proposed as one transaction. Off by one to three days is routine
 *  between a purchase and its posting; a weekend or a holiday adds two. */
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
  /** Where it came from ('import:ofx', ...): an OFX row is dated by posting. */
  source?: string;
  /** A duplicate of the bank's row with this key (bankKey). */
  same_as?: string | null;
  /** A duplicate of the row with this id, which an earlier import kept. */
  same_as_row?: string | null;
  /** The bank's rows (by key) the person said it is not. */
  distinct_from?: string[];
};

/** A file's row as matching reads it: its place among the records read, and
 *  a manual transaction's fields (lib/import/normalize.ts ImportRow). */
export type FileRow = { index: number; date: string; amount: number; currency: string; name: string };

/** What a row can be paired with: a bank's row, or a row an earlier import
 *  kept. A pending one never pairs. */
export type Matchable = { date: string; amount: number; currency: string | null; name: string; merchant_name?: string | null; pending?: boolean };

export type Confidence = 'high' | 'medium' | 'low';

/** One row and the row it looks like. */
export type Pair<T extends Matchable = BankRow> = { twin: T; days: number; similarity: number; confidence: Confidence };

/** The key a bank's row is claimed by (see the header): its day, its amount
 *  in thousandths (enough for every currency's minor unit) and its
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

/** How alike a row's description is to another's: the closer of its own
 *  description and, for a bank's row, Plaid's merchant name. */
function likeness(name: string, twin: Matchable): number {
  return Math.max(similarity(name, twin.name), twin.merchant_name ? similarity(name, twin.merchant_name) : 0);
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

/** Whether a row could be another's: not pending, the same amount in the
 *  same currency (or the other names none), dated within MATCH_DAYS. */
export function couldBe(row: Pick<FileRow, 'date' | 'amount' | 'currency'>, twin: Matchable): boolean {
  if (twin.pending) return false;
  if (twin.currency !== null && twin.currency !== row.currency) return false;
  return sameAmount(row.amount, twin.amount, row.currency) && daysApart(row.date, twin.date) <= MATCH_DAYS;
}

/** Above this many cells in one run, pairing falls back to the greedy way
 *  (still as many pairs as can be, not always the closest): a run that long
 *  is years of one amount every day. */
const DP_LIMIT = 4_000_000;

type Scored = { count: number; days: number; sim: number };
const better = (a: Scored, b: Scored) => a.count > b.count || (a.count === b.count && (a.days < b.days || (a.days === b.days && a.sim > b.sim + 1e-9)));
const NOTHING: Scored = { count: 0, days: 0, sim: 0 };

/**
 * The best pairing of one run (see the header): rows and twins of one
 * amount, each sorted by date, as many pairs as can be, then the fewest days
 * apart in all, then the most alike. Pairs on a line never need to cross (two
 * crossing pairs within MATCH_DAYS can be swapped for two that don't, never
 * further apart in all), so the best pairings of prefixes build the whole.
 */
function pairRun<T extends Matchable>(rows: FileRow[], twins: T[], ok: (row: FileRow, twin: T) => boolean, out: Map<number, Pair<T>>): void {
  const n = rows.length;
  const m = twins.length;
  if (n * m > DP_LIMIT) return pairGreedy(rows, twins, ok, out);
  const W = m + 1;
  const twinDays = twins.map((t) => dayNumber(t.date));
  let prev: Scored[] = new Array<Scored>(W).fill(NOTHING);
  // 1: leave the row out; 2: leave the twin out; 3: pair them.
  const back = new Uint8Array((n + 1) * W);
  for (let i = 1; i <= n; i++) {
    const cur: Scored[] = new Array<Scored>(W);
    cur[0] = NOTHING;
    back[i * W] = 1;
    const r = rows[i - 1];
    const day = dayNumber(r.date);
    for (let j = 1; j <= m; j++) {
      let best = prev[j];
      let from = 1;
      if (better(cur[j - 1], best)) {
        best = cur[j - 1];
        from = 2;
      }
      const t = twins[j - 1];
      if (Math.abs(day - twinDays[j - 1]) <= MATCH_DAYS && ok(r, t)) {
        const p = prev[j - 1];
        const paired = { count: p.count + 1, days: p.days + daysApart(r.date, t.date), sim: p.sim + likeness(r.name, t) };
        if (better(paired, best)) {
          best = paired;
          from = 3;
        }
      }
      cur[j] = best;
      back[i * W + j] = from;
    }
    prev = cur;
  }
  for (let i = n, j = m; i > 0 && j > 0; ) {
    const from = back[i * W + j];
    if (from === 3) {
      const r = rows[i - 1];
      const t = twins[j - 1];
      const days = daysApart(r.date, t.date);
      const sim = likeness(r.name, t);
      out.set(r.index, { twin: t, days, similarity: sim, confidence: confidenceOf(days, sim) });
      i--;
      j--;
    } else if (from === 2) j--;
    else i--;
  }
}

/** As many pairs as can be, for a run too long to weigh every way: each row,
 *  oldest first, takes the oldest twin it can, which never leaves undone a
 *  pair another order would make. */
function pairGreedy<T extends Matchable>(rows: FileRow[], twins: T[], ok: (row: FileRow, twin: T) => boolean, out: Map<number, Pair<T>>): void {
  const used = new Uint8Array(twins.length);
  let lo = 0;
  for (const r of rows) {
    const day = dayNumber(r.date);
    while (lo < twins.length && dayNumber(twins[lo].date) < day - MATCH_DAYS) lo++;
    for (let j = lo; j < twins.length && dayNumber(twins[j].date) <= day + MATCH_DAYS; j++) {
      if (used[j] || !ok(r, twins[j])) continue;
      used[j] = 1;
      const days = daysApart(r.date, twins[j].date);
      const sim = likeness(r.name, twins[j]);
      out.set(r.index, { twin: twins[j], days, similarity: sim, confidence: confidenceOf(days, sim) });
      break;
    }
  }
}

/**
 * The twin each row looks like, one to one (see the header): of the pairs
 * that couldBe, as many as can be, the closest. `forbidden` leaves out a pair
 * the person said is not one. `edge` marks a pair across the edge of either
 * side's days (crossesEdge), one only a posting lag would make: the pairs
 * inside both sides' days come first, as many as can be, and pairs across an
 * edge are made only among the rows and twins left over, so a match inside
 * them (a same-day one above all) is never pushed out by lagged pairs. Rows
 * and twins not in a pair are left out of the answer.
 */
export function pairUp<T extends Matchable>(
  rows: readonly FileRow[],
  twins: readonly T[],
  forbidden?: (row: FileRow, twin: T) => boolean,
  edge?: (row: FileRow, twin: T) => boolean
): Map<number, Pair<T>> {
  const ok = (row: FileRow, twin: T) => couldBe(row, twin) && !forbidden?.(row, twin);
  if (!edge) return pairAll(rows, twins, ok);
  // Inside both sides' days first; across an edge, only what is left (see
  // ACROSS AN EDGE in the header for what a uniform posting lag costs).
  const inside = pairAll(rows, twins, (row, twin) => ok(row, twin) && !edge(row, twin));
  const taken = new Set<T>([...inside.values()].map((p) => p.twin));
  const across = pairAll(
    rows.filter((r) => !inside.has(r.index)),
    twins.filter((t) => !taken.has(t)),
    ok
  );
  return new Map([...inside, ...across]);
}

/** As many pairs as can be, the closest (see pairUp): run by run, of one
 *  amount, pairs only where `ok` says. */
function pairAll<T extends Matchable>(rows: readonly FileRow[], twins: readonly T[], ok: (row: FileRow, twin: T) => boolean): Map<number, Pair<T>> {
  const out = new Map<number, Pair<T>>();
  // By amount in thousandths: only rows of one amount can pair.
  const groups = new Map<number, { rows: FileRow[]; twins: { t: T; at: number }[] }>();
  twins.forEach((t, at) => {
    if (t.pending) return;
    const k = Math.round(t.amount * 1000);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { rows: [], twins: [] }));
    g.twins.push({ t, at });
  });
  for (const r of rows) groups.get(Math.round(r.amount * 1000))?.rows.push(r);
  for (const g of groups.values()) {
    if (g.rows.length === 0 || g.twins.length === 0) continue;
    const rs = [...g.rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.index - b.index));
    const ts = [...g.twins].sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : a.at - b.at)).map((x) => x.t);
    // Runs no pair can cross: split where more than MATCH_DAYS separate one
    // row or twin from the next, in date order.
    let i = 0;
    let j = 0;
    while (i < rs.length || j < ts.length) {
      const runRows: FileRow[] = [];
      const runTwins: T[] = [];
      let last: number | null = null;
      while (i < rs.length || j < ts.length) {
        const nextRow = i < rs.length ? dayNumber(rs[i].date) : Infinity;
        const nextTwin = j < ts.length ? dayNumber(ts[j].date) : Infinity;
        const next = Math.min(nextRow, nextTwin);
        if (last !== null && next - last > MATCH_DAYS) break;
        if (nextRow <= nextTwin) runRows.push(rs[i++]);
        else runTwins.push(ts[j++]);
        last = next;
      }
      if (runRows.length > 0 && runTwins.length > 0) pairRun(runRows, runTwins, ok, out);
    }
  }
  return out;
}

/** Whether a pair would cross the edge of either side's coverage (see the
 *  header): the row dated before the bank's earliest posted row, or the twin
 *  outside the period the row's file covers. */
export function crossesEdge(rowDate: string, twinDate: string, bankFrom: string | null, covers: { from: string; to: string } | null): boolean {
  return (bankFrom !== null && rowDate < bankFrom) || (covers !== null && (twinDate > covers.to || twinDate < covers.from));
}

/** A source dated by posting, as the bank's rows are: OFX's DTPOSTED. */
export const POSTED_DATED = (source: string | undefined) => source === 'import:ofx';

/** What a duplicate stands for while it stands: the bank's row it claims, or
 *  the earlier import's row it names. */
export type Standing = { bank: BankRow } | { row: string };

export type Settled<T extends HeldRow> = {
  /** The rows that count as transactions of the account. */
  counted: T[];
  /** Duplicates standing for their twin: never counted while it is there. */
  standing: Map<string, Standing>;
  /** Rows a posted bank row now stands for. */
  superseded: Map<string, BankRow>;
  /** With `pending`: rows a pending bank row stands for until it posts. */
  pendingStood: Map<string, BankRow>;
};

/**
 * Which of an account's kept rows count, and what each one that doesn't is
 * (see the header). `held` and `banks` are one account's, every id it has had;
 * `order` its imports, earliest first; `bankFrom` its connection's earliest
 * posted row; `covers` the period each import's file covers, where known.
 *
 *   0. A pair kept once made (`twins`, see KEPT ONCE MADE): a row the bank
 *      row with that id stood for, while that posted row is there, whatever
 *      it says now: as a duplicate's twin, or as the row superseding it.
 *   1. A duplicate of the bank's row stands while a posted bank row has its
 *      key, one bank row to one duplicate, earlier imports first.
 *   2. A duplicate of an earlier import's row stands while that row is kept.
 *   3. Every other row (and a duplicate whose twin is gone) counts, unless a
 *      posted bank row no duplicate holds is its twin by the matching rule:
 *      then that bank row stands for it. Earlier imports are matched first; a
 *      pair the person said is not one never is, nor a pair across an edge
 *      (crossesEdge: see the header).
 *   4. With `pending` (what is shown and listed, never the estimated history,
 *      which walks posted rows only): a row left over that a pending bank row
 *      looks like isn't shown beside it until it posts, or goes.
 */
export function settle<T extends HeldRow>(
  held: readonly T[],
  banks: readonly BankRow[],
  order: readonly string[],
  opts: {
    bankFrom: string | null;
    pending?: boolean;
    covers?: ReadonlyMap<string, { from: string; to: string }>;
    /** Pairs kept once made: each imported row's id to the bank row's id. */
    twins?: ReadonlyMap<string, string>;
  }
): Settled<T> {
  const rank = new Map(order.map((id, i) => [id, i]));
  const rankOf = (import_id: string) => rank.get(import_id) ?? Number.MAX_SAFE_INTEGER;
  const before = (a: string, b: string) => rankOf(a) - rankOf(b) || (a < b ? -1 : a > b ? 1 : 0);
  // Earlier imports first; within an import, in the order kept.
  const sorted = [...held].sort((a, b) => before(a.import_id, b.import_id));
  const posted = banks.filter((b) => !b.pending);

  // 0. Pairs kept once made, while their bank row is there, whatever it says.
  const consumed = new Set<BankRow>();
  const standing = new Map<string, Standing>();
  const superseded = new Map<string, BankRow>();
  if (opts.twins && opts.twins.size > 0) {
    const byId = new Map(posted.map((b) => [b.transaction_id, b]));
    for (const r of sorted) {
      const id = opts.twins.get(r.id);
      const b = id === undefined ? undefined : byId.get(id);
      if (!b || consumed.has(b)) continue;
      consumed.add(b);
      if (r.same_as) standing.set(r.id, { bank: b });
      else superseded.set(r.id, b);
    }
  }
  const decided = (r: T) => standing.has(r.id) || superseded.has(r.id);

  // 1. Claims on the bank's rows, while those rows are there.
  const byKey = new Map<string, BankRow[]>();
  for (const b of posted) {
    const k = bankKey(b);
    const list = byKey.get(k);
    if (list) list.push(b);
    else byKey.set(k, [b]);
  }
  for (const r of sorted) {
    if (!r.same_as || decided(r)) continue;
    const b = byKey.get(r.same_as)?.find((x) => !consumed.has(x));
    if (!b) continue;
    consumed.add(b);
    standing.set(r.id, { bank: b });
  }
  // 2. Claims on an earlier import's rows, while they are kept. Only an
  //    earlier import's: a row naming its own import's or a later one's is
  //    taken as a transaction of its own, so no chain of names goes round.
  const importOf = new Map(held.map((r) => [r.id, r.import_id]));
  for (const r of sorted) {
    if (!r.same_as_row || decided(r)) continue;
    const named = importOf.get(r.same_as_row);
    if (named !== undefined && before(named, r.import_id) < 0) standing.set(r.id, { row: r.same_as_row });
  }

  // 3. Superseded: the rest against the free posted rows, never across an
  //    edge, nor as a pair the person said is not one.
  const candidates = sorted.filter((r) => !decided(r));
  const forbidden = (r: T, b: BankRow) =>
    (r.distinct_from ?? []).includes(bankKey(b)) || crossesEdge(r.date, b.date, opts.bankFrom, opts.covers?.get(r.import_id) ?? null);
  const match = (rows: T[], twins: BankRow[], into: Map<string, BankRow>): Set<BankRow> => {
    const asRows = rows.map((r, index) => ({ index, date: r.date, amount: r.amount, currency: r.currency, name: r.name }));
    const pairs = pairUp(asRows, twins, (row, b) => forbidden(rows[row.index], b));
    const used = new Set<BankRow>();
    for (const [index, pair] of pairs) {
      into.set(rows[index].id, pair.twin);
      used.add(pair.twin);
    }
    return used;
  };
  let free = posted.filter((b) => !consumed.has(b));
  for (const import_id of [...new Set(candidates.map((r) => r.import_id))]) {
    if (free.length === 0) break;
    const rows = candidates.filter((r) => r.import_id === import_id);
    if (rows.length === 0) continue;
    const used = match(rows, free, superseded);
    if (used.size > 0) free = free.filter((b) => !used.has(b));
  }

  // 4. For display: a pending bank row stands in until it posts.
  const pendingStood = new Map<string, BankRow>();
  if (opts.pending) {
    const pendings = banks.filter((b) => b.pending);
    const left = candidates.filter((r) => !superseded.has(r.id));
    if (pendings.length > 0 && left.length > 0) {
      const asPosted = pendings.map((b) => ({ ...b, pending: false }));
      const original = new Map(asPosted.map((b, i) => [b, pendings[i]]));
      const stood = new Map<string, BankRow>();
      match(left, asPosted, stood);
      for (const [id, b] of stood) pendingStood.set(id, original.get(b)!);
    }
  }

  const counted = candidates.filter((r) => !superseded.has(r.id) && !pendingStood.has(r.id));
  return { counted, standing, superseded, pendingStood };
}
