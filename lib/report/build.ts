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
//     are stored yet. One never synced isn't missing from a period the
//     history it can bring (at most TRANSACTIONS_DAYS_REQUESTED days before
//     it was first seen) can't reach; one whose store can't be read always
//     is, from every day, since it may have been linked before it was first
//     seen (before balance history or the account directory began);
//   - stale: it last synced before the period's transactions can all be in:
//     POST_DAYS after its last day (banks post late), or today, whichever is
//     first. Or when it last synced isn't known;
//   - partial: an account it used to report stopped appearing (the daily
//     check's "Missing accounts"), so if that account is still open, its
//     later transactions aren't here;
//   - importing: its older transactions are still arriving;
//   - begins_late: its oldest stored transaction is after the period starts,
//     so if its accounts were open before then, the rest isn't here. With
//     none stored, the same from the earliest day its history can reach,
//     when that is after the period starts. Counting the days the files
//     imported into its accounts cover (see IMPORTED);
//   - refused, no_consent: a bank account or card there whose transactions
//     Plaid doesn't provide, or the person didn't allow;
//   - removed: a connection removed since, whose transactions went with it
//     (lib/disconnect-item.ts) and whose history may have reached into the
//     period, unless every one of its accounts is back: linked by the person
//     to an account connected now (lib/link-core.ts), or matched to one at the
//     same institution by its last four digits and type. Then the new
//     connection's own gaps say how far back it reaches. Decided per account,
//     so a second login at the same bank, or the same login added back with
//     fewer accounts, never passes for the one removed. An account that ended
//     by the period's first day (see ENDED ACCOUNTS) had nothing in it to go
//     with the connection, so it is no gap, though it isn't back;
//   - disconnected: an account a SimpleFIN connection kept up to date was
//     let go during the period and kept as a manual account, so from that
//     day its transactions are only the ones entered or imported (one let go
//     and removed is `removed`, its transactions having gone with it);
//   - removed_unknown: whether a connection was removed couldn't all be read;
//   - own_categories, own_exclusions: the person's own categories, or the
//     exclusions they carried across a re-link, couldn't be read, so the
//     totals use the bank's categories, or may count what they excluded;
//   - unreadable: any other transactions the read couldn't read (a manual
//     account's, say), in the read's own words. Only a note that says
//     transactions couldn't all be read or aren't all in is one
//     (lib/activity.ts `unread_notes`); what the read says of how what it
//     read applies (a rule, a category, a split, a group or an approval that
//     couldn't be read) leaves no transaction out, so it is a caveat on the
//     totals (`caveats.notes`), never a gap, and makes no month uncertain;
//   - assumed_closed: an account Nya took as closed because it stopped
//     appearing at its bank and nobody said otherwise (lib/lifecycle.ts): if
//     it is still open, its transactions from then aren't here;
//   - missed: a window an account was missing from its bank's answer before
//     it came back (lib/lifecycle.ts `missed`, the days the chart leaves out
//     as short of it), or that SimpleFIN left an account that ended out of
//     (lib/report/read.ts connectorMissed): its transactions from those days
//     may be missing; or (`let_go`) days a SimpleFIN account was let go
//     before its connection's history reached them;
//   - untracked: an account the person stopped following, still theirs: its
//     transactions from then exist, and aren't counted (see ENDED ACCOUNTS).
// A connection that holds only investment accounts, or no bank account or
// card, brings in no transactions by design: it is listed, never a gap, and
// the report says what it doesn't cover. So is one whose every account had
// ended by the period's first day (`ended_by`, see ENDED ACCOUNTS): nothing
// of it is in the period to be missing. A period with no transactions says
// so rather than showing zeros.
//
// ENDED ACCOUNTS (lib/lifecycle.ts) count as the Activity tab counts them:
// every day before the end, none from it. The read keeps their later rows
// (lib/activity.ts keepEnded) so that the report leaves them out by that rule
// itself and says what it left out, never passing them off as nothing: each
// account whose end the period has something to say of is listed with the
// sources, as closed, no longer the person's, or not followed, from its day,
// with how many of its rows in the period are in Nya and not counted. Listed
// when its end falls in the period, or before it when the account is only
// assumed closed, still the person's (untracked), or holds rows in it. Closed
// and left are never gaps: nothing of the person's is missing. An assumed
// closure and an untracked account are, from their day; so is a missing
// window, on its days; each only for an account whose own transactions a
// report can hold (never an investment account's or a loan's, see the scope
// caveat). A manual account that ended by the period's first day holds
// nothing in it, and isn't listed as a source of it.
//
// SIMPLEFIN. Each bank a SimpleFIN connection reaches is an institution here
// too, with the connection it comes through and its state in its card's own
// words: stale from its last clean sync (a request that failed, a problem
// SimpleFIN reported, a bank balance days old: what it holds after that day
// may not have come), importing while its older history arrives (only when
// the period starts before what has come), begins_late once that history is
// all in. A card waiting for the person's answer about its sign holds its
// balance in the app, never its transactions: said beside it, not a gap.
//
// IMPORTED. Transactions imported into a linked account from its bank's
// files (#52, lib/history-import/) are its rows, in the period as the
// Activity tab counts them, from the period's first day on (and, for an
// account that ended, up to its end: see ENDED ACCOUNTS). Where they reach,
// the bank's own don't need to: an institution's transactions begin, for a
// period, on the latest day from which each of its bank accounts and cards
// is covered through the period's last day (one that ended in the period,
// through the day before its end; one that ended by its first, not at all),
// by the bank's own days (its oldest stored transaction on) or by a file
// imported into it that holds every transaction of its own period. So a
// period the files cover for
// every account has no gap, and one they cover for some accounts names
// those, and how far back each reaches, beside the day the rest begin. A
// bank whose transactions Plaid doesn't provide, or the person didn't allow,
// or that never synced, is short of nothing in a period the files cover for
// every account either. Where the data comes from says how far back each
// account's files reach.
//
// NO TAX ADVICE. The person marks the categories that matter to them
// (lib/report/settings.ts) and gets them as a group, with their transactions
// listed; nothing here decides, suggests or says how any category is taxed.
//
// CATEGORIES are the person's own (lib/categories.ts), as the rows were filed
// by them (lib/activity.ts): each total is a category's, by its id, named as
// it is named now, as the Activity tab and the API's /spending total them. A
// mark is stored as a category's words (one of its text keys, which a rename
// never changes), and found among the categories by them each time: a
// renamed category is still marked, under its new name, and one merged into
// another takes its marks there, its rows with them. Words no category has
// now stay marked, matched by a row's own words, as before categories had
// ids, and so does everything when the rows come without categories.

import type { Txn, TxnCoverage } from '../transactions';
import type { HealthState } from '../connection-state';
import { TRANSACTIONS_DAYS_REQUESTED, type NoTransactionsReason } from '../item-products';
import { noSpending, type NoSpending } from '../no-transactions';
import { isInvestmentType } from '../balance';
import { countTransactions, currencyOf, inCurrency, isExcluded, isTransfer, totalsCurrency, transactionCounter, type LeftOut } from '../spending';
import { bankRows } from '../split-rows';
import { categoryOf, categoryTotals, summarize, type CategoryTotal } from '../totals';
import { categoryById, categoryForKey, choiceText, indexTaxonomy, textKey, TEXT, type Taxonomy } from '../categories';
import { categoryKey } from './settings';
import { addDays, dayIn, periodMonths, type Period } from './period';
import { filesCoverAll as everyAccountCovered, runStart, throughFor } from '../history-import/coverage';

/** How long a bank can take to post a transaction: a period's transactions
 *  are all in once a connection has synced this many days after its last day
 *  (or today, if that is sooner). */
export const POST_DAYS = 3;
/** The most transactions the appendix lists; the totals count them all. */
export const APPENDIX_LIMIT = 500;

/** For a bank a SimpleFIN connection reaches: the connection it comes
 *  through, its state in its card's badge's words, and the cards or loans
 *  there waiting for the person's answer about their sign (lib/connectors/). */
export type ConnectorSourceFacts = { label: string; host: string | null; state: string; waiting: string[] };

/** What the report knows of one linked institution (lib/report/read.ts), or
 *  of one bank a SimpleFIN connection reaches (`connector`). */
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
  /** `missing` because its store was read and holds nothing yet, not
   *  because it couldn't be read (lib/transactions.ts
   *  storedItemTransactions). */
  never_synced: boolean;
  no_transactions: NoTransactionsReason | null;
  /** When the connection last answered without an error. */
  last_ok_at: string | null;
  /** What the daily check last found wrong with it, while that lasts. */
  problem: { state: HealthState; since: string } | null;
  records_unreadable: boolean;
  /** Whether it holds investment or loan accounts, as last loaded: their
   *  activity is never in a report. */
  holds: { investment: boolean; loans: boolean };
  /** The day the last of its accounts (those not hidden) ended, when every
   *  one has (lib/lifecycle.ts); null or absent while one counts. */
  ended_by?: string | null;
  /** Every account it is remembered to hold is hidden (and it holds some):
   *  none of its transactions is read, so its stored rows' first day (which
   *  leaves hidden accounts' out) says nothing of how far back it reaches. */
  every_hidden?: boolean;
  /** Set for a bank a SimpleFIN connection reaches. */
  connector?: ConnectorSourceFacts;
  /** Its bank accounts and cards (not hidden), each with the days the files
   *  imported into it cover (see IMPORTED) and the day it stopped counting,
   *  when it ended (lib/lifecycle.ts): it needs covering only up to then;
   *  absent when not known. */
  accounts?: { name: string; covers: readonly { from: string; to: string }[]; end?: string | null }[];
};

/** Accounts a SimpleFIN connection kept up to date, let go on one day and
 *  kept as manual accounts (lib/connectors/store.ts connector-ended): from
 *  then on their transactions are only the ones entered or imported. `since`
 *  is that day on the person's calendar. */
export type KeptFacts = { institution: string; since: string; accounts: string[] };

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
  /** Every one of its accounts is one a restore brought back
   *  (lib/user-restore/restored.ts): its transactions are kept, and wait to
   *  be linked to the bank connected again, rather than gone. */
  restored?: true;
};

/** An account of a connection stored now: what a removed account is matched
 *  against. */
export type LiveAccountFacts = { account_id: string; institution_id: string | null; institution_name: string; mask: string | null; type: string | null };

/** An account that ended and isn't hidden (lib/lifecycle.ts), as the read
 *  found it: every id it has had (its rows carry one), how its entry names
 *  it, the connection it is at now (null for a manual account, or one no
 *  longer connected), how it ended, and the day it stopped counting. */
export type EndedFacts = {
  ids: readonly string[];
  /** "Checking ••1111". */
  account: string;
  institution: string;
  item_id: string | null;
  /** Its kind (depository, credit, investment...), or null when not known. */
  type: string | null;
  state: 'closed' | 'left' | 'untracked';
  /** Closed by Nya's assumption: it stopped appearing at its bank and nobody
   *  answered (lib/lifecycle-questions.ts), so it may still be open. */
  assumed: boolean;
  end: string;
};

/** A window an account was missing from its bank's answer before it came
 *  back, on the days it counts (lib/lifecycle.ts `missed`), or that SimpleFIN
 *  left it out of; `let_go` when it was let go from SimpleFIN before its
 *  connection's history reached those days. */
export type MissedFacts = { account: string; institution: string; item_id: string | null; type: string | null; from: string; to: string; let_go?: true };

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
  /** The transactions the read couldn't read, or that aren't all in, in its
   *  own words ("Chase: ..."): its `unread_notes` (lib/activity.ts). */
  notes: readonly string[];
  /** The read's other notes, on how what it read applies (a rule's, a
   *  category's, a split's, a group's, an approval's that couldn't be read):
   *  caveats on the totals, never gaps. Absent, none. */
  caveatNotes?: readonly string[];
  manual: readonly ManualFacts[];
  /** The manual accounts whose rows couldn't be read, or 'all'. */
  manualUnread: readonly string[] | 'all';
  /** Removed connections, or null when none could be read: those the
   *  directory remembers and the SimpleFIN accounts let go and removed. */
  removed: readonly RemovedFacts[] | null;
  /** Accounts a SimpleFIN connection fed, kept as manual accounts when let go. */
  kept?: readonly KeptFacts[];
  /** Directory entries, or records of SimpleFIN accounts let go, that
   *  couldn't be read (1 for a directory that couldn't be read at all). */
  removedUnreadable: number;
  /** The accounts of the connections stored now, and the person's links from
   *  an earlier account's id to the one it is now (lib/link-core.ts). */
  liveAccounts: readonly LiveAccountFacts[];
  links: ReadonlyMap<string, string>;
  /** Whether the person's own categories, names for merchants and exclusions
   *  carried across a re-link were all read (lib/activity.ts own_read). */
  ownRead: { categories: boolean; names: boolean; exclusions: boolean };
  /** The categories marked as mattering for taxes, as stored (each one's
   *  words); null when none were ever saved, or they couldn't be read
   *  (markedUnreadable). */
  marked: readonly string[] | null;
  markedUnreadable: boolean;
  /** The person's categories the rows were filed by (lib/activity.ts
   *  finishActivity), which name each total and find each mark (see
   *  CATEGORIES). Absent, the rows' own words do. */
  taxonomy?: Taxonomy | null;
  /** Some account is hidden, and left out. */
  hidden: boolean;
  /** How each connection is doing couldn't be read. */
  healthUnread: boolean;
  appendixLimit?: number;
  /** Every account that ended and isn't hidden (see ENDED ACCOUNTS), with
   *  `rows` keeping theirs: left out here from each one's end day. Absent,
   *  none did. */
  ended?: readonly EndedFacts[];
  /** The windows an account was missing from its bank's answer. */
  missed?: readonly MissedFacts[];
};

/** One way the period may be short (see the header). Days are on the
 *  person's calendar. `item_id` places it under its institution. */
export type Gap =
  | { kind: 'missing'; item_id: string; institution: string; reach: string | null }
  | { kind: 'stale'; item_id: string; institution: string; since: string | null }
  | { kind: 'partial'; item_id: string; institution: string; since: string }
  /** `before`: for a bank a SimpleFIN connection reaches, the first day of
   *  what has come: the days before it are what may be missing. */
  | { kind: 'importing'; item_id: string; institution: string; before?: string }
  /** `first`: its oldest stored transaction ('stored'), or, with none
   *  stored, the earliest day its history can reach ('reach'). Counting
   *  files imported into its accounts (see IMPORTED): `files` when every
   *  account reaches back to `first` through them, before the bank's own
   *  begin, and `imported` the accounts whose files reach further back. */
  | {
      kind: 'begins_late';
      item_id: string;
      institution: string;
      first: string;
      from: 'stored' | 'reach';
      files?: true;
      imported?: { account: string; from: string }[];
    }
  | { kind: 'refused'; item_id: string; institution: string }
  | { kind: 'no_consent'; item_id: string; institution: string }
  | { kind: 'removed'; item_id: null; institution: string; last_seen: string; accounts: string[]; partly_back: boolean; restored?: true }
  /** Let go on `since` and kept as manual accounts (KeptFacts). */
  | { kind: 'disconnected'; item_id: null; institution: string; since: string; accounts: string[] }
  | { kind: 'removed_unknown'; item_id: null; institution: null }
  | { kind: 'own_categories'; item_id: null; institution: null }
  | { kind: 'own_exclusions'; item_id: null; institution: null }
  | { kind: 'unreadable'; item_id: null; institution: null; note: string }
  /** Placed under the connection the account is at now, if any. */
  | { kind: 'assumed_closed'; item_id: string | null; institution: string; account: string; on: string }
  | { kind: 'missed'; item_id: string | null; institution: string; account: string; from: string; to: string; let_go?: true }
  /** `not_counted`: its transactions in the period from then that are in
   *  Nya, left out. */
  | { kind: 'untracked'; item_id: string | null; institution: string; account: string; from: string; not_counted: number };

export type GapKind = Gap['kind'];

export type ReportTotals = {
  money_in: number;
  money_out: number;
  net: number;
  /** Rows in the period, and of them: counted; left out as transfers, cash
   *  withdrawals or loan payments; left out because the person excluded them
   *  or a rule hides them (lib/rules.ts), and of those, how many a rule
   *  hides; counted although whether they did couldn't be read. */
  transactions: number;
  counted: number;
  transfers: number;
  excluded: number;
  hidden_by_rule: number;
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

/** A category as the report offers it for marking: its name now, and the
 *  words a mark of it is stored as (`key`: its first text key, choiceText). */
export type ReportCategory = { key: string; name: string };

export type ReportMarked = {
  /** Each category marked, once, in the order marked: its name now, the
   *  words a mark of it is stored as, and its totals. */
  categories: { category: string; key: string; money_in: number; money_out: number; transactions: number }[];
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
  /** Why it isn't in the totals (the person excluded it; a rule hides it; a
   *  transfer or loan payment; another currency), or null when it is. */
  /** Why the totals don't count it: 'group' for one of a group counted on a
   *  day before the period (lib/split-rows.ts group_outside). */
  not_counted: 'excluded' | 'hidden' | 'transfer' | 'currency' | 'group' | null;
  /** Whether the person excluded it couldn't be read, so it counts. */
  exclusion_unknown: boolean;
  note: string | null;
  /** A part of a split transaction (#39, lib/split-rows.ts), listed as the
   *  Activity tab lists it: its place, how many parts there are, the whole
   *  transaction's amount, and whether it holds what the bank changed the
   *  amount by since the split. Absent on a transaction listed whole. */
  split?: { part: number; parts: number; whole: number; remainder: boolean };
  /** A group's net: how many of its transactions it counts, and how many
   *  aren't here. Absent on anything else. */
  group?: { transactions: number; missing: number };
};

export type ReportAppendix = {
  rows: AppendixRow[];
  /** Transactions in the marked categories, before the limit, and those of
   *  them `rows` lists: a split one's parts are one transaction, a group's
   *  net as many as it holds (lib/spending.ts transactionCounter). */
  total: number;
  shown: number;
  limit: number;
  /** Transactions among them the person excluded or a rule hides: listed,
   *  not counted. */
  excluded: number;
};

export type ReportInstitution = Omit<SourceFacts, 'institution_id' | 'first_seen' | 'never_synced' | 'accounts'> & {
  /** The read's note about it, if any ("stored transactions could not be
   *  read"). */
  note: string | null;
  /** Its accounts whose imported files reach back before its oldest stored
   *  transaction, each with the first day they cover (see IMPORTED). */
  imported: { account: string; from: string }[];
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

/** An account that ended, as the report lists it (see ENDED ACCOUNTS). */
export type ReportEnded = {
  account: string;
  institution: string;
  state: 'closed' | 'left' | 'untracked';
  assumed: boolean;
  /** The day it stopped counting. */
  end: string;
  /** The last day of the period it counts on, or null when it counts on
   *  none (it ended on or before the first). */
  counted_through: string | null;
  /** Its transactions in Nya dated in the period from its end on: left out,
   *  as the Activity tab leaves them out. */
  not_counted: number;
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
  /** Every category in the period and every one marked, once each, by name,
   *  for marking. */
  categories: ReportCategory[];
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
  /** Oldest end first. */
  ended: ReportEnded[];
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
    /** What the read said of how what it read applies, in its own words
     *  (ReportInput `caveatNotes`): none of it leaves a transaction out. */
    notes: string[];
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
  'disconnected',
  'removed_unknown',
  'refused',
  'no_consent',
  'stale',
  'partial',
  'assumed_closed',
  'missed',
  'untracked',
  'importing',
  'begins_late',
  'own_categories',
  'own_exclusions',
  'unreadable',
];

/** A category as a mark finds it (see CATEGORIES): which it is (its id, or
 *  `words:` and the words, for words no category has), the words a mark of
 *  it is stored as, and its name now. */
type Mark = { id: string; key: string; name: string };

/** The notes of `all` besides those of `unread`, each of those taken out
 *  once for each time it is there: what the read said that isn't about
 *  transactions it couldn't read (ReportInput `caveatNotes`), in its order. */
export function notesBesides(all: readonly string[], unread: readonly string[]): string[] {
  const left = [...unread];
  return all.filter((n) => {
    const i = left.indexOf(n);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}

const minDay = (a: string, b: string) => (a < b ? a : b);
/** Whether an account's own transactions can be in a report: never an
 *  investment account's or a loan's (the scope caveat says so); one of a
 *  kind not known may. */
const holdsTransactions = (type: string | null) => type === null || (!isInvestmentType(type) && type !== 'loan');
/** A name compared as the app groups one (lib/manual.ts normalizeInstitutionName). */
const nameKey = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** The earliest day a connection's history can reach: a link brings at most
 *  TRANSACTIONS_DAYS_REQUESTED days before it was first seen. Null when that
 *  isn't known. */
const reachOf = (firstSeen: string | null) => (firstSeen ? addDays(firstSeen, -TRANSACTIONS_DAYS_REQUESTED) : null);

/** Where an institution's transactions begin for the period, counting the
 *  days files imported into its accounts cover (see IMPORTED): the latest day
 *  from which each account is covered through the period's last day (the
 *  bank's own first day for one the files don't help), and the accounts
 *  that reach further back. Null when every account covers the whole
 *  period. `bank` is its oldest stored transaction. */
function startsFor(s: SourceFacts, bank: string, period: Period): { first: string; files: boolean; imported: { account: string; from: string }[] } | null {
  // An account that ended by the period's first day needs nothing of it.
  const accounts = (s.accounts ?? []).filter((a) => throughOf(a, period) !== null);
  if (!accounts.some((a) => a.covers.length > 0)) return bank > period.start ? { first: bank, files: false, imported: [] } : null;
  const starts = accounts.map((a) => {
    const run = runStart(a, bank, throughOf(a, period)!);
    return { account: a.name, from: run && run < bank ? run : bank };
  });
  const first = starts.reduce((latest, a) => (a.from > latest ? a.from : latest), starts[0].from);
  if (first <= period.start) return null;
  return { first, files: first < bank, imported: starts.filter((a) => a.from < first) };
}

/** The last day of the period an account needs its transactions through:
 *  the period's last, or, for one that ended in it (lib/lifecycle.ts), the
 *  day before its end; null for one that ended by the period's first day,
 *  which needs none of it (lib/history-import/coverage.ts throughFor). */
const throughOf = (a: { end?: string | null }, period: Pick<Period, 'start' | 'through'>): string | null => throughFor(a, period.start, period.through);

/** Whether every one of an institution's bank accounts and cards (none
 *  known: no) is covered for the period, each through the day it counts to
 *  (throughOf), by the bank's own days from `bank` on, if any, and by the
 *  files imported into it (see IMPORTED; lib/history-import/coverage.ts,
 *  the rule a rollover's months and a goal's pace follow too). */
const filesCoverAll = (s: SourceFacts, bank: string | null, period: Period): boolean => everyAccountCovered(s.accounts ?? [], bank, period.start, period.through);

/** Each account whose files reach back before the institution's oldest
 *  stored transaction (or all with files, when none is stored), with the
 *  first day they cover. */
function importedBefore(accounts: SourceFacts['accounts'], first: string | null): { account: string; from: string }[] {
  return (accounts ?? []).flatMap((a) => {
    const from = a.covers.reduce<string | null>((min, c) => (min === null || c.from < min ? c.from : min), null);
    return from !== null && (first === null || from < first) ? [{ account: a.name, from }] : [];
  });
}

/** The gaps one linked institution leaves in the period. */
function sourceGaps(s: SourceFacts, period: Period): Gap[] {
  const at = { item_id: s.item_id, institution: s.institution_name };
  // Every account of it had ended before the period: nothing to bring in.
  if (endedBefore(s, period)) return [];
  if (s.no_transactions === 'refused' || s.no_transactions === 'no_consent') return filesCoverAll(s, null, period) ? [] : [{ kind: s.no_transactions, ...at }];
  // Investment accounts only, or no bank account or card: nothing to bring in.
  if (s.no_transactions) return [];
  // A store that can't be read may hold rows from any day: its first sighting
  // can be later than its link, so its reach says nothing.
  if (s.coverage === 'missing' && !s.never_synced) return [{ kind: 'missing', ...at, reach: null }];
  // With nothing stored to say how far back its history goes, how far it can:
  // the days before that will never come, so if its accounts were open then,
  // they are missing, as with a late start. Not for a connection whose every
  // account is hidden: its rows are stored, and none is read (first_date
  // leaves them out), so nothing of it is missing from the period.
  const reach = reachOf(s.first_seen);
  const beyondReach: Gap[] =
    s.first_date === null && !s.every_hidden && reach !== null && reach > period.start ? [{ kind: 'begins_late', ...at, first: reach, from: 'reach' }] : [];
  if (s.coverage === 'missing') {
    // Never synced: missing from the days its history can reach, if any are
    // in the period, unless files cover them all.
    if (filesCoverAll(s, null, period)) return [];
    return reach !== null && reach > period.through ? beyondReach : [{ kind: 'missing', ...at, reach }, ...beyondReach];
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
  // A SimpleFIN bank's history comes a window a night, back from today, so
  // only the days before what has come are short.
  if (s.coverage === 'importing') gaps.push({ kind: 'importing', ...at, ...(s.connector && s.first_date ? { before: s.first_date } : {}) });
  else if (s.first_date !== null) {
    const late = startsFor(s, s.first_date, period);
    if (late) {
      gaps.push({
        kind: 'begins_late',
        ...at,
        first: late.first,
        from: 'stored',
        ...(late.files ? { files: true as const } : {}),
        ...(late.imported.length > 0 ? { imported: late.imported } : {}),
      });
    }
  } else if (!filesCoverAll(s, null, period)) gaps.push(...beyondReach);
  return gaps;
}

/** Whether every account of a connection had ended by the period's first
 *  day, so nothing of it is in the period. */
export function endedBefore(s: Pick<SourceFacts, 'ended_by'>, period: Pick<Period, 'start'>): boolean {
  return !!s.ended_by && s.ended_by <= period.start;
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
    case 'disconnected':
      return end >= g.since;
    case 'importing':
      return g.before === undefined || start < g.before;
    case 'missing':
      return g.reach === null || end >= g.reach;
    case 'assumed_closed':
      return end >= g.on;
    case 'untracked':
      return end >= g.from;
    case 'missed':
      return start <= g.to && end >= g.from;
    default:
      return true;
  }
}

/**
 * The rows of `input` on the days from `start` through `through`, as the
 * Activity tab has them: an ended account's from its end day on left out
 * (see ENDED ACCOUNTS), and how many transactions each ended account (in
 * `input.ended`'s order) had left out, with which ended account each id is
 * (its place in `input.ended`). What buildReport counts, and what a
 * report built on the same read counts (lib/report/runway-read.ts,
 * lib/report/year-over-year-read.ts).
 */
export function periodRows(
  input: Pick<ReportInput, 'rows' | 'ended'>,
  span: { start: string; through: string }
): { rows: Txn[]; notCounted: number[]; endedOf: Map<string, number> } {
  const endedFacts = input.ended ?? [];
  const endedOf = new Map<string, number>();
  endedFacts.forEach((e, i) => {
    for (const id of e.ids) endedOf.set(id, i);
  });
  // Transactions, never rows: a split one is one (lib/spending.ts transactionCounter).
  const notCountedOf = endedFacts.map(() => transactionCounter());
  const rows = input.rows.filter((t) => {
    if (t.date < span.start || t.date > span.through) return false;
    const i = t.account_id === undefined ? undefined : endedOf.get(t.account_id);
    if (i === undefined || t.date < endedFacts[i].end) return true;
    notCountedOf[i].add(t);
    return false;
  });
  return { rows, notCounted: notCountedOf.map((c) => c.n), endedOf };
}

export function buildReport(input: ReportInput): Report {
  const { period } = input;
  const inPeriod = (d: string) => d >= period.start && d <= period.through;
  // The period's rows, as the Activity tab has them: an ended account's from
  // its end day on left out, and counted (see ENDED ACCOUNTS).
  const endedFacts = input.ended ?? [];
  const { rows, notCounted, endedOf } = periodRows(input, period);
  // The ended accounts the period has something to say of: their end is in
  // it, or before it and they are only assumed closed, still the person's,
  // or hold rows in it.
  const endedHere = endedFacts
    .map((e, i) => ({ e, not_counted: notCounted[i] }))
    .filter(({ e, not_counted }) => e.end <= period.through && (e.end >= period.start || e.assumed || e.state === 'untracked' || not_counted > 0))
    .sort((a, b) => a.e.end.localeCompare(b.e.end) || a.e.institution.localeCompare(b.e.institution) || a.e.account.localeCompare(b.e.account));
  // A manual account counts on no day of the period once it ended by its
  // first: not a source of it (its rows in it, if any, are said above).
  const manualHere = input.manual.filter((m) => {
    const i = endedOf.get(m.account_id);
    return i === undefined || endedFacts[i].end > period.start;
  });

  // One currency: the one asked for, if the period has any of it, else the
  // one most of its transactions are in (lib/spending.ts totalsCurrency).
  // Transactions in each, never rows (lib/spending.ts transactionCounter).
  const counters = new Map<string, ReturnType<typeof transactionCounter>>();
  for (const t of rows) {
    const c = currencyOf(t);
    if (!c) continue;
    const counter = counters.get(c) ?? transactionCounter();
    counter.add(t);
    counters.set(c, counter);
  }
  const counts = new Map([...counters].map(([c, counter]) => [c, counter.n] as const));
  const currency = input.currency !== null && counts.has(input.currency) ? input.currency : totalsCurrency(rows);
  const currencies = [...counts]
    .map(([c, transactions]) => ({ currency: c, transactions }))
    .sort((a, b) => b.transactions - a.transactions || (a.currency === currency ? -1 : b.currency === currency ? 1 : a.currency < b.currency ? -1 : 1));

  // Each category's totals by the category the row is filed under, named as
  // it is named now (see CATEGORIES).
  const ix = input.taxonomy ? indexTaxonomy(input.taxonomy) : null;
  const named = ix ? (bucket: string) => ({ category: categoryById(ix, bucket)?.name ?? bucket }) : undefined;
  const summary = summarize(rows, inPeriod, currency);
  const byCategory = categoryTotals(rows, inPeriod, currency, named);

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
  // Ended by the period's first day: nothing of it in the period to go.
  const endedBy = (id: string) => {
    const i = endedOf.get(id);
    return i !== undefined && endedFacts[i].end <= period.start;
  };
  const removedHere = (input.removed ?? [])
    .filter((r) => r.accounts.length > 0 && removedInPeriod(r, period))
    .map((r) => {
      const notBack = r.accounts.filter((a) => !linkedBack(a.account_id) && !matchedBack(a, r));
      return { r, notBack, missing: notBack.filter((a) => !endedBy(a.account_id)) };
    });
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
      .filter(({ missing }) => missing.length > 0)
      .map(({ r, notBack, missing }): Gap => ({
        kind: 'removed',
        item_id: null,
        institution: r.institution_name,
        last_seen: r.last_seen,
        accounts: missing.map(accountLabel),
        partly_back: notBack.length < r.accounts.length,
        ...(r.restored ? { restored: true as const } : {}),
      })),
    // Let go during the period and kept by hand since: later days may be short.
    ...(input.kept ?? [])
      .filter((k) => k.since >= period.start && k.since <= period.through)
      .map((k): Gap => ({ kind: 'disconnected', item_id: null, institution: k.institution, since: k.since, accounts: k.accounts })),
    ...(input.removed === null || input.removedUnreadable > 0 ? [loose('removed_unknown')] : []),
    ...(input.ownRead.categories ? [] : [loose('own_categories')]),
    ...(input.ownRead.exclusions ? [] : [loose('own_exclusions')]),
    ...unexplained.map((note): Gap => ({ kind: 'unreadable', item_id: null, institution: null, note })),
    ...endedHere.flatMap(({ e, not_counted }): Gap[] =>
      !holdsTransactions(e.type)
        ? []
        : e.assumed
          ? [{ kind: 'assumed_closed', item_id: e.item_id, institution: e.institution, account: e.account, on: e.end }]
          : e.state === 'untracked'
            ? [{ kind: 'untracked', item_id: e.item_id, institution: e.institution, account: e.account, from: e.end, not_counted }]
            : []
    ),
    ...(input.missed ?? [])
      .filter((m) => holdsTransactions(m.type) && m.from <= period.through && m.to >= period.start)
      .map((m): Gap => ({ kind: 'missed', item_id: m.item_id, institution: m.institution, account: m.account, from: m.from, to: m.to, ...(m.let_go ? { let_go: true as const } : {}) })),
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

  // The marked categories: their totals, and their transactions listed. A
  // mark's words find the category that has them as a key now (a renamed or
  // merged one too); words none has match rows by their own words, as the
  // app files a category, so "home  office" is in "home office".
  const byWords = (words: string): Mark => {
    const c = ix ? categoryForKey(ix, TEXT, textKey(words)) : null;
    if (c) return { id: c.id, key: choiceText(c), name: c.name };
    const key = categoryKey(words);
    return { id: `words:${key}`, key, name: key };
  };
  // A row's: the category it is filed under, else the one its words find.
  const markOf = (t: Txn): Mark => {
    const c = ix && t.category_id ? categoryById(ix, t.category_id) : null;
    return c ? { id: c.id, key: choiceText(c), name: c.name } : byWords(categoryOf(t));
  };
  const markedList = input.markedUnreadable ? [] : [...new Set((input.marked ?? []).map(categoryKey).filter(Boolean))];
  // Each category marked once, however many of its words were (two merged).
  const marks = new Map<string, Mark>();
  for (const words of markedList) {
    const m = byWords(words);
    if (!marks.has(m.id)) marks.set(m.id, m);
  }
  let marked: ReportMarked | null = null;
  let appendix: ReportAppendix | null = null;
  if (marks.size > 0) {
    const listed = rows
      .filter((t) => marks.has(markOf(t).id))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name) || (a.transaction_id < b.transaction_id ? -1 : 1)));
    // Each marked category's totals, and the group's, summed as every other
    // total is, over its rows filed by mark.
    const byMark = categoryTotals(
      listed.map((t) => ({ ...t, category_id: markOf(t).id })),
      inPeriod,
      currency,
      (bucket) => ({ category: bucket })
    );
    const inOf = new Map(byMark.in.map((c) => [c.category, c]));
    const outOf = new Map(byMark.out.map((c) => [c.category, c]));
    const group = summarize(listed, inPeriod, currency);
    marked = {
      categories: [...marks.values()].map((m) => ({
        category: m.name,
        key: m.key,
        money_in: inOf.get(m.id)?.amount ?? 0,
        money_out: outOf.get(m.id)?.amount ?? 0,
        transactions: (inOf.get(m.id)?.transactions ?? 0) + (outOf.get(m.id)?.transactions ?? 0),
      })),
      money_in: group.money_in,
      money_out: group.money_out,
    };
    const limit = input.appendixLimit ?? APPENDIX_LIMIT;
    appendix = {
      rows: listed.slice(0, limit).map((t) => ({
        date: t.date,
        name: t.name,
        category: markOf(t).name,
        amount: t.amount,
        currency: currencyOf(t) ?? currency,
        account: t.account_name,
        institution: t.institution_name,
        source: t.source ?? 'plaid',
        pending: t.pending,
        not_counted: isExcluded(t) ? (t.excluded_by_rule ? 'hidden' : 'excluded') : t.group_outside ? 'group' : isTransfer(t) ? 'transfer' : !inCurrency(t, currency) ? 'currency' : null,
        exclusion_unknown: t.excluded === null,
        note: t.note ?? null,
        ...(t.split_of !== undefined
          ? { split: { part: (t.split_index ?? 0) + 1, parts: t.split_count ?? 1, whole: t.split_parent?.amount ?? t.amount, remainder: t.split_remainder !== undefined } }
          : {}),
        ...(t.group_members ? { group: { transactions: t.group_members.length, missing: (t.group_missing ?? 0) + (t.group_removed ?? 0) } } : {}),
      })),
      total: countTransactions(listed),
      shown: countTransactions(listed.slice(0, limit)),
      limit,
      excluded: countTransactions(listed.filter((t) => isExcluded(t))),
    };
  }

  // When the data is from: the oldest last sync of the connections that bring
  // transactions into the period; not known when one of them couldn't be
  // loaded or doesn't say. With none, the rows were read as the report was made.
  const bringing = input.sources.filter((s) => {
    if (s.no_transactions !== null || endedBefore(s, period)) return false;
    const reach = reachOf(s.first_seen);
    return !(s.coverage === 'missing' && s.never_synced && reach !== null && reach > period.through);
  });
  const known = bringing.every((s) => s.coverage !== 'missing' && s.synced_at !== null);
  const oldest = bringing.map((s) => s.synced_at!).sort((a, b) => Date.parse(a) - Date.parse(b))[0];

  // Each manual account's transactions in the period, unless they couldn't be read.
  const manualRead = (id: string) => input.manualUnread !== 'all' && !input.manualUnread.includes(id);
  // Each transaction once, on its own account (a split one whole, a group's
  // each on its own: lib/split-rows.ts bankRows).
  const manualCounts = new Map<string, number>();
  for (const t of bankRows(rows)) if (t.account_id && t.source) manualCounts.set(t.account_id, (manualCounts.get(t.account_id) ?? 0) + 1);

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
    categories: [...new Map([...rows.map(markOf), ...marks.values()].map((m) => [m.id, { key: m.key, name: m.name }])).values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key)
    ),
    totals: {
      money_in: summary.money_in,
      money_out: summary.money_out,
      net: summary.net,
      transactions: summary.transactions,
      counted: summary.counted,
      transfers: summary.transfers,
      excluded: summary.excluded,
      hidden_by_rule: countTransactions(rows.filter((t) => isExcluded(t) && t.excluded_by_rule === true)),
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
      .map(({ institution_id: _id, first_seen: _seen, never_synced: _never, every_hidden: _hidden, accounts, ...s }) => ({
        ...s,
        ended_by: s.ended_by ?? null,
        note: noteOf.get(s.item_id) ?? null,
        imported: importedBefore(accounts, s.first_date),
      }))
      .sort((a, b) => a.institution_name.localeCompare(b.institution_name)),
    manual: manualHere
      .map((m) => ({ ...m, transactions: manualRead(m.account_id) ? (manualCounts.get(m.account_id) ?? 0) : null }))
      .sort((a, b) => a.institution.localeCompare(b.institution) || a.name.localeCompare(b.name)),
    removed,
    ended: endedHere.map(({ e, not_counted }) => ({
      account: e.account,
      institution: e.institution,
      state: e.state,
      assumed: e.assumed,
      end: e.end,
      counted_through: e.end > period.start ? addDays(e.end, -1) : null,
      not_counted,
    })),
    gaps,
    caveats: {
      not_over: period.through < period.end,
      settling: period.today < addDays(period.through, POST_DAYS),
      hidden: input.hidden,
      health_unread: input.healthUnread,
      marked: input.markedUnreadable ? 'unreadable' : marks.size > 0 ? 'set' : 'none',
      scope: {
        investment:
          input.sources.some((s) => s.holds.investment || s.no_transactions === 'investment_accounts') || manualHere.some((m) => isInvestmentType(m.type)),
        loans: input.sources.some((s) => s.holds.loans) || manualHere.some((m) => m.type === 'loan'),
      },
      names_unread: !input.ownRead.names,
      notes: [...(input.caveatNotes ?? [])],
    },
    empty: rows.length === 0,
    no_spending: noSpending(view, rows.length),
  };
}
