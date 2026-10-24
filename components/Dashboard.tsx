'use client';

import ClerkAccount, { ClerkSignOut, GEAR } from './ClerkAccount';
import { SettingsScreen, type SettingsSection, type SettingsView } from './Settings';
import { watchSignOut } from './sign-out-watch';
import { LOCAL_CACHE_KEY, cacheKeyFor } from './device-cache';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccessMetadata, type PlaidLinkOnEventMetadata } from 'react-plaid-link';
import { existingItemsAt } from '@/lib/existing-items';
import NetWorthChart, { type HistoryPoint } from './NetWorthChart';
import AccountLinks from './AccountLinks';
import AdminUnusedItems from './AdminUnusedItems';
import DownloadMyData from './DownloadMyData';
import ReceiptsCard from './ReceiptsCard';
import InventoryEntry from './InventoryEntry';
import RestoreCard from './RestoreCard';
import RestoreBanner from './RestoreBanner';
import { downloadAccounts } from './DownloadOptions';
import ReportsEntry from './ReportsEntry';
import ApiTokens from './ApiTokens';
import WeeklySummaryCard from './WeeklySummaryCard';
import { localDate, localMonth } from '@/lib/local-date';
import { PLAID_PORTAL } from '@/lib/deletion-receipt';
import { SharingDrawer, SharedWithMe } from './Sharing';
import { Sheet } from './Sheet';
import DebtPayoff from './DebtPayoff';
import { CoverageNote, TrustLinks } from './TrustLinks';
import ConnectButtons from './ConnectButtons';
import AddAccountSheet from './AddAccountSheet';
import AccountSheet from './AccountSheet';
import AccountsStatus from './AccountsStatus';
import AccountsSummary from './AccountsSummary';
import { CollapsibleHeader } from './Collapsible';
import { RedirectChoices } from './ConnectRedirect';
import type { LinkKind } from '@/lib/item-products';
import { noTransactionsView, quietItemIds, unallowedItemIds, NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';
import { unreadNotesOf } from '@/lib/fire/inputs';
import { historyPausedSince } from '@/lib/history-status';
import MonthBreakdown, { nameForRules, type Txn } from './MonthBreakdown';
import DisconnectSplitsNote from './DisconnectSplitsNote';
import ManualTxnSheet from './ManualTxnSheet';
import ImportSheet, { type ImportTarget } from './ImportSheet';
import HistoryImportSheet, { type HistoryImportTarget } from './HistoryImportSheet';
import MigrationSheet, { SwitchingLink } from './MigrationSheet';
import ImportedHistoryNote from './ImportedHistoryNote';
import type { ImportedHistoryView } from '@/lib/history-import/view';
import { ConnectorCards, ConnectorSheet, useConnectors, type ConnectorAsk } from './Connectors';
import { useTransactionEdits } from './transaction-edits';
import SharedExpensesCard, { type SharedFacts } from './SharedExpensesCard';
import { useSharedExpenses } from './shared-expenses-state';
import type { SharedRowHooks } from './SharedRows';
import { REMOVED_NAME } from '@/lib/shared-expenses/model';
import Insights, { budgetAlerts, paymentAlerts, spendingNotes, type IdleCashAccount, type PaymentAccount } from './Insights';
import NeedsAttention, { AdminAttention, NEEDS_ATTENTION_TITLE } from './NeedsAttention';
import { attentionItems, type Go } from './attention';
import ConnectionDetails from './ConnectionDetails';
import { ALERT, ConnectionStatus, connectionSeverity, statusBadge, type ConnectionPlace } from './ConnectionStatus';
import { Menu } from './Menu';
import { cardlessSeverity as cardlessSeverityOf, firstToFix, severityOf, worse, type Severity } from '@/lib/accounts-status';
import {
  useAccountLifecycle,
  AccountQuestions,
  EndedAccounts,
  LifecycleRepair,
  lifecycleDamageOf,
  type EndedAccount,
  type EndedConnection,
  type LifecycleDamage,
  withEndedAccounts,
} from './AccountLifecycle';
import { useTimelineNotes, TimelineNotesSheet } from './TimelineNotes';
import { totalCaveats, type RestoreHoldNote } from './total-notes';
import { stoppedConnections, type Incomplete } from '@/lib/month-coverage';
import BudgetsTab from './BudgetsTab';
import { EMPTY_BUDGETS, type Budgets } from '@/lib/budget-set';
import { useCategories, useCategoriesForBudgets } from './categories-state';
import { useBudgetMonth } from './budget-month-state';
import CategoriesCard from './CategoriesCard';
import { useTagList } from './tags-state';
import TagsCard from './TagsCard';
import { newDraft, useRules } from './rules-state';
import RulesCard from './RulesCard';
import ReviewSettingsCard from './ReviewSettingsCard';
import CurrencyCard from './CurrencyCard';
import CurrencyChoiceSheet, { CurrencyOptions, MovedBody, RelabelOffer } from './CurrencyChoiceSheet';
import { ChartCurrencyNote, CurrencyOfferSheet, dismissOffer, heroCurrencyCaveats, offerDismissed, offerFor } from './CurrencyNotes';
import { CORRECTION_KEEPS, RELABEL_KEEPS, rateEffectText, relabelledText } from './currency-text';
import { asFxTable } from '@/lib/fx/fields';
import type { FxTable } from '@/lib/fx/rates';
import type { NetWorthBase } from '@/lib/fx/net-worth-base';
import { totalsCurrency } from '@/lib/spending';
import VendorDefaultsCard from './VendorDefaultsCard';
import { useReview } from './review-state';
import { countToReview } from '@/lib/review-layer';
import RuleSheet from './RuleSheet';
import { indexTaxonomy } from '@/lib/categories';
import { ruleSentence, sortedRules } from '@/lib/rules';
import { detectRecurring, type RecurringRow } from '@/lib/recurring';
import { EMPTY_PLANNED, isPlanned, type Planned } from '@/lib/planned';
import { createWholeListStore, initialListState, type ListState } from '@/lib/whole-list-store';
import { type Goal } from './GoalsCard';
import { withAccountEnds } from '@/lib/goal-view';
import { dominantCurrency, hiddenFigure, zeroExample } from '@/lib/format';
import { accruedCaveats } from './AccruedInterestNote';
import NetWorthCard from './NetWorthCard';
import type { Caveat } from './TotalCaveats';
import OwedFlipNote, { crossesOwed, OWED_FLIP_REASON } from './OwedFlipNote';
import { HideAmountsToggle, Masked } from './HideAmounts';
import { useAmountsHidden } from './hide-amounts';
// Same dependency-free-shared-module trick as lib/format: the sign rule lives
// outside lib/hidden.ts so the client can import it without pulling in Redis.
import { CASH_SUBTYPE, isCashOnHand, isOwedType } from '@/lib/balance';
import { minorDigits } from '@/lib/manual-txn-input';
// Same reason: lib/cash.ts imports nothing, so the cash rule can be shared
// between the server payload and this component.
import { institutionCash } from '@/lib/cash';
// The Plan tab carries the projection engine, so its code is loaded only when
// the tab is opened, and a failure to load or run it stays on that tab.
import PlanTabLoader from './PlanTabLoader';
// The FI card on Home works its figures out with the Plan's code, so it is
// loaded the same way, after Home paints.
import FiProgressLoader from './FiProgressLoader';
import InstitutionCard, { cardHeadingId, institutionMenu } from './InstitutionCard';
import { fmt, fmtInstantDay, fmtStaleDay, signedBalance, type Account, type Institution, type ManualAccount } from './accounts-format';



// The form's working copy. `balance` is a STRING, as in BudgetsTab and GoalsCard:
// an <input type="number"> reports '' for a partly typed value like "-", and
// Number('') is 0, so a number would erase the minus sign as you type it. It's
// parsed once on submit. `account_id` is null while adding; the server mints it.
// `currency` is the one chosen; `stored` the one the account is in now, so the
// form can say what changing it does.
type ManualDraft = Omit<ManualAccount, 'account_id' | 'balance' | 'currency'> & {
  account_id: string | null;
  balance: string;
  currency: string;
  stored: string | null;
  /** With its currency corrected: also move the transactions typed on it
   *  into the new one (lib/manual-relabel.ts), only when the person ticks it. */
  relabel?: boolean;
  /** The account as it was when Update opened (null when adding): a type
   *  across money held and owed from its own is offered as a close instead
   *  (components/OwedFlipNote.tsx). */
  kept?: ManualAccount | null;
};

// "cash" is a choice, not a type: saved as depository with the subtype
// CASH_SUBTYPE (lib/balance.ts), which the Plan reads to count cash
// withdrawals and the cash spending entered on the account once.
const MANUAL_TYPE_LABELS: { value: string; label: string }[] = [
  { value: 'depository', label: 'Checking or savings' },
  { value: 'cash', label: 'Cash on hand (a wallet)' },
  { value: 'investment', label: 'Investment (brokerage, 401k, HSA)' },
  { value: 'credit', label: 'Credit card' },
  { value: 'loan', label: 'Loan (mortgage, auto, student)' },
  { value: 'other', label: 'Other (property, crypto)' },
];

type Tab = 'home' | 'accounts' | 'activity' | 'budgets' | 'plan';

// Last-known dashboard snapshot, kept on-device so the app paints instantly on
// open (and shows something useful offline) while fresh data loads. Cleared on
// logout; keyed per account (device-cache.ts).
/** Set once this page has been sent to the login page because its session
 *  ended: nothing may save the snapshot again after it was cleared. */
let signedOut = false;

// Currency-aware money, so a EUR/GBP account isn't rendered with a "$".
// Delegates to the shared formatter (falls back to $ for a null or unrecognized
// code); "--" for a missing value.
/** The value, or the last one that wasn't null: what a closing drawer keeps
 *  showing while it slides out. */
function useLast<T>(value: T | null): T | null {
  const last = useRef<T | null>(value);
  if (value !== null) last.current = value;
  return last.current;
}

/** A 20px line icon for the account actions. */
function ActionIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}



const TAB_ICONS: Record<Tab, React.ReactNode> = {
  home: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5" />
    </svg>
  ),
  accounts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x={2.5} y={5.5} width={19} height={13} rx={2} />
      <path d="M2.5 10h19" />
    </svg>
  ),
  activity: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  ),
  budgets: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx={12} cy={12} r={9} />
      <path d="M12 12V3M12 12l6.4 6.4" />
    </svg>
  ),
  plan: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />
    </svg>
  ),
};

const TAB_LABELS: Record<Tab, string> = {
  home: 'Home',
  accounts: 'Accounts',
  activity: 'Activity',
  budgets: 'Budgets',
  plan: 'Plan',
};

export default function Dashboard({
  clerk = false,
  viewer,
  admin = false,
  brokerageLink = false,
  lunchFlow = false,
}: {
  clerk?: boolean;
  viewer?: string;
  /** Set by the server (app/page.tsx): only the admin is sent the admin panel. */
  admin?: boolean;
  /** Set by the server (app/page.tsx): whether to offer connecting a brokerage
   *  or retirement account (PLAID_BROKERAGE_LINK, lib/item-products.ts). */
  brokerageLink?: boolean;
  /** Set by the server (app/page.tsx): whether to offer connecting Lunch Flow
   *  (LUNCHFLOW_ENABLED, lib/connectors/switch.ts). Connections made before it
   *  was turned off are still shown and work. */
  lunchFlow?: boolean;
}) {
  const cacheKey = cacheKeyFor(viewer);
  // Hiding amounts (components/hide-amounts.ts) changes what every formatter
  // writes, so the whole dashboard draws again when the switch changes.
  const amountsHidden = useAmountsHidden();
  const [tab, setTab] = useState<Tab>('home');
  const [linkToken, setLinkToken] = useState<string | null>(null);
  // 'update' re-authenticates or adds a product; 'accounts' is the account
  // picker on an existing Item. Neither creates an Item.
  const [linkMode, setLinkMode] = useState<'new' | 'update' | 'accounts'>('new');
  // Refs, not state: react-plaid-link builds its handler once per token and
  // keeps the callbacks it was given then, so state read inside them would be
  // stale. See onEvent.
  const bypassDuplicateRef = useRef(false);
  const redirectingRef = useRef(false);
  const exitLinkRef = useRef<(opts?: { force?: boolean }) => void>(() => {});
  // The Item the account picker is open on, and when it opened by the server's
  // clock (see app/api/item-accounts-updated).
  const updatingItemRef = useRef<{ item_id: string; opened_at: string } | null>(null);
  // Whether Link is on screen: a late SELECT_INSTITUTION must not redirect a
  // Link that already closed.
  const linkOpenRef = useRef(false);
  // Which way the new connection in progress was started (components/ConnectButtons.tsx).
  const connectKindRef = useRef<LinkKind>('bank');
  // Set when a new connection was stopped at an institution already connected,
  // with the way it was started, for connecting it separately after all.
  const [redirect, setRedirect] = useState<{ name: string; items: Institution[]; kind: LinkKind } | null>(null);
  const shownRedirect = useLast(redirect);
  const [connected, setConnected] = useState(false);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [netWorth, setNetWorth] = useState(0);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  // Net worth in the home currency the person chose (lib/fx/net-worth-base.ts),
  // worked out by the server after its cache, or null without one: beside
  // netWorth and history, which keep what they always meant.
  const [base, setBase] = useState<NetWorthBase | null>(null);
  // Why nothing is converted, when the currency settings can't be read.
  const [currencyProblem, setCurrencyProblem] = useState<string | null>(null);
  // What the estimated history drawn from imported files covers (#52), for
  // the note under the chart. Sent beside the payload, never cached with it.
  const [importedHistory, setImportedHistory] = useState<ImportedHistoryView | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [backupProblem, setBackupProblem] = useState<{ last_ok: string | null; reason: string | null; none?: true } | null>(null);
  // The nightly clean-up of receipts and documents, said the same way
  // (lib/backup.ts attachmentSweepProblem).
  const [filesProblem, setFilesProblem] = useState<{ last_ok: string | null; reason: string | null; held: boolean; paused?: true } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [txns, setTxns] = useState<Txn[] | null>(null);
  // What the loaded rows' totals convert with, once a home currency is chosen
  // (app/api/transactions `fx`, lib/fx/totals.ts): null without one.
  const [txnFx, setTxnFx] = useState<FxTable | null>(null);
  // Whether receipts and documents can be opened and added here
  // (app/api/transactions `attachments`): null until loaded, and then none
  // is shown where the file store isn't connected.
  const [filesMode, setFilesMode] = useState<{ connected: boolean; uploads: boolean } | null>(null);
  // Your categories (components/categories-state.ts): the lists to choose one
  // from, the group rollups, and what budgets are set on.
  const categories = useCategories();
  const acceptCategories = categories.accept;
  // Your tags (components/tags-state.ts), from each transactions load.
  const tagList = useTagList();
  const acceptTags = tagList.accept;
  // Your rules (components/rules-state.ts), and the rule drawer.
  const rules = useRules();
  const [txnNotes, setTxnNotes] = useState<string[]>([]);
  // What only the list says, beside them (the answer's `aside_notes`: tags
  // or the review queue's settings that couldn't be read), never the chart.
  const [txnAside, setTxnAside] = useState<string[]>([]);
  // What the same answer says of shared expenses (#49): what is gone, and
  // what is shared twice, for the Shared expenses card.
  const [sharedFacts, setSharedFacts] = useState<SharedFacts | null>(null);
  const acceptSharedFacts = useCallback((data: Record<string, unknown>) => {
    const f = data.shared_expenses as SharedFacts | undefined;
    setSharedFacts(f && f.gone && Array.isArray(f.twice) ? f : null);
  }, []);
  // Of those, the ones that say transactions couldn't all be read, which the
  // Plan weighs its figures by (lib/fire/inputs.ts unreadNotesOf): never one
  // that says how a rule, a category, a split or a group applies.
  const [txnUnread, setTxnUnread] = useState<string[]>([]);
  // Institutions whose transactions this load lacks, for Activity's month notes.
  const [txnIncomplete, setTxnIncomplete] = useState<Incomplete[]>([]);
  // Connections that bring in no transactions, so the spending views say why.
  const [txnWithout, setTxnWithout] = useState<NoTransactionsView>(NO_CONNECTIONS_WITHOUT);
  // The rows before the loaded year that recurring detection needs.
  const [txnHistory, setTxnHistory] = useState<RecurringRow[]>([]);
  const [txnsLoading, setTxnsLoading] = useState(false);
  // The last transactions load failed: the forecast and the calendar say so.
  const [txnsFailed, setTxnsFailed] = useState(false);
  // The balances shown are the ones saved on this device, not yet replaced
  // by a load: the forecast says when they are from.
  const [balancesSaved, setBalancesSaved] = useState(false);
  // The last load of the balances failed (the Plan tab then asks, rather than wait).
  const [balancesFailed, setBalancesFailed] = useState(false);
  // Whether the server could read Plaid's warnings, and whether a notice
  // email's link (?view=connections) asks to go to what needs attention.
  const [healthUnavailable, setHealthUnavailable] = useState(false);
  const [healthFocus, setHealthFocus] = useState(false);
  // The Currency card (components/CurrencyCard.tsx), opened from a note on
  // Home, at the form for a rate for the currency the note named, if any.
  const [currencyFocus, setCurrencyFocus] = useState<{ rateFor: string | null } | null>(null);
  const clearCurrencyFocus = useCallback(() => setCurrencyFocus(null), []);
  // The offer to show totals in one currency (components/CurrencyNotes.tsx):
  // whether it was put away on this device (read after the first paint, so
  // the server's render and the browser's agree), and the sheet it opens,
  // with the currency it suggested.
  const [offerHidden, setOfferHidden] = useState(true);
  // The offer's sheet, from its row in Needs attention.
  const [offerOpen, setOfferOpen] = useState(false);
  useEffect(() => setOfferHidden(offerDismissed()), []);
  const [choosingHome, setChoosingHome] = useState<{ initial: string | null } | null>(null);
  // The Item update mode is open on, so its success can be recorded
  // (app/api/item-reconnected).
  const reconnectingItemRef = useRef<string | null>(null);
  // The account whose sheet is open (components/AccountSheet.tsx), by id, so
  // it shows the account as the latest load has it.
  const [accountOpen, setAccountOpen] = useState<{ item_id: string; account_id: string } | null>(null);
  const [expandedHoldings, setExpandedHoldings] = useState<Set<string>>(new Set());
  // Budgets and goals are each saved as one whole list, so their loading and
  // saving go through lib/whole-list-store.ts, which never lets an unloaded or
  // stale list be saved over what is stored.
  const [budgetsState, setBudgetsState] = useState<ListState<Budgets>>(initialListState(EMPTY_BUDGETS));
  const [goalsState, setGoalsState] = useState<ListState<Goal[]>>(initialListState<Goal[]>([]));
  const budgetsStore = useMemo(
    () =>
      createWholeListStore<Budgets>({
        url: '/api/budgets',
        // By category and group id (lib/budget-set.ts).
        field: 'budget_set',
        noun: 'budgets',
        // The month a change is made in, as this page has it: the months
        // before it keep their amounts (#37, app/api/budgets).
        extra: () => ({ month: localMonth() }),
        empty: EMPTY_BUDGETS,
        isValid: (v): v is Budgets => {
          const b = v as Budgets | null;
          return !!b && typeof b.categories === 'object' && b.categories !== null && typeof b.groups === 'object' && b.groups !== null;
        },
        onChange: setBudgetsState,
      }),
    []
  );
  const goalsStore = useMemo(
    () =>
      createWholeListStore<Goal[]>({
        url: '/api/goals',
        field: 'goals',
        noun: 'goals',
        empty: [],
        isValid: (v): v is Goal[] => Array.isArray(v),
        onChange: setGoalsState,
        // The server works out where a target date's line starts, and checks
        // allocations on the balances it knows: keep what it says (#42).
        adoptSaved: true,
        showRefusal: true,
        // What a save dates (an archive) is dated on the person's own day.
        extra: () => ({ today: localDate() }),
        // Plans that can't be read stop the load: the card offers to remove
        // the damaged ones (components/GoalPlansRepair.tsx).
        repair: 'goal-plans',
      }),
    []
  );
  // The forecast's planned items and dismissals (lib/planned.ts), saved whole
  // the same way.
  const [plannedState, setPlannedState] = useState<ListState<Planned>>(initialListState<Planned>(EMPTY_PLANNED));
  const plannedItemsStore = useMemo(
    () =>
      createWholeListStore<Planned>({
        url: '/api/planned-items',
        field: 'planned',
        noun: 'planned items',
        empty: EMPTY_PLANNED,
        isValid: isPlanned,
        onChange: setPlannedState,
      }),
    []
  );
  const budgets = budgetsState.value;
  useCategoriesForBudgets(categories, budgets, budgetsState.status === 'ready');
  // This month's budgets as the server works them out, with rollover (#37):
  // for the Budgets tab, and Home's budget alerts. Once the transactions have
  // loaded (a load syncs what the server reads), again whenever the budgets,
  // the transactions or the categories change, never while a save is under
  // way; with the stored history on the Budgets tab (its month picker).
  const thisMonth = localMonth();
  const budgetMonth = useBudgetMonth(
    budgetsState.status === 'ready' && (txns !== null || txnsFailed) ? thisMonth : null,
    [budgets, txns, categories.taxonomy],
    { paused: budgetsState.saving, history: tab === 'budgets' }
  );
  const goals = goalsState.value;
  // The Settings screen (components/Settings.tsx), in place of the tabs while
  // it is open: null when closed, else its list or one section.
  const [settings, setSettings] = useState<SettingsView | null>(null);
  // What opened it (the avatar's button, or the gear), for focus to go back
  // to when Settings closes.
  const settingsOpener = useRef<HTMLElement | null>(null);
  const openSettings = useCallback(() => {
    settingsOpener.current = document.querySelector<HTMLElement>('.user-button-slot button') ?? (document.activeElement as HTMLElement | null);
    window.scrollTo(0, 0);
    setSettings('list');
  }, []);
  const closeSettings = useCallback(() => {
    setSettings(null);
    requestAnimationFrame(() => {
      const opener = settingsOpener.current;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    });
  }, []);
  // The Currency card is in Settings > Preferences.
  const openCurrency = useCallback((rateFor: string | null = null) => {
    setSettings('preferences');
    setCurrencyFocus({ rateFor });
  }, []);
  // The institution whose Connection details are open, by id, from its ⋯
  // (its rare actions are in that menu; disconnectTarget drives the
  // type-to-confirm drawer).
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  // The Sharing drawer, opened from the Accounts tab or the account menu.
  const [sharingOpen, setSharingOpen] = useState(false);
  const closeSharing = useCallback(() => setSharingOpen(false), []);
  // The debt payoff planner, opened from the Accounts tab (components/DebtPayoff.tsx).
  const [payoffOpen, setPayoffOpen] = useState(false);
  const closePayoff = useCallback(() => setPayoffOpen(false), []);
  const [disconnectTarget, setDisconnectTarget] = useState<Institution | null>(null);
  // What the SimpleFIN drawer is asked to do (components/Connectors.tsx).
  const [connectorAsk, setConnectorAsk] = useState<ConnectorAsk | null>(null);
  const shownDisconnectTarget = useLast(disconnectTarget);
  const [disconnectInput, setDisconnectInput] = useState('');
  const [disconnecting, setDisconnecting] = useState(false);
  // Manual accounts: `manualDraft` drives the add/edit drawer, and
  // `editingManual` flips the same form between adding and editing.
  // `manualError` is separate from the page-level `error` so a failed save can't
  // linger on the Accounts card after the drawer closes, and a background refresh
  // failure can't look like a save failure.
  const [manualDraft, setManualDraft] = useState<ManualDraft | null>(null);
  const [editingManual, setEditingManual] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  const [manualError, setManualError] = useState('');
  const [manualDeleteTarget, setManualDeleteTarget] = useState<ManualAccount | null>(null);
  // Saved with its typed transactions moved too: what moved, shown in the
  // same drawer until the person closes it (kept while it slides out).
  const [manualMoved, setManualMoved] = useState<{ text: string; open: boolean } | null>(null);
  // What each drawer shows: the current value, or the last one while it slides out.
  const shownManualDraft = useLast(manualDraft);
  const editingManualShown = useLast(manualDraft ? editingManual : null) ?? false;
  // Update, with a type across money held and owed from the account's own:
  // refused, said why, and offered as a close or a hide (components/OwedFlipNote.tsx).
  const manualCrossing = !!shownManualDraft?.kept && crossesOwed(shownManualDraft.kept.type, shownManualDraft.type);
  const shownDeleteTarget = useLast(manualDeleteTarget);
  // The Hidden card starts collapsed: it exists so hidden accounts are
  // findable, not so they take up room on the balance sheet you decluttered.
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  // The stored hidden set, straight from the server, so hidden accounts stay
  // listed (and unhideable) even when their institution fails to load.
  const [hiddenMeta, setHiddenMeta] = useState<
    { account_id: string; type: string; label?: string; disconnected?: boolean }[]
  >([]);
  const [togglingHidden, setTogglingHidden] = useState<string | null>(null);
  // The accounts that ended (#50, lib/lifecycle.ts), the stored set like
  // hiddenMeta, for the Accounts that ended card; closures that
  // couldn't be read, which stop the load rather than count a closed account;
  // and the connection whose every account ended, which the disconnect sheet
  // then offers to remove.
  const [ended, setEnded] = useState<EndedAccount[]>([]);
  // What a restore holds back of the total (components/total-notes.ts).
  const [restoreHold, setRestoreHold] = useState<RestoreHoldNote | null>(null);
  const [lifecycleDamage, setLifecycleDamage] = useState<LifecycleDamage | null>(null);
  const [endedOffer, setEndedOffer] = useState<string | null>(null);
  // Guards the one-shot estimated-history backfill per page load; the server
  // keeps its own done-flag, so this only avoids redundant requests.
  const backfillTried = useRef(false);

  // Fire-and-forget: ask the server to reconstruct estimated history from
  // transactions (no-op if it already has), then reload so the chart picks
  // up the new points.
  const requestBackfill = useCallback((reload: () => void) => {
    fetch('/api/backfill', { method: 'POST' })
      .then((res) => res.ok && res.json())
      .then((data) => {
        if (data && data.backfilled > 0) reload();
      })
      .catch(() => {
        // Estimated history is a nice-to-have; fail silently.
      });
  }, []);

  const loadNetWorth = useCallback(async (force = false) => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/net-worth${force ? '?refresh=1' : ''}`);
      if (!res.ok) {
        // The server's reason when it gives one (no usable container, say),
        // so the cause shows on screen rather than only in the logs.
        // Closures that can't be read say so, with their repair (#50).
        const body = await res.json().catch(() => null);
        const reason = body?.error ?? null;
        const damage = lifecycleDamageOf(res.status, body);
        setLifecycleDamage(damage);
        setError(reason && (res.status === 503 || damage) ? `Failed to load accounts: ${reason}` : 'Failed to load accounts.');
        setBalancesFailed(true);
        return;
      }
      const data = await res.json();
      setError('');
      setLifecycleDamage(null);
      setInstitutions(data.institutions);
      setNetWorth(data.netWorth);
      setHistory(data.history ?? []);
      setBase(data.base && typeof data.base === 'object' ? data.base : null);
      setCurrencyProblem(typeof data.currency_problem === 'string' ? data.currency_problem : null);
      setHiddenMeta(data.hidden ?? []);
      setImportedHistory(data.imported_history ?? null);
      setEnded(Array.isArray(data.lifecycle) ? data.lifecycle : []);
      setRestoreHold(data.restore_hold ?? null);
      setAsOf(data.as_of ?? null);
      setBalancesSaved(false);
      setBalancesFailed(false);
      setBackupProblem(data.backup_problem ?? null);
      setFilesProblem(data.attachments_problem ?? null);
      setHealthUnavailable(!!data.health_unavailable);
      setConnected(data.institutions.length > 0);

      // First open with a near-empty chart: backfill estimated history from
      // transactions in the background.
      //
      // `backfill_stale` covers a layer that exists but was built by an older
      // algorithm. That is invisible from here (the chart looks full), so the
      // server has to say so, or an improvement to the reconstruction would only
      // reach people with no history yet.
      const hist: HistoryPoint[] = data.history ?? [];
      const thin = hist.filter((h) => !h.estimated).length <= 1 && !hist.some((h) => h.estimated);
      if ((thin || data.backfill_stale) && data.institutions.length > 0 && !backfillTried.current) {
        backfillTried.current = true;
        requestBackfill(() => loadNetWorth());
      }

      try {
        // A response still in flight when the session ended must not bring
        // back the snapshot the redirect just cleared.
        if (signedOut) return;
        localStorage.setItem(
          cacheKey,
          JSON.stringify({
            institutions: data.institutions,
            netWorth: data.netWorth,
            history: data.history ?? [],
            // Added beside the rest: a release before reads the snapshot
            // without it, as it always did.
            base: data.base ?? null,
            hidden: data.hidden ?? [],
            lifecycle: data.lifecycle ?? [],
            as_of: data.as_of,
          })
        );
      } catch {
        // Storage unavailable/full -- the instant-open snapshot is best-effort.
      }
    } catch {
      // Network unreachable; keep showing whatever we have (possibly the
      // hydrated snapshot).
      setError('Could not reach the server.');
      setBalancesFailed(true);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [requestBackfill]);

  // The review queue (components/review-state.ts), from each transactions
  // load; it reads the list again through the edits below.
  const review = useReview({ setTxns, refresh: () => txnEdits.refresh(), reload: () => loadTransactions() });
  const acceptReview = review.accept;

  const loadTransactions = useCallback(async (force = false) => {
    setTxnsLoading(true);
    try {
      const res = await fetch(`/api/transactions${force ? '?refresh=1' : ''}`);
      if (!res.ok) {
        setTxnNotes(['Could not load transactions.']);
        setTxnAside([]);
        setTxnUnread(['Could not load transactions.']);
        setTxnsFailed(true);
        return;
      }
      const data = await res.json();
      setTxns(data.transactions);
      setTxnFx(asFxTable(data.fx));
      setFilesMode(data.attachments && typeof data.attachments === 'object' ? { connected: data.attachments.connected === true, uploads: data.attachments.uploads === true } : null);
      // The categories the rows were filed by, the tags they carry, and the queue.
      acceptCategories(data.categories);
      acceptTags(data.tags);
      acceptReview(data.review);
      setTxnNotes(data.notes ?? []);
      setTxnAside(Array.isArray(data.aside_notes) ? data.aside_notes : []);
      setTxnUnread(unreadNotesOf(data));
      setTxnIncomplete(Array.isArray(data.incomplete) ? data.incomplete : []);
      setTxnWithout(noTransactionsView(data));
      setTxnHistory(Array.isArray(data.recurring_history) ? data.recurring_history : []);
      acceptSharedFacts(data);
      setTxnsFailed(false);
    } catch {
      setTxnNotes(['Could not load transactions.']);
      setTxnAside([]);
      setTxnUnread(['Could not load transactions.']);
      setTxnsFailed(true);
    } finally {
      setTxnsLoading(false);
    }
  }, [acceptCategories, acceptTags, acceptReview, acceptSharedFacts]);

  // A session ended elsewhere (signed out everywhere, or the password changed)
  // makes every API call answer 401; send the dashboard to the login page instead
  // of showing load errors. A layout effect, so it is in place before any effect
  // (this component's or a child's) makes the first requests.
  useLayoutEffect(() => {
    const original = window.fetch;
    // Bound: a browser's fetch called without window as `this` throws.
    const call = original.bind(window);
    const watched = watchSignOut(call, {
      clerk,
      onSignedOut: () => {
        // The saved snapshot goes too: a device signed out elsewhere (a
        // lost phone) must not keep painting balances, offline included.
        signedOut = true;
        try {
          localStorage.removeItem(cacheKey);
        } catch {
          // Best-effort.
        }
        window.location.href = clerk ? '/sign-in' : '/login';
      },
    });
    window.fetch = Object.assign(watched, original) as typeof window.fetch;
    return () => {
      window.fetch = original;
    };
  }, [clerk]);

  useEffect(() => {
    // Paint immediately from the last-known snapshot, then revalidate.
    try {
      // The shared password's unkeyed snapshot belongs to no one account.
      if (viewer) localStorage.removeItem(LOCAL_CACHE_KEY);
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const snap = JSON.parse(raw);
        if (Array.isArray(snap.institutions)) {
          setInstitutions(snap.institutions);
          setNetWorth(snap.netWorth ?? 0);
          setHistory(Array.isArray(snap.history) ? snap.history : []);
          setBase(snap.base && typeof snap.base === 'object' && typeof snap.base.currency === 'string' && Array.isArray(snap.base.history) ? snap.base : null);
          setHiddenMeta(Array.isArray(snap.hidden) ? snap.hidden : []);
          setEnded(Array.isArray(snap.lifecycle) ? snap.lifecycle : []);
          setAsOf(snap.as_of ?? null);
          setBalancesSaved(true);
          setConnected(snap.institutions.length > 0);
          setLoading(false);
        }
      }
    } catch {
      // Corrupted snapshot -- ignore; the network load will replace it.
    }
    loadNetWorth();
  }, [loadNetWorth]);

  // A notice email links to /?view=connections: open the Accounts tab and go
  // to what needs attention once the accounts are in (healthFocus, below),
  // then drop the query, so a reload doesn't jump there.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('view') !== 'connections') return;
    setTab('accounts');
    setHealthFocus(true);
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  // Everything else loads in parallel with net worth (no waterfall): transactions
  // feed Activity and insights, budgets/goals feed the Budgets tab. All are cheap
  // on the server (cached or Redis-only) and empty when nothing is connected.
  useEffect(() => {
    loadTransactions();
    budgetsStore.load();
    goalsStore.load();
    plannedItemsStore.load();
  }, [loadTransactions, budgetsStore, goalsStore, plannedItemsStore]);

  const renameVendor = useCallback(
    async (vendor_key: string, name: string) => {
      // Optimistically relabel every transaction from this vendor. An empty
      // name clears the rename; we can't reconstruct the original Plaid name
      // locally, so reload to pick the reverted names back up.
      if (name) {
        setTxns((prev) =>
          prev
            ? prev.map((t) => (t.vendor_key === vendor_key ? { ...t, name } : t))
            : prev
        );
      }
      try {
        const res = await fetch('/api/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vendor_key, name }),
        });
        // Re-sync on a clear (to recover the reverted Plaid names) or on a
        // rejected write, so the optimistic change can't linger out of sync.
        if (!name || !res.ok) loadTransactions();
      } catch {
        loadTransactions(); // network failure: reload to server truth
      }
    },
    [loadTransactions]
  );

  // What a rule can name of the accounts, and a rule as a sentence, for the
  // Rules screen, the rule drawer and a transaction's detail: those that
  // ended too, with their end (#50).
  const ruleAccounts = useMemo(
    () =>
      withEndedAccounts(
        institutions.flatMap((i) => i.accounts.map((a) => ({ id: a.account_id, label: `${i.institution_name} ${a.name}${a.mask ? ` ••${a.mask}` : ''}` }))),
        ended
      ),
    [institutions, ended]
  );
  const ruleSentenceOf = useCallback(
    (id: string) => {
      const r = rules.set?.rules.find((x) => x.id === id);
      if (!r) return null;
      const ix = categories.taxonomy ? indexTaxonomy(categories.taxonomy) : null;
      const account = (a: string) => ruleAccounts.find((x) => x.id === a)?.label ?? null;
      return ruleSentence(r, { ix, tags: { version: 1, tags: tagList.tags }, account, money: (n) => hiddenFigure(n.toLocaleString(undefined, { maximumFractionDigits: 8 })) });
    },
    [rules.set, categories.taxonomy, tagList.tags, ruleAccounts]
  );
  const ruleUses = useMemo(() => {
    const uses: Record<string, number> = {};
    for (const r of sortedRules(rules.set)) for (const t of r.actions.add_tags ?? []) uses[t] = (uses[t] ?? 0) + 1;
    return uses;
  }, [rules.set]);

  // Transactions entered by hand, categories and the exclude flag
  // (components/transaction-edits.ts).
  const txnEdits = useTransactionEdits({
    txns,
    setTxns,
    setTxnNotes,
    setTxnAside,
    setTxnUnread,
    setTxnIncomplete,
    setTxnWithout,
    loadTransactions,
    loadNetWorth,
    requestBackfill,
    taxonomy: categories.taxonomy,
    onTagMade: tagList.add,
    onAnswer: acceptSharedFacts,
  });
  // Shared expenses (#49, components/shared-expenses-state.ts): the card's
  // read, its sheets, and what a row of the list offers. A change that
  // moves a total reads the list again quietly.
  const sharedExpenses = useSharedExpenses({ enabled: tab === 'activity', onTotalsChanged: txnEdits.refresh });
  const sharedCard = sharedExpenses.card;
  const openShared = sharedExpenses.setOpen;
  const sharedRows = useMemo<SharedRowHooks | undefined>(
    () =>
      sharedCard
        ? {
            names: new Map(sharedCard.people.map((p) => [p.id, p.name ?? REMOVED_NAME])),
            onShare: (t) => openShared({ kind: 'share', t }),
            onPaidBack: (t) => openShared({ kind: 'paid', t }),
            onIou: (id) => openShared({ kind: 'iou', id }),
            owes: Object.values(sharedCard.balances ?? {}).some((bs) => bs.some((b) => b.amount < 0)),
          }
        : undefined,
    [sharedCard, openShared]
  );

  // File import into a manual account (components/ImportSheet.tsx). After an
  // import or an undo the list is read again, and when the statement's
  // balance was set too, net worth as after the account's Update form.
  const [importTarget, setImportTarget] = useState<ImportTarget | null>(null);
  // Importing a linked account's history (components/HistoryImportSheet.tsx):
  // its rows join the Activity tab, and the estimated history is drawn back
  // through them, so both are read again.
  const [historyTarget, setHistoryTarget] = useState<HistoryImportTarget | null>(null);
  // Switching from another app (components/MigrationSheet.tsx): accounts it
  // makes change net worth, and its rows join the Activity tab.
  const [migrationOpen, setMigrationOpen] = useState(false);
  // Every way to add an account (components/AddAccountSheet.tsx).
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const onImported = useCallback(
    async ({ balanceChanged }: { balanceChanged: boolean }) => {
      loadTransactions();
      if (balanceChanged) {
        await loadNetWorth(true);
        requestBackfill(() => loadNetWorth());
      }
    },
    [loadTransactions, loadNetWorth, requestBackfill]
  );

  // `kind` is which way to connect (app/api/create-link-token). `bypass` skips
  // both duplicate checks for this run: the user has said the institution they
  // already have is a different login.
  const beginConnect = useCallback(async (kind: LinkKind, bypass: boolean) => {
    setError('');
    setConnecting(true);
    bypassDuplicateRef.current = bypass;
    redirectingRef.current = false;
    connectKindRef.current = kind;
    // Whatever happens (no network, an answer that isn't JSON), the buttons
    // come back: left on "Starting…", nothing could be connected.
    try {
      const res = await fetch('/api/create-link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.link_token) {
        setLinkMode('new');
        setLinkToken(data.link_token);
      } else {
        setError('Could not start connection.');
      }
    } catch {
      setError('Could not start connection.');
    } finally {
      setConnecting(false);
    }
  }, []);
  const startConnect = useCallback((kind: LinkKind) => beginConnect(kind, false), [beginConnect]);

  // Link's account picker on an existing Item, to add (or remove) accounts at an
  // institution already connected without creating a second Item.
  const startManageAccounts = useCallback(async (item_id: string) => {
    setError('');
    setConnecting(true);
    redirectingRef.current = false;
    updatingItemRef.current = null;
    const res = await fetch('/api/create-update-link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id, select_accounts: true }),
    });
    const data = await res.json().catch(() => ({}));
    setConnecting(false);
    if (data.link_token) {
      updatingItemRef.current = { item_id, opened_at: data.opened_at ?? '' };
      setLinkMode('accounts');
      setLinkToken(data.link_token);
    } else {
      setError(data.error || 'Could not open account selection.');
    }
  }, []);

  const startReconnect = useCallback(async (item_id: string) => {
    setError('');
    setConnecting(true);
    redirectingRef.current = false;
    const res = await fetch('/api/create-update-link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id }),
    });
    const data = await res.json();
    setConnecting(false);
    if (data.link_token) {
      reconnectingItemRef.current = item_id;
      setLinkMode('update');
      setLinkToken(data.link_token);
    } else {
      setError('Could not start reconnection.');
    }
  }, []);

  // Asks for consent to share transactions on a connection whose transactions
  // weren't allowed (lib/no-transactions.ts, no_consent): update mode with the
  // consent request (app/api/create-update-link-token, allow_transactions).
  // Its success goes the way of a Reconnect's: the server forgets the refusal
  // (app/api/item-reconnected), and the reload asks Plaid again.
  const startAllowTransactions = useCallback(async (item_id: string) => {
    setError('');
    setConnecting(true);
    redirectingRef.current = false;
    try {
      const res = await fetch('/api/create-update-link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id, allow_transactions: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.link_token) {
        reconnectingItemRef.current = item_id;
        setLinkMode('update');
        setLinkToken(data.link_token);
      } else {
        setError('Could not start allowing transactions.');
      }
    } catch {
      setError('Could not start allowing transactions.');
    } finally {
      setConnecting(false);
    }
  }, []);

  // Adds the liabilities product to an Item that was linked without it. Goes
  // through Link's update mode, so it re-authenticates the SAME Item rather
  // than creating a new one -- the stored transaction history survives.
  const startEnableLiabilities = useCallback(async (item_id: string) => {
    setError('');
    setConnecting(true);
    redirectingRef.current = false;
    const res = await fetch('/api/create-update-link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id, add_liabilities: true }),
    });
    const data = await res.json();
    setConnecting(false);
    if (data.link_token) {
      reconnectingItemRef.current = item_id;
      setLinkMode('update');
      setLinkToken(data.link_token);
    } else {
      // The route names the institution-doesn't-support-it case specifically,
      // which is the likely one here and not something a retry fixes.
      setError(data.error || 'Could not start enabling payment details.');
    }
  }, []);

  const performDisconnect = useCallback(
    async (item_id: string) => {
      setDisconnecting(true);
      setError('');
      try {
        const res = await fetch('/api/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item_id }),
        });
        if (!res.ok) throw new Error('failed');
        setDisconnectTarget(null);
        loadNetWorth(true);
        if (txns !== null) loadTransactions(true);
      } catch {
        setError('Could not disconnect account.');
      } finally {
        setDisconnecting(false);
      }
    },
    [loadNetWorth, loadTransactions, txns]
  );

  // Notes on the timeline (#50), read again with each load.
  const timeline = useTimelineNotes(asOf);
  // The chart notes sheet, from the Net worth card (components/TimelineNotes.tsx).
  const [notesOpen, setNotesOpen] = useState(false);
  const reloadTimeline = timeline.reload;
  // Ending, reopening or answering for an account (#50) reloads what it
  // touches: the totals, its transactions from its end, its note.
  const lifecycleChanged = useCallback(() => {
    loadNetWorth(true);
    if (txns !== null) loadTransactions(true);
    reloadTimeline();
  }, [loadNetWorth, loadTransactions, txns, reloadTimeline]);
  // Its last open account ended: offer to remove the connection, through the
  // same confirmation as any removal, since Plaid bills it until then.
  const offerRemoval = useCallback(
    (c: EndedConnection) => {
      const target = institutions.find((i) => i.item_id === c.item_id) ?? { ...c, accounts: [], holdings: [], error: null, needs_reauth: false };
      setEndedOffer(c.item_id);
      setDisconnectInput('');
      setDisconnectTarget(target);
    },
    [institutions]
  );
  const lifecycle = useAccountLifecycle({ onChanged: lifecycleChanged, onRemoveConnection: offerRemoval });
  // Closures that can't be read stop the load: said with the load's error,
  // wherever that shows, with the repair.
  const lifecycleRepair = lifecycleDamage && <LifecycleRepair damage={lifecycleDamage} onRepaired={() => loadNetWorth(true)} />;

  /**
   * One manual-account mutation. Every call names a single account, so a stale
   * page can only affect the account it acted on: it can't delete accounts it
   * doesn't know about or revert a balance a scheduled push to
   * /api/ingest/balance wrote meanwhile.
   */
  const mutateManual = useCallback(
    async (method: 'POST' | 'PATCH' | 'DELETE', body: unknown) => {
      setSavingManual(true);
      setManualError('');
      try {
        const res = await fetch('/api/manual-accounts', {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          setManualError(data?.error ?? 'Could not save. Please try again.');
          return false;
        }
        // What a move of its typed transactions did, said before the drawer
        // closes (the answer's `relabelled`).
        const done = await res.json().catch(() => null);
        const asked = body as { relabel_from?: string; currency?: string };
        const r = done?.relabelled;
        if (method === 'PATCH' && asked.relabel_from && asked.currency && typeof r?.moved === 'number' && typeof r?.kept === 'number') {
          setManualMoved({ text: relabelledText(r, asked.relabel_from, asked.currency), open: true });
        }
        setManualDraft(null);
        setManualDeleteTarget(null);
        // A forced fetch writes the new balance into today's history point, as the
        // disconnect flow does. Then recompute estimated history, which the save
        // invalidated server-side (the automatic backfill only fires when history
        // is thin).
        await loadNetWorth(true);
        requestBackfill(() => loadNetWorth());
        // Its transactions carry its name, and go with it when it is deleted.
        loadTransactions();
        return true;
      } catch {
        setManualError('Could not reach the server.');
        return false;
      } finally {
        setSavingManual(false);
      }
    },
    [loadNetWorth, requestBackfill, loadTransactions]
  );

  // After a change through SimpleFIN (components/Connectors.tsx): balances and
  // transactions reload, and when accounts were added, retyped, kept or
  // removed, the estimated history is rebuilt too, as after a manual save.
  const connectorChanged = useCallback(
    async (accountsChanged: boolean) => {
      await loadNetWorth(true);
      if (accountsChanged) requestBackfill(() => loadNetWorth());
      if (txns !== null) loadTransactions(true);
    },
    [loadNetWorth, requestBackfill, loadTransactions, txns]
  );
  // Every SimpleFIN and Lunch Flow connection, read once for the dashboard,
  // again after each load (`asOf` changes with it).
  const connectors = useConnectors(asOf);
  const connectSimpleFin = useCallback(() => setConnectorAsk({ kind: 'connect' }), []);
  const askLunchFlow = useCallback(() => setConnectorAsk({ kind: 'connect', connector: 'lunchflow' }), []);
  // Offered only where the deployment turned it on (app/page.tsx).
  const connectLunchFlow = lunchFlow ? askLunchFlow : undefined;

  // A restore (components/RestoreCard.tsx) changes everything: read it all again.
  const restoreChanged = useCallback(() => {
    void loadNetWorth(true);
    loadTransactions(true);
    budgetsStore.load();
    goalsStore.load();
    plannedItemsStore.load();
  }, [loadNetWorth, loadTransactions, budgetsStore, goalsStore, plannedItemsStore]);
  /** The banner's way to the card: Settings > Your data and privacy, with
   *  focus moved to it. */
  const openRestore = useCallback(() => {
    setSettings('data');
    requestAnimationFrame(() => {
      const card = document.getElementById('bring-back');
      card?.focus({ preventScroll: true });
      card?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, []);

  // `currency`: what a new account's currency starts as (the home currency,
  // else the one most accounts are in), for the person to change.
  const startAddManual = useCallback((currency: string) => {
    setManualError('');
    setManualMoved(null);
    setEditingManual(false);
    // The id is minted server-side on create, so a draft doesn't carry one.
    setManualDraft({
      account_id: null,
      name: '',
      institution_name: '',
      type: 'depository',
      subtype: null,
      balance: '',
      currency,
      stored: null,
    });
  }, []);

  // A home currency, a rate or an account's currency changed: net worth
  // converts again, and so do the transactions' totals, whose rates come with
  // them (/api/transactions `fx`), with any rows a correction moved.
  const currencyChanged = useCallback(() => {
    void loadNetWorth();
    loadTransactions();
  }, [loadNetWorth, loadTransactions]);

  const startEditManual = useCallback((account: ManualAccount) => {
    setManualError('');
    setManualMoved(null);
    setEditingManual(true);
    const currency = account.currency ?? 'USD';
    setManualDraft({ ...account, balance: String(account.balance), currency, stored: currency, kept: account });
  }, []);

  const submitManualDraft = useCallback(() => {
    if (!manualDraft) return;
    const payload = {
      name: manualDraft.name,
      institution_name: manualDraft.institution_name,
      type: manualDraft.type,
      subtype: manualDraft.subtype,
      // As typed: choosing its currency never changes the number.
      balance: Number(manualDraft.balance),
      currency: manualDraft.currency,
    };
    if (manualDraft.account_id) {
      // The rows typed on it move too only when the person ticked it.
      const relabel = manualDraft.relabel && manualDraft.stored !== null && manualDraft.stored !== manualDraft.currency ? { relabel_from: manualDraft.stored } : {};
      mutateManual('PATCH', { ...payload, ...relabel, account_id: manualDraft.account_id });
    } else {
      mutateManual('POST', payload);
    }
  }, [manualDraft, mutateManual]);

  // What a sign-out through Clerk clears first (components/ClerkAccount.tsx).
  const clearDevice = useCallback(() => {
    signedOut = true; // no load still in flight may save the snapshot again
    try {
      localStorage.removeItem(cacheKey);
    } catch {
      // Best-effort; the snapshot only lives on this device anyway.
    }
  }, []);

  const logout = useCallback(async () => {
    signedOut = true; // no load still in flight may save the snapshot again
    try {
      localStorage.removeItem(cacheKey);
    } catch {
      // Best-effort; the snapshot only lives on this device anyway.
    }
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  }, []);

  // Ends every session for this data, on every device, this one included
  // (lib/sessions.ts). The other devices are sent to the login page on their
  // next request.
  const signOutEverywhere = useCallback(async () => {
    if (!window.confirm('Sign out on every device, including this one?')) return;
    const res = await fetch('/api/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ everywhere: true }),
    }).catch(() => null);
    if (!res?.ok) {
      const message = await res?.json().then((b) => b?.error).catch(() => null);
      window.alert(message || 'Could not sign out other devices. Try again.');
      return;
    }
    signedOut = true; // as in logout
    try {
      localStorage.removeItem(cacheKey);
    } catch {
      // Best-effort.
    }
    window.location.href = '/login';
  }, []);


  const onSuccess = useCallback(
    async (public_token: string, metadata: PlaidLinkOnSuccessMetadata) => {
      linkOpenRef.current = false;
      if (linkMode === 'update') {
        // Update mode re-authenticates the existing Item -- no new Item is
        // created and the access token doesn't change, so there's nothing
        // to exchange. Clear the token, tell the server the connection was
        // repaired (its "Reconnect soon" warning and any email about a break
        // are done with), then refresh.
        setLinkToken(null);
        const repaired = reconnectingItemRef.current;
        reconnectingItemRef.current = null;
        if (repaired) {
          await fetch('/api/item-reconnected', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_id: repaired }),
          }).catch(() => null);
        }
        loadNetWorth(true);
        // Transactions allowed just now come in on this load.
        if (txns !== null) loadTransactions(true);
        return;
      }

      if (linkMode === 'accounts') {
        // The account picker changed which accounts the Item shares. The token
        // is unchanged; the server reconciles what it remembers about the Item
        // (app/api/item-accounts-updated) before the reload reads it.
        setLinkToken(null);
        const picker = updatingItemRef.current;
        const res = picker
          ? await fetch('/api/item-accounts-updated', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(picker),
            }).catch(() => null)
          : null;
        const summary = res?.ok ? await res.json().catch(() => null) : null;
        // Unreconciled, a removed account would pause history at the next load
        // as if it had vanished. Running the picker again finishes the job.
        if (!res?.ok) setError('Could not update the account list. Open "Add or remove accounts" again to finish.');
        loadNetWorth(true);
        if (txns !== null) loadTransactions(true);
        // Only an addition cleared the backfill flag (a removal must not rebuild
        // past estimates), so only then is there anything to recompute.
        if (summary?.added > 0) requestBackfill(() => loadNetWorth());
        return;
      }

      const institutionName = metadata.institution?.name || 'Connected Account';
      // Skipped when the user already said this is a different login.
      const isDuplicate =
        !bypassDuplicateRef.current &&
        existingItemsAt(institutions, {
          institution_id: metadata.institution?.institution_id,
          name: metadata.institution?.name,
        }).length > 0;
      if (isDuplicate) {
        const proceed = window.confirm(
          `You already have an account connected to ${institutionName}. Link another one anyway?`
        );
        if (!proceed) {
          // We never call exchange-public-token, so the unused public_token
          // simply expires -- no Plaid Item gets created.
          setLinkToken(null);
          return;
        }
      }

      await fetch('/api/exchange-public-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_token, institution_name: institutionName }),
      });
      setConnected(true);
      setLinkToken(null);
      loadNetWorth(true);
      if (txns !== null) loadTransactions(true);
      // The exchange route cleared the server's backfill flag, so this
      // recomputes estimated history with the new institution included.
      requestBackfill(() => loadNetWorth());
    },
    [linkMode, institutions, loadNetWorth, loadTransactions, requestBackfill, txns]
  );

  // Stops a new connection at an institution already connected, before the user
  // enters credentials, and offers to add accounts to the existing Item instead.
  // A second Item for the same login is billed separately and would duplicate
  // every account.
  //
  // The handler keeps the callbacks from the render that made it, and the `exit`
  // that render saw belongs to the previous handler, so exit goes through a ref
  // kept current below.
  const onEvent = useCallback(
    (eventName: string, metadata: PlaidLinkOnEventMetadata) => {
      if (eventName !== 'SELECT_INSTITUTION' || linkMode !== 'new' || bypassDuplicateRef.current) return;
      if (!linkOpenRef.current) return;
      const items = existingItemsAt(institutions, {
        institution_id: metadata.institution_id,
        name: metadata.institution_name,
      });
      if (items.length === 0) return;
      redirectingRef.current = true;
      setRedirect({ name: metadata.institution_name || items[0].institution_name, items, kind: connectKindRef.current });
      exitLinkRef.current({ force: true });
    },
    [linkMode, institutions]
  );

  const { open, ready, exit } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onEvent,
    onExit: (err) => {
      linkOpenRef.current = false;
      // Closed by onEvent above: not a cancellation, and the redirect sheet
      // says what happens next.
      if (redirectingRef.current) {
        redirectingRef.current = false;
      } else if (err) {
        setError('Connection cancelled or failed.');
      }
      setLinkToken(null);
    },
  });
  useLayoutEffect(() => {
    exitLinkRef.current = exit as (opts?: { force?: boolean }) => void;
  }, [exit]);

  // Open Link automatically as soon as a fresh token is ready
  useEffect(() => {
    if (linkToken && ready) {
      linkOpenRef.current = true;
      open();
    }
  }, [linkToken, ready, open]);

  const toggleHoldings = useCallback((item_id: string) => {
    setExpandedHoldings((prev) => {
      const next = new Set(prev);
      if (next.has(item_id)) next.delete(item_id);
      else next.add(item_id);
      return next;
    });
  }, []);

  const refreshAll = useCallback(() => {
    loadNetWorth(true);
    if (txns !== null) loadTransactions(true);
    // Retry a list that could not be loaded. One that loaded is left alone:
    // reloading it mid-edit would only risk replacing what is on screen.
    if (budgetsStore.get().status === 'error' && !budgetsStore.get().saving) budgetsStore.load();
    if (goalsStore.get().status === 'error' && !goalsStore.get().saving) goalsStore.load();
  }, [loadNetWorth, loadTransactions, txns, budgetsStore, goalsStore]);


  // Connections whose transactions have stopped arriving, for Activity's months.
  // Not a connection that holds no bank account or card: it brings no
  // transactions in, so its lapse leaves no month short (lib/no-transactions.ts).
  const stoppedTxns = useMemo(() => stoppedConnections(institutions, quietItemIds(txnWithout)), [institutions, txnWithout]);
  // Recurring bills and income, detected once (lib/recurring.ts) for Home and
  // the Budgets tab, from the year loaded and the rows before it.
  const recurring = useMemo(() => (txns ? detectRecurring([...txns, ...txnHistory]) : null), [txns, txnHistory]);
  // Connections whose transactions weren't allowed: their card offers to.
  const unallowedIds = useMemo(() => unallowedItemIds(txnWithout), [txnWithout]);

  // The last recorded day, when recording has stalled (see lib/history-status.ts).
  const pausedSince = useMemo(() => historyPausedSince(history, asOf), [history, asOf]);

  // 30-day (or available-span) net-worth delta for the hero stat tile.
  const heroDelta = useMemo(() => {
    if (history.length < 2) return null;
    const targetTs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let base = history[0]; // fall back to oldest when the series is short
    for (const p of history) {
      if (new Date(`${p.date}T00:00:00Z`).getTime() <= targetTs) base = p;
    }
    const current = history[history.length - 1];
    if (base.date === current.date || base.value === 0) return null;
    const value = current.value - base.value;
    const pct = (Math.abs(value) / Math.abs(base.value)) * 100;
    const days = Math.round(
      (new Date(`${current.date}T00:00:00Z`).getTime() -
        new Date(`${base.date}T00:00:00Z`).getTime()) /
        (24 * 60 * 60 * 1000)
    );
    return { value, pct, days, from: base.date, to: current.date };
  }, [history]);

  // The stored hidden set's ids, and the notes the chart marks: not those
  // about a hidden account, which moves no day of it (#50).
  const hiddenIds = useMemo(() => new Set(hiddenMeta.map((h) => h.account_id)), [hiddenMeta]);
  const chartNotes = useMemo(
    () => timeline.notes.filter((n) => !(n.kind === 'auto' && n.account_id && hiddenIds.has(n.account_id))),
    [timeline.notes, hiddenIds]
  );
  // The change Home shows: in the home currency when one is chosen, each day
  // at its own rate, so rate moves are in it (base.delta, with how much came
  // from them), else the stored sums' as always.
  const shownDelta = base ? base.delta : heroDelta;
  // Accounts that ended within the delta's days: its change includes their
  // leaving, which is said, so it isn't read as a gain or a loss (#50).
  const endedInDelta = useMemo(() => {
    if (!shownDelta) return 0;
    return ended.filter((e) => {
      const day = e.lifecycle.state === 'untracked' ? e.lifecycle.from : e.lifecycle.on;
      return day > shownDelta.from && day <= shownDelta.to && !hiddenIds.has(e.account_id);
    }).length;
  }, [shownDelta, ended, hiddenIds]);

  // Plaid returns institutions/accounts in no guaranteed order; sort by name so
  // the Accounts tab renders the same every load.
  //
  // Hidden accounts are dropped here and surface in the Hidden card. An
  // institution is only removed once it has nothing left to show: one whose
  // accounts are ALL hidden goes, but one that simply failed to load keeps its
  // (empty) account list so its error and Reconnect button still render. A
  // linked one that went is listed in Settings > Connections instead, or its
  // Disconnect would be unreachable without unhiding every account first.
  const { sortedInstitutions, allHiddenInstitutions } = useMemo(() => {
    const shown = [...institutions]
        .sort((a, b) => a.institution_name.localeCompare(b.institution_name))
        .map((inst) => {
          const hiddenIds = new Set(
            inst.accounts.filter((a) => a.hidden).map((a) => a.account_id)
          );
          return {
            ...inst,
            accounts: [...inst.accounts]
              .filter((a) => !a.hidden)
              .sort((a, b) => a.name.localeCompare(b.name)),
            // Holdings belong to a parent account, so hiding a brokerage has to
            // take its positions with it. Holdings from a payload cached before
            // this existed have no account_id and are kept.
            holdings: inst.holdings.filter(
              (h) => !h.account_id || !hiddenIds.has(h.account_id)
            ),
          };
        });
    const keep = (inst: (typeof shown)[number]) => inst.accounts.length > 0 || inst.holdings.length > 0 || !!inst.error;
    return {
      sortedInstitutions: shown.filter(keep),
      allHiddenInstitutions: shown.filter((inst) => !keep(inst) && !inst.manual),
    };
  }, [institutions]);

  // A SimpleFIN or Lunch Flow connection's cards: one per bank it reaches,
  // its lines about all of them on the first (components/ConnectionStatus.tsx).
  const places = useMemo(() => {
    const map = new Map<string, ConnectionPlace>();
    const firsts = new Map<string, string>();
    for (const inst of sortedInstitutions) {
      if (!inst.connection_id) continue;
      const conn = connectors.data?.connections.find((c) => c.connection_id === inst.connection_id) ?? null;
      const first = firsts.get(inst.connection_id);
      if (first === undefined) firsts.set(inst.connection_id, inst.institution_name);
      map.set(inst.item_id, { conn, first: first === undefined, firstName: first ?? null });
    }
    return map;
  }, [sortedInstitutions, connectors.data]);

  // Connections with no card on the Accounts tab, listed in Settings >
  // Connections: linked ones whose accounts are all hidden or ended, and
  // SimpleFIN or Lunch Flow ones with nothing chosen yet, every account
  // hidden or ended, or accounts left from one that is gone.
  const cardlessConnectors = useMemo(() => {
    const carded = new Set(sortedInstitutions.map((i) => i.connection_id).filter(Boolean));
    const ids = [...(connectors.data?.connections ?? []).map((c) => c.connection_id), ...(connectors.data?.orphaned ?? []).map((o) => o.connection_id)];
    return new Set(ids.filter((id) => !carded.has(id)));
  }, [sortedInstitutions, connectors.data]);
  // Each, with its one color (lib/accounts-status.ts), in Settings' order.
  const cardless = useMemo(() => {
    const plaid = allHiddenInstitutions.map((inst) => {
      const full = institutions.find((i) => i.item_id === inst.item_id) ?? inst;
      return { key: inst.item_id, severity: connectionSeverity(full) };
    });
    const fed = [...cardlessConnectors].map((id) => {
      const conn = connectors.data?.connections.find((c) => c.connection_id === id);
      return { key: id, severity: cardlessSeverityOf(conn ?? 'orphaned') };
    });
    return [...plaid, ...fed];
  }, [allHiddenInstitutions, institutions, cardlessConnectors, connectors.data]);
  const cardlessCount = cardless.filter((c) => c.severity).length;
  const cardlessWorst = cardless.reduce<Severity | null>((w, c) => worse(w, c.severity), null);
  // What couldn't be read about how many connections, hidden ones' too.
  const unreadConnections = institutions.filter((i) => i.health?.unread).length;
  const openConnections = useCallback(() => {
    window.scrollTo(0, 0);
    setSettings('connections');
  }, []);
  const removeConnection = (item_id: string) => {
    const target = institutions.find((i) => i.item_id === item_id);
    if (target) startDisconnect(target);
  };

  // Each card's one color, keyed by its connection, so the status pill counts
  // a SimpleFIN or Lunch Flow connection's cards once.
  const cardStatus = useMemo(
    () => sortedInstitutions.map((inst) => ({ item_id: inst.item_id, key: inst.connection_id ?? inst.item_id, severity: connectionSeverity(inst, places.get(inst.item_id) ?? null) })),
    [sortedInstitutions, places]
  );
  const statusEntries = useMemo(() => [...cardStatus, ...cardless], [cardStatus, cardless]);
  // The first connection that needs attention, worst first: its card's
  // heading, focused, or Settings > Connections when it has no card. From
  // the status pill and from a notice email's link.
  const goToFirstToFix = useCallback(() => {
    const target = firstToFix([...cardStatus, ...cardless.map((c) => ({ item_id: null, severity: c.severity }))]);
    if (!target) return;
    if (target.item_id === null) {
      openConnections();
      return;
    }
    const id = cardHeadingId(target.item_id);
    requestAnimationFrame(() => {
      const heading = document.getElementById(id);
      heading?.scrollIntoView({ block: 'start' });
      heading?.focus({ preventScroll: true });
    });
  }, [cardStatus, cardless, openConnections]);
  // A notice email links to /?view=connections: once the accounts have come
  // from the server (not the snapshot this device kept), go to the first that
  // needs attention. Nothing needs it: the top of the Accounts tab.
  useEffect(() => {
    if (!healthFocus || loading || (balancesSaved && !balancesFailed)) return;
    setHealthFocus(false);
    goToFirstToFix();
  }, [healthFocus, loading, balancesSaved, balancesFailed, goToFirstToFix]);

  // Connection details, from an institution's ⋯ (components/ConnectionDetails.tsx).
  const shownDetailsFor = useLast(detailsFor);

  // The open account as this load has it.
  const openedAccount = useMemo(() => {
    if (!accountOpen) return null;
    const inst = sortedInstitutions.find((i) => i.item_id === accountOpen.item_id);
    const account = inst?.accounts.find((a) => a.account_id === accountOpen.account_id);
    return inst && account ? { inst, account } : null;
  }, [accountOpen, sortedInstitutions]);
  // Gone from the tab while its sheet is open (hidden, or no longer
  // reported): the sheet closes, and stays closed if the account comes back.
  useEffect(() => {
    if (accountOpen && !openedAccount) setAccountOpen(null);
  }, [accountOpen, openedAccount]);
  // What the closing sheet keeps showing while it slides out.
  const shownAccount = useLast(openedAccount);

  // Investment accounts carrying enough uninvested cash to be worth a Home-tab
  // line. Built from `institutions`, not `sortedInstitutions`, so that an
  // insight follows the accounts themselves rather than what the Accounts tab
  // lists. Hidden accounts are dropped, as from every total.
  const idleCashAccounts = useMemo(() => {
    const out: IdleCashAccount[] = [];
    for (const inst of institutions) {
      // Hidden accounts are dropped BEFORE the verdict rather than after, so
      // institutionCash sees exactly what the Accounts tab sees: same rule,
      // same exemptions, same answer on both tabs.
      const visible = inst.accounts.filter((a) => !a.hidden);
      const hiddenIds = new Set(
        inst.accounts.filter((a) => a.hidden).map((a) => a.account_id)
      );
      const { byAccount, flaggedAccounts } = institutionCash(
        visible,
        inst.holdings.filter((h) => !h.account_id || !hiddenIds.has(h.account_id))
      );
      for (const a of visible) {
        if (!flaggedAccounts.has(a.account_id)) continue;
        const cash = byAccount[a.account_id];
        out.push({
          // Carries the id, institution and mask because account names aren't
          // distinctive ("Individual", "Roth IRA"), and two would otherwise
          // produce a duplicate React key and two identical, unactionable lines.
          account_id: a.account_id,
          name: a.name,
          mask: a.mask,
          institution_name: inst.institution_name,
          cash: cash.cash,
          // Null where the denominator is degenerate (a margin debit bigger than
          // the positions), so the insight drops the phrase rather than claiming
          // "100% of its holdings" for an account also holding a short. The
          // Accounts tab badge suppresses it the same way.
          share: cash.total > 0 ? cash.share : null,
          currency: a.currency,
        });
      }
    }
    return out.sort((x, y) => y.cash - x.cash);
  }, [institutions]);

  // Hidden accounts for the Hidden card, built from the STORED set, not whatever
  // resolved this load: an erroring institution returns no accounts, and
  // deriving from the live list would make its hidden accounts vanish (still
  // hidden, still subtracted from history, with no Unhide button anywhere).
  const hiddenAccounts = useMemo(() => {
    const live = new Map(
      institutions.flatMap((i) =>
        i.accounts
          .filter((a) => a.hidden)
          .map((a) => [a.account_id, { account: a, institution_name: i.institution_name }] as const)
      )
    );
    return hiddenMeta
      .map(({ account_id, type, label, disconnected }) => {
        const resolved = live.get(account_id);
        if (resolved) return { ...resolved, resolved: true };
        // Hidden, but not in this load: its institution didn't answer, or was
        // disconnected (a hidden account stays hidden past a disconnect). Render
        // what we stored so it can still be unhidden.
        return {
          account: {
            account_id,
            name: label ?? 'Unavailable account',
            type,
            subtype: null,
            balance: null,
            currency: null,
            hidden: true,
          } as Account,
          institution_name: disconnected ? 'Disconnected' : 'Not loaded',
          resolved: false,
        };
      })
      .sort((a, b) => a.account.name.localeCompare(b.account.name));
  }, [institutions, hiddenMeta]);

  const toggleHidden = useCallback(
    async (account_id: string, hidden: boolean) => {
      setError('');
      // Guarded like the adjacent manual-account actions: each toggle triggers
      // a full refresh, so repeated taps would queue several of them.
      setTogglingHidden(account_id);
      try {
        const res = await fetch('/api/hidden-accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_id, hidden }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setError(data?.error ?? 'Could not update hidden accounts.');
          return;
        }
        await loadNetWorth(true);
        // Hidden accounts' transactions must leave the Activity tab too. Guarded
        // like every other refresh here, so this can't kick off a first-ever
        // Plaid sync from the Accounts tab.
        if (txns !== null) loadTransactions(true);
        // The estimated layer doesn't know this account, so it can't subtract it
        // and would sit high by its balance with a step at the estimated/real
        // seam. The server cleared the backfill flag; running the recompute is on
        // us, since the automatic one only fires when history is thin.
        if (data?.recompute) requestBackfill(() => loadNetWorth());
      } catch {
        setError('Could not update hidden accounts.');
      } finally {
        setTogglingHidden(null);
      }
    },
    [loadNetWorth, loadTransactions, requestBackfill, txns]
  );

  // One currency to label summed account figures (net worth, deltas). Accounts
  // can differ, so use the most common code and flag a genuine mix rather than
  // implying an FX-converted total. Hidden accounts are excluded: a hidden EUR
  // account must not make Home announce "Accounts use multiple currencies" with
  // no such account on screen.
  const allAccounts = useMemo(
    () => institutions.flatMap((i) => i.accounts.filter((a) => !a.hidden)),
    [institutions]
  );
  const accountCurrency = useMemo(
    () => dominantCurrency(allAccounts.map((a) => ({ iso_currency_code: a.currency }))),
    [allAccounts]
  );
  const mixedAccountCurrency = useMemo(() => {
    const seen = new Set<string>();
    for (const a of allAccounts) if (a.currency) seen.add(a.currency);
    return seen.size > 1;
  }, [allAccounts]);
  // Every account's currency (hidden ones too), most accounts first: offered
  // first when choosing a home currency.
  const accountCurrencies = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of institutions) for (const a of i.accounts) if (a.currency) counts.set(a.currency, (counts.get(a.currency) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([c]) => c);
  }, [institutions]);
  // The manual accounts typed in the app, with their currency, which the
  // choice of a home currency lists for the person to correct.
  const manualCurrencies = useMemo(
    () =>
      institutions
        .filter((i) => i.manual && !i.connector)
        .flatMap((i) => i.accounts.map((a) => ({ account_id: a.account_id, name: a.name, currency: a.currency ?? 'USD' }))),
    [institutions]
  );
  // The offer to show totals in one currency (decision 1): only for someone
  // whose accounts' balances (hidden ones too) are in more than one,
  // suggesting the currency their budgets are read in today, from the last
  // 365 days of rows as the Budgets tab's read takes them. Once the
  // transactions are in, so what it suggests doesn't change under a finger.
  const offer = useMemo(() => {
    if (txns === null) return null;
    // The same window as lib/budget-month.ts windowStart (LOOKBACK_DAYS, 365 UTC days).
    const since = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    const year = txns.filter((t) => t.date >= since);
    const budgets = totalsCurrency(year);
    return offerFor({
      accounts: institutions.flatMap((i) => i.accounts.filter((a) => a.balance !== null).map((a) => a.currency)),
      budgets,
      main: accountCurrency,
      // The last year's transactions in more than one currency: they convert
      // too, so the offer is made for them (decision A, step 2).
      transactions: year.map((t) => t.iso_currency_code || t.unofficial_currency_code || null),
    });
  }, [institutions, txns, accountCurrency]);
  // What Home shows: net worth in the home currency once one is chosen
  // (base), else the sum as it always was, labelled with the main currency.
  const shownWorth = base ? base.net_worth : netWorth;
  const shownCurrency = base ? base.currency : accountCurrency;
  // A new manual account's currency, until the person chooses another.
  const manualDefaultCurrency = base?.currency ?? accountCurrency ?? 'USD';
  const shownHistory = base ? base.history : history;
  // How much of the change came from exchange rates, when more than rounding
  // (decision 4). Written as it is drawn, so hiding amounts covers it.
  const fromRates = base?.delta ? rateEffectText(base.delta.value, base.delta.from_rates, base.currency) : '';

  // The institutions as the Plan reads them, with what went wrong at each, so
  // a figure that may be short says so; hidden accounts too, which the Plan
  // leaves out itself. One mapping for the Plan tab and the FI card on Home,
  // so both read the same accounts.
  const planInstitutions = useMemo(
    () =>
      institutions.map((i) => ({
        name: i.institution_name,
        item_id: i.manual ? null : i.item_id,
        error: !!i.error || i.needs_reauth,
        staleAsOf: i.stale_as_of ?? null,
        staleAsOfAt: i.stale_as_of_at ?? null,
        missing: (i.stale_missing ?? 0) + (i.unconfirmed_missing ?? 0),
        accounts: i.accounts.map((a) => ({
          account_id: a.account_id,
          name: a.name,
          type: a.type,
          subtype: a.subtype,
          balance: a.balance,
          currency: a.currency,
          hidden: a.hidden,
          positionsFailed: a.holdings_unanswered === true,
        })),
        // What it can't show (no balance recovered), for allocation over
        // time, which still expects the investment ones.
        unshown: (i.unshown_accounts ?? []).map((a) => ({ account_id: a.account_id, name: a.name, type: a.type ?? null, currency: a.currency ?? null })),
      })),
    [institutions]
  );
  // Every position, with its account, for the Plan's allocation.
  const planHoldings = useMemo(() => institutions.flatMap((i) => i.holdings), [institutions]);

  // Counts what's rendering, so hiding an institution's last account doesn't
  // leave "3 institutions connected" above two cards, and a fully hidden set
  // doesn't read "0 institutions connected" as if nothing were linked.
  const shownInstitutionCount = sortedInstitutions.length;
  const subtitle = loading
    ? 'Loading your accounts…'
    : !connected
      ? 'Connect your bank, credit card, and brokerage accounts'
      : shownInstitutionCount === 0 && hiddenAccounts.length > 0
        ? `All ${hiddenAccounts.length} account${hiddenAccounts.length === 1 ? '' : 's'} hidden`
        : `${shownInstitutionCount} institution${shownInstitutionCount === 1 ? '' : 's'} connected`;

  const startDisconnect = (inst: Institution) => {
    setDisconnectInput('');
    setEndedOffer(null);
    setDisconnectTarget(inst);
  };

  // Settings' sections (docs/design/information-architecture.md#settings):
  // the cards the Accounts tab's Manage mode used to append, unchanged,
  // each mounted only while its section is open.
  const settingsSections: SettingsSection[] = [
    {
      id: 'preferences',
      title: 'Preferences',
      sub: 'Home currency and rates, weekly summary email',
      content: (
        <>
          {/* The home currency and your own rates (components/CurrencyCard.tsx):
              applied after the server's cache, so a change shows on the
              next load of net worth, which it asks for. */}
          <CurrencyCard currencies={accountCurrencies} manual={manualCurrencies} focus={currencyFocus} onFocused={clearCurrencyFocus} onChanged={currencyChanged} />
          {/* The weekly summary email, off until turned on, with what
              this week's would say (components/WeeklySummaryCard.tsx). */}
          <WeeklySummaryCard clerk={clerk} />
        </>
      ),
    },
    {
      id: 'transactions',
      title: 'Transactions',
      sub: 'Categories, tags, rules, merchant defaults, review queue',
      content: (
        <>
          {/* Your categories and their groups (components/CategoriesCard.tsx):
              a change shows on the next read of the transactions and budgets. */}
          <CategoriesCard
            categories={categories}
            onChanged={() => {
              loadTransactions();
              budgetsStore.load();
            }}
          />
          {/* Your tags (components/TagsCard.tsx): applied after the
              server's cache, so a change shows on the next read. */}
          <TagsCard tags={tagList.tags} ruleUses={ruleUses} onChanged={acceptTags} />
          {/* Your rules (components/RulesCard.tsx): applied on every
              read, so a change shows when the transactions are read again. */}
          <RulesCard rules={rules} taxonomy={categories.taxonomy} tags={tagList.tags} accounts={ruleAccounts} onChanged={() => loadTransactions()} />
          {/* Merchants' default categories, beside the rules
              (components/VendorDefaultsCard.tsx), and the review queue
              (components/ReviewSettingsCard.tsx): both applied on read. */}
          <VendorDefaultsCard taxonomy={categories.taxonomy} onChanged={() => loadTransactions()} />
          <ReviewSettingsCard review={review} toReview={countToReview(txns ?? [])} />
        </>
      ),
    },
    {
      id: 'connections',
      title: 'Connections',
      sub:
        cardless.length > 0
          ? `${cardless.length} with no card on Accounts, reconnected accounts`
          : admin
            ? 'Reconnected accounts, unused connections'
            : 'Reconnected accounts',
      content: (
        <>
          {/* Before anything is connected there is no Accounts tab to point to. */}
          {connected && (
            <p className="panel-note">
              Each connection&apos;s status and actions are on its card on the Accounts tab. Here are the
              ones with no card, and accounts that may continue an earlier one.
            </p>
          )}
          {/* A linked institution whose accounts are all hidden (or all
              ended) has no card on the Accounts tab, so its status, its
              questions and its ⋯ (Add or remove accounts, Disconnect) are
              here. */}
          {allHiddenInstitutions.map((shown) => {
            const inst = institutions.find((i) => i.item_id === shown.item_id) ?? shown;
            const severity = connectionSeverity(inst);
            const badge = statusBadge(inst);
            const menu = institutionMenu(inst, null, null, {
              onDetails: (i) => setDetailsFor(i.item_id),
              onRemove: removeConnection,
              onConnector: setConnectorAsk,
              startManageAccounts,
              startEnableLiabilities,
            });
            return (
              <section className="card stack" key={inst.item_id}>
                <div className="card-header">
                  <h2 id={cardHeadingId(inst.item_id)} tabIndex={-1}>
                    {inst.institution_name}
                    {badge && severity && <> <span className={`badge ${severity === 'critical' ? 'neg' : 'warn'}`}>{badge}</span></>}
                  </h2>
                  <Menu label={`Options for ${inst.institution_name}`} items={menu} />
                </div>
                <p className="helper">
                  These still sync, but every account in them is hidden. Unhide one from Hidden on the
                  Accounts tab, add or remove its accounts, or disconnect it.
                </p>
                <ConnectionStatus
                  inst={inst}
                  allRows={inst.accounts}
                  place={null}
                  fx={base?.fx ?? null}
                  connecting={connecting}
                  unallowed={unallowedIds.has(inst.item_id)}
                  lifecycle={lifecycle}
                  onReconnect={startReconnect}
                  onRemove={removeConnection}
                  onManageAccounts={startManageAccounts}
                  onAllowTransactions={startAllowTransactions}
                  onConnector={setConnectorAsk}
                />
              </section>
            );
          })}
          {/* SimpleFIN and Lunch Flow connections with no card on the
              Accounts tab: nothing chosen yet, every account hidden or
              ended, or accounts left from one that is gone. */}
          {cardlessConnectors.size > 0 && (
            <ConnectorCards data={connectors.data} error={connectors.error} only={cardlessConnectors} onAsk={setConnectorAsk} onChanged={() => connectorChanged(false)} />
          )}
          {/* Renders only when there is a reconnected account to link or a
              link to undo; mounted only here, which also skips its history
              read until it is wanted. A change reloads live, since links
              alter hidden accounts and per-account history. */}
          <AccountLinks onChanged={() => loadNetWorth(true)} refreshKey={asOf} />
          {/* The admin's list of connections, across every account, that
              cost money and do nothing. Only ever mounted for the admin (decided
              on the server in app/page.tsx); the route also refuses
              anyone else. Removal is confirmed inside it. */}
          {admin && <AdminUnusedItems onRemoved={() => loadNetWorth(true)} />}
        </>
      ),
    },
    // Sharing needs Clerk: it is between people, each with their own sign-in.
    ...(clerk
      ? [
          {
            id: 'sharing' as const,
            title: 'Sharing',
            sub: 'Who sees your accounts, and for how long',
            content: (
              <div className="card">
                <p className="panel-note">
                  Invite someone to follow your accounts, and choose what each person sees and for how long.
                </p>
                <div className="card-actions">
                  <button className="secondary" onClick={() => setSharingOpen(true)}>
                    Open sharing
                  </button>
                </div>
              </div>
            ),
          },
        ]
      : []),
    {
      id: 'data',
      title: 'Your data and privacy',
      sub: filesMode?.connected ? 'Download, bring back a download, receipts, API tokens' : 'Download, bring back a download, API tokens',
      content: (
        <>
          {/* Download my data. It asks for a fresh sign-in itself. The
              accounts are what an OFX statement can be of: the live ones,
              and those that ended, which the live list no longer holds,
              labelled with their end. */}
          <DownloadMyData
            clerk={clerk}
            accounts={downloadAccounts(
              institutions.flatMap((i) =>
                i.accounts.map((a) => ({ account_id: a.account_id, name: a.name, institution_name: i.institution_name, type: a.type, mask: a.mask }))
              ),
              ended
            )}
          />
          {/* Receipts and documents (#47): every file kept, and as ZIP
              files, beside the download of the rest. */}
          {filesMode?.connected && <ReceiptsCard clerk={clerk} rows={txns} onChanged={txnEdits.refresh} />}
          {/* What Nya keeps about you, kind by kind (app/your-data),
              beside the download; for the admin, also storage
              across accounts (/admin/storage). */}
          <InventoryEntry admin={admin} />
          {/* Bringing a download back, and its undo, beside the download
              (components/RestoreCard.tsx). The restore banner moves focus
              here. */}
          <div id="bring-back" tabIndex={-1}>
            <RestoreCard clerk={clerk} onChanged={restoreChanged} refreshKey={asOf} />
          </div>
          {/* API tokens for the read-only API and the MCP server
              (components/ApiTokens.tsx). */}
          <ApiTokens clerk={clerk} />
        </>
      ),
    },
    {
      id: 'account',
      title: 'Account',
      sub: clerk ? 'Sign out, and where your profile is' : 'Log out, sign out everywhere',
      content: (
        <div className="card">
          {clerk ? (
            <>
              <p className="panel-note">
                Your profile, how you sign in, your devices and deleting your account are in the account
                menu, under your picture at the top.
              </p>
              <div className="card-actions">
                <ClerkSignOut clearDevice={clearDevice} />
              </div>
            </>
          ) : (
            <div className="card-actions">
              <button className="secondary" onClick={logout}>
                Log out
              </button>
              <button className="secondary" onClick={signOutEverywhere}>
                Sign out everywhere
              </button>
            </div>
          )}
        </div>
      ),
    },
  ];

  // Home's Needs attention (components/attention.ts): what asks the person
  // to act, from what the Accounts tab, Settings > Connections, the review
  // count, the budgets and the offer of a home currency already show. Only
  // while Home is on screen: the budgets read the year's transactions.
  const homeShown = tab === 'home' && !settings && connected && !loading;
  const paymentAccounts = useMemo(
    () =>
      sortedInstitutions.flatMap((i) =>
        i.accounts.map((a): PaymentAccount => ({ item_id: i.item_id, account_id: a.account_id, name: a.name, type: a.type, balance: a.balance, currency: a.currency, liability: a.liability }))
      ),
    [sortedInstitutions]
  );
  const budgetCarries = budgetMonth.view?.month === thisMonth ? budgetMonth.view.carries : null;
  const reviewOn = !!review.view?.on;
  const attention = useMemo(() => {
    if (!homeShown) return null;
    const now = new Date();
    const budgetRows = budgetAlerts({ txns, fx: txnFx, budgets, taxonomy: categories.taxonomy, budgetCarries }, now);
    const items = attentionItems({
      cards: cardStatus.map((c) => ({ inst: sortedInstitutions.find((i) => i.item_id === c.item_id)!, severity: c.severity })),
      hiddenOnly: allHiddenInstitutions.map((inst) => {
        const full = institutions.find((i) => i.item_id === inst.item_id) ?? inst;
        return { inst: full, severity: connectionSeverity(full) };
      }),
      institutions,
      cardless: cardlessConnectors,
      connectors: connectors.data ?? null,
      review: reviewOn ? countToReview(txns ?? []) : 0,
      payments: paymentAlerts(paymentAccounts, now),
      budgets: budgetRows,
      currency: offer && !base && !currencyProblem && !offerHidden ? offer : null,
      restore: restoreHold,
      now,
    });
    const notes = budgetRows.alerts.length > 0 ? spendingNotes({ txns, fx: txnFx, withoutTransactions: txnWithout, incomplete: txnIncomplete, stopped: stoppedTxns }, now) : { leftOut: null, missing: [] };
    return { items, notes };
    // `amountsHidden` isn't read inside: it changes what formatMoney writes there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeShown, txns, txnFx, budgets, categories.taxonomy, budgetCarries, cardStatus, sortedInstitutions, allHiddenInstitutions, institutions, cardlessConnectors, connectors.data, reviewOn, paymentAccounts, offer, base, currencyProblem, offerHidden, restoreHold, txnWithout, txnIncomplete, stoppedTxns, amountsHidden]);

  // Where a Needs attention row goes, focused once it is on screen: a tab's
  // content can come a render later (the Budgets tab's after its spinner).
  // Dropped when the person goes elsewhere first, or after a moment.
  const [focusTarget, setFocusTarget] = useState<{ id: string; tab: Tab; settings: SettingsView | null; at: number } | null>(null);
  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.tab !== tab || focusTarget.settings !== settings || Date.now() - focusTarget.at > 10_000) {
      setFocusTarget(null);
      return;
    }
    const target = document.getElementById(focusTarget.id);
    if (!target) return;
    setFocusTarget(null);
    target.scrollIntoView({ block: 'start' });
    target.focus({ preventScroll: true });
  });
  const goTo = useCallback(
    (go: Go) => {
      const focus = (id: string, t: Tab, s: SettingsView | null) => setFocusTarget({ id, tab: t, settings: s, at: Date.now() });
      switch (go.to) {
        case 'card':
          window.scrollTo(0, 0);
          setTab('accounts');
          focus(cardHeadingId(go.item_id), 'accounts', null);
          return;
        case 'connections':
          openConnections();
          // Settings focuses its title; the card there, when it has one.
          if (go.item_id) focus(cardHeadingId(go.item_id), tab, 'connections');
          return;
        case 'account':
          // Over Home: the sheet returns focus to the row that opened it.
          setAccountOpen({ item_id: go.item_id, account_id: go.account_id });
          return;
        case 'budgets':
          window.scrollTo(0, 0);
          setTab('budgets');
          focus('budgets-month-title', 'budgets', null);
          return;
        case 'review':
          window.scrollTo(0, 0);
          setTab('activity');
          focus('review-count', 'activity', null);
          return;
        case 'restore':
          openRestore();
          return;
        case 'currency':
          setOfferOpen(true);
          return;
      }
    },
    [tab, openConnections, openRestore]
  );

  // What qualifies the Home total, under it (components/TotalCaveats.tsx),
  // each in its color: what the total is missing, named
  // (components/total-notes.ts), colored as each institution's card is
  // (lib/accounts-status.ts); the student loans' accrued interest it leaves
  // out or couldn't read; and its currency. Built while rendering, not in a
  // memo, so hide amounts masks the figures in them at once.
  const homeCaveats: Caveat[] = [
    ...totalCaveats(institutions, { snapshot: fmtStaleDay, instant: fmtInstantDay }, restoreHold, severityOf).map((n) => ({
      key: n.text,
      severity: n.severity,
      summary: n.summary,
      body: n.text,
    })),
    ...accruedCaveats(institutions, accountCurrency, base?.fx ?? null),
    ...(base
      ? heroCurrencyCaveats(base, accountCurrency, openCurrency)
      : currencyProblem
        ? [
            {
              key: 'currency-unread',
              severity: 'caution' as const,
              summary: 'currency settings unreadable',
              body: (
                <>
                  Your currency settings couldn&apos;t be read, so totals aren&apos;t converted.{' '}
                  <button className="btn ghost" onClick={() => openCurrency()}>
                    See Currency
                  </button>
                </>
              ),
            },
          ]
        : mixedAccountCurrency
          ? [{ key: 'currency-mixed', severity: 'caution' as const, summary: 'currencies not converted', body: "Accounts use multiple currencies; totals aren't converted." }]
          : []),
  ];

  return (
    <>
      <main className="wrap">
        <div className="top-row">
          <div>
            <div className="brand">
              {/* eslint-disable-next-line @next/next/no-img-element -- the app icon, already a static SVG */}
              <img className="brand-logo" src="/icon.svg" alt="" width={34} height={34} />
              <h1>Nya</h1>
            </div>
            <p className="sub">{subtitle}</p>
          </div>
          <div className="top-actions">
            <HideAmountsToggle />
            {connected && !loading && (
              <button
                className="secondary icon-btn"
                onClick={refreshAll}
                disabled={refreshing}
                aria-label="Refresh"
                title="Refresh"
              >
                <svg
                  className={refreshing ? 'spin' : undefined}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20 12a8 8 0 1 1-2.35-5.65M20 4v4h-4" />
                </svg>
              </button>
            )}
            {clerk ? (
              <ClerkAccount clearDevice={clearDevice} onOpenSettings={openSettings} onOpenSharing={() => setSharingOpen(true)} />
            ) : (
              // Password mode has no account menu: Log out and Sign out
              // everywhere are in Settings > Account.
              <button className="secondary icon-btn" onClick={openSettings} aria-label="Settings" title="Settings">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d={GEAR} />
                </svg>
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="card">
            <div className="spinner" role="status" aria-label="Loading" />
          </div>
        ) : settings ? (
          <SettingsScreen view={settings} sections={settingsSections} onView={setSettings} onClose={closeSettings} />
        ) : !connected ? (
          <>
            <div className="card">
              <ConnectButtons connecting={connecting} onConnect={startConnect} onConnectSimpleFin={connectSimpleFin} onConnectLunchFlow={connectLunchFlow} brokerage={brokerageLink} />
              <CoverageNote />
              {/* Also offered here, not just on the Accounts tab: with nothing
                  connected the tab bar is hidden, so this is the only reachable
                  entry point for someone whose bank Plaid doesn't support at all. */}
              <div className="action-row">
                <button className="secondary" onClick={() => startAddManual(manualDefaultCurrency)} disabled={savingManual}>
                  <ActionIcon d="M12 5v14M5 12h14" />
                  Add manual
                </button>
                {clerk && (
                  <button className="secondary" onClick={() => setSharingOpen(true)}>
                    <ActionIcon d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
                    Sharing
                  </button>
                )}
              </div>
              <p className="empty-note">
                Manual accounts are for institutions Plaid can&apos;t reach. You type the balance and
                update it whenever you like; it counts toward net worth and builds its own history.
              </p>
              <SwitchingLink onOpen={() => setMigrationOpen(true)} />
              {error && <div className="error">{error}</div>}
              {lifecycleRepair}
            </div>
            {/* Bringing back a download goes only into an empty account, so
                it is offered here first (components/RestoreCard.tsx). */}
            <div id="bring-back">
              <RestoreCard clerk={clerk} onChanged={restoreChanged} autoScan refreshKey={asOf} />
            </div>
            {/* A SimpleFIN connection whose accounts aren't chosen yet. */}
            <ConnectorCards data={connectors.data} error={connectors.error} onAsk={setConnectorAsk} onChanged={() => connectorChanged(false)} />
            {/* Someone who only follows what others share needs no bank of their own. */}
            {clerk && <SharedWithMe refreshKey={asOf} viewer={viewer} />}
          </>
        ) : (
          <>
            {/* An unfinished restore, said on every tab. */}
            <RestoreBanner hold={restoreHold} onOpen={openRestore} />
            {tab === 'home' && (
              <>
                {/* One card: the total, what qualifies it, the chart and
                    what qualifies that, the nightly jobs, and the chart
                    notes in a sheet (rollout phase 4a). */}
                <NetWorthCard
                  worth={shownWorth}
                  currency={shownCurrency}
                  caveats={homeCaveats}
                  pausedSince={pausedSince}
                  notesProblem={timeline.problem}
                  backupProblem={backupProblem}
                  filesProblem={filesProblem}
                  asOf={asOf}
                  refreshing={refreshing}
                  notesCount={timeline.notes.length}
                  onNotes={() => setNotesOpen(true)}
                  delta={shownDelta && (
                    <div className={`hero-delta${shownDelta.value >= 0 ? ' up' : ' down'}`}>
                      {shownDelta.value >= 0 ? '▲' : '▼'} <Masked>{fmt(Math.abs(shownDelta.value), shownCurrency)}</Masked> (
                      {shownDelta.pct.toFixed(1)}%) · past {shownDelta.days} days
                      {endedInDelta > 0 && ` · includes ${endedInDelta === 1 ? 'an account' : `${endedInDelta} accounts`} that ended`}
                      {fromRates && (
                        <>
                          {' · '}
                          <Masked>{fromRates}</Masked>
                        </>
                      )}
                    </div>
                  )}
                  chart={
                    shownHistory.length >= 2 ? (
                      <>
                        <NetWorthChart points={shownHistory} currency={base?.currency} notes={chartNotes} />
                        {base && <ChartCurrencyNote base={base} main={accountCurrency} />}
                        {importedHistory && <ImportedHistoryNote view={importedHistory} institutions={institutions} />}
                      </>
                    ) : base && history.length >= 2 ? (
                      // A history there is, that couldn't be converted: why.
                      <ChartCurrencyNote base={base} main={accountCurrency} />
                    ) : (
                      <p className="empty-note">
                        History builds as you use the app: check back tomorrow for your first
                        trend line.
                      </p>
                    )
                  }
                />
                <TimelineNotesSheet
                  open={notesOpen}
                  onClose={() => setNotesOpen(false)}
                  notes={timeline.notes}
                  problem={timeline.problem}
                  onChanged={timeline.reload}
                />

                {/* What asks the person to act, each row going where it is
                    fixed (rollout phase 4b); the admin's instructions for
                    the nightly jobs under it. */}
                {attention && <NeedsAttention items={attention.items} notes={attention.notes} onGo={goTo} />}
                {admin && <AdminAttention backup={backupProblem} files={filesProblem} />}

                <Insights
                  txns={txns}
                  fx={txnFx}
                  idleCash={idleCashAccounts}
                  withoutTransactions={txnWithout}
                  series={recurring ?? undefined}
                  dismissed={plannedState.status === 'ready' ? plannedState.value.dismissed : undefined}
                  incomplete={txnIncomplete}
                  stopped={stoppedTxns}
                  accounts={institutions.flatMap((i) =>
                    i.accounts
                      .filter((a) => !a.hidden)
                      .map((a) => ({
                        name: a.name,
                        type: a.type,
                        subtype: a.subtype,
                        balance: a.balance,
                        currency: a.currency,
                        liability: a.liability,
                      }))
                  )}
                />

                {/* The Plan's FI number, years to FI and savings rate, from
                    the same inputs and plan as the Plan tab. Below the
                    insights: it appears only once its inputs are in, so
                    nothing above it moves when it does. */}
                <FiProgressLoader
                  txns={txns}
                  txnsLoading={txnsLoading}
                  txnNotes={txnUnread}
                  txnWithout={txnWithout}
                  institutions={planInstitutions}
                  currency={accountCurrency}
                  txnFx={txnFx}
                  balanceFx={base?.fx ?? null}
                  onOpenPlan={() => {
                    window.scrollTo(0, 0);
                    setTab('plan');
                  }}
                />
                {error && <div className="error">{error}</div>}
                {lifecycleRepair}
              </>
            )}

            {tab === 'accounts' && (
              <>
                {/* Connecting, a manual account and switching are in the
                    Add account sheet; sharing is in the avatar menu and
                    Settings > Sharing. The pill counts from this load only:
                    never from this device's snapshot or a load that failed. */}
                <div className="accounts-bar">
                  <AccountsStatus
                    entries={statusEntries}
                    known={!loading && !balancesSaved && !balancesFailed && !!connectors.data && !connectors.error}
                    healthRead={!healthUnavailable}
                    syncing={sortedInstitutions.some((i) => !i.manual || !!i.connector) || cardless.length > 0}
                    onGo={goToFirstToFix}
                  />
                  <button className="btn" onClick={() => setAddAccountOpen(true)}>
                    <ActionIcon d="M12 5v14M5 12h14" />
                    Add account
                  </button>
                </div>
                <AccountsSummary institutions={sortedInstitutions} fx={base?.fx ?? null} main={accountCurrency} />
                {error && <div className="error">{error}</div>}
                {lifecycleRepair}
                {lifecycle.problem && <div className="error">{lifecycle.problem}</div>}
                {/* Whenever there is a card or loan on screen to plan, until
                    it moves to Budgets > Goals (rollout phase 6). */}
                {allAccounts.some((a) => isOwedType(a.type)) && (
                  <ul className="card list-rows">
                    <li>
                      <button className="list-row" onClick={() => setPayoffOpen(true)}>
                        <span className="list-row-text">
                          <span className="list-row-title">Payoff plan</span>
                        </span>
                        <ActionIcon d="m9 6 6 6-6 6" />
                      </button>
                    </li>
                  </ul>
                )}

                {/* What couldn't be read about every connection, said once
                    for the tab: a card can't say what is missing from it. */}
                {healthUnavailable ? (
                  <div className="notice caution">
                    {ALERT}
                    <p>Plaid&apos;s warnings and the last sync times couldn&apos;t be read just now, so a connection that is about to end may not say so here.</p>
                  </div>
                ) : (
                  unreadConnections > 0 && (
                    <div className="notice caution">
                      {ALERT}
                      <p>{`Some of what Nya keeps about ${unreadConnections === 1 ? 'one connection' : `${unreadConnections} connections`} couldn't be read, so a warning that one is about to end may be missing here.`}</p>
                    </div>
                  )
                )}
                {connectors.error && (
                  <div className="notice critical">
                    {ALERT}
                    <p>Your own sync’s connections couldn’t be loaded: {connectors.error}</p>
                  </div>
                )}
                {/* Connections with no card here (every account hidden, or
                    none chosen yet) that need attention, in Settings. */}
                {cardlessWorst && (
                  <div className={`notice ${cardlessWorst}`}>
                    {ALERT}
                    <div className="stack tight">
                      <p>
                        {cardlessCount === 1
                          ? 'A connection with no card here needs attention: its accounts are hidden or not chosen yet.'
                          : `${cardlessCount} connections with no card here need attention: their accounts are hidden or not chosen yet.`}
                      </p>
                      <div className="btn-row">
                        <button className="btn secondary" onClick={openConnections}>
                          Open Settings, Connections
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {sortedInstitutions.map((inst) => (
                  <InstitutionCard
                    key={inst.item_id}
                    inst={inst}
                    institutions={institutions}
                    base={base}
                    shownCurrency={shownCurrency}
                    connecting={connecting}
                    expandedHoldings={expandedHoldings}
                    unallowedIds={unallowedIds}
                    lifecycle={lifecycle}
                    place={places.get(inst.item_id) ?? null}
                    requestsLeft={connectors.data?.requests?.left ?? null}
                    onOpenAccount={(account_id) => setAccountOpen({ item_id: inst.item_id, account_id })}
                    toggleHoldings={toggleHoldings}
                    onDetails={(i) => setDetailsFor(i.item_id)}
                    onRemove={removeConnection}
                    onConnector={setConnectorAsk}
                    startReconnect={startReconnect}
                    startAllowTransactions={startAllowTransactions}
                    startEnableLiabilities={startEnableLiabilities}
                    startManageAccounts={startManageAccounts}
                  />
                ))}

                {hiddenAccounts.length > 0 && (
                  <section className="card stack">
                    <CollapsibleHeader
                      title="Hidden"
                      count={hiddenAccounts.length}
                      open={hiddenExpanded}
                      onToggle={() => setHiddenExpanded((v) => !v)}
                      controls="hidden-accounts"
                    />
                    {hiddenExpanded && (
                      <>
                        <p className="helper">
                          These accounts still sync, but are left out of net worth, transactions,
                          budgets and insights, on every day, past ones too. Unhiding restores their
                          history in full. To stop counting one only from a day on, unhide it, then open
                          it, use Close… and choose Stop following: every day before then still counts.
                        </p>
                        {/* Each row's Unhide sits beside its text, not inside
                            a control. */}
                        <ul id="hidden-accounts" className="list-rows">
                          {hiddenAccounts.map(({ account, institution_name, resolved }) => (
                            <li key={account.account_id} className="list-row">
                              <span className="list-row-text">
                                <span className="list-row-title">{account.name}</span>
                                <span className="list-row-sub">
                                  {institution_name} · {account.subtype || account.type}
                                </span>
                              </span>
                              {/* An unresolved account has no balance to
                                  show; "--" beats a misleading $0.00. */}
                              <span className="list-row-value">
                                <Masked>{resolved ? fmt(signedBalance(account), account.currency) : '--'}</Masked>
                              </span>
                              <button
                                className="btn ghost"
                                disabled={togglingHidden !== null}
                                onClick={() => toggleHidden(account.account_id, false)}
                              >
                                {togglingHidden === account.account_id ? 'Unhiding…' : 'Unhide'}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </section>
                )}

                {/* Accounts that ended (#50), from the
                    stored set, with when each ended, to change or reopen. */}
                <EndedAccounts
                  ended={ended}
                  hidden={hiddenIds}
                  busy={lifecycle.busy}
                  onOpen={lifecycle.open}
                  onReopen={lifecycle.reopen}
                  onStillOpen={lifecycle.stillOpen}
                  onImportHistory={(e) =>
                    setHistoryTarget({
                      account_id: e.account_id,
                      name: e.label.name || 'Account',
                      institution_name: e.label.institution,
                      type: e.type ?? 'other',
                      currency: null,
                    })
                  }
                  importable={new Set(institutions.filter((i) => !i.manual).map((i) => i.item_id))}
                />

                {/* What others share with me, whenever there is some; last,
                    so my own accounts don't move when it arrives. What I
                    share is in the Sharing drawer. */}
                {clerk && <SharedWithMe refreshKey={asOf} viewer={viewer} />}
              </>
            )}

            {tab === 'activity' && (
              <MonthBreakdown
                txns={txns}
                fx={txnFx}
                notes={txnNotes}
                asideNotes={txnAside}
                loading={txnsLoading}
                taxonomy={categories.taxonomy}
                onRecategorize={txnEdits.recategorize}
                onRename={renameVendor}
                // Only with a manual account to add to (hidden ones aren't offered).
                onAddTransaction={
                  institutions.some((i) => i.manual && !i.connector && i.accounts.some((a) => !a.hidden)) ? () => txnEdits.openAdd() : undefined
                }
                onImport={() => setImportTarget({ account_id: null })}
                onEditTransaction={txnEdits.openEdit}
                onToggleExcluded={txnEdits.toggleExcluded}
                tags={tagList.tags}
                onChangeTags={txnEdits.changeTags}
                onSaveNote={txnEdits.saveNote}
                // Prefilled from the row as rules read it: the name it had
                // before any rule named it, which a new rule's condition
                // matches (a rule never reads another's changes).
                onCreateRule={(t, category_id) =>
                  rules.open(
                    newDraft({
                      conditions: [{ field: 'name', op: 'equals', value: nameForRules(t), value2: '', direction: '' }],
                      set_category: category_id ?? t.category_id ?? '',
                    })
                  )
                }
                ruleSentenceOf={ruleSentenceOf}
                // Splits and groups (#39): applied after the server's cache,
                // so the list is read again quietly after a change.
                onSplitsChanged={txnEdits.refresh}
                review={review}
                shared={sharedRows}
                // Receipts and documents (#47), where the file store is connected.
                onAttachmentsChanged={filesMode?.connected ? txnEdits.refresh : undefined}
                actionError={txnEdits.error}
                incomplete={txnIncomplete}
                stopped={stoppedTxns}
                withoutTransactions={txnWithout}
              />
            )}

            {/* Shared expenses (#49): who owes what, under the transactions. */}
            {tab === 'activity' && (
              <SharedExpensesCard
                shared={sharedExpenses}
                txns={txns}
                facts={sharedFacts}
                tags={tagList.tags}
                taxonomy={categories.taxonomy}
                currency={accountCurrency ?? 'USD'}
                fx={txnFx}
              />
            )}

            {/* Reports for an accountant (app/reports), under the transactions. */}
            {tab === 'activity' && <ReportsEntry />}

            {tab === 'budgets' && (
              <BudgetsTab
                txns={txns}
                fx={txnFx}
                budgets={budgets}
                taxonomy={categories.taxonomy}
                categoriesError={categories.error}
                budgetsStatus={budgetsState.status}
                budgetsError={budgetsState.error}
                budgetsSaveError={budgetsState.saveError}
                onSave={budgetsStore.save}
                goals={goals}
                goalsStatus={goalsState.status}
                goalsError={goalsState.error}
                goalsSaveError={goalsState.saveError}
                goalsDamage={goalsState.damage}
                onGoalsRepaired={() => goalsStore.load()}
                onSaveGoals={goalsStore.save}
                // Hidden accounts stay in this list, and those that ended join
                // it with their end (#50): GoalsCard needs them to tell "you hid
                // this account" or "it closed" from "this account was
                // disconnected". It excludes them from the picker itself.
                accounts={withAccountEnds(
                  institutions.flatMap((i) =>
                    i.accounts.map((a) => ({
                      account_id: a.account_id,
                      name: a.name,
                      institution: i.institution_name,
                      balance: a.balance,
                      currency: a.currency,
                      hidden: a.hidden,
                      type: a.type,
                    }))
                  ),
                  ended
                )}
                loading={txnsLoading}
                incomplete={txnIncomplete}
                stopped={stoppedTxns}
                withoutTransactions={txnWithout}
                // The forecast, the calendar and the recurring list.
                series={recurring}
                txnsFailed={txnsFailed && txns === null}
                institutions={institutions}
                balancesAsOf={asOf}
                balancesSaved={balancesSaved}
                planned={plannedState.value}
                plannedStatus={plannedState.status}
                plannedError={plannedState.error}
                plannedSaveError={plannedState.saveError}
                onSavePlanned={plannedItemsStore.save}
                budgetMonth={budgetMonth}
                onCategories={(t) => {
                  categories.accept(t);
                  loadTransactions();
                  budgetsStore.load();
                }}
              />
            )}

            {tab === 'plan' && (
              <PlanTabLoader
                txns={txns}
                txnsLoading={txnsLoading}
                txnNotes={txnUnread}
                txnWithout={txnWithout}
                institutions={planInstitutions}
                holdings={planHoldings}
                balancesAsOf={asOf}
                balancesSaved={balancesSaved}
                balancesFailed={balancesFailed}
                currency={accountCurrency}
                txnFx={txnFx}
                balanceFx={base?.fx ?? null}
              />
            )}
          </>
        )}
        {/* At the foot of every tab: how the data is protected, and who can read it. */}
        <TrustLinks />
      </main>
      {clerk && <SharingDrawer open={sharingOpen} onClose={closeSharing} />}
      {/* Mounted outside the tabs so what was typed into it lasts until a reload. */}
      <DebtPayoff open={payoffOpen} onClose={closePayoff} institutions={institutions} />
      {/* The offer, from its row in Needs attention: a choice closes it and
          opens the sheet that confirms one, never one over the other. */}
      <CurrencyOfferSheet
        open={offerOpen && !!offer && !base && !currencyProblem && !offerHidden}
        offer={offer}
        onClose={() => setOfferOpen(false)}
        onChoose={(code) => {
          setOfferOpen(false);
          setChoosingHome({ initial: code });
        }}
        onDismiss={() => {
          dismissOffer();
          setOfferHidden(true);
          setOfferOpen(false);
          // Its row has gone: the card's heading while the card stays, else the
          // Net worth card's.
          setFocusTarget({ id: (attention?.items.length ?? 0) > 1 ? NEEDS_ATTENTION_TITLE : 'net-worth-title', tab: 'home', settings: null, at: Date.now() });
        }}
      />
      {/* Opened from the offer on Home: only the person's confirmation in it
          chooses a home currency. */}
      <CurrencyChoiceSheet
        open={!!choosingHome}
        onClose={() => setChoosingHome(null)}
        initial={choosingHome?.initial ?? null}
        first={accountCurrencies}
        manual={manualCurrencies}
        onSaved={currencyChanged}
      />

      {connected && !loading && (
        <nav className="tab-bar" aria-label="Sections">
          {(['home', 'accounts', 'activity', 'budgets', 'plan'] as const).map((t) => (
            <button
              key={t}
              className={tab === t && !settings ? 'active' : ''}
              aria-current={tab === t && !settings ? 'page' : undefined}
              onClick={() => {
                // Each tab starts at its top: the page scroll would otherwise
                // carry over from one tab to the next. A tab also closes
                // Settings, which shows in place of the tabs.
                if (t !== tab || settings) window.scrollTo(0, 0);
                setSettings(null);
                setTab(t);
              }}
            >
              {TAB_ICONS[t]}
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
      )}

      {/* Forms and confirmations open in the same drawer as Sharing
          (components/Sheet.tsx). Each keeps its last content while it slides
          out, so it doesn't empty mid-animation. */}
      <Sheet
        open={!!manualDraft || !!manualMoved?.open}
        title={manualMoved && !manualDraft ? 'Saved' : shownManualDraft && editingManualShown ? 'Update account' : 'Add a manual account'}
        onClose={() => {
          if (savingManual) return;
          setManualDraft(null);
          setManualMoved((m) => (m ? { ...m, open: false } : m));
        }}
      >
        {manualMoved && !manualDraft ? (
          <MovedBody moved={[{ name: '', text: manualMoved.text }]} onClose={() => setManualMoved((m) => (m ? { ...m, open: false } : m))} />
        ) : shownManualDraft && (
          <>
            <p className="panel-note" style={{ marginTop: 0 }}>
              For institutions Plaid can&apos;t reach. The balance you type counts toward net worth
              and is recorded on the timeline each time you update it.
            </p>
            <div className="sheet-form">
              <label className="field">
                Account name
                <input
                  value={shownManualDraft.name}
                  onChange={(e) => setManualDraft({ ...shownManualDraft, name: e.target.value })}
                  placeholder="e.g. Credit Union Checking"
                  maxLength={60}
                  disabled={savingManual}
                />
              </label>
              <label className="field">
                Institution
                <input
                  value={shownManualDraft.institution_name}
                  onChange={(e) => setManualDraft({ ...shownManualDraft, institution_name: e.target.value })}
                  placeholder="Groups accounts into one card"
                  maxLength={60}
                  disabled={savingManual}
                />
              </label>
              <label className="field">
                Type
                <select
                  value={isCashOnHand(shownManualDraft) ? 'cash' : shownManualDraft.type}
                  onChange={(e) => {
                    const cash = e.target.value === 'cash';
                    setManualDraft({
                      ...shownManualDraft,
                      type: cash ? 'depository' : e.target.value,
                      // Cash only when chosen; another subtype is kept as it was.
                      subtype: cash ? CASH_SUBTYPE : shownManualDraft.subtype === CASH_SUBTYPE ? null : shownManualDraft.subtype,
                    });
                  }}
                  disabled={savingManual}
                  aria-describedby={manualCrossing ? OWED_FLIP_REASON : undefined}
                >
                  {MANUAL_TYPE_LABELS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Currency
                <select
                  value={shownManualDraft.currency}
                  // The balance stays as typed: only what it is counted in changes.
                  onChange={(e) => setManualDraft({ ...shownManualDraft, currency: e.target.value })}
                  disabled={savingManual}
                >
                  <CurrencyOptions first={accountCurrencies} value={shownManualDraft.currency} />
                </select>
              </label>
              <label className="field">
                {isOwedType(shownManualDraft.type) ? 'Amount owed' : 'Current balance'}
                <input
                  // Held as a string (see ManualDraft) so a leading "-" survives
                  // typing. Credit and loan balances are amounts owed, which
                  // subtract from net worth, so a negative would double-negate.
                  type="number"
                  inputMode="decimal"
                  step={String(10 ** -minorDigits(shownManualDraft.currency))}
                  min={isOwedType(shownManualDraft.type) ? 0 : undefined}
                  value={shownManualDraft.balance}
                  onChange={(e) => setManualDraft({ ...shownManualDraft, balance: e.target.value })}
                  placeholder={zeroExample(minorDigits(shownManualDraft.currency))}
                  disabled={savingManual}
                />
              </label>
            </div>
            {shownManualDraft.stored !== null && shownManualDraft.currency !== shownManualDraft.stored && (
              <p className="panel-note">
                The balance you typed stays as it is, now in {shownManualDraft.currency}: this account and its history are counted in {shownManualDraft.currency} from now on.{' '}
                {shownManualDraft.relabel ? RELABEL_KEEPS : CORRECTION_KEEPS}
              </p>
            )}
            {shownManualDraft.stored !== null && shownManualDraft.account_id && shownManualDraft.currency !== shownManualDraft.stored && (
              // The server's count of every row the move would take, older
              // ones too, and that it has no undo.
              <RelabelOffer
                account_id={shownManualDraft.account_id}
                from={shownManualDraft.stored}
                to={shownManualDraft.currency}
                checked={!!shownManualDraft.relabel}
                onChange={(on) => setManualDraft({ ...shownManualDraft, relabel: on })}
                disabled={savingManual}
              />
            )}
            <p className="panel-note">
              {isOwedType(shownManualDraft.type)
                ? 'Enter what you owe as a positive number. It subtracts from net worth.'
                : 'Negative balances are allowed (e.g. an overdrawn account).'}
            </p>
            <OwedFlipNote
              crossing={manualCrossing}
              toOwed={isOwedType(shownManualDraft.type)}
              disabled={savingManual || togglingHidden !== null}
              onClose={() => {
                const a = shownManualDraft.kept!;
                setManualDraft(null);
                lifecycle.open({ account_id: a.account_id, name: a.name, mask: null, institution: a.institution_name, balance: a.balance, type: a.type, currency: a.currency ?? 'USD', lastKnown: false });
              }}
              onHide={() => {
                const a = shownManualDraft.kept!;
                setManualDraft(null);
                void toggleHidden(a.account_id, true);
              }}
            />

            {editingManualShown && shownManualDraft.account_id && (
              <p className="panel-note manual-id">
                Account ID for scripted updates: <code>{shownManualDraft.account_id}</code>
              </p>
            )}

            {manualError && <div className="error">{manualError}</div>}

            <div className="button-pair" style={{ marginTop: 16 }}>
              <button className="secondary" onClick={() => setManualDraft(null)} disabled={savingManual}>
                Cancel
              </button>
              <button
                disabled={
                  savingManual ||
                  !shownManualDraft.name.trim() ||
                  !shownManualDraft.institution_name.trim() ||
                  shownManualDraft.balance.trim() === '' ||
                  !Number.isFinite(Number(shownManualDraft.balance)) ||
                  manualCrossing ||
                  (isOwedType(shownManualDraft.type) && Number(shownManualDraft.balance) < 0)
                }
                onClick={submitManualDraft}
                aria-describedby={manualCrossing ? OWED_FLIP_REASON : undefined}
              >
                {savingManual ? 'Saving…' : editingManualShown ? 'Save' : 'Add account'}
              </button>
            </div>
          </>
        )}
      </Sheet>

      <Sheet
        open={!!manualDeleteTarget}
        title={shownDeleteTarget ? `Delete ${shownDeleteTarget.name}?` : 'Delete'}
        onClose={() => !savingManual && setManualDeleteTarget(null)}
      >
        {shownDeleteTarget && (
          <>
            <p className="panel-note" style={{ marginTop: 0 }}>
              This account&apos;s balance history, and any transactions entered on it, are{' '}
              <strong>not recoverable</strong>. Re-adding it creates a new account with an empty history.
            </p>
            {manualError && <div className="error">{manualError}</div>}
            <div className="button-pair" style={{ marginTop: 16 }}>
              <button className="secondary" onClick={() => setManualDeleteTarget(null)} disabled={savingManual}>
                Cancel
              </button>
              <button
                className="danger"
                disabled={savingManual}
                onClick={() => mutateManual('DELETE', { account_id: shownDeleteTarget.account_id })}
              >
                {savingManual ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </>
        )}
      </Sheet>

      <ManualTxnSheet
        target={txnEdits.sheet}
        institutions={institutions}
        txns={txns}
        taxonomy={categories.taxonomy}
        onClose={txnEdits.closeSheet}
        onSaved={txnEdits.onSaved}
        onBalanceStale={() => loadNetWorth(true)}
      />

      <ImportSheet target={importTarget} institutions={institutions} onClose={() => setImportTarget(null)} onImported={onImported} />
      <HistoryImportSheet
        target={historyTarget}
        onClose={() => setHistoryTarget(null)}
        onImported={() => {
          loadTransactions();
          // The backfill draws it, running again first when rows after its
          // earliest point changed (lib/history-import/extend.ts).
          requestBackfill(() => loadNetWorth());
          void loadNetWorth();
        }}
      />
      <AccountSheet
        open={!!openedAccount}
        account={shownAccount?.account ?? null}
        inst={shownAccount?.inst ?? null}
        shownCurrency={shownCurrency}
        saving={savingManual}
        hiding={togglingHidden !== null}
        lifecycleBusy={lifecycle.busy}
        onDismiss={() => setAccountOpen(null)}
        onHide={(account_id) => toggleHidden(account_id, true)}
        onEnd={lifecycle.open}
        onUpdate={startEditManual}
        onAddTransaction={(account_id) => txnEdits.openAdd(account_id)}
        onImport={(account_id) => setImportTarget({ account_id })}
        onImportHistory={setHistoryTarget}
        onDelete={(account) => {
          setManualError('');
          setManualDeleteTarget(account);
        }}
      />
      <AddAccountSheet
        open={addAccountOpen}
        onClose={() => setAddAccountOpen(false)}
        connecting={connecting}
        brokerage={brokerageLink}
        onConnect={startConnect}
        onConnectSimpleFin={connectSimpleFin}
        onConnectLunchFlow={connectLunchFlow}
        onAddManual={() => startAddManual(manualDefaultCurrency)}
        onSwitching={() => setMigrationOpen(true)}
      />
      <MigrationSheet
        open={migrationOpen}
        taxonomy={categories.taxonomy}
        onClose={() => setMigrationOpen(false)}
        onImported={() => {
          loadTransactions();
          // Accounts it made or took out move net worth; a linked account's
          // rows are drawn into its estimated history by the backfill.
          void loadNetWorth(true);
          requestBackfill(() => loadNetWorth());
        }}
      />
      <ConnectorSheet ask={connectorAsk} onClose={() => setConnectorAsk(null)} onChanged={connectorChanged} />

      {/* The rule drawer (#36), from the Rules screen or a transaction. */}
      <RuleSheet rules={rules} taxonomy={categories.taxonomy} tags={tagList.tags} accounts={ruleAccounts} onChanged={() => loadTransactions()} />

      <Sheet
        open={!!redirect}
        title={shownRedirect ? `${shownRedirect.name} is already connected` : 'Already connected'}
        onClose={() => setRedirect(null)}
      >
        {shownRedirect && (
          <RedirectChoices
            name={shownRedirect.name}
            items={shownRedirect.items}
            kind={shownRedirect.kind}
            connecting={connecting}
            onAdd={(item_id) => {
              setRedirect(null);
              startManageAccounts(item_id);
            }}
            onConnectAgain={() => {
              setRedirect(null);
              beginConnect(shownRedirect.kind, true);
            }}
          />
        )}
      </Sheet>

      {lifecycle.sheet}

      {/* Everything about a connection, from its ⋯. What it asks of the
          connector closes it first, so no drawer opens on top of another. */}
      <ConnectionDetails
        open={!!detailsFor}
        inst={institutions.find((i) => i.item_id === shownDetailsFor) ?? null}
        place={(shownDetailsFor && places.get(shownDetailsFor)) || null}
        requests={connectors.data?.requests ?? null}
        fx={base?.fx ?? null}
        onClose={() => setDetailsFor(null)}
        onConnector={setConnectorAsk}
      />

      <Sheet
        open={!!disconnectTarget}
        title={
          shownDisconnectTarget
            ? endedOffer === shownDisconnectTarget.item_id
              ? 'Remove this connection?'
              : `Disconnect ${shownDisconnectTarget.institution_name}?`
            : 'Disconnect'
        }
        onClose={() => !disconnecting && setDisconnectTarget(null)}
      >
        {shownDisconnectTarget && (
          <>
            {/* Every account of it ended (#50): the connection still syncs
                nothing of use, and Plaid bills it until it is removed. */}
            {endedOffer === shownDisconnectTarget.item_id && (
              <p className="panel-note" style={{ marginTop: 0 }}>
                Every account at {shownDisconnectTarget.institution_name} has ended, but the connection is still
                open, and Plaid charges for it until it is removed. Their history, and when each ended, are kept.
              </p>
            )}
            <p className="panel-note" style={endedOffer === shownDisconnectTarget.item_id ? undefined : { marginTop: 0 }}>
              This removes {shownDisconnectTarget.institution_name} and its accounts from Nya, and ends the
              connection at Plaid. You can reconnect it later. Type{' '}
              <strong>{shownDisconnectTarget.institution_name}</strong> below to confirm.
            </p>
            {/* What adding it back doesn't bring back (#39). */}
            <DisconnectSplitsNote itemId={shownDisconnectTarget.item_id} />
            {/* Disconnecting is about the connection; closing is about an
                account (#50). Only the person knows which happened. */}
            {endedOffer !== shownDisconnectTarget.item_id && (
              <p className="panel-note">
                Disconnecting doesn&apos;t say an account closed. If one did, mark it instead (open the account, then Close…): it then stops counting from that day, and the chart marks it.
              </p>
            )}
            {/* What Plaid itself keeps is beyond a disconnect's reach (the
                deletion receipt says the same, lib/deletion-receipt.ts): say
                where people can see and delete it. */}
            <p className="panel-note">
              Plaid keeps its own records of what it collected, under its own privacy policy. See and delete
              them at the{' '}
              <a href={PLAID_PORTAL} target="_blank" rel="noreferrer">
                Plaid Portal
              </a>
              .
            </p>
            <label className="field" style={{ marginTop: 12 }}>
              Institution name
              <input
                value={disconnectInput}
                onChange={(e) => setDisconnectInput(e.target.value)}
                placeholder={shownDisconnectTarget.institution_name}
                disabled={disconnecting}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            <div className="button-pair" style={{ marginTop: 16 }}>
              <button className="secondary" onClick={() => setDisconnectTarget(null)} disabled={disconnecting}>
                Cancel
              </button>
              <button
                className="danger"
                disabled={
                  disconnecting ||
                  disconnectInput.trim().toLowerCase() !== shownDisconnectTarget.institution_name.trim().toLowerCase()
                }
                onClick={() => performDisconnect(shownDisconnectTarget.item_id)}
              >
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
          </>
        )}
      </Sheet>
    </>
  );
}
