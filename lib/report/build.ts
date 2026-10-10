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
//     are stored yet;
//   - stale: it last synced before the period's transactions can all be in:
//     POST_DAYS after its last day (banks post late), or today, whichever is
//     first. Or when it last synced isn't known;
//   - importing: its older transactions are still arriving;
//   - begins_late: its oldest stored transaction is after the period starts,
//     so if its accounts were open before then, the rest isn't here;
//   - refused, no_consent: a bank account or card there whose transactions
//     Plaid doesn't provide, or the person didn't allow;
//   - removed: a connection removed since, whose transactions went with it
//     (lib/disconnect-item.ts) and whose history may have reached into the
//     period, unless the institution was connected again (then the new
//     connection's own gaps say how far back it reaches);
//   - unreadable: anything else the read couldn't read (a manual account's
//     transactions, say), in the read's own words.
// A connection that holds only investment accounts, or no bank account or
// card, brings in no transactions by design: it is listed, never a gap. A
// period with no transactions says so rather than showing zeros.
//
// NO TAX ADVICE. The person marks the categories that matter to them
// (lib/report/settings.ts) and gets them as a group, with their transactions
// listed; nothing here decides, suggests or says how any category is taxed.

import type { Txn, TxnCoverage } from '../transactions';
import type { HealthState } from '../connection-state';
import { TRANSACTIONS_DAYS_REQUESTED, type NoTransactionsReason } from '../item-products';
import { noSpending, type NoSpending } from '../no-transactions';
import { currencyOf, inCurrency, isExcluded, isTransfer, totalsCurrency, type LeftOut } from '../spending';
import { categoryOf, categoryTotals, summarize, type CategoryTotal } from '../totals';
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
  no_transactions: NoTransactionsReason | null;
  /** When the connection last answered without an error. */
  last_ok_at: string | null;
  /** What the daily check last found wrong with it, while that lasts. */
  problem: { state: HealthState; since: string } | null;
  records_unreadable: boolean;
};

/** A manual account, as the report lists it. */
export type ManualFacts = { account_id: string; name: string; institution: string; updated_at: string | null };

/** A connection removed since (lib/links.ts removedConnections). */
export type RemovedFacts = { institution_name: string; institution_id: string | null; first_seen: string; last_seen: string };

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
  /** Removed connections, or null when the directory couldn't be read. */
  removed: readonly RemovedFacts[] | null;
  /** Directory entries that couldn't be read. */
  removedUnreadable: number;
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
  | { kind: 'missing'; item_id: string; institution: string }
  | { kind: 'stale'; item_id: string; institution: string; since: string | null }
  | { kind: 'importing'; item_id: string; institution: string }
  | { kind: 'begins_late'; item_id: string; institution: string; first: string }
  | { kind: 'refused'; item_id: string; institution: string }
  | { kind: 'no_consent'; item_id: string; institution: string }
  | { kind: 'removed'; item_id: null; institution: string; last_seen: string }
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
  /** Why it isn't in the totals (a transfer or loan payment; another
   *  currency), or null when it is. */
  not_counted: 'transfer' | 'currency' | null;
  /** Whether the person excluded it couldn't be read, so it counts. */
  exclusion_unknown: boolean;
  note: string | null;
};

export type ReportAppendix = {
  rows: AppendixRow[];
  /** Rows in the marked categories, before the limit. */
  total: number;
  limit: number;
  /** Rows in them the person excluded: left out of the list too. */
  excluded: number;
};

export type ReportInstitution = Omit<SourceFacts, 'institution_id'> & {
  /** The read's note about it, if any ("stored transactions could not be
   *  read"). */
  note: string | null;
};

export type ReportManualAccount = ManualFacts;

export type ReportRemoved = { institution: string; first_seen: string; last_seen: string; connected_again: boolean };

export type Report = {
  version: 1;
  period: Period;
  generated_at: string;
  /** The oldest of the times the institutions' transactions were last
   *  brought in (when the report's data is complete through, at best), or when
   *  the report was made, for one with no connection's transactions in it. */
  data_as_of: string;
  currency: string | null;
  /** The currencies the period's transactions are in, most first. */
  currencies: { currency: string; transactions: number }[];
  /** Every category in the period, and every one marked, for marking. */
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
    /** Whether a connection was removed couldn't all be read. */
    removed_unread: boolean;
    marked: 'none' | 'set' | 'unreadable';
  };
  /** No transaction in the period at all. */
  empty: boolean;
  /** When no connection can bring in spending and nothing else did: what is
   *  true of them (lib/no-transactions.ts). */
  no_spending: NoSpending | null;
};

const GAP_ORDER: GapKind[] = ['missing', 'removed', 'refused', 'no_consent', 'stale', 'importing', 'begins_late', 'unreadable'];

const minDay = (a: string, b: string) => (a < b ? a : b);
/** A name compared as the app groups one (lib/manual.ts normalizeInstitutionName). */
const nameKey = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The gaps one linked institution leaves in the period. */
function sourceGaps(s: SourceFacts, period: Period): Gap[] {
  const at = { item_id: s.item_id, institution: s.institution_name };
  if (s.no_transactions === 'refused' || s.no_transactions === 'no_consent') return [{ kind: s.no_transactions, ...at }];
  // Investment accounts only, or no bank account or card: nothing to bring in.
  if (s.no_transactions) return [];
  if (s.coverage === 'missing') return [{ kind: 'missing', ...at }];
  const gaps: Gap[] = [];
  const synced = s.synced_at ? dayIn(s.synced_at, period.time_zone) : null;
  if (synced === null || synced < minDay(addDays(period.through, POST_DAYS), period.today)) gaps.push({ kind: 'stale', ...at, since: synced });
  // Still importing: its oldest rows are still on their way, which says it.
  if (s.coverage === 'importing') gaps.push({ kind: 'importing', ...at });
  else if (s.first_date !== null && s.first_date > period.start) gaps.push({ kind: 'begins_late', ...at, first: s.first_date });
  return gaps;
}

/** Whether a removed connection's transactions may have been in the period:
 *  it was still connected on its first day or later, and the history a link
 *  brings (at most TRANSACTIONS_DAYS_REQUESTED days before it was first seen)
 *  could reach the period. */
function removedInPeriod(r: RemovedFacts, period: Period): boolean {
  return r.last_seen >= period.start && addDays(r.first_seen, -TRANSACTIONS_DAYS_REQUESTED) <= period.through;
}

/** Whether a gap reaches into the days from `start` to `end`. */
function gapTouches(g: Gap, start: string, end: string): boolean {
  switch (g.kind) {
    case 'stale':
      return g.since === null || end > g.since;
    case 'begins_late':
      return start < g.first;
    case 'removed':
      return start <= g.last_seen;
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
  const currencies = [...counts]
    .map(([currency, transactions]) => ({ currency, transactions }))
    .sort((a, b) => b.transactions - a.transactions || (a.currency < b.currency ? -1 : 1));
  const currency = input.currency !== null && counts.has(input.currency) ? input.currency : totalsCurrency(rows);

  const summary = summarize(rows, inPeriod, currency);
  const byCategory = categoryTotals(rows, inPeriod, currency);

  // Gaps: each linked institution's, the removed connections', and whatever
  // else the read couldn't read.
  const sourceNames = new Set(input.sources.map((s) => s.institution_name));
  const noteFor = (name: string) => input.notes.find((n) => n.startsWith(`${name}:`)) ?? null;
  const live = input.sources.map((s) => ({ id: s.institution_id, name: nameKey(s.institution_name) }));
  const removed: ReportRemoved[] = (input.removed ?? [])
    .filter((r) => removedInPeriod(r, period))
    .map((r) => ({
      institution: r.institution_name,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      // Connected again: the new connection's own gaps say how far back it reaches.
      connected_again: live.some((l) => (l.id && r.institution_id ? l.id === r.institution_id : l.name === nameKey(r.institution_name))),
    }));
  const gaps: Gap[] = [
    ...input.sources.flatMap((s) => sourceGaps(s, period)),
    ...removed.filter((r) => !r.connected_again).map((r): Gap => ({ kind: 'removed', item_id: null, institution: r.institution, last_seen: r.last_seen })),
    ...input.notes
      .filter((n) => ![...sourceNames].some((name) => n.startsWith(`${name}:`)))
      .map((note): Gap => ({ kind: 'unreadable', item_id: null, institution: null, note })),
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
  const markedList = input.markedUnreadable ? [] : [...new Set(input.marked ?? [])];
  const markedSet = new Set(markedList);
  let marked: ReportMarked | null = null;
  let appendix: ReportAppendix | null = null;
  if (markedList.length > 0) {
    const inOf = new Map(byCategory.in.map((c) => [c.category, c]));
    const outOf = new Map(byCategory.out.map((c) => [c.category, c]));
    const categories = markedList.map((category) => ({
      category,
      money_in: inOf.get(category)?.amount ?? 0,
      money_out: outOf.get(category)?.amount ?? 0,
      transactions: (inOf.get(category)?.transactions ?? 0) + (outOf.get(category)?.transactions ?? 0),
    }));
    const listed = rows
      .filter((t) => markedSet.has(categoryOf(t)))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name) || (a.transaction_id < b.transaction_id ? -1 : 1)));
    // The group's own totals, summed as every other total is.
    const group = summarize(listed, inPeriod, currency);
    marked = { categories, money_in: group.money_in, money_out: group.money_out };
    const shown = listed.filter((t) => !isExcluded(t));
    const limit = input.appendixLimit ?? APPENDIX_LIMIT;
    appendix = {
      rows: shown.slice(0, limit).map((t) => ({
        date: t.date,
        name: t.name,
        category: categoryOf(t),
        amount: t.amount,
        currency: currencyOf(t) ?? currency,
        account: t.account_name,
        institution: t.institution_name,
        source: t.source ?? 'plaid',
        pending: t.pending,
        not_counted: isTransfer(t) ? 'transfer' : !inCurrency(t, currency) ? 'currency' : null,
        exclusion_unknown: t.excluded === null,
        note: t.note ?? null,
      })),
      total: shown.length,
      limit,
      excluded: listed.length - shown.length,
    };
  }

  const bringing = input.sources.filter((s) => s.no_transactions === null && s.coverage !== 'missing');
  const known = bringing.flatMap((s) => (s.synced_at ? [s.synced_at] : [])).sort((a, b) => Date.parse(a) - Date.parse(b));
  const view = {
    without: input.sources.flatMap((s) => (s.no_transactions ? [{ item_id: s.item_id, institution_name: s.institution_name, reason: s.no_transactions }] : [])),
    connections: input.sources.length,
  };

  return {
    version: 1,
    period,
    generated_at: input.generatedAt,
    data_as_of: known[0] ?? input.generatedAt,
    currency,
    currencies,
    categories: [...new Set([...rows.map(categoryOf), ...markedList])].sort((a, b) => a.localeCompare(b)),
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
      .map(({ institution_id: _, ...s }) => ({ ...s, note: noteFor(s.institution_name) }))
      .sort((a, b) => a.institution_name.localeCompare(b.institution_name)),
    manual: [...input.manual].sort((a, b) => a.institution.localeCompare(b.institution) || a.name.localeCompare(b.name)),
    removed,
    gaps,
    caveats: {
      not_over: period.through < period.end,
      settling: period.today < addDays(period.through, POST_DAYS),
      hidden: input.hidden,
      health_unread: input.healthUnread,
      removed_unread: input.removed === null || input.removedUnreadable > 0,
      marked: input.markedUnreadable ? 'unreadable' : markedList.length > 0 ? 'set' : 'none',
    },
    empty: rows.length === 0,
    no_spending: noSpending(view, rows.length),
  };
}
