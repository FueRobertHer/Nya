// lib/report/build.ts
//
// A report for an accountant (#43): a tax-year summary or a report on any
// range of days, built from the Activity tab's own rows (lib/activity.ts, read
// by lib/report/read.ts) and what Nya knows of each institution. Pure, so the
// same rows always give the same report, wherever it is built, and its
// numbers are tested against the Activity tab's.
//
// THE APP'S RULES, NONE OF ITS OWN. Every total goes through lib/totals.ts
// (summarize, categoryTotals), so through countsInTotals (lib/spending.ts):
// one currency per report (the one most of the period's transactions are in,
// unless the person picks another of theirs), the rest named and left out,
// never converted; what the person excluded left out and counted; transfers,
// cash withdrawals and loan payments (paying a card off among them) never
// money in or out. Rows entered by hand or imported into a manual account
// count as a bank's do, and the appendix says where each one came from.
// Hidden accounts are left out by the read, as everywhere.
//
// NEVER COMPLETE WITHOUT SAYING SO. A report handed to an accountant must
// never imply completeness it does not have. Each way a period can be short is
// a gap (Gap), named with its institution and, where it has one, its day on
// the person's calendar, and each month it touches says so:
//   - missing: an institution's stored transactions couldn't be read, or none
//     are stored yet; not when the history it can bring (at most
//     TRANSACTIONS_DAYS_REQUESTED days before it was first seen) can't reach
//     the period;
//   - stale: it last synced before the period's transactions can all be in:
//     POST_DAYS after its last day (banks post late), or today, whichever is
//     first. Or when it last synced isn't known;
//   - partial: an account it used to report stopped appearing (the daily
//     check's "Missing accounts"), so if that account is still open, its
//     later transactions aren't here;
//   - importing: its older transactions are still arriving;
//   - begins_late: its oldest stored transaction is after the period starts,
//     so if its accounts were open before then, the rest isn't here;
//   - refused, no_consent: a bank account or card there whose transactions
//     Plaid doesn't provide, or the person didn't allow;
//   - removed: a connection removed since, whose transactions went with it
//     (lib/disconnect-item.ts) and whose history may have reached into the
//     period, unless every one of its accounts is back: linked by the person
//     to an account connected now (lib/link-core.ts), or matched to one at the
//     same institution by its last four digits and type. Then the new
//     connection's own gaps say how far back it reaches. Decided per account,
//     so a second login at the same bank, or the same login added back with
//     fewer accounts, never passes for the one removed;
//   - removed_unknown: whether a connection was removed couldn't all be read;
//   - own_categories, own_exclusions: the person's own categories, or the
//     exclusions they carried across a re-link, couldn't be read, so the
//     totals use the bank's categories, or may count what they excluded;
//   - unreadable: anything else the read couldn't read (a manual account's
//     transactions, say), in the read's own words.
// A connection that holds only investment accounts, or no bank account or
// card, brings in no transactions by design: it is listed, never a gap, and
// the report says what it doesn't cover. A period with no transactions says
// so rather than showing zeros.
//
// NO TAX ADVICE. The person marks the categories that matter to them
// (lib/report/settings.ts) and gets them as a group, with their transactions
// listed; nothing here decides, suggests or says how any category is taxed.

import type { Txn, TxnCoverage } from '../transactions';
import type { HealthState } from '../connection-state';
import { TRANSACTIONS_DAYS_REQUESTED, type NoTransactionsReason } from '../item-products';
import { noSpending, type NoSpending } from '../no-transactions';
import { isInvestmentType } from '../balance';
import { currencyOf, inCurrency, isExcluded, isTransfer, totalsCurrency, type LeftOut } from '../spending';
import { categoryOf, categoryTotals, summarize, type CategoryTotal } from '../totals';
import { categoryKey } from './settings';
import { addDays, dayIn, periodMonths, type Period } from './period';

/** How long a bank can take to post a transaction: a period's transactions
 *  are all in once a connection has synced this many days after its last day
 *  (or today, if that is sooner). */
export const POST_DAYS = 3;
/** The most transactions the appendix lists; the totals count them all. */
export const APPENDIX_LIMIT = 500;

/** What the report knows of one linked institution (lib/report/read.ts). */
export type SourceFacts = {
  item_id: string;
  institution_name: string;
  institution_id: string | null;
  coverage: TxnCoverage;
  /** When its transactions were last brought in (an instant), or null when
   *  not known. */
  synced_at: string | null;
  /** The oldest day of its stored transactions, or null with none. */
  first_date: string | null;
  /** The first UTC day any of its accounts was seen (the account
   *  directory), or null when not known. */
  first_seen: string | null;
  no_transactions: NoTransactionsReason | null;
  /** When the connection last answered without an error. */
  last_ok_at: string | null;
  /** What the daily check last found wrong with it, while that lasts. */
  problem: { state: HealthState; since: string } | null;
  records_unreadable: boolean;
  /** Whether it holds investment or loan accounts, as last loaded: their
   *  activity is never in a report. */
  holds: { investment: boolean; loans: boolean };
};

/** A manual account, as the report lists it. */
export type ManualFacts = { account_id: string; name: string; institution: string; type: string; updated_at: string | null };

/** One account of a removed connection, as the directory remembers it. */
export type RemovedAccountFacts = { account_id: string; name: string | null; mask: string | null; type: string | null };

/** A connection removed since (lib/links.ts removedConnections), with its
 *  accounts not hidden. */
export type RemovedFacts = {
  institution_name: string;
  institution_id: string | null;
  first_seen: string;
  last_seen: string;
  accounts: RemovedAccountFacts[];
};

/** An account of a connection stored now: what a removed account is matched
 *  against. */
export type LiveAccountFacts = { account_id: string; institution_id: string | null; institution_name: string; mask: string | null; type: string | null };

export type ReportInput = {
  period: Period;
  /** When the report was made (an instant). */
  generatedAt: string;
  /** The Activity tab's rows from the period's first day on; later ones are
   *  left out here. */
  rows: readonly Txn[];
  /** The currency asked for; the default (null, or one no row is in) is the
   *  one most of the period's transactions are in. */
  currency: string | null;
  sources: readonly SourceFacts[];
  /** What the read couldn't read, in its own words ("Chase: ..."). */
  notes: readonly string[];
  manual: readonly ManualFacts[];
  /** The manual accounts whose rows couldn't be read, or 'all'. */
  manualUnread: readonly string[] | 'all';
  /** Removed connections, or null when the directory couldn't be read. */
  removed: readonly RemovedFacts[] | null;
  /** Directory entries that couldn't be read. */
  removedUnreadable: number;
  /** The accounts of the connections stored now, and the person's links from
   *  an earlier account's id to the one it is now (lib/link-core.ts). */
  liveAccounts: readonly LiveAccountFacts[];
  links: ReadonlyMap<string, string>;
  /** Whether the person's own categories, names for merchants and exclusions
   *  carried across a re-link were all read (lib/activity.ts own_read). */
  ownRead: { categories: boolean; names: boolean; exclusions: boolean };
  /** The categories marked as mattering for taxes; null when none were ever
   *  saved, or they couldn't be read (markedUnreadable). */
  marked: readonly string[] | null;
  markedUnreadable: boolean;
  /** Some account is hidden, and left out. */
  hidden: boolean;
  /** How each connection is doing couldn't be read. */
  healthUnread: boolean;
  appendixLimit?: number;
};

/** One way the period may be short (see the header). Days are on the
 *  person's calendar. `item_id` places it under its institution. */
export type Gap =
  | { kind: 'missing'; item_id: string; institution: string; reach: string | null }
  | { kind: 'stale'; item_id: string; institution: string; since: string | null }
  | { kind: 'partial'; item_id: string; institution: string; since: string }
  | { kind: 'importing'; item_id: string; institution: string }
  | { kind: 'begins_late'; item_id: string; institution: string; first: string }
  | { kind: 'refused'; item_id: string; institution: string }
  | { kind: 'no_consent'; item_id: string; institution: string }
  | { kind: 'removed'; item_id: null; institution: string; last_seen: string; accounts: string[]; partly_back: boolean }
  | { kind: 'removed_unknown'; item_id: null; institution: null }
  | { kind: 'own_categories'; item_id: null; institution: null }
  | { kind: 'own_exclusions'; item_id: null; institution: null }
  | { kind: 'unreadable'; item_id: null; institution: null; note: string };

export type GapKind = Gap['kind'];

export type ReportTotals = {
  money_in: number;
  money_out: number;
  net: number;
  /** Rows in the period, and of them: counted; left out as transfers, cash
   *  withdrawals or loan payments; left out because the person excluded them;
   *  counted although whether they did couldn't be read. */
  transactions: number;
  counted: number;
  transfers: number;
  excluded: number;
  exclusion_unknown: number;
  /** Left out for another currency, by currency, and as a sentence. */
  left_out: LeftOut;
  left_out_text: string | null;
};

export type ReportMonth = {
  month: string;
  /** Its days inside the period (a range can start or end mid-month; a year
   *  still running stops at today). */
  start: string;
  end: string;
  /** Still to come: after the last day this report covers. */
  future: boolean;
  money_in: number;
  money_out: number;
  net: number;
  /** Rows counted in it. */
  transactions: number;
  /** The institutions whose gaps reach into it, and whether any gap does
   *  (one not tied to an institution among them). */
  gaps: string[];
  uncertain: boolean;
};

export type ReportMarked = {
  categories: { category: string; money_in: number; money_out: number; transactions: number }[];
  money_in: number;
  money_out: number;
};

export type AppendixRow = {
  date: string;
  name: string;
  category: string;
  /** Plaid's sign: positive is money out. */
  amount: number;
  /** Its own currency, or the report's for a row that says none. */
  currency: string | null;
  account: string;
  institution: string;
  /** 'plaid' for a bank's row, else a manual row's source ('manual',
   *  'import:ofx', ...: lib/manual-txn-input.ts sourceLabel). */
  source: string;
  pending: boolean;
  /** Why it isn't in the totals (the person excluded it; a transfer or loan
   *  payment; another currency), or null when it is. */
  not_counted: 'excluded' | 'transfer' | 'currency' | null;
  /** Whether the person excluded it couldn't be read, so it counts. */
  exclusion_unknown: boolean;
  note: string | null;
};

export type ReportAppendix = {
  rows: AppendixRow[];
  /** Rows in the marked categories, before the limit. */
  total: number;
  limit: number;
  /** Rows among them the person excluded: listed, not counted. */
  excluded: number;
};

export type ReportInstitution = Omit<SourceFacts, 'institution_id' | 'first_seen'> & {
  /** The read's note about it, if any ("stored transactions could not be
   *  read"). */
  note: string | null;
};

export type ReportManualAccount = ManualFacts & {
  /** Its transactions in the period, or null when they couldn't be read. */
  transactions: number | null;
};

export type ReportRemoved = {
  institution: string;
  first_seen: string;
  last_seen: string;
  /** Every one of its accounts is back (see the header). */
  connected_again: boolean;
  /** Its accounts that aren't, as "Name ••1234". */
  not_back: string[];
};

export type Report = {
  version: 1;
  period: Period;
  generated_at: string;
  /** The oldest of the times the institutions' transactions were last
   *  brought in (when the report's data is complete through, at best); null
   *  when that isn't known for one of them, or one couldn't be loaded; when
   *  the report was made, for one with no connection's transactions in it. */
  data_as_of: string | null;
  currency: string | null;
  /** The currencies the period's transactions are in, most first, the
   *  report's own first among equals. */
  currencies: { currency: string; transactions: number }[];
  /** Every category in the period and every one marked, as the app files a
   *  category (lib/report/settings.ts categoryKey), for marking. */
  categories: string[];
  totals: ReportTotals;
  money_in: CategoryTotal[];
  money_out: CategoryTotal[];
  months: ReportMonth[];
  /** The marked categories' group, or null with none marked. */
  marked: ReportMarked | null;
  appendix: ReportAppendix | null;
  institutions: ReportInstitution[];
  manual: ReportManualAccount[];
  removed: ReportRemoved[];
  gaps: Gap[];
  caveats: {
    /** A year still running: covered through today. */
    not_over: boolean;
    /** The period ended less than POST_DAYS ago, or hasn't: its last days
     *  may still change. */
    settling: boolean;
    hidden: boolean;
    health_unread: boolean;
    marked: 'none' | 'set' | 'unreadable';
    /** What isn't in any report that some account here holds: activity
     *  inside investment accounts, and inside loans. */
    scope: { investment: boolean; loans: boolean };
    /** The person's names for merchants couldn't be read: the bank's show. */
    names_unread: boolean;
  };
  /** No transaction in the period at all. */
  empty: boolean;
  /** When no connection can bring in spending and nothing else did: what is
   *  true of them (lib/no-transactions.ts). */
  no_spending: NoSpending | null;
};

const GAP_ORDER: GapKind[] = [
  'missing',
  'removed',
  'removed_unknown',
  'refused',
  'no_consent',
  'stale',
  'partial',
  'importing',
  'begins_late',
  'own_categories',
  'own_exclusions',
  'unreadable',
];

const minDay = (a: string, b: string) => (a < b ? a : b);
/** A name compared as the app groups one (lib/manual.ts normalizeInstitutionName). */
const nameKey = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The earliest day a connection's history can reach: a link brings at most
 *  TRANSACTIONS_DAYS_REQUESTED days before it was first seen. Null when that
 *  isn't known. */
const reachOf = (firstSeen: string | null) => (firstSeen ? addDays(firstSeen, -TRANSACTIONS_DAYS_REQUESTED) : null);

/** The gaps one linked institution leaves in the period. */
function sourceGaps(s: SourceFacts, period: Period): Gap[] {
  const at = { item_id: s.item_id, institution: s.institution_name };
  if (s.no_transactions === 'refused' || s.no_transactions === 'no_consent') return [{ kind: s.no_transactions, ...at }];
  // Investment accounts only, or no bank account or card: nothing to bring in.
  if (s.no_transactions) return [];
  if (s.coverage === 'missing') {
    // A connection whose history can't reach the period leaves nothing of it out.
    const reach = reachOf(s.first_seen);
    return reach !== null && reach > period.through ? [] : [{ kind: 'missing', ...at, reach }];
  }
  const gaps: Gap[] = [];
  const allIn = minDay(addDays(period.through, POST_DAYS), period.today);
  const synced = s.synced_at ? dayIn(s.synced_at, period.time_zone) : null;
  if (synced === null || synced < allIn) gaps.push({ kind: 'stale', ...at, since: synced });
  // An account it used to report stopped appearing before the period's
  // transactions could all be in.
  const gone = s.problem?.state === 'partial' ? dayIn(s.problem.since, period.time_zone) : null;
  if (gone !== null && gone < allIn) gaps.push({ kind: 'partial', ...at, since: gone });
  // Still importing: its oldest rows are still on their way, which says it.
  if (s.coverage === 'importing') gaps.push({ kind: 'importing', ...at });
  else if (s.first_date !== null && s.first_date > period.start) gaps.push({ kind: 'begins_late', ...at, first: s.first_date });
  return gaps;
}

/** Whether a removed connection's transactions may have been in the period:
 *  it was still connected on its first day or later, and the history a link
 *  brings could reach the period. */
function removedInPeriod(r: RemovedFacts, period: Period): boolean {
  return r.last_seen >= period.start && reachOf(r.first_seen)! <= period.through;
}

/** "Sapphire ••1234": an account as a gap names it. */
const accountLabel = (a: RemovedAccountFacts) => `${a.name ?? 'An account'}${a.mask ? ` ••${a.mask}` : ''}`;

/** Whether a gap reaches into the days from `start` to `end`. A day's
 *  transactions can post up to POST_DAYS later, so a sync, or an account
 *  last seen, that soon after a month ends still leaves it short. */
function gapTouches(g: Gap, start: string, end: string): boolean {
  switch (g.kind) {
    case 'stale':
      return g.since === null || addDays(end, POST_DAYS) > g.since;
    case 'partial':
      return addDays(end, POST_DAYS) > g.since;
    case 'begins_late':
      return start < g.first;
    case 'removed':
      return start <= g.last_seen;
    case 'missing':
      return g.reach === null || end >= g.reach;
    default:
      return true;
  }
}

export function buildReport(input: ReportInput): Report {
  const { period } = input;
  const inPeriod = (d: string) => d >= period.start && d <= period.through;
  const rows = input.rows.filter((t) => inPeriod(t.date));

  // One currency: the one asked for, if the period has any of it, else the
  // one most of its transactions are in (lib/spending.ts totalsCurrency).
  const counts = new Map<string, number>();
  for (const t of rows) {
    const c = currencyOf(t);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const currency = input.currency !== null && counts.has(input.currency) ? input.currency : totalsCurrency(rows);
  const currencies = [...counts]
    .map(([c, transactions]) => ({ currency: c, transactions }))
    .sort((a, b) => b.transactions - a.transactions || (a.currency === currency ? -1 : b.currency === currency ? 1 : a.currency < b.currency ? -1 : 1));

  const summary = summarize(rows, inPeriod, currency);
  const byCategory = categoryTotals(rows, inPeriod, currency);

  // The read's notes: an institution whose transactions aren't all here
  // (missing, importing) has one of its own ("Chase: ..."), already said by
  // its gap, and kept beside it. Every other note is a gap of its own, a
  // manual account's under an institution of the same name as a bank's
  // included: only one note per such institution is its own.
  const unexplained = [...input.notes];
  const noteOf = new Map<string, string>();
  for (const s of input.sources) {
    if (s.coverage === 'complete') continue;
    const i = unexplained.findIndex((n) => n.startsWith(`${s.institution_name}:`));
    if (i >= 0) noteOf.set(s.item_id, unexplained.splice(i, 1)[0]);
  }

  // Removed connections: each account back, or not (see the header).
  const liveIds = new Set(input.liveAccounts.map((a) => a.account_id));
  const linkedBack = (id: string) => {
    let current = id;
    const seen = new Set([id]);
    for (let i = 0; i < 50; i++) {
      const next = input.links.get(current);
      if (!next || seen.has(next)) break;
      seen.add(next);
      current = next;
    }
    return current !== id && liveIds.has(current);
  };
  const sameInstitution = (l: LiveAccountFacts, r: RemovedFacts) =>
    l.institution_id && r.institution_id ? l.institution_id === r.institution_id : nameKey(l.institution_name) === nameKey(r.institution_name);
  const matchedBack = (a: RemovedAccountFacts, r: RemovedFacts) =>
    !!a.mask && !!a.type && input.liveAccounts.some((l) => sameInstitution(l, r) && l.mask === a.mask && l.type === a.type);
  const removedHere = (input.removed ?? [])
    .filter((r) => r.accounts.length > 0 && removedInPeriod(r, period))
    .map((r) => ({ r, notBack: r.accounts.filter((a) => !linkedBack(a.account_id) && !matchedBack(a, r)) }));
  const removed: ReportRemoved[] = removedHere.map(({ r, notBack }) => ({
    institution: r.institution_name,
    first_seen: r.first_seen,
    last_seen: r.last_seen,
    connected_again: notBack.length === 0,
    not_back: notBack.map(accountLabel),
  }));

  const loose = (kind: 'removed_unknown' | 'own_categories' | 'own_exclusions'): Gap => ({ kind, item_id: null, institution: null });
  const gaps: Gap[] = [
    ...input.sources.flatMap((s) => sourceGaps(s, period)),
    ...removedHere
      .filter(({ notBack }) => notBack.length > 0)
      .map(({ r, notBack }): Gap => ({
        kind: 'removed',
        item_id: null,
        institution: r.institution_name,
        last_seen: r.last_seen,
        accounts: notBack.map(accountLabel),
        partly_back: notBack.length < r.accounts.length,
      })),
    ...(input.removed === null || input.removedUnreadable > 0 ? [loose('removed_unknown')] : []),
    ...(input.ownRead.categories ? [] : [loose('own_categories')]),
    ...(input.ownRead.exclusions ? [] : [loose('own_exclusions')]),
    ...unexplained.map((note): Gap => ({ kind: 'unreadable', item_id: null, institution: null, note })),
  ].sort((a, b) => GAP_ORDER.indexOf(a.kind) - GAP_ORDER.indexOf(b.kind) || String(a.institution).localeCompare(String(b.institution)));

  const months: ReportMonth[] = periodMonths(period).map((m) => {
    if (m.start > period.through) {
      return { month: m.month, start: m.start, end: m.end, future: true, money_in: 0, money_out: 0, net: 0, transactions: 0, gaps: [], uncertain: false };
    }
    const end = minDay(m.end, period.through);
    const s = summarize(rows, (d) => d >= m.start && d <= end, currency);
    const touching = gaps.filter((g) => gapTouches(g, m.start, end));
    return {
      month: m.month,
      start: m.start,
      end,
      future: false,
      money_in: s.money_in,
      money_out: s.money_out,
      net: s.net,
      transactions: s.counted,
      gaps: [...new Set(touching.flatMap((g) => (g.institution ? [g.institution] : [])))].sort((a, b) => a.localeCompare(b)),
      uncertain: touching.length > 0,
    };
  });

  // The marked categories: their totals, and their transactions listed.
  // Matched as the app files a category, so "home  office" is in "home office".
  const keyOf = (t: Txn) => categoryKey(categoryOf(t));
  const markedList = input.markedUnreadable ? [] : [...new Set((input.marked ?? []).map(categoryKey).filter(Boolean))];
  const markedSet = new Set(markedList);
  let marked: ReportMarked | null = null;
  let appendix: ReportAppendix | null = null;
  if (markedList.length > 0) {
    const listed = rows
      .filter((t) => markedSet.has(keyOf(t)))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name) || (a.transaction_id < b.transaction_id ? -1 : 1)));
    // Each marked category's totals, and the group's, summed as every other
    // total is, over its rows filed by key.
    const byKey = categoryTotals(
      listed.map((t) => ({ ...t, category: keyOf(t) })),
      inPeriod,
      currency
    );
    const inOf = new Map(byKey.in.map((c) => [c.category, c]));
    const outOf = new Map(byKey.out.map((c) => [c.category, c]));
    const group = summarize(listed, inPeriod, currency);
    marked = {
      categories: markedList.map((category) => ({
        category,
        money_in: inOf.get(category)?.amount ?? 0,
        money_out: outOf.get(category)?.amount ?? 0,
        transactions: (inOf.get(category)?.transactions ?? 0) + (outOf.get(category)?.transactions ?? 0),
      })),
      money_in: group.money_in,
      money_out: group.money_out,
    };
    const limit = input.appendixLimit ?? APPENDIX_LIMIT;
    appendix = {
      rows: listed.slice(0, limit).map((t) => ({
        date: t.date,
        name: t.name,
        category: keyOf(t),
        amount: t.amount,
        currency: currencyOf(t) ?? currency,
        account: t.account_name,
        institution: t.institution_name,
        source: t.source ?? 'plaid',
        pending: t.pending,
        not_counted: isExcluded(t) ? 'excluded' : isTransfer(t) ? 'transfer' : !inCurrency(t, currency) ? 'currency' : null,
        exclusion_unknown: t.excluded === null,
        note: t.note ?? null,
      })),
      total: listed.length,
      limit,
      excluded: listed.filter((t) => isExcluded(t)).length,
    };
  }

  // When the data is from: the oldest last sync of the connections that bring
  // transactions into the period; not known when one of them couldn't be
  // loaded or doesn't say. With none, the rows were read as the report was made.
  const bringing = input.sources.filter((s) => {
    if (s.no_transactions !== null) return false;
    const reach = reachOf(s.first_seen);
    return !(s.coverage === 'missing' && reach !== null && reach > period.through);
  });
  const known = bringing.every((s) => s.coverage !== 'missing' && s.synced_at !== null);
  const oldest = bringing.map((s) => s.synced_at!).sort((a, b) => Date.parse(a) - Date.parse(b))[0];

  // Each manual account's transactions in the period, unless they couldn't be read.
  const manualRead = (id: string) => input.manualUnread !== 'all' && !input.manualUnread.includes(id);
  const manualCounts = new Map<string, number>();
  for (const t of rows) if (t.account_id && t.source) manualCounts.set(t.account_id, (manualCounts.get(t.account_id) ?? 0) + 1);

  const view = {
    without: input.sources.flatMap((s) => (s.no_transactions ? [{ item_id: s.item_id, institution_name: s.institution_name, reason: s.no_transactions }] : [])),
    connections: input.sources.length,
  };

  return {
    version: 1,
    period,
    generated_at: input.generatedAt,
    data_as_of: bringing.length === 0 ? input.generatedAt : known ? oldest : null,
    currency,
    currencies,
    categories: [...new Set([...rows.map(keyOf), ...markedList])].sort((a, b) => a.localeCompare(b)),
    totals: {
      money_in: summary.money_in,
      money_out: summary.money_out,
      net: summary.net,
      transactions: summary.transactions,
      counted: summary.counted,
      transfers: summary.transfers,
      excluded: summary.excluded,
      exclusion_unknown: summary.exclusion_unknown,
      left_out: summary.left_out,
      left_out_text: summary.left_out_text,
    },
    money_in: byCategory.in,
    money_out: byCategory.out,
    months,
    marked,
    appendix,
    institutions: input.sources
      .map(({ institution_id: _id, first_seen: _seen, ...s }) => ({ ...s, note: noteOf.get(s.item_id) ?? null }))
      .sort((a, b) => a.institution_name.localeCompare(b.institution_name)),
    manual: input.manual
      .map((m) => ({ ...m, transactions: manualRead(m.account_id) ? (manualCounts.get(m.account_id) ?? 0) : null }))
      .sort((a, b) => a.institution.localeCompare(b.institution) || a.name.localeCompare(b.name)),
    removed,
    gaps,
    caveats: {
      not_over: period.through < period.end,
      settling: period.today < addDays(period.through, POST_DAYS),
      hidden: input.hidden,
      health_unread: input.healthUnread,
      marked: input.markedUnreadable ? 'unreadable' : markedList.length > 0 ? 'set' : 'none',
      scope: {
        investment:
          input.sources.some((s) => s.holds.investment || s.no_transactions === 'investment_accounts') || input.manual.some((m) => isInvestmentType(m.type)),
        loans: input.sources.some((s) => s.holds.loans) || input.manual.some((m) => m.type === 'loan'),
      },
      names_unread: !input.ownRead.names,
    },
    empty: rows.length === 0,
    no_spending: noSpending(view, rows.length),
  };
}
