"use client";

// Activity tab: month-by-month breakdown of the last ~12 months of
// transactions. A scrollable "Net by month" column row selects the month:
// each column's height is that month's net magnitude and its color the sign
// (green positive, red negative). Below it, a two-line chart traces cumulative
// income vs spend across the days of the selected month. Money in / money
// out / net heads the panel, said once (components/MonthFigures.tsx;
// transfers and loan payments excluded, so credit-card payments don't
// double-count as both spending and income, and so is anything the person
// excluded; every total is in one currency and says what it left out in
// others: lib/spending.ts); top spending, rolled up to
// your category groups (components/CategoryRollup.tsx), draws as single-hue
// horizontal bars (magnitude lives in length, not color); and finally the
// searchable transaction list, each row a button that opens its sheet
// (components/TransactionSheet.tsx), where a manual row can be edited, any
// row given another of your categories, and any row excluded from budgets
// and reports. Each row shows the name of the category it is filed under
// (lib/categories.ts), so renaming a category renames it here at once.

import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import ActivityBar, { ACTIVITY_PANEL, segmentTabId, type ActivityMonth, type ActivitySegment } from "./ActivityBar";
import { Segmented } from "./Segmented";
import ReportsEntry from "./ReportsEntry";
import { ActivityListSkeleton } from "./LoadingSkeletons";
import MonthFlowChart from "./MonthFlowChart";
import MonthFigures from "./MonthFigures";
import { amountSamples, compactMoney, formatMoney, signedMoney, spoken } from "@/lib/format";
import { textWidth } from "@/lib/sankey";
import { Masked } from "./HideAmounts";
import { countsInTotals, countTransactions, currencyOf, historyCount, isExcluded, leftOutByCurrency, leftOutText, uncategorizedFrom, uncategorizedFromConnector, uncategorizedNote } from "@/lib/spending";
import { conversionIn, convertedText, leftOutWhy, totalsIn } from "@/lib/fx/totals";
import type { FxTable } from "@/lib/fx/rates";
import { instantDay, localDate, localMonth } from "@/lib/local-date";
import { monthGapNotes, type Incomplete, type Stopped } from "@/lib/month-coverage";
import { missingEmptyNotes, missingMonthNotes, noSpending, withoutNote, NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from "@/lib/no-transactions";
import { importedRowsNote } from "@/lib/history-import/view";
import { displayName, filedId, indexTaxonomy, type CategoryKind, type Taxonomy } from "@/lib/categories";
import CategoryRollup from "./CategoryRollup";
import type { CategoryChoice } from "./transaction-edits";
import type { Tag } from "@/lib/tags";
import TagChips from "./TagChips";
import TagFilter from "./TagFilter";
import ChipSelect from "./ChipSelect";
import SpendByTag from "./SpendByTag";
import type { TagChange } from "./TxnTagsNote";
import { searchEntries } from "./txn-search";
import CashFlowSankey, { FlowShown } from "./CashFlowSankey";
import { inPeriod, periodCaption, periodEnding, periodGapNotes, pickedRows, SPANS, type FlowPick, type PeriodKey } from "@/lib/cash-flow";
import { bankRows, type GroupAway, type GroupOutside, type SplitParent } from "@/lib/split-rows";
import type { SettlesMark, SettlesUnapplied, SharedIou, SharedMark, SharedPart, SharedUnapplied } from "@/lib/shared-expenses/rows";
import SplitSheet from "./SplitSheet";
import GroupSheet from "./GroupSheet";
import { entryLabel, MemberRows, PartRows, wholeSplits } from "./SplitRows";
import { needsReview, type ReviewMarks } from "@/lib/review-layer";
import type { ReviewControls } from "./review-state";
import ReviewBar from "./ReviewBar";
import CardMode from "./CardMode";
import type { SharedRowHooks } from "./SharedRows";
import TransactionSheet, { findTarget, TxnNotes, type SheetTarget } from "./TransactionSheet";
import { provenanceWords, rowAccountNames, unsureCategory } from "./txn-words";
import { shownName } from "@/lib/merchant-name";
import { receiptRows, unknownNote, type ReceiptChoice } from "./receipt-filter";
import { activityMonth, activityOpensOn, writeMonth, type ViewMonth } from "./view-month-state";

// What a row and its sheet say of a transaction (components/txn-words.ts),
// re-exported for code that imported them from here.
export { exclusionOffer, nameForRules, pairedWords } from "./txn-words";

// Stable empty defaults, as in Insights: a fresh literal per render would be
// a new identity each time.
const NO_GAPS: Incomplete[] = [];
const NO_STOPPED: Stopped[] = [];
const NO_TAGS: Tag[] = [];
const NO_NOTES: string[] = [];

export type Txn = {
  transaction_id: string;
  date: string;
  name: string;
  // The bank's own text, shown readably (lib/merchant-name.ts, lib/transactions.ts).
  name_from_bank?: true;
  amount: number;
  pending: boolean;
  account_name: string;
  // As in lib/transactions.ts: the account's type, for the cash forecast.
  account_type?: string | null;
  institution_name: string;
  // As in lib/transactions.ts: the category words the rules read, and, once
  // filed into the person's categories, the category's id, the name to show
  // (null for a row that says nothing) and the kind it counts as.
  category: string | null;
  category_id?: string;
  category_name?: string | null;
  category_kind?: CategoryKind;
  iso_currency_code: string | null;
  unofficial_currency_code?: string | null;
  vendor_key: string;
  logo_url: string | null;
  category_icon_url: string | null;
  subcategory: string | null;
  category_confidence: string | null;
  transaction_code: string | null;
  payment_channel: string | null;
  datetime: string | null;
  website: string | null;
  check_number: string | null;
  account_owner: string | null;
  city: string | null;
  region: string | null;
  counterparty: string | null;
  payment_processor: string | null;
  payment_reference: string | null;
  // As in lib/transactions.ts: on manual rows, and on rows the person excluded.
  source?: string;
  // As in lib/transactions.ts (#52): on a bank row standing for a row
  // imported from the bank's file at another amount, that row's amount.
  imported_amount?: number;
  account_id?: string;
  note?: string | null;
  excluded?: boolean | null;
  // As in lib/transactions.ts: the ids of the tags it carries (lib/tags.ts),
  // the rules that match it (lib/rules.ts), whether a rule hid it, whether
  // its category is a rule's, and the name it had before a rule named it.
  tags?: string[];
  rule_ids?: string[];
  excluded_by_rule?: true;
  category_by_rule?: true;
  name_before_rules?: string;
  // As in lib/transactions.ts: one side of a pair Nya worked out between two
  // SimpleFIN accounts.
  paired?: "card" | "loan" | "transfer";
  // As in lib/transactions.ts (#39, lib/split-rows.ts): a part of a split
  // transaction, in its place; a transaction whose split couldn't be read or
  // no longer fits; a group's row, its transactions inside it. And, on a
  // split transaction put back whole for the list (bankRows), its parts. A
  // bank row standing for a row imported from a file is split or grouped as
  // that row was, its parts or its place in the group naming that row, where
  // an edit is made (split_carried_from, group_carried_from).
  split_of?: string;
  split_index?: number;
  split_count?: number;
  split_excluded?: true;
  split_remainder?: { was: number };
  split_parent?: SplitParent;
  split_updated_at?: string;
  split_carried_from?: string;
  split_unread?: true;
  split_unapplied?: "currency";
  split_parts?: Txn[];
  group_id?: string;
  group_members?: Txn[];
  group_missing?: number;
  group_removed?: number;
  group_unapplied?: { id: string; name: string };
  group_outside?: GroupOutside;
  group_carried_from?: string;
  // Why its transactions that aren't counted in it aren't, where known.
  group_away?: GroupAway[];
  // As in lib/transactions.ts (#49, lib/shared-expenses/rows.ts): a shared
  // transaction's own row and its amount before your part, a payment's, the
  // rows that layer adds (another's part, a paid-back part, an IOU's row,
  // on no account), their transaction (shared_of), and, on a transaction
  // put back whole for the list (bankRows), its rows.
  shared?: SharedMark;
  shared_was?: number;
  shared_of?: string;
  shared_part?: SharedPart;
  shared_iou?: SharedIou;
  shared_parts?: Txn[];
  shared_carried_from?: string;
  shared_unapplied?: SharedUnapplied;
  shared_twice?: string[];
  settles?: SettlesMark;
  settles_unapplied?: SettlesUnapplied;
  // As in lib/transactions.ts (#47): whether it has receipts or documents
  // (null when that couldn't be read), and the ids whose files it shows.
  attached?: true | null;
  attached_on?: string[];
  // And, as in lib/transactions.ts, the review queue's marks
  // (lib/review-layer.ts ReviewMarks): whether it needs review, when it was
  // approved, what changed since, and the merchant's default that filed it.
} & ReviewMarks;

/**
 * What an empty list says, from what narrows it: one filter on says what it
 * looked for; the search, or more than one, says nothing matches them; none,
 * that the month (or the cash flow's pick) has nothing.
 */
export function emptyListWords(on: { query: boolean; tag: boolean; review: boolean; unsure?: boolean; receipt: ReceiptChoice; pick: boolean }): string {
  const count = [on.query, on.tag, on.review, !!on.unsure, on.receipt !== ""].filter(Boolean).length;
  if (count === 0) return on.pick ? "Nothing to list." : "No transactions this month.";
  if (count > 1) return on.query ? "No transactions match your search and filters." : "No transactions match these filters.";
  if (on.review) return "Nothing listed needs review.";
  if (on.unsure) return "No category listed is one Plaid was unsure of.";
  if (on.receipt === "with") return "No transaction listed has a receipt or document.";
  if (on.receipt === "without") return "Nothing listed over that amount is missing a receipt.";
  if (on.tag) return "No transaction listed has that tag.";
  return "No transactions match your search.";
}

// Amounts in their currency (lib/format.ts), never assumed to be dollars.

// Compact, signed, for the net-bar value labels: +$1.2K / -$340.
function fmtCompactSigned(n: number, currency: string | null): string {
  return `${n < 0 ? "-" : "+"}${compactMoney(Math.abs(n), currency)}`;
}

// How wide Net by month's columns are, in px: the widest a month's figure
// can be in `currency` at its 12px (lib/format.ts amountSamples), so no
// figure widens its own column, and never under a finger's 42. From the
// currency alone, so hiding amounts changes nothing.
function trendColumn(currency: string | null): number {
  const widest = Math.max(...amountSamples(currency).map((s) => textWidth(`+${s}`, 12)));
  return Math.max(42, Math.ceil(widest) + 4);
}

// Plaid's convention: positive amounts are money leaving the account, so the
// displayed value flips sign (positive = money in).
function fmtTxnAmount(amount: number, currency: string | null): string {
  return signedMoney(-amount, currency, { always: true });
}

// The per-day net, in display terms (positive = net money in), one figure per
// currency the day's rows are in, the totals' first: never added across
// currencies. Zero renders without a sign.
function fmtDayNet(nets: Map<string | null, number>, currency: string | null): string {
  return [...nets.keys()]
    .sort((a, b) => (a === currency ? -1 : b === currency ? 1 : String(a) < String(b) ? -1 : 1))
    .map((c) => {
      const n = nets.get(c)!;
      return signedMoney(Math.abs(n) < 0.005 ? 0 : n, c);
    })
    .join(" · ");
}

function fmtTxnDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** The bar's month, in full: "October 2026". */
function monthName(ym: string): string {
  return new Date(`${ym}-01T00:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function monthLabel(ym: string): string {
  const d = new Date(`${ym}-01T00:00:00`);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(
    undefined,
    sameYear ? { month: "short" } : { month: "short", year: "2-digit" },
  );
}

// Money moving between your own accounts isn't income or spending, and a
// transaction the person excluded counts in no total: both decided in
// lib/spending.ts, which every total uses. isTransfer is re-exported for code
// that imported it from here.
export { isTransfer } from "@/lib/spending";

// Base category options for recategorization, merged with whatever
// categories appear in the data (categoryOptions).
const BASE_CATEGORIES = [
  "food and drink",
  "general merchandise",
  "transportation",
  "travel",
  "rent and utilities",
  "entertainment",
  "personal care",
  "medical",
  "general services",
  "income",
  "transfer in",
  "transfer out",
  "loan payments",
  "other",
];

/** A row's category as the list shows it: the name of the category it is
 *  filed under, or, on a row not filed (no categories loaded), its words. */
export function categoryLabel(t: Pick<Txn, "category" | "category_name">): string | null {
  const name = t.category_name !== undefined ? t.category_name : t.category;
  return name ? displayName(name) : null;
}

/** The categories to choose from when the person's own couldn't be loaded:
 *  the base ones and every one in the data, sorted, as before categories had
 *  ids. Shared with the quick-add form (components/ManualTxnSheet.tsx). */
export function categoryOptions(txns: Txn[] | null): string[] {
  const set = new Set(BASE_CATEGORIES);
  (txns ?? []).forEach((t) => {
    if (t.category) set.add(t.category);
  });
  return [...set].sort();
}

export default function MonthBreakdown({
  txns,
  fx = null,
  notes,
  asideNotes = NO_NOTES,
  loading,
  taxonomy = null,
  onRecategorize,
  onRename,
  onAddTransaction,
  onImport,
  onEditTransaction,
  onToggleExcluded,
  actionError = null,
  incomplete = NO_GAPS,
  stopped = NO_STOPPED,
  withoutTransactions = NO_CONNECTIONS_WITHOUT,
  tags = NO_TAGS,
  onChangeTags,
  onSaveNote,
  onCreateRule,
  ruleSentenceOf,
  onSplitsChanged,
  review,
  shared,
  onAttachmentsChanged,
  segment: segmentShown,
  onSegment,
  sharedSegment = null,
  viewMonth,
  onViewMonth,
}: {
  txns: Txn[] | null;
  /** What the totals convert with, once a home currency is chosen
   *  (app/api/transactions `fx`); null without one. */
  fx?: FxTable | null;
  /** What the load couldn't read, or couldn't apply as it says: said under
   *  the list and beside the chart, whose figures it bears on. */
  notes: string[];
  /** What only the list says, after those: what no figure reads (tags, the
   *  review queue's settings), so never beside the chart. */
  asideNotes?: string[];
  loading: boolean;
  /** Your categories (components/categories-state.ts): the list to choose
   *  one from, and the groups top spending rolls up to. Null until loaded. */
  taxonomy?: Taxonomy | null;
  /** May return a promise that resolves true once the change is saved, so
   *  the sheet says it was kept only then. */
  onRecategorize: (transaction_id: string, choice: CategoryChoice) => unknown;
  onRename: (vendor_key: string, name: string) => void;
  /** Opens the quick-add form; left out when there is no manual account to
   *  add to, which hides the button. */
  onAddTransaction?: () => void;
  /** Opens the import sheet (components/ImportSheet.tsx); left out, like the
   *  quick-add form's, when there is no manual account to import into. */
  onImport?: () => void;
  /** Opens a manual row's edit form. */
  onEditTransaction?: (t: Txn) => void;
  /** Leaves a transaction out of budgets and reports, or puts it back. */
  onToggleExcluded?: (t: Txn, excluded: boolean) => unknown;
  /** Why the last change to a transaction didn't save. */
  actionError?: string | null;
  /** Connections that bring in no transactions (lib/no-transactions.ts): an
   *  empty list says why rather than "no transactions", rows entered by hand
   *  or imported name them under the month instead, and a bank account or
   *  card whose transactions don't come in is named under every month. */
  withoutTransactions?: NoTransactionsView;
  /** Institutions whose rows this load lacks, or lacks the oldest of
   *  (/api/transactions), and connections whose transactions have stopped
   *  (their health): the month's totals say so (lib/month-coverage.ts). */
  incomplete?: Incomplete[];
  stopped?: Stopped[];
  /** Your tags (components/tags-state.ts): names and colors for each row's
   *  tag ids, the filter, and spending by tag. */
  tags?: Tag[];
  /** Puts tags on a transaction or takes them off, or makes one as typed. */
  onChangeTags?: (t: Txn, change: TagChange) => void;
  /** Saves a transaction's note (empty clears it). */
  onSaveNote?: (t: Txn, note: string) => void;
  /** Opens the rule drawer on a rule made from a transaction, filing it
   *  under `category_id` (the one just chosen in its sheet) or the one it is
   *  under now. */
  onCreateRule?: (t: Txn, category_id?: string) => void;
  /** A rule, by id, in a sentence, for the rules a transaction matches. */
  ruleSentenceOf?: (id: string) => string | null;
  /** After a split or a group is saved or undone (components/SplitSheet.tsx,
   *  components/GroupSheet.tsx): the list read again. Without it, nothing is
   *  offered to split or group. */
  onSplitsChanged?: () => void;
  /** The review queue (components/review-state.ts): what needs review, its
   *  filter, Card Mode and approving. Without it, none is shown. */
  review?: ReviewControls;
  /** Shared expenses (#49, components/SharedRows.tsx): each row's line, and
   *  sharing or confirming a payment from its detail. Without it, none. */
  shared?: SharedRowHooks;
  /** After a receipt or document is added, moved or deleted (#47): the list
   *  read again, for its paperclips. Without it (no file store connected),
   *  no receipt is shown, offered or filtered by. */
  onAttachmentsChanged?: () => void;
  /** The segment shown (components/ActivityBar.tsx) and how to choose
   *  another, when the caller keeps it: the dashboard does, so the tab
   *  comes back on the last one chosen. Left out, it keeps its own,
   *  starting on Transactions. */
  segment?: ActivitySegment;
  onSegment?: (s: ActivitySegment) => void;
  /** What the Shared segment shows: the Shared expenses card. */
  sharedSegment?: ReactNode;
  /** The month shared with Budgets (components/view-month-state.ts), and
   *  its writer; without them the tab keeps its own. */
  viewMonth?: ViewMonth;
  onViewMonth?: (m: ViewMonth) => void;
}) {
  const [ownSegment, setOwnSegment] = useState<ActivitySegment>("transactions");
  const segment = segmentShown ?? ownSegment;
  const chooseSegment = onSegment ?? setOwnSegment;
  // The month asked for (null: the one the tab opens on), shared with Budgets
  // when the dashboard passes it; and the month a cash-flow pick holds, here
  // alone, so a pick never moves Budgets.
  const [ownMonth, setOwnMonth] = useState<ViewMonth>(null);
  const wantMonth = onViewMonth ? (viewMonth ?? null) : ownMonth;
  const writeViewMonth = onViewMonth ?? setOwnMonth;
  const [pin, setPin] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The row whose sheet is open (components/TransactionSheet.tsx), kept
  // while it slides out, with the errors already said when it opened, so
  // the sheet says only those its own changes bring. Each opening is its
  // own (`n`): what was typed or offered in the last one doesn't carry over.
  const [sheet, setSheet] = useState<{ target: SheetTarget; open: boolean; seen: (string | null)[]; n: number } | null>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const [tagFilter, setTagFilter] = useState(""); // a tag's id; "" for every transaction
  // A node of the cash flow tapped (#41): the list shows its transactions,
  // from every month of its period, until it is cleared or a month is chosen.
  // The chart's period is kept here beside it: a reload shows a spinner in
  // the chart's place, and it must come back on the pick's period.
  const [flowPick, setFlowPick] = useState<FlowPick | null>(null);
  // Spending's period: its length (SPANS), ending with the bar's month. Kept
  // here, so a reload's spinner brings it back, and across segments.
  const [span, setSpan] = useState<PeriodKey>("this-month");
  const listRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef<HTMLDivElement>(null);
  const pickedNow = useRef(false);
  // The split being made or changed, and the group (#39).
  const [splitting, setSplitting] = useState<Txn | null>(null);
  const [grouping, setGrouping] = useState<{ start: Txn | null; group: Txn | null }>({ start: null, group: null });
  const [splitError, setSplitError] = useState<string | null>(null);
  // The review queue: the To review filter, and Card Mode, open.
  const [reviewOnly, setReviewOnly] = useState(false);
  const [cardsOpen, setCardsOpen] = useState(false);
  const reviewing = reviewOnly && !!review?.view?.on;
  // The filter to the rows whose category Plaid wasn't sure of
  // (txn-words.ts unsureCategory), from the chip that counts them.
  const [unsureOnly, setUnsureOnly] = useState(false);
  // The filter by receipt (#47, components/receipt-filter.ts), and the amount
  // a transaction without one is over.
  const [receiptChoice, setReceiptChoice] = useState<ReceiptChoice>("");
  const [receiptOver, setReceiptOver] = useState("");
  const byReceipt: ReceiptChoice = onAttachmentsChanged ? receiptChoice : "";

  const pickable = useMemo(() => categoryOptions(txns), [txns]);

  const months = useMemo(() => {
    const set = new Set<string>();
    (txns ?? []).forEach((t) => set.add(t.date.slice(0, 7)));
    return [...set].sort().reverse().slice(0, 12);
  }, [txns]);

  // The month asked for when it is listed, else the nearest before it
  // (components/view-month-state.ts activityMonth).
  const thisMonth = localMonth();
  const selected = activityMonth(pin ?? wantMonth, months, thisMonth);

  const monthTxns = useMemo(
    () => (txns ?? []).filter((t) => t.date.slice(0, 7) === selected),
    [txns, selected],
  );
  // Spending's period, and its rows: every card there sums them.
  const period = useMemo(() => (selected ? periodEnding(span, selected) : null), [span, selected]);
  const periodTxns = useMemo(() => {
    if (!period) return [];
    const within = inPeriod(period);
    return (txns ?? []).filter((t) => within(t.date));
  }, [txns, period]);
  const onSpending = segment === "spending";
  const today = localDate();

  // Every total on the tab sums amounts in one currency, the same for every
  // month so the trend compares like with like: the home currency once one
  // is chosen, each row in another converted at its own day's rate
  // (lib/fx/totals.ts), else the one most of the transactions are in; what
  // can't be counted in it is named, not added (lib/spending.ts). The totals
  // add up `counted`; the list shows the rows as they are.
  const counted = useMemo(() => totalsIn(txns ?? [], fx), [txns, fx]);
  const currency = counted.currency;
  const countedMonth = useMemo(() => counted.rows.filter((t) => t.date.slice(0, 7) === selected), [counted, selected]);
  const countedPeriod = useMemo(() => {
    if (!period) return [];
    const within = inPeriod(period);
    return counted.rows.filter((t) => within(t.date));
  }, [counted, period]);
  // What the figures shown sum: the bar's month on Transactions, the period
  // on Spending. One segment is drawn at a time, so the sums below are its.
  const scopeTxns = onSpending ? periodTxns : monthTxns;
  const scopeCounted = onSpending ? countedPeriod : countedMonth;
  const leftOut = useMemo(
    () => leftOutWhy(leftOutText(leftOutByCurrency(scopeCounted, currency), currency), conversionIn(scopeCounted, counted.conversion)),
    [scopeCounted, currency, counted]
  );
  const convertedNote = useMemo(() => convertedText(conversionIn(scopeCounted, counted.conversion)), [scopeCounted, counted]);
  // Rows imported into linked accounts from files (#52): the totals say so.
  const periodWords = onSpending && period && period.months.length > 1 ? "this period" : "this month";
  const importedNote = useMemo(() => importedRowsNote(scopeTxns, periodWords), [scopeTxns, periodWords]);

  // Rows the person excluded, and rows whether they did couldn't be read
  // (counted, so the total may include one): both said under the summary.
  // A split transaction is one, however many of its parts are (#39).
  // Another person's part of a shared transaction, or money paid back
  // between the person and someone (lib/shared-expenses/rows.ts), is no
  // exclusion of theirs: counted apart.
  const { excludedCount, hiddenCount, unknownCount, sharedCount } = useMemo(() => {
    const excluded = new Set<string>();
    const hidden = new Set<string>();
    const unknown = new Set<string>();
    const shared = new Set<string>();
    for (const t of scopeTxns) {
      const id = t.split_of ?? t.shared_of ?? t.transaction_id;
      if (t.shared_part !== undefined) shared.add(id);
      else if (t.excluded === true && t.excluded_by_rule) hidden.add(id);
      else if (t.excluded === true) excluded.add(id);
      else if (t.excluded === null) unknown.add(id);
    }
    return { excludedCount: excluded.size, hiddenCount: hidden.size, unknownCount: unknown.size, sharedCount: shared.size };
  }, [scopeTxns]);

  const { moneyIn, moneyOut, categories, byCategoryId } = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    // By the words a row carries (no categories loaded), and by the id of
    // the category it is filed under, for the rollup to groups.
    const byCategory: Record<string, number> = {};
    const byCategoryId = new Map<string, number>();
    const ix = taxonomy ? indexTaxonomy(taxonomy) : null;
    for (const t of scopeCounted) {
      if (!countsInTotals(t, currency)) continue;
      if (t.amount < 0) {
        inflow += -t.amount;
      } else {
        outflow += t.amount;
        const cat = t.category ?? "other";
        byCategory[cat] = (byCategory[cat] ?? 0) + t.amount;
        if (ix) {
          const id = filedId(ix, t);
          byCategoryId.set(id, (byCategoryId.get(id) ?? 0) + t.amount);
        }
      }
    }
    const categories = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    return { moneyIn: inflow, moneyOut: outflow, categories, byCategoryId };
  }, [scopeCounted, currency, taxonomy]);

  // Online vs in-store spending, from Plaid's payment_channel. Only rows that
  // carry a channel count toward the split (unknown ones are left out rather
  // than guessed), so the two need not sum to the month's total outflow.
  const channelSplit = useMemo(() => {
    let online = 0;
    let inStore = 0;
    for (const t of scopeCounted) {
      if (t.amount <= 0 || !countsInTotals(t, currency)) continue;
      if (t.payment_channel === "online") online += t.amount;
      else if (t.payment_channel === "in store") inStore += t.amount;
    }
    return { online, inStore };
  }, [scopeCounted, currency]);

  // Top places by spend, from transaction location. Disambiguates same-named
  // merchants and gives a light geo view without a map dependency.
  const topCities = useMemo(() => {
    const byCity: Record<string, number> = {};
    for (const t of scopeCounted) {
      if (t.amount <= 0 || !countsInTotals(t, currency) || !t.city) continue;
      const label = t.region ? `${t.city}, ${t.region}` : t.city;
      byCity[label] = (byCity[label] ?? 0) + t.amount;
    }
    return Object.entries(byCity)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [scopeCounted, currency]);

  // Net per month (oldest → newest) for the trend columns. Bar height tracks
  // net magnitude and bar color tracks its sign (green positive, red negative),
  // so a month you overspent reads as a tall red bar and one you saved as a
  // tall green one.
  const trend = useMemo(
    () =>
      [...months].reverse().map((m) => {
        let inflow = 0;
        let outflow = 0;
        for (const t of counted.rows) {
          if (t.date.slice(0, 7) !== m || !countsInTotals(t, currency)) continue;
          if (t.amount < 0) inflow += -t.amount;
          else outflow += t.amount;
        }
        return { month: m, net: inflow - outflow };
      }),
    [counted, months, currency],
  );

  // Keep the newest month in view when the row overflows (older months scroll
  // off to the left), and again each time Spending is opened, which draws it.
  const trendRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = trendRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [trend.length, segment]);

  // A segment chosen from the bar while the bar is pinned opens at its top,
  // just under the bar, not where the last one was scrolled to. (A pick
  // scrolls to the list itself.)
  const panelRef = useRef<HTMLDivElement>(null);
  const switched = useRef(false);
  useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    const el = panelRef.current;
    const pinned = el?.previousElementSibling;
    if (el && pinned && el.getBoundingClientRect().top < pinned.getBoundingClientRect().bottom) el.scrollIntoView({ block: "start" });
  }, [segment]);
  const switchSegment = (s: ActivitySegment) => {
    if (s === segment) return;
    switched.current = true;
    chooseSegment(s);
  };

  // The search reads a row's tags and note too (#40), and the tag filter
  // keeps the rows carrying one tag. A tag deleted meanwhile filters nothing.
  const filterTag = tags.some((t) => t.id === tagFilter) ? tagFilter : "";
  // A tapped node's rows, worked out again as the rows change, in place of
  // the month's; the search and the tag filter narrow them the same way.
  // Picked from the counted rows, as the chart counts them, and listed as
  // they are.
  const picked = useMemo(() => {
    if (!flowPick || !taxonomy) return null;
    const original = new Map((txns ?? []).map((t) => [t.transaction_id, t]));
    return pickedRows(counted.rows, flowPick, { ix: indexTaxonomy(taxonomy), currency, today: localDate() }).map((t) => original.get(t.transaction_id) ?? t);
  }, [flowPick, txns, counted, taxonomy, currency]);
  const listed = picked ?? monthTxns;
  // A split transaction is kept whole, every part of it, when any part is
  // (#39): its parts are listed under it, and its split edited from all.
  const searched = useMemo(() => searchEntries(listed, { query, tag: filterTag, review: reviewing, unsure: unsureOnly }, tags), [listed, query, filterTag, reviewing, unsureOnly, tags]);
  // Then the filter by receipt (#47): every part of a split transaction has
  // its transaction's mark and amount, so it keeps them all or none.
  const receipted = useMemo(() => receiptRows(searched, byReceipt, receiptOver), [searched, byReceipt, receiptOver]);
  const visible = receipted.rows;
  const filtering = !!(query || filterTag || reviewing || byReceipt || unsureOnly);
  // How many rows listed (the month, or a pick) Plaid wasn't sure of, as
  // the list shows them: its chip is there while there are any, or while it
  // is on, so answering the last one under an open sheet doesn't snap the
  // list back.
  const unsureCount = useMemo(() => bankRows(listed, { groups: "keep", ious: "keep" }).filter(unsureCategory).length, [listed]);
  // Once a pick has filled the list: the list into view, and focus on the
  // line saying what it shows, so a pick made from the chart's table by
  // keyboard goes on from the list rather than from the button left above.
  useEffect(() => {
    if (!flowPick || !pickedNow.current) return;
    pickedNow.current = false;
    listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    shownRef.current?.focus({ preventScroll: true });
  }, [flowPick]);

  // Group the visible rows into day sections, each carrying the day's net in
  // display terms (positive = money in) for each currency its rows are in, so
  // the header adds up the rows shown under it. A row the person excluded is
  // left out of it, as of every total.
  const days = useMemo(() => {
    const groups: { date: string; nets: Map<string | null, number>; txns: Txn[] }[] = [];
    for (const t of visible) {
      let g = groups[groups.length - 1];
      if (!g || g.date !== t.date) {
        g = { date: t.date, nets: new Map(), txns: [] };
        groups.push(g);
      }
      g.txns.push(t);
      // Not counted: excluded, or counted in a group dated before this year (#39).
      if (isExcluded(t) || t.group_outside) continue;
      const c = currencyOf(t) ?? currency;
      g.nets.set(c, (g.nets.get(c) ?? 0) - t.amount);
    }
    // Listed as the bank has them: a split transaction once, with its parts
    // under it; a group's row with its transactions under it (#39). The day's
    // figure above counts the parts and the nets, as every total does.
    // An IOU's row (#49) is listed too, on its day, though no account has it.
    return groups.map((g) => ({ ...g, entries: bankRows(g.txns, { groups: "keep", ious: "keep" }) }));
  }, [visible, currency]);
  // Each split transaction whole, every part of it (#39), from all the rows:
  // a pick from the cash flow lists only the parts in its node under it, but
  // the transaction still says how many parts it has, and its split is edited
  // from all of them, never from those the list happens to show.
  const splitsWhole = useMemo(() => wholeSplits(txns ?? []), [txns]);
  const whole = (t: Txn): Txn => (t.split_parts ? (splitsWhole.get(t.transaction_id) ?? t) : t);
  // Each account's name on a row: its institution only where two share a
  // name (txn-words.ts rowAccountNames), from every row loaded.
  const accountName = useMemo(() => rowAccountNames(txns ?? []), [txns]);

  // What an open sheet shows, found again in every row loaded, put back
  // whole as the list puts them (a split one with all its parts, a group's
  // row with its transactions): so a change shows in the sheet at once, and a
  // filter the change takes the row out of leaves the sheet open on it.
  const byId = useMemo(() => new Map(bankRows(txns ?? [], { groups: "keep", ious: "keep" }).map((t) => [t.transaction_id, t])), [txns]);
  const sheetRows = useMemo(() => findTarget(sheet?.target ?? null, byId), [sheet, byId]);
  const sheetErrors = [actionError, splitError, review?.error ?? null];
  const openSheet = (target: SheetTarget) => setSheet((s) => ({ target, open: true, seen: sheetErrors, n: (s?.n ?? 0) + 1 }));
  const closeSheet = () => {
    setSheet((s) => (s ? { ...s, open: false } : s));
    // Back to its row, as the sheet gives focus back; when a filter has
    // taken the row out of the list meanwhile (approved under To review),
    // to the list's heading rather than to nothing. Another sheet opened
    // in its place keeps focus.
    requestAnimationFrame(() => {
      // Still in the sheet sliding out (its row gone, so it had nowhere to
      // give focus back to), or nowhere.
      let left = !document.activeElement || document.activeElement === document.body;
      for (let n: Element | null = document.activeElement; n && !left; n = n.parentElement) {
        if (n.getAttribute("role") === "dialog") left = n.getAttribute("data-open") === "false";
      }
      if (left) listHeading.current?.focus({ preventScroll: true });
    });
  };
  // An error said before the sheet opened, once cleared, is forgotten: the
  // same words coming back are a new refusal, and the sheet says it.
  const [shownAction, shownSplit, shownReview] = sheetErrors;
  useEffect(() => {
    const now = [shownAction, shownSplit, shownReview];
    setSheet((s) => (s && s.seen.some((e, i) => e !== null && now[i] === null) ? { ...s, seen: s.seen.map((e, i) => (now[i] === null ? null : e)) } : s));
  }, [shownAction, shownSplit, shownReview]);
  // Its row gone once the list is read again (posted under a new id,
  // deleted): the sheet closes, and focus goes to the list's heading rather
  // than to nothing.
  useEffect(() => {
    if (sheet?.open && !sheetRows) {
      setSheet(null);
      listHeading.current?.focus({ preventScroll: true });
    }
  }, [sheet, sheetRows]);
  // The list read again with a spinner (after a change the server refused):
  // the sheet goes with the list, and doesn't come back on its own.
  useEffect(() => {
    if (loading) setSheet(null);
  }, [loading]);

  // The pinned bar: the month (none on Shared, whose balances aren't by
  // month, or before there is one), stepping through and listing the months
  // with transactions, with a way back to the one the tab opens on; and the
  // ⋯ to add or import a transaction where a manual account takes one.
  // Where the tab opens: this month, or the latest with transactions while
  // this one has none yet, which the way back says. Landing on it writes
  // null, as the way back does.
  const opensOn = activityOpensOn(months, thisMonth);
  const goMonth = (m: string | null) => {
    writeViewMonth(m === null ? null : writeMonth(m, opensOn));
    setPin(null);
    setFlowPick(null);
  };
  const shownMonth: ActivityMonth | null =
    segment !== "shared" && selected
      ? {
          value: selected,
          months,
          label: monthName,
          optionLabel: (m) => (m === thisMonth ? `${monthName(m)} (this month)` : monthName(m)),
          onMonth: goMonth,
          back:
            opensOn && selected !== opensOn
              ? {
                  label: opensOn === thisMonth ? "This month" : "Latest month",
                  onBack: () => goMonth(null),
                }
              : null,
        }
      : null;
  const bar = (withMenu: boolean) => (
    <ActivityBar
      month={shownMonth}
      monthPending={segment !== "shared" && !selected && loading}
      segment={segment}
      onSegment={switchSegment}
      menu={
        withMenu && onAddTransaction
          ? [{ label: "Add a transaction", onSelect: onAddTransaction }, ...(onImport ? [{ label: "Import a file", onSelect: onImport }] : [])]
          : []
      }
    />
  );
  const panel = (body: ReactNode) => (
    <div className="activity-panel" id={ACTIVITY_PANEL} role="tabpanel" aria-labelledby={segmentTabId(segment)} ref={panelRef}>
      {body}
    </div>
  );

  // Shared doesn't wait for the transactions: its card reads its own.
  if (segment === "shared") {
    return (
      <>
        {bar(true)}
        {panel(sharedSegment)}
      </>
    );
  }

  if (loading) {
    return (
      <>
        {bar(false)}
        {panel(
          <>
            {/* The list's cards as they will be, figures still to come
                (components/LoadingSkeletons.tsx). */}
            <ActivityListSkeleton segment={segment} />
            {/* Reports read their own, so they don't wait for the list. */}
            {segment === "spending" && <ReportsEntry />}
          </>
        )}
      </>
    );
  }

  // Entering a transaction by hand or importing a file, on a manual account,
  // while there is nothing to list: in the ⋯ once there is.
  const addCard = onAddTransaction && (
    <div className="card">
      {onImport ? (
        <div className="button-pair" style={{ marginTop: 0 }}>
          <button onClick={onAddTransaction}>Add a transaction</button>
          <button className="secondary" onClick={onImport}>
            Import a file
          </button>
        </div>
      ) : (
        <button onClick={onAddTransaction}>Add a transaction</button>
      )}
      <p className="panel-note">
        On one of your manual accounts: cash, or a bank Plaid can&apos;t reach, typed in or imported from the
        bank&apos;s file. It doesn&apos;t change the account&apos;s balance unless you ask.
      </p>
    </div>
  );

  if (!txns || (txns.length === 0 && notes.length === 0 && asideNotes.length === 0)) {
    // Connections that can't bring any in are not an empty year.
    const none = txns ? noSpending(withoutTransactions, historyCount(txns)) : null;
    const missing = txns && !none ? missingEmptyNotes(withoutTransactions) : [];
    return (
      <>
        {bar(false)}
        {panel(
          <>
            {addCard}
            <div className="card">
              <p className="empty-note">
                {none
                  ? `${none.lead}, so there are no bank or card transactions to show. To see spending, ${none.remedy}${onAddTransaction ? (onImport ? ", or add a transaction by hand or import a file" : ", or add a transaction by hand") : ""}.`
                  : "No transactions in the last 12 months."}
              </p>
              {missing.map((n) => (
                <div className="stale-note" key={n}>
                  {n}
                </div>
              ))}
            </div>
            {/* The runway and what the accounts held don't need transactions. */}
            {segment === "spending" && <ReportsEntry />}
          </>
        )}
      </>
    );
  }

  const net = moneyIn - moneyOut;
  const maxCat = categories.length > 0 ? categories[0][1] : 1;
  // A total that looks finished but may not be says so, under the total.
  // SimpleFIN's and Lunch Flow's rows come without categories: said while any counts.
  const uncategorized = uncategorizedNote(uncategorizedFromConnector(monthTxns), uncategorizedFrom(monthTxns));
  const gapNotes = selected
    ? [
        ...monthGapNotes(selected, incomplete, stopped, (at) => instantDay(at) ?? at.slice(0, 10)),
        // Not a bank whose files cover the month in its place (#52), as a
        // report and budget rollover count it.
        ...missingMonthNotes(withoutTransactions, selected),
        ...(uncategorized ? [uncategorized] : []),
      ]
    : [];
  // When only rows entered by hand are here, the connections that bring in
  // none are named beside the totals: where they come from, not a warning.
  const namedWithout = withoutNote(withoutTransactions, historyCount(txns));
  // On Spending, what may be missing from the period is said beside the cash
  // flow; where it isn't drawn (categories not loaded), beside the totals,
  // the load's notes first, as the cash flow says them.
  const spendingGaps =
    onSpending && !taxonomy
      ? period
        ? periodGapNotes({ period, rows: txns, read: notes, incomplete, stopped, view: withoutTransactions, today, day: (at) => instantDay(at) ?? at.slice(0, 10) })
        : notes
      : [];
  const caption = period ? periodCaption(period, today) : "";
  // The period's length, from the switch at the top of Spending; a pick from
  // the cash flow ends with it, as with a month chosen.
  const chooseSpan = (k: PeriodKey) => {
    if (k === span) return;
    setSpan(k);
    setFlowPick(null);
  };

  // The In / Out / Net, with what it leaves out and may be missing, said
  // once, at the top of the panel under the bar (components/MonthFigures.tsx):
  // the month's on Transactions, over the list; the period's on Spending,
  // under the switch that chooses it, naming it when it is longer than the
  // bar's month, as every card there names it.
  const longer = onSpending && !!period && !(period.months.length === 1 && period.months[0] === selected);
  const figures = (
    <MonthFigures
      totals={{ moneyIn, moneyOut, currency }}
      title={`In and out, ${onSpending ? caption : selected ? monthName(selected) : ""}`}
      caption={longer ? caption : null}
    >
      <div className="chart-note">
        Transfers and loan payments excluded
        {excludedCount > 0 &&
          `, and ${excludedCount} transaction${excludedCount === 1 ? "" : "s"} you left out`}
        {hiddenCount > 0 && `, and ${hiddenCount} transaction${hiddenCount === 1 ? "" : "s"} a rule hides`}
        {sharedCount > 0 && `, and other people’s parts of ${sharedCount} shared transaction${sharedCount === 1 ? "" : "s"} or money paid back`}
        .
        {unknownCount > 0 &&
          ` Whether you excluded ${unknownCount} transaction${unknownCount === 1 ? "" : "s"} couldn't be read, so ${unknownCount === 1 ? "it counts" : "they count"} here.`}
        {convertedNote && ` ${convertedNote}`}
        {leftOut && ` ${leftOut}`}
        {namedWithout && ` ${namedWithout}`}
        {importedNote && ` ${importedNote}`}
      </div>
      {/* On Transactions, what may be missing from the month, then the load's
          notes; on Spending, the period's (spendingGaps), only where the cash
          flow isn't drawn to say them. */}
      {(onSpending ? spendingGaps : gapNotes).map((n) => (
        <div className="stale-note" key={n}>
          {n}
        </div>
      ))}
      {!onSpending &&
        notes.map((n) => (
          <div className="stale-note" key={`note:${n}`}>
            {n}
          </div>
        ))}
    </MonthFigures>
  );

  return (
    <>
      {bar(true)}
      {panel(
        segment === "spending" ? (
          <>
            {/* The period every card here sums: a length, ending with the
                bar's month. The underline switch, a labelled radio group
                (since the screen review: the chips were a fourth kind of
                switch and wrapped at 375px), held to its items' width. */}
            {selected && (
              <Segmented
                className="spending-period"
                label={`Period ending ${monthName(selected)}`}
                value={span}
                onChange={chooseSpan}
                options={SPANS.map((s) => [s.key, s.short, s.label] as const)}
              />
            )}
            {figures}
            {/* Where the money came from and went (#41), over the period;
                tapping a node lists its transactions on Transactions. */}
            {taxonomy && (
              <CashFlowSankey
                txns={counted.rows}
                taxonomy={taxonomy}
                currency={currency}
                incomplete={incomplete}
                stopped={stopped}
                withoutTransactions={withoutTransactions}
                notes={notes}
                pick={flowPick}
                onPick={(p) => {
                  pickedNow.current = p !== null;
                  setFlowPick(p);
                  // The bar holds the month the pick's period ends with, so a
                  // reload that brings a later month doesn't move it; held
                  // here alone, so Budgets doesn't follow a pick.
                  if (p && selected) setPin(selected);
                  if (p) chooseSegment("transactions");
                }}
                period={span}
                month={selected ?? undefined}
              />
            )}
            {trend.length > 1 && (
              <div className="card">
                <div className="inst-header">
                  <div className="inst-name">Net by month</div>
                  <div className="inst-total">tap a month to end on it</div>
                </div>
                <div className="trend-row" ref={trendRef} style={{ "--trend-col": `${trendColumn(currency)}px` } as CSSProperties}>
                  {(() => {
                    const max = Math.max(...trend.map((t) => Math.abs(t.net)), 1);
                    return trend.map(({ month: m, net }) => (
                      <button
                        key={m}
                        className={`trend-col${m === selected ? " active" : period?.months.includes(m) ? " in-period" : ""}`}
                        onClick={() => goMonth(m)}
                        aria-pressed={m === selected}
                        aria-label={spoken(`${monthLabel(m)}: net ${formatMoney(net, currency)}${m !== selected && period?.months.includes(m) ? ", in the period" : ""}`)}
                      >
                        <span className="trend-val">
                          <Masked>{fmtCompactSigned(net, currency)}</Masked>
                        </span>
                        <span
                          className={`trend-bar${net >= 0 ? " up" : " down"}`}
                          style={{
                            height: `${Math.max((Math.abs(net) / max) * 72, 2)}px`,
                          }}
                        />
                        <span className="trend-label">{monthLabel(m)}</span>
                      </button>
                    ));
                  })()}
                </div>
              </div>
            )}

            {period && periodTxns.length > 0 && (
              <div className="card">
                <div className="inst-header">
                  <div className="inst-name">Income vs spend</div>
                  <div className="inst-total">{caption}</div>
                </div>
                <MonthFlowChart txns={countedPeriod} from={period.from} to={period.to} currency={currency} />
              </div>
            )}
            {taxonomy && byCategoryId.size > 0 && (
              <div className="card">
                <div className="inst-header">
                  <div className="inst-name">Top spending</div>
                  <div className="inst-total">by group, {caption}</div>
                </div>
                <CategoryRollup taxonomy={taxonomy} byCategory={byCategoryId} currency={currency} />
              </div>
            )}

            {!taxonomy && categories.length > 0 && (
              <div className="card">
                <div className="inst-header">
                  <div className="inst-name">Top spending</div>
                  <div className="inst-total">{caption}</div>
                </div>
                <div className="cat-list">
                  {categories.map(([cat, sum]) => (
                    <div className="cat-row" key={cat}>
                      <span className="cat-name">{displayName(cat)}</span>
                      <div className="cat-track">
                        <div
                          className="cat-bar"
                          style={{ width: `${(sum / maxCat) * 100}%` }}
                        />
                      </div>
                      <span className="cat-val">
                        <Masked>{formatMoney(sum, currency)}</Masked>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <SpendByTag txns={countedPeriod} tags={tags} currency={currency} caption={caption} />

            {(channelSplit.online > 0 || channelSplit.inStore > 0) && (
              <div className="card">
                <div className="inst-header">
                  <div className="inst-name">Online vs in-store</div>
                  <div className="inst-total">{caption}</div>
                </div>
                {(() => {
                  const total = channelSplit.online + channelSplit.inStore;
                  const rows: [string, number][] = [
                    ["Online", channelSplit.online],
                    ["In store", channelSplit.inStore],
                  ];
                  return (
                    <div className="cat-list">
                      {rows.map(([label, sum]) => (
                        <div className="cat-row" key={label}>
                          <span className="cat-name">{label}</span>
                          <div className="cat-track">
                            <div
                              className="cat-bar"
                              style={{ width: `${total > 0 ? (sum / total) * 100 : 0}%` }}
                            />
                          </div>
                          <span className="cat-val">
                            <Masked>{formatMoney(sum, currency)}</Masked>
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            )}

            {topCities.length > 0 && (
              <div className="card">
                <div className="inst-header">
                  <div className="inst-name">Where you spent</div>
                  <div className="inst-total">{caption}</div>
                </div>
                <div className="cat-list">
                  {topCities.map(([place, sum]) => (
                    <div className="cat-row" key={place}>
                      <span className="cat-name">{place}</span>
                      <div className="cat-track">
                        <div
                          className="cat-bar"
                          style={{ width: `${(sum / topCities[0][1]) * 100}%` }}
                        />
                      </div>
                      <span className="cat-val">
                        <Masked>{formatMoney(sum, currency)}</Masked>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Reports for an accountant (app/reports), at the foot of the analysis. */}
            <ReportsEntry />
          </>
        ) : (
          <>
            {figures}

            <div className="card" ref={listRef}>
              <div className="card-header">
                <h2 ref={listHeading} tabIndex={-1}>Transactions</h2>
                <span className="meta">
                  {/* Transactions, not rows: a split one is one, a group as many as it holds. */}
                  {countTransactions(visible)}
                  {filtering ? ` of ${countTransactions(listed)}` : ""}
                </span>
              </div>
              {flowPick && <FlowShown pick={flowPick} count={countTransactions(picked ?? [])} onClear={() => setFlowPick(null)} focusRef={shownRef} />}

              <input
                className="text-input search-input"
                type="search"
                placeholder="Search transactions"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {/* The filters, as chips: categories Plaid was unsure of (while
                  any are listed), what needs review (while the queue is on),
                  a tag, and a receipt (with a file store). */}
              {(review?.view?.on || tags.length > 0 || onAttachmentsChanged || unsureCount > 0 || unsureOnly) && (
                <div className="chip-row" role="group" aria-label="Filter the list">
                  {/* Plaid's doubt, counted: Information, so not "N to check"
                      (the Accounts pill's caution words) nor "To review" (the
                      queue's). Its dot is the one each such row leads with. */}
                  {(unsureCount > 0 || unsureOnly) && (
                    <button type="button" className="chip" aria-pressed={unsureOnly} onClick={() => setUnsureOnly(!unsureOnly)}>
                      <span className="txn-check" aria-hidden="true" />
                      Unsure category ({unsureCount})
                    </button>
                  )}
                  {review?.view?.on && (
                    <button type="button" className="chip" aria-pressed={reviewing} onClick={() => setReviewOnly(!reviewing)}>
                      To review
                    </button>
                  )}
                  <TagFilter tags={tags} value={filterTag} onChange={setTagFilter} />
                  {onAttachmentsChanged && (
                    <ChipSelect
                      label="Receipt"
                      shown={receiptChoice === "with" ? "Receipt: has one" : receiptChoice === "without" ? "Receipt: none" : "Receipt"}
                      on={receiptChoice !== ""}
                      value={receiptChoice}
                      onChange={(v) => setReceiptChoice(v as ReceiptChoice)}
                    >
                      <option value="">With or without a receipt</option>
                      <option value="with">Has a receipt or document</option>
                      <option value="without">No receipt, money out over…</option>
                    </ChipSelect>
                  )}
                  {onAttachmentsChanged && receiptChoice === "without" && (
                    <input
                      className="text-input receipt-over"
                      inputMode="decimal"
                      autoComplete="off"
                      value={receiptOver}
                      onChange={(e) => setReceiptOver(e.target.value)}
                      placeholder="Any amount"
                      aria-label="Money out over, in each transaction’s own currency"
                    />
                  )}
                </div>
              )}
              {unknownNote(receipted.unknown) && <div className="stale-note">{unknownNote(receipted.unknown)}</div>}
              {/* The review queue, while it is on: its count, Card Mode and approving what's listed (its filter is the To review chip, and the N key). */}
              {review && <ReviewBar review={review} all={txns} listed={visible} filtering={reviewing} onFilter={setReviewOnly} onReview={() => setCardsOpen(true)} />}

              {actionError && <div className="error">{actionError}</div>}
              {splitError && <div className="error">{splitError}</div>}
              {visible.length === 0 ? (
                <p className="empty-note">{emptyListWords({ query: !!query, tag: !!filterTag, review: reviewing, unsure: unsureOnly, receipt: byReceipt, pick: !!flowPick })}</p>
              ) : (
                <ul className="list-rows txn-list">
                  {days.map((g) => (
                    <Fragment key={g.date}>
                      <li className="txn-day">
                        <span>{fmtTxnDate(g.date)}</span>
                        <span className="money">
                          <Masked>{fmtDayNet(g.nets, currency)}</Masked>
                        </span>
                      </li>
                      {g.entries.map((t) => {
                        // A split one's parts or a group's size, its category
                        // (a split one's are its parts') and its account: one
                        // line, cut short rather than wrapping (the screen
                        // review found rows of three and four lines). The
                        // bank, Plaid's finer category and a connector's name
                        // are in its sheet.
                        const filed = !t.split_parts ? categoryLabel(t) : null;
                        // An IOU's row is on no account (#49).
                        const where = t.shared_iou ? "An IOU, on no account" : accountName(t);
                        const sub = [entryLabel(whole(t)), filed, where].filter(Boolean).join(" · ");
                        const provenance = t.shared_iou ? null : provenanceWords(t.source);
                        const unsure = unsureCategory(t);
                        const body = (
                          <>
                            {t.logo_url || t.category_icon_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img className="txn-logo" src={(t.logo_url || t.category_icon_url) ?? undefined} alt="" loading="lazy" />
                            ) : (
                              <span className="txn-logo txn-logo-fallback" aria-hidden="true">
                                {t.name.slice(0, 1).toUpperCase()}
                              </span>
                            )}
                            <span className="list-row-text">
                              <span className="list-row-title">
                                {shownName(t)}
                                <TagChips ids={t.tags} tags={tags} />
                              </span>
                              {/* Where it came from as chips (design-system.md#list-row).
                                  Plaid's doubt about its category leads the line as a
                                  quiet mark (txn-words.ts unsureCategory). */}
                              <span className="list-row-sub">
                                <span className="txn-row-line">
                                  {unsure && (
                                    <>
                                      <span className="txn-check" aria-hidden="true" />
                                      <span className="visually-hidden">Unsure category: </span>
                                    </>
                                  )}
                                  {sub}
                                </span>
                                {provenance && <span className="badge">{provenance}</span>}
                                {t.pending && <span className="badge">Pending</span>}
                                {review?.view?.on && needsReview(t) && <span className="badge warn">To review</span>}
                                {t.excluded === true && <span className="badge">{t.excluded_by_rule ? "Hidden by a rule" : "Excluded"}</span>}
                                {t.note && <span className="badge">Note</span>}
                                {onAttachmentsChanged && t.attached === true && (
                                  <span className="badge">
                                    <PaperclipIcon />
                                    <span className="visually-hidden">Has a receipt or document</span>
                                  </span>
                                )}
                              </span>
                              <TxnNotes t={t} whole={whole(t)} shared={shared} />
                            </span>
                            {/* A split transaction's own amount is the bank's; its parts below are what count (#39).
                                One of a group counted before the transactions shown counts in no total here: quieter,
                                as an excluded one is, its notice saying why. */}
                            <span
                              className={`list-row-value money txn-amount${t.amount < 0 ? " inflow" : ""}${t.excluded === true || t.group_outside ? " excluded" : ""}${t.split_parts ? " split-whole" : ""}`}
                            >
                              <Masked>{fmtTxnAmount(t.amount, currencyOf(t) ?? currency)}</Masked>
                            </span>
                          </>
                        );
                        const iou = t.shared_iou;
                        return (
                          <Fragment key={t.transaction_id}>
                            <li>
                              {/* An IOU's row is no transaction: it opens the IOU, where there is one to open. */}
                              {iou && !shared ? (
                                <div className="list-row txn-row">{body}</div>
                              ) : (
                                <button
                                  type="button"
                                  className="list-row txn-row"
                                  aria-haspopup="dialog"
                                  onClick={() => (iou ? shared?.onIou(iou.item) : openSheet({ kind: "txn", id: t.transaction_id }))}
                                >
                                  {body}
                                </button>
                              )}
                            </li>
                            {t.split_parts && <PartRows parent={t} onOpen={openSheet} />}
                            {t.group_members && <MemberRows group={t} onOpen={openSheet} accountName={accountName} />}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  ))}
                </ul>
              )}

              {[...new Set([...notes, ...asideNotes])].map((n) => (
                <div className="error" key={n}>
                  {n}
                </div>
              ))}
            </div>
          </>
        )
      )}

      {/* A row's sheet: what was its inline editor. Its Split and Group close
          it and open the sheets below. */}
      <TransactionSheet
        key={sheet?.n ?? 0}
        open={!!sheet?.open}
        rows={sheetRows}
        onClose={closeSheet}
        currency={currency}
        errors={sheetErrors.filter((e, i): e is string => !!e && e !== sheet?.seen[i])}
        taxonomy={taxonomy}
        pickable={pickable}
        tags={tags}
        list={txns}
        review={review}
        shared={shared}
        ruleSentenceOf={ruleSentenceOf}
        onRecategorize={onRecategorize}
        onRename={onRename}
        onEditTransaction={onEditTransaction}
        onToggleExcluded={onToggleExcluded}
        onChangeTags={onChangeTags}
        onSaveNote={onSaveNote}
        onCreateRule={onCreateRule}
        onSplitsChanged={onSplitsChanged}
        onSplit={(t) => setSplitting(t)}
        onGroup={(start, group) => setGrouping({ start, group })}
        onSplitError={setSplitError}
        onAttachmentsChanged={onAttachmentsChanged}
      />

      {/* Card Mode, over the tab: its Split and Group open the sheets below, over it. */}
      {review && (
        <CardMode
          open={cardsOpen}
          txns={txns}
          taxonomy={taxonomy}
          tags={tags}
          currency={currency}
          review={review}
          onClose={() => {
            setCardsOpen(false);
            onSplitsChanged?.();
          }}
          onSplit={(x) => (onSplitsChanged ? setSplitting(whole(x)) : undefined)}
          onGroup={(x) => (onSplitsChanged ? setGrouping(x.group_members ? { start: null, group: x } : { start: x, group: null }) : undefined)}
        />
      )}

      {taxonomy && onSplitsChanged && (
        <>
          <SplitSheet t={splitting} taxonomy={taxonomy} onClose={() => setSplitting(null)} onSaved={() => { setSplitError(null); onSplitsChanged(); }} />
          <GroupSheet
            start={grouping.start}
            group={grouping.group}
            txns={txns}
            taxonomy={taxonomy}
            onClose={() => setGrouping({ start: null, group: null })}
            onSaved={() => { setSplitError(null); onSplitsChanged(); }}
          />
        </>
      )}
    </>
  );
}

/** The mark of a transaction with a receipt or document. */
function PaperclipIcon() {
  return (
    <svg className="attach-clip" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
    </svg>
  );
}
