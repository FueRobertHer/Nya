'use client';

// The Plan tab: financial independence, and how a retirement plan would have
// lasted. Loaded on demand (components/PlanTabLoader.tsx), since it carries
// the engine the other tabs never need; the simulations themselves run in a
// Web Worker (components/plan-runner.ts) with the market history, so the
// page stays responsive while 5,000 runs or the grid are worked out.
//
// What it shows, top to bottom (rollout phase 6b,
// docs/design/information-architecture.md#plan): what is about the whole
// plan (its load error, a save's error, a repair waiting, its currency), then
// a pinned bar (components/PlanBar.tsx) naming the plan shown, your plan or
// the copy open, over three segments, and with a copy open its card under
// the bar, above every segment. All three segments stay mounted, the
// others hidden, and the bar is drawn before the plan has loaded, so Home's
// FI line has its heading to land on. It opens on Your path, or on Drawdown
// once the stop age has come (D2 of the tax plan), decided once the plan has
// loaded, with none selected until then:
//   - Your path: the FI view (lib/fire/plan.ts fiView): the FI card, with
//     the FI number, years to FI, Coast and Barista FI, and on the number
//     what may leave it short; then the figures it rests on (rollout phase
//     6c), each a row that opens its sheet, saying where it came from
//     (measured by Nya, typed by you, or missing) and, under it, what may be
//     missing from it: an institution whose transactions couldn't be read,
//     balances that are old or short (components/plan-figure-notes.ts). How
//     a measured figure was worked out is behind Why? in its sheet. A figure
//     that may be short says so; none is presented as complete when it may
//     not be. Then the Timeline (components/PlanTimeline.tsx): everything
//     the plan holds, on the points in time that place it.
//   - Drawdown (Stress test until T1 of the tax plan): one notice when the
//     spending or invested assets the simulation uses may be low, then "Will it last?": the plan run through
//     history or Monte Carlo (lib/fire/simulate.ts), with the success rate
//     and its definition, for a flexible rule the spending cuts beside it, a
//     fan chart, the worst starting years, and every assumption listed under
//     it; the success grid by withdrawal rate and length; and what the
//     numbers can't say.
//   - Portfolio: Allocation (components/AllocationCard.tsx): what the
//     investment accounts hold by asset class and tax bucket, against a
//     target, over time, and the mix the simulation can take from it, on the
//     person's word.
//
// Your plan goes to the server (/api/fire-plan), saved whole on each change
// through lib/whole-list-store.ts, which never lets an unloaded plan be
// saved over the real one, each save naming the version it was made from.
// It loads, with the workplace plans' contributions, through the copy of the
// Plan's inputs the tab shares with Home's FI line
// (lib/plan-inputs-store.ts): always asked for here, and every save's answer
// goes into the copy, so Home shows it.
//
// COPIES (the tax plan's C2, lib/plan-copies.ts, components/PlansSheet.tsx):
// every plan is whole, yours and its copies, listed, made, renamed, deleted,
// made yours and compared in the Plans sheet, which the bar opens, and the
// open copy's card too (components/plan-list.ts holds them). Opening one
// shows the whole tab as that copy, every card saying so, with your plan's
// facts (your age, how figures are measured, the method) in it, and every
// save the tab makes goes through components/plan-savers.ts: to the copy,
// whole, and to the plans checked in Also change it in with it, never to
// your plan unasked. The repair and the allocation settings are your plan's
// own, so a copy has no saver for them.

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Txn } from './MonthBreakdown';
import { Sheet, focusInsteadOf } from './Sheet';
import PlanFanChart from './PlanFanChart';
import PlanGrid, { type FailedCell } from './PlanGrid';
import { AboutForm, AssumptionsForm, FiNumberForm, FigureForm, type AssumptionsAt, type DetailForm, type FigureKind } from './PlanForms';
import { Why } from './Why';
import { createPlanRunner, type PlanRunner, type WorkerLike } from './plan-runner';
import { planSearch } from './plan-search';
import { createDetailedFigures, detailedInput, measuredYield, pageBuckets, type DetailedAnswer } from './plan-detailed';
import { DEFAULT_TAX_CHOICES } from '@/lib/fire/tax-choices';
import {
  DATA_BONDS,
  DATA_STOCKS,
  HYPOTHETICAL,
  HYPOTHETICAL_LABEL,
  METHOD_NAMES,
  monthName,
  pct,
  saidAbove,
  saidRate,
  progressText,
  successDefinition,
  successText,
  wholeMoney,
  yearsText,
  askAgesText,
  coastNeed,
  figuresNeed,
  projectionNeed,
  SPENDING_NEED,
  fiHeadline,
  walkWords,
  EVENTS_WORDS,
} from './plan-text';
import { childMovedText, fiMovedText, stillNew } from './plan-moved';
import { Hero } from './Hero';
import { createWholeListStore, initialListState, type ListState, type ListStatus } from '@/lib/whole-list-store';
import { NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';
import { leftOutOf } from '@/lib/fire/child-accounts';
import { bucketsToday, type AccountYear } from '@/lib/fire/buckets-today';
import { savingsSplit } from '@/lib/fire/savings-split';
import { mixShares, mixToday, projectMix } from '@/lib/fire/tax/mix';
import { balanceShares, mixLine } from './plan-buckets';
import type { BucketSheet, FigureLevel } from './PlanBuckets';
import { fmtAsOf } from './accounts-format';
import { EMPTY_SETTINGS, overridesOf, withBucket } from '@/lib/allocation/settings';
import { investedAssets, type AssetInstitution, type InvestedAssets, type TrailingFlows, type UnreadTransactions, type WorkplaceSavings } from '@/lib/fire/inputs';
import { fiFigures, measuredInputs, notMeasuredWhat, notWorkedOutText, unmeasuredNeed, type ShareRates } from '@/lib/fire/progress';
import { historyCount } from '@/lib/spending';
import { figureNotes, inputFlags, names, stressNotice, windowText, type FigureArgs, type FigureNote, type FigureNotes, type FigureText } from './plan-figure-notes';
import TotalCaveats, { Notice } from './TotalCaveats';
import { chevron, RIGHT } from './ActivityBar';
import { planAccountsOf, planId, plansAskedFor, saveTaxFact, usePlanInputs, useSharedPlanInputs, workplacePlansOf, yearFrom } from './plan-inputs';
import { createPlanInputsStore, type PlanInputsStore } from '@/lib/plan-inputs-store';
import AllocationCard, { mixToOffer, useAllocation } from './AllocationCard';
import type { AllocHolding, PlanMix } from '@/lib/allocation/allocation';
import {
  DEFAULT_PLAN,
  formulasTake,
  stopOf,
  type EnginePlan,
  type FirePlan,
  type FiView,
  type Measured,
  type Missing,
  type PlanCore,
  type Repair,
} from '@/lib/fire/plan';
import { basePlanOf, DEFAULT_PLAN_V2, isStoredPlan, NEW_PLAN_START, parsePlanV2, planOf, type FirePlanV2, type StoredPlan } from '@/lib/fire/plan-v2';
import { MAX_FIRE_PLANS, entryHoldsAmounts, factsOf, withFacts, type Facts } from '@/lib/fire/copies';
import type { TaxChoices } from '@/lib/fire/tax-choices';
import { withItem, type PlanItem } from '@/lib/fire/items';
import type { Count, ItemAges, ItemNote } from '@/lib/fire/compile';
import type { GridCell, SimResult } from '@/lib/fire/simulate';
import { canRunOut } from '@/lib/fire/rules';
import type { PlanJob } from '@/lib/fire/jobs';
import { Masked } from './HideAmounts';
import { CopyCard, JOB_FAILED_TEXT, PlansSheet, REFUSED_TEXT, rememberResult, type PlanOutcome, type SheetPlan } from './PlansSheet';
import PlanBar, { openingSegment, planPanelId, planTabId, type PlanSegment } from './PlanBar';
import { PlanPanelSkeleton } from './LoadingSkeletons';
import PlanProgress, { progressOverlay, useProgress, type ProgressOverlay } from './PlanProgress';
import { CopyTag } from './CopyTag';
import { TimelineCard } from './PlanTimeline';
import { itemRuleText, itemSentence, reachesStart } from './plan-items';
import { copiesOf, createPlansClient, INITIAL_PLANS, plansCount, type PlanRow, type PlanSave, type PlansState } from './plan-list';
import { planSavers, type Save, type SaveMore } from './plan-savers';
import { DEFAULT_INFLATION } from '@/lib/fire/saved-plan';
import { copyDiffParts, figureChoices, itemChoices, sameChange, type AlsoTarget } from './plan-diff';
import { currencyText, laterText, numberSpending, retirementText, shortText, startLineText, startsWithText } from './plan-scenario-text';
import { DrawdownCard, drawdownMarks, DrawdownMore, StageLevel, YearLevel } from './PlanDrawdown';
import type { DrawdownMark } from './DrawdownChart';
import PlanHealthForm, { type PaidChoice } from './PlanHealthForm';
import { OptInRow, OptInSheet, OPT_IN_TITLE } from './PlanOptIn';
import { CompareCard, ConversionsForm, HowYouDrawCard, OrderForm, RuleLevel } from './PlanHowYouDraw';
import { TuneForm } from './PlanTune';
import { TUNE_TITLE } from './plan-tune';
import { PlanTaxSheet } from './PlanTaxSheet';
import { choicesDiffParts, copyNameFor, ruleTitle } from './plan-conversions';
import { ABOUT_DETAIL, WITH_EACH_YEARS_TAX, gridSampleLine, assumptionsLine, assumptionsWorked, HEALTH_NOT_SET, healthSub, honestyNotes, householdLine, hypotheticalDrawdown, namesCoverage, stageHealthLines, stageTitle, STATE_NAMES, taxHypothetical, yearTitle, type YearContext } from './plan-drawdown';
import { planFigures, resolveSaved, type FiguresRefused, type PlanFigures, type StartsWith } from '@/lib/fire/plan-figures';
import { compareRows, conversionRun, type CompareRow } from '@/lib/fire/compare-conversions';
import type { TunedRow } from '@/lib/fire/tune';
import { defaultUntil as untilByDefault, type Strategy } from '@/lib/fire/tax/rules';
import { lawFor } from '@/lib/fire/tax/law';
import { householdOf, type TaxFactOp } from '@/lib/fire/tax-facts';
import { planPath, type PathRange, type PlanPath } from '@/lib/fire/path';
import PlanPathChart, { wholeShown } from './PlanPathChart';
import { hasWalk, type Shortfall } from '@/lib/fire/events';
import {
  NO_ANSWER,
  askText,
  candidates,
  firstText,
  hasTypedAmounts,
  keptText,
  planCurrencyState,
  relabelOffer,
  readCurrencyAnswer,
  shownFrom,
  shownReliably,
  typedAmounts,
  WAITING_TEXT,
  type CurrencyAnswer,
} from '@/lib/fire/plan-currency';
import { recordPlanCurrency } from './plan-currency-client';
import { CurrencyChangeSheet, PlanCurrencyCard, currencyQuiet, type CurrencyCardMode } from './PlanCurrency';
import { plainNumber } from '@/lib/format';
import type { FxTable } from '@/lib/fx/rates';
import type { PageFx } from '@/lib/fx/view';

/** The grid's rows and columns; the plan's own rate and length are added. */
const GRID_RATES = [0.03, 0.035, 0.04, 0.045, 0.05];
const GRID_YEARS = [20, 30, 40, 50];
/** The plan's own rate joins the grid's rows up to this; a start balance far
 *  below the spending implies a rate no row would help to show. */
const GRID_MAX_OWN_RATE = 0.2;

function withOwn(values: number[], own: number): number[] {
  return values.some((v) => Math.abs(v - own) < 1e-9) ? values : [...values, own].sort((a, b) => a - b);
}

/** The value, or the last one that wasn't null: what a closing drawer keeps
 *  showing while it slides out (as in Dashboard.tsx). */
/** The same place the walk stops, said once: under the answer. */
const sameShort = (a: Shortfall, b: Shortfall | null) => b !== null && a.year === b.year && a.kind === b.kind && a.have === b.have && a.need === b.need;

function useLast<T>(value: T | null): T | null {
  const last = useRef<T | null>(value);
  if (value !== null) last.current = value;
  return last.current;
}

/** A copy as the tab shows it: with your plan's facts in it, repaired where
 *  a value no longer fits them (and what had to change), the currency its
 *  amounts were typed in when it isn't your plan's now, and its figures
 *  (none then). */
type PlanView = { row: PlanRow; plan: FirePlanV2; fixed: Repair[]; other: string | null; figures: PlanFigures | FiguresRefused | null; working: boolean; failed: boolean };

/** Said for a save with nowhere to record its amounts' currency. */
/** The answer above the grid, as its own cell. */
const answerCell = (r: SimResult, rate: number | null): GridCell => ({
  rate,
  years: r.years,
  successRate: r.successRate,
  lowestSpendingShare: r.lowestSpending && r.firstYearSpending > 0 ? r.lowestSpending.amount / r.firstYearSpending : null,
  paths: r.paths,
  firstStart: r.firstStart,
  lastStart: r.lastStart,
});

/** Your age, and a stop age or stopping at FI: what a detailed plan's years need. */
const bothAges = (p: FirePlanV2) => p.age !== null && (p.stopAtFi || stopOf(p) !== null);

/** A plan never saved: it starts from what it would have then. */
const NEW_PLAN: FirePlanV2 = { ...DEFAULT_PLAN_V2, start: NEW_PLAN_START };

const NO_COPY_CURRENCY = 'Your plan has no currency yet, so this copy can’t hold amounts: say which currency your plan’s figures are in first (above), then save again.';

/** A save's answer as a button on a card shows it: done, or why not. */
const said = (r: boolean | string): true | string => (r === true ? true : r === false ? 'It wasn’t saved. Try again in a moment.' : r);

const NO_TAGS: readonly { id: string; name: string }[] = [];

export type SheetState =
  | { kind: 'about' }
  | { kind: 'figure'; figure: FigureKind }
  // Every rate and setting, in one sheet (rollout 6d), opened at the stress
  // test's part or its mix; `mix` is the allocation's, filled in, as it was
  // when "Use my allocation in the plan" was pressed.
  | { kind: 'assumptions'; at?: AssumptionsAt; mix?: PlanMix & { ok: true } }
  | { kind: 'numbers' }
  | { kind: 'fi-number' }
  // Work out tax from your accounts, and a stage of Year by year, with its
  // years as a level (drawn over it, as a figure's accounts are).
  | { kind: 'opt-in' }
  | { kind: 'stage'; at: number }
  | { kind: 'health' }
  // Tax after you stop; How you draw's two; a rule of Compare conversions.
  | { kind: 'tax' }
  | { kind: 'order' }
  | { kind: 'conversions' }
  | { kind: 'rule'; key: string }
  // Tune to a goal, from Compare conversions.
  | { kind: 'tune' };

const SHEET_TITLES: Record<SheetState['kind'], string> = {
  about: 'Household',
  figure: '',
  assumptions: 'Assumptions',
  numbers: 'About these numbers',
  'fi-number': 'FI number',
  'opt-in': OPT_IN_TITLE,
  stage: '',
  health: 'Health coverage',
  tax: 'Tax after you stop',
  order: 'Order',
  conversions: 'Roth conversions',
  rule: '',
  tune: TUNE_TITLE,
};

const FIGURE_TITLES: Record<FigureKind, string> = {
  spending: 'Annual spending',
  savings: 'Annual savings',
  assets: 'Invested assets',
};

/** The simulation's answer: its result, or why there is none. `unavailable`
 *  means it couldn't be run at all (its code failed to load), not that the
 *  plan was refused. */
export type Outcome = { result: SimResult } | { error: string; unavailable?: boolean };

// The words about the inputs moved to components/plan-figure-notes.ts in 6c;
// said from here too, where they were.
export { assetCaveatLines, unreadText, windowText } from './plan-figure-notes';

export type PlanTabProps = {
  /** The dashboard's transactions, null until they load. */
  txns: Txn[] | null;
  txnsLoading: boolean;
  /** /api/transactions' notes that say transactions couldn't all be read
   *  (lib/fire/inputs.ts unreadNotesOf: "Chase: needs to be reconnected"), or
   *  that the whole load failed; never one that says how a rule, a category,
   *  a split or a group applies. */
  txnNotes: string[];
  /** The connections that bring in no transactions (lib/no-transactions.ts):
   *  when none can bring in spending, the figures say so rather than waiting
   *  for transactions that won't come; a bank account Plaid doesn't provide
   *  them for keeps "this figure may be low". */
  txnWithout?: NoTransactionsView;
  /** Every institution as the dashboard last loaded it, hidden accounts
   *  included (they are left out here), with its errors and stale state. */
  institutions: AssetInstitution[];
  /** When those balances were loaded: old when the dashboard is showing its
   *  saved copy (offline, or before it refreshes). */
  balancesAsOf: string | null;
  /** The balances are that saved copy: nothing is recorded from them. */
  balancesSaved?: boolean;
  /** The dashboard's last load of the balances failed. */
  balancesFailed?: boolean;
  /** The accounts' main currency, for amounts nothing else labels. */
  currency: string | null;
  /** Every position the dashboard loaded, each with its account (hidden
   *  accounts' included: the allocation leaves those out itself). */
  holdings: AllocHolding[];
  /** With a home currency: what the transactions convert with
   *  (/api/transactions `fx`) and what balances do (/api/net-worth
   *  base.fx), into the Plan's currency (lib/fire/inputs.ts). */
  txnFx?: FxTable | null;
  balanceFx?: PageFx | null;
  /** The segment shown, kept by the dashboard so the tab comes back on it;
   *  null until one is shown, and left out, the tab keeps its own. */
  segment?: PlanSegment | null;
  onSegment?: (s: PlanSegment) => void;
  /** Your path's chart's range, kept by the dashboard so it comes back on
   *  it; left out, the tab keeps its own. Both open on Whole path. */
  range?: PathRange;
  onRange?: (r: PathRange) => void;
  /** When Home's FI line opened the tab (Date.now()): the bar's heading takes
   *  focus once, if that was under ten seconds ago. */
  landing?: number | null;
  /** Said once the heading has it, so the dashboard forgets the landing. */
  onLanded?: () => void;
  /** The copy of the Plan's inputs the tab shares with Home's FI line
   *  (components/Dashboard.tsx); left out, the tab keeps its own. */
  planInputs?: PlanInputsStore;
  /** D15's switch (the flag 'plan-items-in-fi'): the plan's one-offs and
   *  income count in the walk to its FI date. */
  planInWalk?: boolean;
  /** The last day D15's change is new (lib/flag-read.ts newUntil), as
   *  YYYY-MM-DD: until then Your path and Progress say what it moved. */
  newUntil?: string | null;
  /** Got it was tapped on that line this session (kept by the dashboard, so
   *  it stays hidden across tabs), and tapping it. */
  movedSeen?: boolean;
  onMovedSeen?: () => void;
  /** D7's switch (the flag 'plan-child-accounts'): accounts for a child's
   *  education are out of invested assets unless counted. */
  childOut?: boolean;
  /** The last day D7's change is new, and its own Got it, as D15's above. */
  childNewUntil?: string | null;
  childMovedSeen?: boolean;
  onChildMovedSeen?: () => void;
  /** Your tags, for what already pays for coverage (a tag is held by its id). */
  tags?: readonly { id: string; name: string }[];
};

/** Said by New copy, Duplicate and a rename of your plan while your plan
 *  is read again after a write: what is held is from before it. */
const READING_AGAIN = 'Still loading your plan after the last change. Try again in a moment.';

export default function PlanTab({
  txns,
  txnsLoading,
  txnNotes,
  txnWithout = NO_CONNECTIONS_WITHOUT,
  institutions,
  balancesAsOf,
  currency,
  holdings,
  txnFx = null,
  balanceFx = null,
  balancesSaved = false,
  balancesFailed = false,
  segment: segmentShown,
  onSegment,
  range: rangeShown,
  onRange,
  landing = null,
  onLanded,
  planInputs: sharedInputs,
  planInWalk = false,
  newUntil = null,
  movedSeen = false,
  onMovedSeen,
  childOut = false,
  childNewUntil = null,
  childMovedSeen = false,
  onChildMovedSeen,
  tags = NO_TAGS,
}: PlanTabProps) {
  const count: Count = useMemo(() => ({ planInWalk }), [planInWalk]);
  const [state, setState] = useState<ListState<StoredPlan | null>>(initialListState<StoredPlan | null>(null));
  // The plan as the server last confirmed it, and the currency its typed
  // figures are in as the route answered with it (lib/fire/plan-currency.ts):
  // never the plan a save has yet to write, which the store shows at once.
  // And the currency each save sends (set below, once the tab knows it).
  const [confirmed, setConfirmed] = useState<{ plan: StoredPlan | null; answer: CurrencyAnswer; id: string | null }>({ plan: null, answer: NO_ANSWER, id: null });
  const sendCurrency = useRef<string | null>(null);
  // The facts of the plan this page holds (lib/fire/copies.ts), which each
  // save sends as `facts_were`, so a save writes only the facts the person
  // changed over what every plan shares (lib/plan-writes.ts): taken from a
  // load's answer (the defaults' before your plan is first saved), and from
  // the plan a save sent once it is saved, never from a save's answer,
  // since the store keeps the plan it sent and an age another device saved
  // since isn't on the page. And your plan's version, from every answer,
  // which each save names (`based_on`, null before your plan is first
  // saved), so one made from a version changed since is refused.
  const factsWere = useRef<Facts>(factsOf(DEFAULT_PLAN));
  const stampRef = useRef<string | null>(null);
  const answeringSave = useRef(false);
  // What the one save under way says beside the plan (a detailed plan's choices, the
  // household), so every other save stays what a release before takes.
  const sendMore = useRef<Record<string, unknown> | null>(null);
  // Your plans (components/plan-list.ts): yours and its copies, for the
  // Plans sheet, Also change it in and the copy open. Made before the store,
  // whose answers its row of your plan takes.
  const [plansState, setPlansState] = useState<PlansState>(INITIAL_PLANS);
  const plansClient = useMemo(() => createPlansClient(setPlansState), []);
  useEffect(() => {
    void plansClient.load();
  }, [plansClient]);
  // The plan loads through the shared copy, for the workplace plans shown
  // now; the store below is made once, so both are read through refs.
  const planInputs = useMemo(() => sharedInputs ?? createPlanInputsStore(), [sharedInputs]);
  const inputsRef = useRef(planInputs);
  inputsRef.current = planInputs;
  const plansRef = useRef<string[]>([]);
  plansRef.current = plansAskedFor(institutions, childOut).map(planId);
  const store = useMemo(
    () =>
      createWholeListStore<StoredPlan | null>({
        url: '/api/fire-plan',
        field: 'plan',
        noun: 'plan assumptions',
        empty: null,
        isValid: (v): v is StoredPlan | null => v === null || isStoredPlan(v),
        onChange: setState,
        reloadHint: 'use Try again below',
        // A save refused for what is stored now (its currency changed on
        // another device, say) says why.
        showRefusal: true,
        extra: () => ({ currency: sendCurrency.current, facts_were: factsWere.current, based_on: stampRef.current, ...sendMore.current }),
        onAnswer: (data) => {
          const plan = isStoredPlan(data.plan) ? data.plan : null;
          stampRef.current = typeof data.updated_at === 'string' ? data.updated_at : null;
          if (answeringSave.current) answeringSave.current = false;
          else factsWere.current = factsOf(plan ?? DEFAULT_PLAN);
          setConfirmed({ plan, answer: readCurrencyAnswer(data), id: typeof data.id === 'string' ? data.id : null });
          // Your plan's row in the Plans sheet takes it (or the list is read
          // again, when another plan is yours now).
          plansClient.adoptMain(data);
        },
        // Always asked for: nothing refuses a save made from a plan another
        // device changed since, so the tab never edits from a kept copy.
        read: () => inputsRef.current.load(plansRef.current, { force: true }),
        // A save's request holds the copy's loads until it has answered, and
        // its answer goes into the copy (Home's line shows it).
        saveHooks: (() => {
          let end: (() => void) | null = null;
          let copy: PlanInputsStore | null = null;
          return {
            started: () => {
              copy = inputsRef.current;
              end = copy.beginSave();
            },
            ended: (answer: Record<string, unknown> | null) => {
              // A save's answer, which onAnswer is handed next.
              if (answer) answeringSave.current = true;
              if (answer) copy?.adopt(answer);
              end?.();
              end = copy = null;
            },
          };
        })(),
      }),
    []
  );
  useEffect(() => {
    void store.load();
  }, [store]);

  // A saved plan this release can't take as it is (a range narrowed since it
  // was saved, say): the tab works from a repaired copy, says what changed,
  // and offers to save it; saving any change saves it too. Nothing here ever
  // computes with a value outside what the formulas take.
  // A version 1 plan is repaired by today's repair and held as version 2
  // (lib/fire/plan-v2.ts basePlanOf), which each save sends.
  const stored: StoredPlan = state.value ?? NEW_PLAN;
  const repair = useMemo(() => basePlanOf(stored), [stored]);
  /** The Plan as the tab shows it: the repaired one while a repair waits. */
  const basePlan = repair.plan;
  // While a repair waits, nothing but "Save it this way" saves: a save from
  // anywhere else would commit it unseen, dropping what it leaves out.
  const repairing = repair.fixed.length > 0;

  // The segment shown: the one chosen, or kept by the dashboard; else where
  // the Plan opens (components/PlanBar.tsx openingSegment), decided once the
  // saved plan has loaded and never again while the tab is open, so a stop
  // age changed on Your path doesn't move the screen. Until then none is
  // selected, so nothing jumps under the person as the plan arrives; after a
  // failed load, Your path, over the defaults, until Try again loads it.
  const [ownSegment, setOwnSegment] = useState<PlanSegment | null>(null);
  const chosen = segmentShown !== undefined ? segmentShown : ownSegment;
  const chooseSegment = onSegment ?? setOwnSegment;
  const [firstSegment, setFirstSegment] = useState<PlanSegment | null>(null);
  if (firstSegment === null && chosen === null && state.status === 'ready') setFirstSegment(openingSegment(basePlan));
  const segment = chosen ?? firstSegment ?? (state.status === 'error' ? 'path' : null);
  // Handed on, so the tab comes back on it while the app is open, as it does
  // on a segment chosen.
  useEffect(() => {
    if (chosen === null && firstSegment !== null) chooseSegment(firstSegment);
  }, [chosen, firstSegment, chooseSegment]);
  // Your path's range: to the stop, or the whole path (opening on it, D13).
  const [ownRange, setOwnRange] = useState<PathRange>('whole');
  const range = rangeShown ?? ownRange;
  const chooseRange = onRange ?? setOwnRange;

  // The copy open, if any. None opens before your plan has loaded, or while
  // a repair of it waits (one open closes): a copy is shown with your plan's
  // facts in it. One deleted, or made your plan, closes.
  const [openId, setOpenId] = useState<string | null>(null);
  // Your plan read again after a write changed it (a rename, an Also save
  // with it checked): what it held stays loaded until the answer is in, so
  // the copy open, its card, a drawer and the sheet's plans stay as they
  // are (editing still waits, editableNow, and so does anything made from
  // it or naming its version: READING_AGAIN). Not after a failed load, nor
  // once the list names another plan yours (Make this your plan): what is
  // held is then no longer your plan.
  const [settled, setSettled] = useState<ListStatus | null>(null);
  if (state.status !== 'loading' && state.status !== settled) setSettled(state.status);
  const planLoaded = state.status === 'ready' || (state.status === 'loading' && settled === 'ready' && confirmed.id === plansState.main);
  const canOpen = planLoaded && !repairing;
  const entry = openId !== null && canOpen ? (plansState.list.find((r) => r.id === openId && r.id !== plansState.main && r.plan !== null) ?? null) : null;
  useEffect(() => {
    if (openId === null) return;
    if ((planLoaded && repairing) || (plansState.status === 'ready' && (openId === plansState.main || !plansState.list.some((r) => r.id === openId)))) setOpenId(null);
  }, [openId, planLoaded, repairing, plansState]);
  // Another plan made yours on another device, seen as the list loads: your
  // plan is read again, once for each.
  const mainSeen = useRef<string | null>(null);
  useEffect(() => {
    if (plansState.status !== 'ready' || !planLoaded || confirmed.id === null || plansState.main === confirmed.id || mainSeen.current === plansState.main) return;
    mainSeen.current = plansState.main;
    void store.load();
  }, [plansState.status, plansState.main, planLoaded, confirmed.id, store]);
  // And once the currency the plan's figures are in is known (below).
  const editableNow = state.status === 'ready' && !state.saving && !repairing && !plansState.saving;

  // Before a plan's first typed amount: the currency the person said they'll
  // type it in, when the accounts can't tell it (lib/fire/plan-currency.ts).
  const [picked, setPicked] = useState<string | null>(null);
  // The currency everything measured is in: the plan's own once recorded,
  // the one picked before its first amount, else the accounts' (null).
  const ownCurrency = confirmed.answer.currency ?? (planLoaded && (!confirmed.plan || !hasTypedAmounts(confirmed.plan)) ? picked : null);

  // What Nya measures, and what may be missing from it, by the same hook and
  // arithmetic as the FI card on Home (components/plan-inputs.ts,
  // lib/fire/progress.ts), so the two always agree. The hook also reads which
  // manual accounts are cash on hand, whose spending entered by hand is what
  // cash withdrawals went on (lib/fire/inputs.ts trailingFlows), and names
  // them for the label. The workplace plans' contributions come from the
  // shared copy.
  const shared = useSharedPlanInputs(planInputs, institutions, childOut);
  const leaveOut = useMemo(() => leftOutOf(childOut, shared.taxFacts.countAnyway), [childOut, shared.taxFacts.countAnyway]);
  // The detailed tax model (lib/fire/plan-detail.ts): said on, and allowed now.
  const detailedOn = shared.factsKnown && shared.taxFacts.model === 'detailed';
  // The opt-in is open: what it would come to is shown before anything is saved.
  const [optInOpen, setOptInOpen] = useState(false);
  const inputs = usePlanInputs({
    txns,
    txnNotes,
    without: txnWithout,
    institutions,
    includeCash: basePlan.includeCash,
    planFunding: basePlan.planFunding,
    fx: txnFx,
    balanceFx,
    currency: ownCurrency,
    contributions: shared.contributions,
    childContributions: shared.childContributions,
    leaveOut,
    paid: detailedOn || optInOpen ? shared.taxFacts.paidToday : null,
  });
  const { flows, unread, assets, contributions, workplace, child, cashOn, cashUnmarked } = inputs;
  const figures = fiFigures(basePlan, inputs, currency);
  // The plan's own currency once recorded, which everything above is in;
  // otherwise the accounts' (figures.currency), and with typed amounts and no
  // record, not known until the tab can tell it reliably or the person says
  // (lib/fire/plan-currency.ts).
  const txnsFailed = txns === null && !txnsLoading && txnNotes.length > 0;
  const currencyAnswer = confirmed.answer;
  const currencyState = planCurrencyState(planLoaded ? confirmed.plan : null, currencyAnswer, figures.currency);
  const reliably = shownReliably(figures.currency, inputs, { balancesAsOf, balancesSaved, balancesFailed, institutions: institutions.length, txnsLoading, txnsFailed, unread: unread.length });
  const currencyKnown = currencyState.kind !== 'unknown';
  const home = balanceFx?.home ?? txnFx?.home ?? null;
  const from = shownFrom(figures.currency, inputs);
  // A currency being recorded, by the tab or on the person's word: nothing
  // else about the currency starts meanwhile.
  const [recordingNow, setRecordingNow] = useState(false);
  const currencyBusy = state.saving || recordingNow;
  // A save records the plan's currency with it: the recorded one; for a plan
  // with nothing typed yet, the one the person picked, else the accounts'
  // when that can be told reliably; else none, and a save that would give
  // the plan its first amount waits until the person says (savePlanIn).
  sendCurrency.current =
    currencyState.kind === 'recorded' ? currencyState.currency : currencyState.kind === 'follows' ? (picked ?? (reliably.ok ? figures.currency : null)) : null;
  const editable = editableNow && currencyKnown;
  const regionRef = useRef<HTMLDivElement | null>(null);
  // Whether the currency's card or line is where it can take focus: quiet, it
  // is at the foot of Your figures, in Your path's panel, hidden on the other
  // segments. Set as the tab is drawn (below).
  const regionShown = useRef(true);
  const currencyHadFocus = useRef(false);
  // Bumped by an answer the person gave on the card: focus then goes to the
  // card, or the line it became, once it is drawn (an effect below), since
  // the answer can move it to the other place.
  const [focusCurrency, setFocusCurrency] = useState(0);
  // The change drawer, the tab's (components/PlanCurrency.tsx): the currency
  // chosen in it, null before one is; shut without it.
  const [changing, setChanging] = useState<{ to: string | null } | null>(null);
  const [currencySaid, setCurrencySaid] = useState('');
  // The currency before the person changed it, offered back for a while.
  const [previous, setPrevious] = useState<string | null>(null);
  /** Records the currency for the plan the server last confirmed; true, or
   *  why not. `byPerson`: the person's own answer, which alone may replace a
   *  record there. */
  const recordCurrency = async (c: string, byPerson: boolean): Promise<true | string> => {
    const stored = confirmed.plan;
    if (!stored || !planLoaded) return 'Your plan hasn’t loaded yet.';
    if (currencyBusy) return 'Still saving the last change. Try again in a moment.';
    const before = currencyState.kind === 'recorded' ? currencyState.currency : null;
    setRecordingNow(true);
    // As a save: the copy's loads wait for it, and take its answer.
    const copy = planInputs;
    const end = copy.beginSave();
    const r = await recordPlanCurrency(c, typedAmounts(stored), byPerson);
    if (r.ok && r.body) {
      copy.adopt(r.body);
      // Recording it gives your plan a new version, which the next save names.
      if (typeof r.body.updated_at === 'string') stampRef.current = r.body.updated_at;
      plansClient.adoptMain(r.body);
    }
    end();
    setRecordingNow(false);
    if (r.ok) {
      setConfirmed((was) => ({ plan: r.plan ?? stored, answer: r.answer, id: was.id }));
      setPrevious(byPerson && before && before !== c ? before : null);
      setCurrencySaid(`Your plan’s figures are recorded as ${c}.`);
      return true;
    }
    // Changed elsewhere: the plan as it is now (after any save under way,
    // lib/whole-list-store.ts load), and the question asked of it.
    if (r.stale) void store.load();
    return r.error;
  };
  // A plan saved before the currency was recorded (no record at all), shown
  // in one that can be told reliably: that is the one its figures were typed
  // in, recorded once, and only while no save or answer is under way. If it
  // fails, the tab asks instead, and doesn't try again for that plan.
  const autoCurrency = currencyState.kind === 'unknown' && reliably.ok && !currencyBusy && confirmed.plan ? currencyState.shown : null;
  const autoKey = autoCurrency && confirmed.plan ? `${autoCurrency}:${JSON.stringify(typedAmounts(confirmed.plan))}` : null;
  const triedFor = useRef<string | null>(null);
  const [autoFailed, setAutoFailed] = useState<{ for: string; error: string } | null>(null);
  useEffect(() => {
    if (!autoKey || !autoCurrency || triedFor.current === autoKey) return;
    triedFor.current = autoKey;
    void recordCurrency(autoCurrency, false).then((r) => {
      if (r !== true) setAutoFailed({ for: autoKey, error: r });
    });
    // recordCurrency reads this render's plan, which autoKey names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoKey, autoCurrency]);
  const waitingOnAccounts = !reliably.ok && reliably.why === 'loading';
  const offer = candidates(figures.currency, inputs, home);
  const currencyMode: CurrencyCardMode =
    currencyState.kind === 'unknown'
      ? // Nothing said while the tab records it on its own; while it waits on
        // the accounts to tell it, that it waits (a load that failed is asked
        // about).
        autoKey !== null && autoFailed?.for !== autoKey
        ? { kind: 'none' }
        : waitingOnAccounts
          ? { kind: 'waiting', text: WAITING_TEXT }
          : { kind: 'ask', text: askText(currencyState, reliably.ok ? null : reliably.why, from), offer }
      : currencyState.kind === 'recorded'
        ? {
            kind: 'recorded',
            currency: currencyState.currency,
            kept: keptText(currencyState.currency, inputs, !!(txnFx || balanceFx)),
            relabelTo: relabelOffer(currencyState.currency, inputs),
            previous,
            copiesIn: copiesOf(plansState).filter((r) => r.plan !== null && entryHoldsAmounts(r.plan, r.tax) && r.currency === currencyState.currency).length,
            offer,
          }
        : // Nothing typed yet: asked only when the accounts can't tell it.
          picked || (!reliably.ok && reliably.why !== 'loading')
          ? { kind: 'first', text: firstText(figures.currency, reliably.ok ? 'none' : reliably.why, from), offer, picked }
          : { kind: 'none' };
  // Where focus goes after an answer, or when the drawer shuts after the
  // button that opened it has gone: the card or its line where it is shown,
  // else the bar's heading.
  const currencyTarget = () => (regionRef.current?.isConnected && regionShown.current ? regionRef.current : titleRef.current);
  const currencyCard = (
    <PlanCurrencyCard
      mode={currencyMode}
      failure={autoKey && autoFailed?.for === autoKey ? autoFailed.error : null}
      disabled={currencyBusy || !planLoaded}
      regionRef={regionRef}
      onAnswer={async (c) => {
        const r = await recordCurrency(c, true);
        if (r === true) setFocusCurrency((n) => n + 1);
        return r;
      }}
      onPick={(c) => {
        setPicked(c);
        if (c) setCurrencySaid(`You’ll type your plan’s figures in ${c}.`);
      }}
      onChange={(to, from) => {
        focusInsteadOf(from, currencyTarget);
        setChanging({ to });
      }}
    />
  );
  const quietCurrency = currencyQuiet(currencyMode);
  // The drawer is for a recorded currency: once there is none (a reload that
  // finds the record unreadable), what was chosen in it is dropped, so it
  // never opens again on its own when one is recorded later.
  useEffect(() => {
    if (currencyMode.kind !== 'recorded') setChanging(null);
  }, [currencyMode.kind]);
  /** Why a save must wait: it gives your plan its first typed amount, with
   *  no currency yet to record it in. */
  const firstAmountWait = (p: FirePlanV2, tax: TaxChoices | null = shared.choices): string | null =>
    sendCurrency.current === null && currencyState.kind === 'follows' && entryHoldsAmounts(p, tax)
      ? waitingOnAccounts
        ? 'Your accounts are still loading, and the currency your plan’s figures are in is taken from them: save again in a moment.'
        : 'Say which currency you type your plan’s figures in first (above the figures), then save again: nothing was saved.'
      : null;
  // Every save of your plan alone, through its store, with the currency its
  // figures are in: never a first typed amount without one.
  const savePlanIn = async (next: FirePlanV2, tax?: TaxChoices): Promise<boolean | string> => {
    const wait = firstAmountWait(next, tax);
    if (wait) return wait;
    const saved = await store.save(next);
    if (saved) factsWere.current = factsOf(next);
    // A plan that has just been given both ages, with no rate typed, starts worked out
    // from its accounts, unless it has been worked out before and was taken back to
    // flat (opting in leaves its choices). The sheet closes on the save. A failure
    // leaves it flat, with its offer on Drawdown.
    if (saved === true && offerDetail && yourChoices === null && next.taxRate === 0 && bothAges(next) && !bothAges(basePlan)) void chooseModel({ kind: 'opt-in' });
    return saved;
  };

  const measured = measuredInputs(inputs);
  // Plan amounts are in the Plan's own currency, the one its figures were
  // typed in, once recorded; otherwise the accounts' own, or the
  // transactions' (lib/fire/plan-currency.ts).
  const displayCurrency = figures.currency;
  const money = (n: number) => wholeMoney(n, displayCurrency);
  // Without a home currency nothing is converted: investments in one and
  // spending in another can't be compared (lib/fire/progress.ts). Within
  // either, only amounts in one currency are added up, and the notes beside
  // them name the rest.
  const currencyNote = figures.currencyNote;
  // With a home currency: what was converted into the Plan's currency.
  const convertedNote = figures.convertedNote;
  // In the plan's currency, so its mix is of what the plan counts.
  const allocation = useAllocation({ institutions, holdings, currency: displayCurrency, includeCash: basePlan.includeCash, fx: balanceFx, leaveOut });
  // The other accounts' last year, on top of the shared copy (lib/plan-inputs-store.ts
  // fill): Home and the Plan ask only for what moves the savings. Asked for at load in the
  // detailed model, and when a sheet that reads them opens in the flat one.
  const yearRows = useMemo(() => planAccountsOf(institutions).map(planId), [institutions]);
  useEffect(() => {
    if (detailedOn) planInputs.fill(yearRows);
  }, [detailedOn, planInputs, yearRows]);
  // What a detailed plan's years rest on. They wait for all of it to settle, a failed
  // part counting as settled with its stand-ins and their words, so the stress test
  // below never runs on a guess and then again. The law is in dollars. Balances come
  // first: until they are in there are no accounts to wait on. Once settled it stays so
  // for these accounts: a failed row asked for again when a sheet opens reads as it did
  // until it answers, and doesn't take the answer back to a flat one.
  const taxInDollars = displayCurrency === 'USD';
  const yearRowsKey = yearRows.join();
  const settledFor = useRef<string | null>(null);
  const settledNow = taxInDollars && (balancesAsOf !== null || balancesFailed) && allocation.settings.status !== 'loading' && yearRows.every((id) => shared.copy.rows[id] && !shared.copy.rows[id].pending);
  if (detailedOn && settledNow) settledFor.current = yearRowsKey;
  const detailReady = detailedOn && taxInDollars && settledFor.current === yearRowsKey;
  // The way in, while a plan in dollars is flat, once the facts have been read.
  const offerDetail = shared.factsKnown && shared.taxFacts.model === 'flat' && taxInDollars;
  const detailHeld = detailedOn && taxInDollars && !detailReady;
  const detailBuckets = useMemo(
    () => (detailReady ? pageBuckets({ assets, holdings, facts: shared.taxFacts, settings: allocation.settings.value ?? null, rows: shared.copy.rows, partner: basePlan.partnerAge !== null }) : null),
    [detailReady, assets, holdings, shared.taxFacts, allocation.settings.value, shared.copy.rows, basePlan.partnerAge]
  );
  const calendarYear = Number(inputs.today.slice(0, 4));
  const paidToday = flows?.paid ?? 0;
  const yourChoices = shared.choices;
  const inputOf = (p: FirePlanV2, tax: TaxChoices | null) => (detailBuckets && p.age !== null ? detailedInput({ plan: p, tax: tax ?? yourChoices, facts: shared.taxFacts, today: detailBuckets, paid: paidToday, calendarYear }) : null);
  const detailKey = detailBuckets ? JSON.stringify([detailBuckets, shared.taxFacts, paidToday, calendarYear, yourChoices]) : null;
  // The page's searches (components/plan-search.ts): an answer draws the tab again.
  const search = planSearch();
  const searchVersion = useSyncExternalStore(search.subscribe, search.version, search.version);
  const detailedRun = useMemo(() => createDetailedFigures(search), [search]);
  // The opt-in's after, apart from the page's own figures, which stay flat until Work it out.
  const previewing = optInOpen && offerDetail;
  useEffect(() => {
    if (previewing) planInputs.fill(yearRows);
    else search.drop('opt-in');
  }, [previewing, planInputs, yearRows, search]);
  const previewBuckets = useMemo(
    () => (previewing && settledNow ? pageBuckets({ assets, holdings, facts: shared.taxFacts, settings: allocation.settings.value ?? null, rows: shared.copy.rows, partner: basePlan.partnerAge !== null }) : null),
    [previewing, settledNow, assets, holdings, shared.taxFacts, allocation.settings.value, shared.copy.rows, basePlan.partnerAge]
  );
  /** Every plan's figures, by one flow (components/plan-detailed.ts), so a preview
   *  agrees with the answer it would save. A flat plan costs what it always did. */
  const figuresFor = (slot: string, p: FirePlanV2, tax: TaxChoices | null, m: Measured = measured, c: Count = count): DetailedAnswer => {
    const flat = planFigures(p, m, { count: c });
    const input = inputOf(p, tax);
    if (input) return detailedRun(slot, p, m, c, input, flat);
    // What it rests on hasn't settled: a detailed plan's answer isn't in yet.
    return { figures: flat, working: detailHeld && p.age !== null && !('refused' in flat), failed: false };
  };
  // The Plan's figures by the same function a copy's come from
  // (lib/fire/plan-figures.ts).
  // Null when your plan isn't worked out: its lasting changes take its
  // spending in retirement below zero (measured spending can fall with no
  // save at all), and Your path says so, with its Timeline to fix them.
  const baseAnswer = figuresFor('plan', basePlan, yourChoices);
  const baseRun = baseAnswer.figures;
  const baseFigures: PlanFigures | null = 'refused' in baseRun ? null : baseRun;

  // Every copy as the tab shows it: with your plan's facts in it, repaired
  // where a value no longer fits them (your age moved past its stop age,
  // say: its card says so, and offers to save it that way), and its figures,
  // unless its amounts were typed in another currency than your plan's now
  // (then only why is shown, nothing worked out). For the copy open, its row
  // in the Plans sheet, and Also change it in.
  const planCurrency = figures.currency;
  const measuredKey = JSON.stringify(measured);
  const views = useMemo(() => {
    const m = new Map<string, PlanView>();
    if (!planLoaded) return m;
    const facts = factsOf(basePlan);
    for (const row of plansState.list) {
      if (row.id === plansState.main || row.plan === null) continue;
      const r = basePlanOf(withFacts(row.plan, facts));
      const other = entryHoldsAmounts(row.plan, row.tax) && row.currency !== null && planCurrency !== null && row.currency !== planCurrency ? row.currency : null;
      const answer = other ? null : figuresFor(`copy:${row.id}`, r.plan, row.tax);
      m.set(row.id, { row, plan: r.plan, fixed: r.fixed, other, figures: answer?.figures ?? null, working: answer?.working ?? false, failed: answer?.failed ?? false });
    }
    return m;
    // measuredKey stands for measured, a new object each render; detailKey for what
    // a detailed plan's years rest on, and searchVersion for a job's answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planLoaded, plansState.list, plansState.main, basePlan, planCurrency, measuredKey, count, detailedOn, detailKey, searchVersion]);
  const openView = entry ? (views.get(entry.id) ?? null) : null;
  const other = openView?.other ?? null;
  const copyFixing = !!openView && openView.fixed.length > 0;
  const openFigures = openView?.figures ?? null;
  const shown: PlanFigures | null = entry ? (openFigures && !('refused' in openFigures) ? openFigures : null) : baseFigures;
  // A job is out for the plan shown, or it couldn't be run: dimmed, or said.
  const shownWorking = entry ? (openView?.working ?? false) : baseAnswer.working;
  const shownFailed = entry ? (openView?.failed ?? false) : baseAnswer.failed;
  // The stress test waits for a detailed plan's years, so it never runs twice, and
  // doesn't run on a date that couldn't be worked out.
  const holdSim = detailHeld || (detailedOn && taxInDollars && (shownWorking || shownFailed));
  const problem = openFigures && 'refused' in openFigures ? REFUSED_TEXT : null;
  const baseRefused = !entry && baseFigures === null;
  /** The plan the forms edit: the copy open, or your plan. */
  const shownPlan = openView?.plan ?? basePlan;
  const plan = shown?.plan ?? shownPlan;
  const view = shown?.view ?? figures.view;
  // The path from today to the stop age (lib/fire/path.ts), the chart's
  // line, and where it can't go on, which the At age row says. Every plan's
  // ages are parsed (each is repaired), so it is never longer than a plan
  // can be.
  // Until a detailed plan's years are in, what follows the stop would be flat, and then move.
  const path = useMemo(() => {
    const p = shown ? planPath(shown) : null;
    return p && detailHeld ? { ...p, after: null } : p;
  }, [shown, detailHeld]);
  const stopShort = path?.short ?? null;
  const stopWalked = path?.fromWalk ?? false;
  const engine: EnginePlan | { missing: Missing } = shown?.engine ?? { missing: 'spending' };
  const sim = 'sim' in engine ? engine.sim : null;
  // Your plan's method: the same in every plan.
  const simKey = sim ? JSON.stringify([plan.method, sim]) : null;
  const simKeyRef = useRef(simKey);
  simKeyRef.current = simKey;
  // Answers for the visit, by job: the Plan's reused by compare mode.
  const answers = useRef(new Map<string, SimResult>()).current;

  // The runner (and its worker) for as long as the tab is open. Made on first
  // use rather than in a memo, so a development-mode remount, which disposes
  // it, gets a new one.
  const runnerRef = useRef<PlanRunner | null>(null);
  const runner = () =>
    (runnerRef.current ??= createPlanRunner({
      startWorker: () => (typeof Worker === 'undefined' ? null : (new Worker(new URL('../lib/fire/plan.worker.ts', import.meta.url)) as unknown as WorkerLike)),
      runHere: async (job: PlanJob) => {
        // Loaded only when a worker can't be had: otherwise the history ships
        // in the worker's own chunk alone.
        const [{ runPlanJob }, { usMarket }] = await Promise.all([import('@/lib/fire/jobs'), import('@/lib/fire/us-market')]);
        return runPlanJob(job, usMarket());
      },
    }));
  useEffect(
    () => () => {
      runnerRef.current?.dispose();
      runnerRef.current = null;
    },
    []
  );
  // Trying again, after the simulation couldn't be run, starts a new runner
  // and with it a new worker. This effect comes before the ones that run
  // jobs, so the old runner is gone before they ask for one; their cleanups,
  // which run before any effect, have already stopped listening to it.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (attempt === 0) return;
    runnerRef.current?.dispose();
    runnerRef.current = null;
  }, [attempt]);
  const retry = () => setAttempt((n) => n + 1);

  // The simulation, recomputed only when what it runs on changes. While a new
  // answer is worked out the last one stays, dimmed, so nothing jumps.
  const simRef = useRef(sim);
  simRef.current = sim;
  const methodRef = useRef(plan.method);
  methodRef.current = plan.method;
  const simRunKey = simKey && !holdSim ? `${attempt}:${simKey}` : null;
  const [main, setMain] = useState<{ key: string; outcome: Outcome } | null>(null);
  useEffect(() => {
    const s = simRef.current;
    if (!simRunKey || !s) return;
    let live = true;
    const key = simKeyRef.current;
    // Dropped from the runner's queue if the plan changes before it runs.
    const stop = new AbortController();
    void runner()
      .run({ kind: 'simulate', method: methodRef.current, plan: s }, stop.signal)
      .then((r) => {
        if (r.ok && r.kind === 'simulate' && key) rememberResult(answers, key, r.result);
        if (!live) return;
        setMain({
          key: simRunKey,
          outcome: r.ok
            ? r.kind === 'simulate'
              ? { result: r.result }
              : { error: 'an unexpected answer' }
            : { error: r.error, unavailable: r.unavailable === true },
        });
      });
    return () => {
      live = false;
      stop.abort();
    };
    // simRunKey stands for plan.method and sim, which are new objects each
    // render, and the attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simRunKey]);
  const pending = (holdSim && !!simKey) || (!!simRunKey && main?.key !== simRunKey);
  // While a new answer is worked out the last result stays, dimmed; an old
  // failure doesn't.
  const outcome = main && !(pending && 'error' in main.outcome) ? main.outcome : null;

  // The grid, one cell per job, filling in as the answers arrive.
  const vpw = plan.rule === 'vpw';
  const ownRate = 'rate' in engine ? engine.rate : plan.withdrawalRate;
  const gridRates = useMemo<(number | null)[]>(
    () => (vpw ? [null] : ownRate <= GRID_MAX_OWN_RATE ? withOwn(GRID_RATES, ownRate) : GRID_RATES),
    [vpw, ownRate]
  );
  const gridYears = useMemo(() => withOwn(GRID_YEARS, sim?.years ?? 30), [sim?.years]);
  const gridKey = sim && !holdSim ? JSON.stringify([attempt, simKey, gridRates, gridYears]) : null;
  const [grid, setGrid] = useState<{ key: string; cells: GridCell[]; failed: FailedCell[]; unavailable: boolean } | null>(null);
  useEffect(() => {
    const s = simRef.current;
    if (!gridKey || !s) return;
    let live = true;
    // The cells not yet run are dropped if the plan changes meanwhile.
    const stop = new AbortController();
    const cells: GridCell[] = [];
    const failed: FailedCell[] = [];
    let unavailable = false;
    const method = methodRef.current;
    for (const years of gridYears) {
      for (const rate of gridRates) {
        void runner()
          .run({ kind: 'grid-cell', method, plan: s, rate, years }, stop.signal)
          .then((r) => {
            if (!live) return;
            if (r.ok && r.kind === 'grid-cell') cells.push(r.cell);
            else {
              failed.push({ rate, years });
              if (!r.ok && r.unavailable) unavailable = true;
            }
            setGrid({ key: gridKey, cells: cells.slice(), failed: failed.slice(), unavailable });
          });
      }
    }
    return () => {
      live = false;
      stop.abort();
    };
    // gridKey stands for everything the grid is computed from, and the attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridKey]);
  const shownGrid = grid && grid.key === gridKey ? grid : null;

  // The drawer, and the plan it was opened for: the copy open, at the
  // version it was opened on, or null for your plan. A form saves only to
  // the plan it was opened for, and the drawer closes whenever the plan
  // shown changes (a copy opened, closed, deleted elsewhere, saved, or
  // changed on another device), so a form left open can never send one
  // plan's values to another, or a version's values over a newer one.
  const shownFor = entry ? `${entry.id}@${entry.updated_at}` : null;
  const shownForRef = useRef(shownFor);
  shownForRef.current = shownFor;
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  // The drawer's level past a figure's sheet (components/PlanBuckets.tsx).
  const [figureLevel, setFigureLevel] = useState<FigureLevel | null>(null);
  // A stage's year, by its place in Year by year's years, drawn over the stage.
  const [yearLevel, setYearLevel] = useState<number | null>(null);
  const [tuneLevel, setTuneLevel] = useState<TunedRow | null>(null);
  const [stageRuns, setStageRuns] = useState<readonly number[]>([]);
  const [opened, setOpened] = useState(0);
  const shownSheet = useLast(sheet);
  // The figure's row a sheet was opened from (InputsCard), by its kind, set
  // by the row and cleared by every other open, so closing an income's or a
  // one-off's sheet never lands on a figure's row. The rows themselves, by
  // kind, so focus finds the row drawn now when the one pressed has gone
  // (the panel drawn again as the plan loads).
  const openedFrom = useRef<RowKind | null>(null);
  const inputRows = useRef(new Map<RowKind, HTMLElement>());
  const inputRowRef = (kind: RowKind, el: HTMLElement | null) => {
    if (el) inputRows.current.set(kind, el);
    else if (inputRows.current.get(kind)?.isConnected === false) inputRows.current.delete(kind);
  };
  // Portfolio's "For your plan" heading: where focus goes back when "Use my
  // allocation in the plan" has gone as its sheet closes (the plan took it).
  const mixHeading = useRef<HTMLElement | null>(null);
  // The saved plan as a sheet opened on it, and which opening is the sheet's
  // now: a sheet whose plan was read again behind it (Try again, a stale
  // currency record) holds the values it opened with, so it can't save them
  // over the plan read since; and a save that ends after its sheet was
  // dismissed closes only that one, never a sheet opened since.
  const storedKey = JSON.stringify(state.value);
  const openedOn = useRef<string | null>(null);
  const openedNow = useRef(0);
  const open = (s: SheetState, row: RowKind | null = null) => {
    openedFrom.current = row;
    openedOn.current = storedKey;
    openedNow.current += 1;
    setOpened(openedNow.current);
    setSheetFor(shownForRef.current);
    setSheet(s);
    setFigureLevel(null);
    setYearLevel(null);
    setTuneLevel(null);
    setStageRuns([]);
  };
  const close = () => setSheet(null);
  useEffect(() => setOptInOpen(sheet?.kind === 'opt-in'), [sheet?.kind]);
  const typedBasis = useMemo(() => new Map(shared.taxFacts.basis.map((b) => [b.account_id, b.amount])), [shared.taxFacts.basis]);
  useEffect(() => {
    if (sheet?.kind === 'figure' && sheet.figure !== 'spending') planInputs.fill(yearRows);
  }, [opened, planInputs, yearRows]); // eslint-disable-line react-hooks/exhaustive-deps
  const closeFor = (n: number) => () => {
    if (openedNow.current === n) setSheet(null);
  };
  // A level's save holds the drawer: what it answers belongs to that level, so
  // the arrow, Escape and Close wait for it, as the level's own Cancel does.
  const [levelSaves, setLevelSaves] = useState(0);
  const heldBy = <T,>(saving: Promise<T>): Promise<T> => {
    setLevelSaves((n) => n + 1);
    return saving.finally(() => setLevelSaves((n) => n - 1));
  };
  useEffect(() => {
    setSheet(null);
  }, [shownFor]);
  // Closed: the sheet gives focus back to what was focused when it opened as
  // its own effect ends, which runs before this one. When that wasn't the row
  // (pressed without taking focus, as in Safari), focus is lost or still in
  // the sheet: then to the row that opened it (as ForecastCard's Warns below).
  // Portfolio's "Use my allocation in the plan" goes once the plan takes the
  // mix: then to the heading over where it was.
  const sheetOpen = !!sheet;
  const wasOpen = useRef(sheetOpen);
  useEffect(() => {
    const closed = wasOpen.current && !sheetOpen;
    wasOpen.current = sheetOpen;
    let row = openedFrom.current === 'mix' ? mixHeading.current : openedFrom.current ? (inputRows.current.get(openedFrom.current) ?? null) : null;
    // The answer's ask goes once the ages are saved: then to the Ages row.
    if (openedFrom.current === 'ask-about' && !row?.isConnected) row = inputRows.current.get('about') ?? null;
    // The Timeline's goes once the age is saved: then to its Add
    // (components/PlanTimeline.tsx).
    if (openedFrom.current === 'ask-timeline' && !row?.isConnected) row = inputRows.current.get('timeline-first') ?? null;
    // Work it out goes once it is chosen: then to Year by year, or the rows under it
    // while its years are worked out.
    if (openedFrom.current === 'opt-in' && !row?.isConnected) row = inputRows.current.get('years') ?? inputRows.current.get('stress-assumptions') ?? null;
    if (!closed || !row?.isConnected) return;
    let lost = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;
    for (let n: Element | null = document.activeElement; n && !lost; n = n.parentElement) lost = n.getAttribute('role') === 'dialog';
    if (lost) row.focus({ preventScroll: true });
  }, [sheetOpen]);
  // What a copy's save said that has no form left to say it in: refused for
  // what is stored now, so the drawer closed on the version it was made to.
  const [notice, setNotice] = useState<{ for: string; text: string } | null>(null);

  /** Saves plans whole through /api/plans, all or none (the copy open, and
   *  the plans checked in Also change it in): true, or why not. Your plan,
   *  when among them, is read again after, so its store and Home have it. */
  const savePlans = async (saves: PlanSave[]): Promise<true | string> => {
    const mainIn = saves.some((x) => x.id === plansState.main);
    const r = await plansClient.save(saves, factsWere.current);
    if (mainIn) void store.load();
    if ('error' in r) {
      if (!r.stale) return r.error;
      // The list is read again on a refusal (components/plan-list.ts), so the
      // server's "load it again" is done: said in words for what is shown now.
      if (entry) setNotice({ for: entry.id, text: 'Changed on another device, so nothing of your change was kept: make it again if it still applies.' });
      return 'Changed on another device, so nothing was saved: save again to make your change in what is there now.';
    }
    setNotice(null);
    return true;
  };
  // The currency the plan shown is saved with: a copy's own once it holds an
  // amount, else your plan's.
  const shownCurrency = entry?.plan && entryHoldsAmounts(entry.plan, entry.tax) ? entry.currency : sendCurrency.current;
  // Every other plan the same change can go to (Also change it in): each
  // that reads and needs no repair with your plan's facts in it, holding its
  // amounts in the currency of the plan shown, or none. In the list's order,
  // your plan first.
  const alsoPlans: { row: PlanRow; plan: FirePlanV2; currency: string | null }[] =
    plansState.status !== 'ready' || !planLoaded
      ? []
      : plansState.list.flatMap((row) => {
          if (row.id === (entry ? entry.id : plansState.main)) return [];
          const mine = row.id === plansState.main;
          const v = mine ? null : views.get(row.id);
          const p = mine ? (repairing ? null : basePlan) : v && v.fixed.length === 0 ? v.plan : null;
          if (!p) return [];
          const currency = !entryHoldsAmounts(p, row.tax) ? null : mine ? sendCurrency.current : row.currency;
          return currency === null || currency === shownCurrency ? [{ row, plan: p, currency }] : [];
        });
  // As offered (components/plan-diff.ts figureChoices, itemChoices): your
  // plan named so.
  const alsoTargets: AlsoTarget[] = alsoPlans.map(({ row, plan: p }) => ({ id: row.id, name: row.id === plansState.main ? `${row.name} (your plan)` : row.name, plan: p }));
  /** Every save of the plan shown, from its forms and cards: your plan alone
   *  through its store; the copy open, or any plans checked in Also change
   *  it in, all together through /api/plans, each with the same change made
   *  in it (components/plan-diff.ts sameChange) from `before`, the plan the
   *  form was opened on. */
  const saveShown = async (next: FirePlanV2, also: readonly string[] = [], before: FirePlanV2 = shownPlan, tax?: TaxChoices): Promise<boolean | string> => {
    if (!entry && also.length === 0) return savePlanIn(next);
    if (other && planCurrency) return currencyText(other, planCurrency, currencyKnown);
    const wait = entry ? null : firstAmountWait(next, tax);
    if (wait) return wait;
    if (entry && shownCurrency === null && entryHoldsAmounts(next, tax ?? entry.tax)) return NO_COPY_CURRENCY;
    const taxTo = tax ? { tax } : {};
    const saves: PlanSave[] = [
      entry
        ? { id: entry.id, plan: next, currency: shownCurrency, based_on: entry.updated_at, ...taxTo }
        : { id: plansState.main, plan: next, currency: shownCurrency, based_on: stampRef.current, ...taxTo },
    ];
    const facts = factsOf(next);
    for (const id of also) {
      const there = alsoPlans.find((x) => x.row.id === id);
      if (!there) return 'A plan checked in Also change it in changed since this opened, so nothing was saved: open it again.';
      saves.push({
        id,
        plan: planOf(withFacts(sameChange(before, next, there.plan), facts)),
        currency: there.currency ?? shownCurrency,
        based_on: id === plansState.main ? stampRef.current : there.row.updated_at,
      });
    }
    return savePlans(saves);
  };
  /** The plan shown with what it says beside the plan, in one request: a copy holds its
   *  own choices, and your plan's save carries the household too. */
  const saveMore: SaveMore = async (next, more, also = []) => {
    if (entry || also.length > 0) return saveShown(next, also, shownPlan, more.tax);
    sendMore.current = { ...(more.tax ? { tax: more.tax } : {}), ...(more.household ? { household: more.household, household_were: householdOf(shared.taxFacts) } : {}) };
    try {
      return await savePlanIn(next, more.tax);
    } finally {
      sendMore.current = null;
    }
  };
  // Every save the tab makes, from one place (components/plan-savers.ts).
  const savers = planSavers({ copy: entry ? saveShown : null, savePlan: saveShown, repaired: repairing ? repair.plan : null, more: saveMore });
  const formPlan = shownPlan;
  const saversRef = useRef(savers);
  saversRef.current = savers;
  // Bound when the drawer opened: refused once the plan shown isn't the one
  // it was opened for (the drawer is closing by then).
  const saveFor =
    (target: string | null): Save =>
    async (next, also) =>
      target === shownForRef.current ? saversRef.current.form(next, also) : 'This form was opened for another plan than the one shown now, so nothing was saved.';
  const moreFor =
    (target: string | null): SaveMore =>
    async (next, more, also) =>
      target === shownForRef.current ? saversRef.current.more(next, more, also) : 'This form was opened for another plan than the one shown now, so nothing was saved.';
  const replaced = sheet !== null && !state.saving && state.status === 'ready' && storedKey !== openedOn.current;
  const formEditable = editable && !other && !copyFixing && sheetFor === shownFor && !replaced;
  // The figures' rows open their sheets whatever the state: while saving is
  // paused for more than a moment, the sheet says why above its buttons.
  // Nothing for a save under way, or a sheet whose plan was replaced under
  // it, as before.
  const savesWait =
    state.status === 'error'
      ? state.value === null
        ? "Your saved plan couldn't be read, so this shows the defaults and can't be saved yet: try again at the top of the Plan tab."
        : "Your saved plan couldn't be read, so this can't be saved yet: try again at the top of the Plan tab."
      : state.status !== 'ready'
        ? null
        : !currencyKnown
          ? currencyMode.kind === 'none'
            ? "Your plan's currency is still being recorded, so this can't be saved yet."
            : "Which currency your plan's figures are in isn't known yet (at the top of the Plan tab), so this can't be saved yet."
          : repairing
            ? "Your saved plan has values to fix first (at the top of the Plan tab), so this can't be saved yet."
            : copyFixing
              ? "This copy has values to fix first (on its card, under the bar), so this can't be saved yet."
              : null;
  const paused = formEditable
    ? null
    : (savesWait ?? (state.status === 'ready' && replaced && editable && !other && sheetFor === shownFor ? "Your saved plan was read again since this opened, so this can't be saved: close it and open it again." : null));
  // The Timeline's own sheet (components/PlanTimeline.tsx): it keeps the
  // version it opened on itself, so only the plan's state matters here.
  const timelineEditable = editable && !other && !copyFixing;
  const timelinePaused = timelineEditable ? null : savesWait;
  /** Whether a save would turn a plan that is worked out into one that isn't. */
  const breaks = (was: FirePlanV2, next: FirePlanV2) => !('refused' in planFigures(was, measured, { count })) && 'refused' in planFigures(next, measured, { count });
  /** The Timeline's saves: refused, by name, for a plan checked in Also
   *  change it in that the change breaks, and for one taken below zero; a
   *  plan already refused can be fixed a step at a time. */
  const saveTimeline = async (next: FirePlanV2, also: readonly string[], before: FirePlanV2): Promise<boolean | string> => {
    if (!timelineEditable) return timelinePaused ?? false;
    const facts = factsOf(next);
    for (const id of also) {
      const there = alsoPlans.find((x) => x.row.id === id);
      if (!there) continue;
      const changed = planOf(withFacts(sameChange(before, next, there.plan), facts));
      const parsed = parsePlanV2(changed);
      if ('error' in parsed) return `${there.row.name} can’t take this change, so nothing was saved: ${itemRuleText(parsed.error, changed)} Untick it to save the rest.`;
      if (breaks(there.plan, changed)) return `${there.row.name} can’t take this change, so nothing was saved: its spending in retirement would go below zero. Untick it to save the rest.`;
    }
    if (breaks(before, next)) return `With this, ${REFUSED_TEXT.charAt(0).toLowerCase()}${REFUSED_TEXT.slice(1)} Nothing was saved.`;
    return saversRef.current.form(next, also);
  };
  // The plan saved as your plan and what was recorded since (rollout 8e), for
  // the Progress card and, with the Plan shown, the chart's lines before today.
  const progress = useProgress(institutions, childOut ? shared.taxFacts.countAnyway.join(',') : '');
  const progressSaved = progress.savedState.kind === 'ready' ? progress.savedState.saved : null;
  // Only where both are of one thing: the saved plan's currency and include
  // cash are the path's (the Progress card says when they changed).
  const progressSeries = progress.series;
  const todayUtc = new Date().toISOString().slice(0, 10);
  // The saved plan's items on its own steady path (lib/fire/plan-figures.ts
  // resolveSaved), for the card's line and the chart's: with the switch as
  // it is, and off, for the line that says what it moved.
  const anchor = progressSeries?.kind === 'ready' ? progressSeries.answer.anchor : null;
  const savedStart = anchor && anchor.total !== null ? { day: anchor.date, total: anchor.total } : null;
  const savedOn = progressSaved && savedStart ? resolveSaved(progressSaved, savedStart, measured.spending, count) : null;
  const savedItems = { on: savedOn, off: progressSaved && savedStart && planInWalk ? resolveSaved(progressSaved, savedStart, measured.spending, { planInWalk: false }) : savedOn };
  // D15's line while new (components/plan-moved.ts): what counting the
  // plan's one-offs and income moved, on the Plan's answer and Progress's
  // line, until Got it (one for both).
  const movedNew = planInWalk && !movedSeen && stillNew(newUntil, todayUtc);
  const offFigures = movedNew && entry === null && baseFigures ? figuresFor('moved', basePlan, yourChoices, measured, { planInWalk: false }).figures : null;
  const movedText = offFigures && baseFigures && !('refused' in offFigures) ? fiMovedText(offFigures, baseFigures) : null;
  // D7's the same way, with its own Got it: the plan's figures with a child's
  // accounts counted again, on the Plan's answer alone, since a saved plan's
  // Progress line leaves them out at both its ends.
  const childMovedNew = childOut && !childMovedSeen && entry === null && stillNew(childNewUntil, todayUtc) && (assets.childAccounts?.length ?? 0) > 0;
  const childOffFigures = childMovedNew && baseFigures ? figuresFor('child-moved', basePlan, yourChoices, measuredInputs({ ...inputs, child: null, workplace: inputs.workplaceCounted, assets: investedAssets(institutions, basePlan.includeCash, balanceFx, Date.now(), ownCurrency) })).figures : null;
  const childMoved = childOffFigures && baseFigures && !('refused' in childOffFigures) ? childMovedText(childOffFigures, baseFigures) : null;
  const overlay = useMemo(
    () =>
      entry === null &&
      progressSaved &&
      progressSeries?.kind === 'ready' &&
      basePlan.age !== null &&
      progressSeries.answer.currency === displayCurrency &&
      progressSaved.plan.includeCash === basePlan.includeCash
        ? progressOverlay(progressSaved, progressSeries.answer, basePlan.age, todayUtc, savedItems.on)
        : null,
    [entry, progressSaved, progressSeries, basePlan.age, basePlan.includeCash, displayCurrency, todayUtc, savedItems.on]
  );
  // Why "This is my plan" can't save now: as the Plan's own saves wait.
  const progressBlocked =
    state.status === 'error'
      ? "Your saved plan couldn't be read, so this can't be saved yet: try again at the top of the Plan tab."
      : state.status !== 'ready' || state.saving
        ? 'Still loading or saving your plan. Try again in a moment.'
        : repairing
          ? "Your saved plan has values to fix first (at the top of the Plan tab), so this can't be saved yet."
          : !currencyKnown
            ? "Which currency your plan's figures are in isn't known yet (at the top of the Plan tab), so this can't be saved yet."
            : figures.view.savings.source === 'measured' && (txnsLoading || txnsFailed || unread.length > 0)
              ? "Some of your transactions haven't loaded or couldn't be read, so Nya's savings figure may be off: save once they have, or type your savings in Your figures."
              : null;
  const copyName = entry?.name ?? null;
  // Invested assets and Annual savings by tax bucket, worked out while one of
  // them is open.
  const bucketsFor = (includeCash: boolean) =>
    bucketsToday({
      assets: investedAssets(institutions, includeCash, balanceFx, Date.now(), ownCurrency, leaveOut),
      holdings,
      tax: shared.taxFacts,
      overrides: overridesOf(allocation.settings.value ?? null).buckets,
      yearOf: (a): AccountYear => (a.item_id ? yearFrom(shared.copy.rows[planId({ item_id: a.item_id, account_id: a.account_id })]) : { income: null, contributions: null }),
      partner: plan.partnerAge !== null,
    });
  const bucketSheet = (kind: FigureKind): BucketSheet | undefined => {
    if (kind === 'spending') return undefined;
    const rows = shared.copy.rows;
    return {
      detail: shownInput ? { rmdAges: shownInput.rmdAges, cautions: rothCautions } : null,
      bucketsFor,
      asOf: balancesAsOf ? fmtAsOf(balancesAsOf) : null,
      reading: yearRows.some((id) => !rows[id] || rows[id].pending),
      partner: plan.partnerAge !== null,
      childOut,
      tax: shared.taxFacts,
      chosen: overridesOf(allocation.settings.value ?? null).buckets,
      level: figureLevel,
      // A save ending after its sheet was dismissed moves only that opening's level.
      onLevel: (level) => {
        if (openedNow.current === opened) setFigureLevel(level);
      },
      saveFact: (op) => heldBy(saveTaxFact(planInputs, op)),
      factsLocked: !savers.taxFacts ? 'What is said about an account is the same in every plan: change it on your plan.' : !shared.factsKnown ? 'What’s saved about your accounts hasn’t loaded, so this can’t be changed yet.' : null,
      saveBucket: (account_id, bucket) => heldBy(allocation.save(withBucket(allocation.settings.value ?? EMPTY_SETTINGS, account_id, bucket))),
      bucketsEditable: savers.allocationSettings && allocation.withSettings && !allocation.settings.saving,
    };
  };
  // Where a year of savings goes, and the mix by the start age of what the plan
  // shown counts: apart from the sheet, since these rest on the plan's figures.
  const splitFor = (kind: FigureKind) => {
    if (kind !== 'savings') return null;
    const split = savingsSplit(bucketsFor(plan.includeCash), view.savings.value);
    return split.from === 'none' ? null : split;
  };
  const mixFor = (kind: FigureKind) => {
    const startsAt = shown && 'sim' in shown.engine ? shown.engine.startAge : null;
    if (kind !== 'assets' || !shown || startsAt === null || plan.age === null || view.assets.value === null) return null;
    // A detailed plan's is where Year by year starts.
    const drawn = shown.detail && !('failed' in shown.detail) ? shown.detail : null;
    const first = drawn?.start.years[0];
    if (drawn && first) return mixLine(drawn.startAge, balanceShares(first.start));
    const today = bucketsFor(plan.includeCash);
    const split = savingsSplit(today, view.savings.value);
    const projected = projectMix(mixToday(today, view.assets.value), { savings: view.savings.value ?? 0, split: split.shares, realReturn: plan.realReturn, inflation: detailedOn ? ((entry ? entry.tax : yourChoices)?.inflation ?? DEFAULT_INFLATION) : DEFAULT_INFLATION, walk: shown.walk, years: Math.max(0, startsAt - plan.age) });
    return projected && mixLine(startsAt, mixShares(projected));
  };
  const formProps = { plan: formPlan, onSave: saveFor(sheetFor), onDone: closeFor(opened), editable: formEditable, copy: copyName, paused, planInWalk, childOut };

  // What each figure the plan shown rests on says, worked out once for the
  // rows under the FI card, their sheets' Why? and Drawdown's notice
  // (components/plan-figure-notes.ts). Cheap, and not memoized: it holds
  // amounts, which are written as they are drawn.
  const figureArgs: FigureArgs = {
    plan,
    view,
    flows,
    unread,
    withoutTransactions: txnWithout,
    transactionCount: txns ? historyCount(txns) : 0,
    txnsLoading,
    txnsFailed,
    assets,
    balancesAsOf,
    workplace,
    workplaceCount: contributions === null ? null : contributions.length,
    child,
    childPending: shared.childPending,
    cashOn,
    cashUnmarked,
    money,
    savingsRate: figures.savingsRate,
    shareRates: inputs.rates ?? null,
    // Said detailed, and not worked out that way now.
    taxOnHold: shared.taxFacts.model === 'detailed' && !taxInDollars,
  };
  const shownNow = figureNotes(figureArgs);
  // A detailed plan's own: what it says of its household and rates, and each gap in
  // what it rests on, on the row it is about and on Drawdown's notice.
  const shownChoices = entry ? entry.tax : yourChoices;
  const detailShown = detailedOn && taxInDollars;
  const lawNow = lawFor(calendarYear).law;
  // In points, rounded as the forms round a pace they hold: 0.022 * 100 isn't 2.2.
  const defaultGrowth = Number((lawNow.healthGrowth.overPrices * 100).toFixed(4));
  const paidChoices: PaidChoice[] = useMemo(() => {
    if (!detailedOn) return [];
    const names = [...new Set((txns ?? []).flatMap((t) => t.category_name ?? t.category ?? []))].sort((a, b) => a.localeCompare(b));
    return [...names.map((name): PaidChoice => ({ kind: 'category', name, label: name })), ...tags.map((t): PaidChoice => ({ kind: 'tag', name: t.id, label: `Tag: ${t.name}` }))];
  }, [detailedOn, txns, tags]);
  const unansweredPaid = useMemo(() => {
    if (!detailedOn || shared.taxFacts.paidToday || view.spending.source !== 'measured') return null;
    const named = paidChoices.find((c) => c.kind === 'category' && namesCoverage(c.name));
    const amount = named ? inputs.paidFor(named) : 0;
    return named && amount >= 0.5 ? { name: named.label, amount } : null;
    // flows stands for what paidFor reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailedOn, shared.taxFacts.paidToday, view.spending.source, paidChoices, flows]);
  const detailChoices = (entry ? (entry.tax ?? yourChoices) : yourChoices) ?? DEFAULT_TAX_CHOICES;
  // The tax and health in the FI number. Until what they rest on settles, nothing flat
  // shows that would then move; once it has, a plan they can't be worked out for keeps
  // the flat rate's words and its field.
  const fiHeld = detailShown && shownWorking;
  const shownShares = fiHeld ? null : (shown?.shares ?? null);
  const taxWorked = shownShares !== null || fiHeld;
  const honesty = shown?.detail && !('failed' in shown.detail) ? honestyNotes({ today: detailBuckets, choices: detailChoices, items: shownPlan.items, law: shown.detail.law, unansweredPaid, money }) : [];
  const healthRow: (FigureText & { value: string | null }) | null = !detailShown
    ? null
    : {
        sub: healthSub(detailChoices, shownPlan.fiNumber === null && taxWorked),
        line: shownShares && detailChoices.health.beforeMedicare !== null ? 'a year, on average' : null,
        why: null,
        value: detailChoices.health.beforeMedicare === null ? null : shownShares ? money(shownShares.h) : '--',
        notes: honesty.filter((n) => n.kind === 'health not set' || n.kind === 'coverage counted twice').map((n) => (n.kind === 'health not set' ? { ...n, text: HEALTH_NOT_SET } : n)),
      };
  const figureTexts: typeof shownNow = !detailShown
    ? shownNow
    : {
        ...shownNow,
        ages: { ...shownNow.ages, sub: `${shownNow.ages.sub} · ${householdLine(shared.taxFacts, detailChoices)}` },
        assumptions: {
          ...shownNow.assumptions,
          sub: taxWorked ? assumptionsWorked(shownPlan, detailChoices, detailChoices.health.growth ?? lawNow.healthGrowth.overPrices, money) : `${shownNow.assumptions.sub} · ${assumptionsLine(detailChoices, detailChoices.health.growth ?? lawNow.healthGrowth.overPrices)}`,
        },
      };
  const taxRow: (FigureText & { value: string }) | null = shownShares
    ? { sub: `Share of your costs after ${shownShares.drawn.years[0]?.age} · from your accounts and ${lawNow.year} law`, line: null, why: null, notes: [], value: pct(shownShares.t, 1) }
    : fiHeld
      ? { sub: 'Working it out', line: null, why: null, notes: [], value: '--' }
      : offerDetail && !entry
        ? { sub: 'As set · work out tax from your accounts', line: null, why: null, notes: [], value: pct(shownPlan.taxRate) }
        : null;
  const fiSub = shownPlan.fiNumber !== null ? null : shownShares ? `Spending, health coverage and tax, at a ${pct(shownPlan.withdrawalRate)} withdrawal rate` : fiHeld ? 'Working it out' : null;
  const stressNotes = stressNotice(figureArgs, engine, shown?.startsWith ?? null);
  // Design-system rule 3: a badge on each card the notice is about.
  const stressBadge = stressNotes.length === 0 ? null : stressNotes.length === 1 ? 'An input may be low' : 'Inputs may be low';

  // A detailed plan's years, and what the sheets over them are worked out with.
  const drawn = shown?.detail && !('failed' in shown.detail) ? shown.detail : null;
  const detailStuck = !!shown?.detail && 'failed' in shown.detail;
  const shownInput = drawn ? inputOf(shownPlan, shownChoices) : null;
  const yearContext: YearContext | null =
    drawn && shownInput
      ? {
          money,
          realReturn: plan.realReturn,
          healthGrowth: shownInput.health.growth,
          acaLaw: shownInput.health.acaLaw,
          lawYear: drawn.law.year,
          state: shownInput.state,
          stateTaxes: shownInput.state ? shownInput.law.stateIncomeTax[shownInput.state] : null,
          rmdAge: shownInput.rmdAges.you,
          gainsZeroTo: shownInput.law.brackets.gains[shownInput.filing === 'joint' && shownPlan.partnerAge !== null ? 'joint' : 'single'].zeroTo,
          medicaid: shownInput.state ? shownInput.law.medicaidStates[shownInput.state] : null,
        }
      : null;
  // The rules side by side: whole drawdowns, so only while Drawdown is shown.
  const compareOn = segment === 'drawdown' && !!drawn && !shownFailed;
  const compare = useMemo(
    () => (compareOn && shown && drawn && shownInput ? compareRows(shown, shownInput, drawn.start) : []),
    // `shown` holds what the input is made from, and is kept while that stays the same.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, compareOn]
  );
  const previewConversions = useMemo(
    () => (shown && shownInput && drawn ? (strategy: Strategy) => ({ rule: conversionRun(shown, shownInput, strategy), none: conversionRun(shown, shownInput, { ...strategy, conversions: { kind: 'none' }, convertUntil: null }) }) : null),
    // As above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, drawn]
  );
  const shownUntil = shownInput && shownPlan.age !== null ? untilByDefault(shownInput.rmdAges, { age: shownPlan.age, partnerAge: shownInput.filing === 'joint' ? shownPlan.partnerAge : null }) : null;
  /** A copy's choices beside your plan's, where tax is worked out. */
  const choicesBeside = (copy: TaxChoices | null) => (detailShown && copy !== null ? { mine: yourChoices ?? DEFAULT_TAX_CHOICES, copy, until: shownUntil } : null);
  // Taxes don't move a saved plan's assets before the stop, so a year your plan draws
  // leaves its line above Your path.
  const firstTax = baseFigures?.walk.taxes?.[0] ?? null;
  const baseTax = baseFigures?.detail && !('failed' in baseFigures.detail) ? baseFigures.detail.walkTax : 0;
  const progressFlatLine =
    firstTax && baseTax >= 0.5 && basePlan.age !== null
      ? `Your saved plan’s line takes no tax out before you stop, so from ${basePlan.age + firstTax.year} it runs ${money(baseTax)} above Your path.`
      : null;
  // What isn't known about a Roth, on the sheets it is about.
  const rothCautions = honesty.filter((n) => n.kind.includes('Roth put-in')).map((n) => n.text);
  // What the forms of a detailed plan read and save with. The shared parts lock in a copy.
  const detailForm: DetailForm | null = detailShown
    ? { choices: detailChoices, facts: shared.taxFacts, factsLocked: !savers.taxFacts, stateTaxes: lawNow.stateIncomeTax, statute: lawNow.statute, calendarYear, save: moreFor(sheetFor) }
    : null;
  const sheetStage = shownSheet?.kind === 'stage' ? (drawn?.start.stages[shownSheet.at] ?? null) : null;
  const sheetYear = sheetStage && yearLevel !== null ? (drawn?.start.years[yearLevel] ?? null) : null;
  const sheetRule: CompareRow | null = shownSheet?.kind === 'rule' ? (compare.find((r) => r.key === shownSheet.key) ?? null) : null;
  // A tuned row's own sheet runs the plan with that setting in it: one run, or the
  // search's on a plan that searches, dropped as the sheet closes.
  const tuneLevelShown = shownSheet?.kind === 'tune' ? tuneLevel : null;
  const tuneLevelOn = sheet !== null && tuneLevelShown !== null;
  useEffect(() => {
    if (!tuneLevelOn) search.drop('tune-level');
  }, [tuneLevelOn, search]);
  /** A choice of model moves every plan's stamp, so all of them are read again, however
   *  it went: a later save names what is stored now. */
  const chooseModel = async (op: TaxFactOp): Promise<true | string> => {
    const r = await heldBy(saveTaxFact(planInputs, op));
    await Promise.all([store.load(), plansClient.load()]);
    return r;
  };
  // Your plan as the opt-in would work it out, and nothing saved.
  const optInAfter = previewBuckets && basePlan.age !== null ? detailedRun('opt-in', basePlan, measured, count, detailedInput({ plan: basePlan, tax: yourChoices, facts: shared.taxFacts, today: previewBuckets, paid: paidToday, calendarYear }), baseRun) : null;

  // The bar, its heading and its Plans button, the copy's card (with
  // the Timeline that fixes it, when it is refused) and the panel shown:
  // what a switch scrolls to, and what focus moves to.
  const barRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const plansButtonRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // After the person's answer on the currency's card: focus on it, or on the
  // line it became, once drawn wherever it went.
  useEffect(() => {
    if (focusCurrency) currencyTarget()?.focus();
    // currencyTarget reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCurrency]);
  /** Scrolls `el` up when it is behind the pinned bar, to one --sp-2 under
   *  the bar, where Activity's and Budgets' segments land (their
   *  scroll-margin-top in app/globals.css). Where nothing is laid out (a
   *  test's document) every top is the same, and nothing moves. */
  const underBar = (el: HTMLElement | null) => {
    const bar = barRef.current;
    if (!el || !bar) return;
    const top = el.getBoundingClientRect().top;
    const bottom = bar.getBoundingClientRect().bottom;
    if (top >= bottom) return;
    const gap = parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue('--sp-2')) || 0;
    window.scrollBy(0, top - bottom - gap);
  };
  // The Plans sheet, and the button that opened it. Closed, the sheet gives
  // focus back to that button; when the button went while it was open (with
  // the copy's card: the copy was deleted or made your plan meanwhile), the
  // bar's Plans takes focus instead (below).
  const [plansOpen, setPlansOpen] = useState(false);
  const plansFrom = useRef<Element | null>(null);
  /** `within`: the bar's button, or the card's place. The button pressed is
   *  the one focused, where a browser focuses what is pressed; where none is
   *  (Safari), its card stands for it, gone exactly when it is. */
  const openPlans = (within: HTMLElement | null) => {
    const pressed = document.activeElement;
    plansFrom.current = within && pressed && within.contains(pressed) ? pressed : within;
    setPlansOpen(true);
  };
  const closePlans = () => setPlansOpen(false);
  // What takes focus once the bar has drawn the plan now shown: its heading
  // when a copy opens (from the Plans sheet, the Timeline, on your plan or inside
  // another copy), with the copy's card scrolled into view, since focus in
  // the pinned bar scrolls nothing; its Plans button when one is left, as
  // the arrow, the card and the sheet's row that left it are gone, or when
  // the sheet closes and the button that opened it has gone. Set by the
  // handler that opens or leaves, which closes the sheet in the same commit,
  // so the sheet gives focus back first and loses it to this. Run only by
  // the commit that changes the plan shown or the sheet: a commit in between
  // (a simulation's answer, say), its effects still waiting when the click
  // comes, would otherwise take the request before the bar has drawn what
  // it is for. A copy the tab closes itself (deleted elsewhere, a repair
  // waiting), or one deleted in the sheet, moves nothing.
  const focusNext = useRef<'title' | 'plans' | null>(null);
  useEffect(() => {
    const to = focusNext.current;
    focusNext.current = null;
    if (to === 'title') {
      titleRef.current?.focus({ preventScroll: true });
      underBar(cardRef.current);
    } else if (to === 'plans' || (!plansOpen && plansFrom.current && !plansFrom.current.isConnected)) {
      plansButtonRef.current?.focus({ preventScroll: true });
    }
    if (!plansOpen) plansFrom.current = null;
    // underBar reads only refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, plansOpen]);
  // A notice is about the copy as it was open: leaving it, or opening one,
  // starts without it.
  const leave = () => {
    setNotice(null);
    setOpenId(null);
    focusNext.current = 'plans';
  };
  const openCopy = (id: string | null) => {
    setNotice(null);
    setOpenId(id);
    if (id !== null && id !== openId) focusNext.current = 'title';
  };
  // Home's FI line lands on the bar's heading, which is there from the
  // tab's first render, the plan loaded or not.
  useEffect(() => {
    if (landing === null || Date.now() - landing > 10_000) return;
    titleRef.current?.focus({ preventScroll: true });
    onLanded?.();
    // Only when the dashboard hands it a new landing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landing]);

  // A segment chosen while the bar is pinned opens at its top, just under the
  // bar, not where the last one was scrolled to; at the copy's card instead
  // while that says something about the copy never to be scrolled past (its
  // amounts typed in another currency, lasting changes below zero, values to
  // fix, a save's notice). An error after a change on the card stays where it is.
  const cardSays = !!entry && (other !== null || problem !== null || copyFixing || (notice !== null && notice.for === entry.id));
  const landOn = useRef<'panel' | 'card' | null>(null);
  useEffect(() => {
    const to = landOn.current;
    if (to === null) return;
    landOn.current = null;
    underBar(to === 'card' ? cardRef.current : panelRef.current);
    // Only when the segment has just been switched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment]);
  const switchSegment = (s: PlanSegment) => {
    if (s === segment) return;
    landOn.current = cardSays ? 'card' : 'panel';
    chooseSegment(s);
  };

  // The status line says which plan the tab shows, so a switch is never
  // silent, and when another plan became yours.
  const everOpened = useRef(false);
  if (entry) everOpened.current = true;
  const shownStatus = entry ? `Showing the copy ${entry.name}.` : everOpened.current ? 'Showing your plan.' : '';
  const [mainSaid, setMainSaid] = useState('');
  // A copy's "They're in" relabels its amounts into your plan's currency.
  // Once that is recorded it can't move, so it is offered at once. Before,
  // for a plan with nothing typed it is the accounts', which may read
  // otherwise while they load or tie (shownReliably): not offered until it
  // can be told; and while not known, not until the person has said.
  const confirmWhyNot =
    currencyState.kind === 'recorded'
      ? null
      : currencyState.kind === 'unknown'
        ? 'Say which currency your plan’s figures are in first (above): this is offered once you have.'
        : reliably.ok || picked
          ? null
          : reliably.why === 'loading' || reliably.why === 'failed' || reliably.why === 'problem' || reliably.why === 'empty-balance'
            ? 'Your plan’s currency is the one most of your invested accounts are in, and your accounts haven’t all loaded without a problem, so it may read otherwise for now: this isn’t offered until they have.'
            : 'Your plan’s currency can’t be told from your accounts: say which you’ll type your plan’s figures in first (above), and this is offered then.';
  // What the plan's items do to the FI card's figures, a line each: for any
  // item, whatever it is timed by.
  const lifeNotes: string[] = [];
  if (shown && (entry || shownPlan.items.length > 0)) {
    const inNumber = numberSpending(shown);
    if (inNumber && shown.view.spending.value !== null) lifeNotes.push(`FI number from ${retirementText(inNumber.spending, inNumber.lasting, shown.view.spending.value, money)}.`);
    const later = laterText(shown.events?.later ?? [], money);
    if (later) lifeNotes.push(later);
    if (shownPlan.items.length > 0) lifeNotes.push(`${view.barista !== null ? 'Coast and Barista FI count' : 'Coast FI counts'} only lasting changes in spending, not ${entry ? 'this copy’s' : 'your plan’s'} other items.`);
  }
  // How many plans there are, for the bar's and the card's Plans: none said
  // until they are listed (after a failed reload the client keeps the list
  // it had, but the sheet shows only why it couldn't load).
  const plansShown = plansState.status === 'ready' ? plansCount(plansState) : null;

  /** Makes a copy of `from` (your plan's id, or a copy's) named `name`, with
   *  `whole` in it when given (Try it's item), else as it is; opens it when
   *  `openIt`. Your plan's first save, when it has none, is made with it,
   *  so your plan is read again once it is made (not when refused: the read
   *  takes the Timeline's sheet off the page, and its form with why). */
  const createCopy = async (from: string, name: string, openIt: boolean, whole?: FirePlanV2, tax?: TaxChoices): Promise<true | string> => {
    if (state.status !== 'ready') return READING_AGAIN;
    const source = from === plansState.main ? { plan: basePlan, currency: sendCurrency.current } : views.get(from);
    if (!source) return 'That plan changed since this opened, so nothing was made: open it again.';
    const currency = 'row' in source ? (entryHoldsAmounts(source.plan, source.row.tax) ? source.row.currency : sendCurrency.current) : source.currency;
    const r = await plansClient.create({ from, name, plan: whole ?? source.plan, currency, ...(tax ? { tax } : {}) });
    if ('error' in r) return r.error;
    if (stampRef.current === null) void store.load();
    // The copy opens with the sheet closed, in one commit, as Open it does,
    // so the sheet's focus going back loses to the copy's heading.
    if (openIt) {
      closePlans();
      openCopy(r.ok.id);
    }
    return true;
  };
  /** The Timeline's Try it: a copy of your plan with the item in it (in place
   *  of the one it changes, else added). */
  const tryItem = (item: PlanItem, name: string) => createCopy(plansState.main, name, true, withItem(basePlan, item));
  /** Try it, from Compare or Tune: a copy of the plan shown with a rule, opened on
   *  Drawdown. `until` goes in its name, as a tuned setting's end says which it is. */
  const tryRule = async (strategy: Strategy, until: number | null = null): Promise<true | string> => {
    const name = copyNameFor(strategy.conversions, plansState.list, until);
    const r = await createCopy(entry ? entry.id : plansState.main, name, true, undefined, { ...detailChoices, strategy });
    if (r === true) close();
    return r;
  };
  const renamePlan = async (id: string, name: string): Promise<true | string> => {
    const row = plansState.list.find((r) => r.id === id);
    if (!row) return 'That plan changed since this opened, so nothing was renamed: open it again.';
    const mine = id === plansState.main;
    if (mine && state.status !== 'ready') return READING_AGAIN;
    const r = await plansClient.rename(id, name, mine ? stampRef.current : row.updated_at);
    // Your plan's version moves with its name: read again, so its next save
    // names the new one.
    if (mine) void store.load();
    return 'error' in r ? r.error : true;
  };
  const deletePlan = async (id: string, unreadable: boolean): Promise<true | string> => {
    const row = plansState.list.find((r) => r.id === id);
    const r = await plansClient.remove(id, row?.updated_at ?? null, unreadable);
    return 'error' in r ? r.error : true;
  };
  // Make this your plan: the copy becomes yours, and yours a copy. Its answer
  // goes into the shared copy of the Plan's inputs at once, so Home's line
  // moves with it, and your plan and the list are read again; the copy
  // closes, since it is your plan now, and the status line says so.
  const makeMain = async (id: string): Promise<true | string> => {
    const row = plansState.list.find((r) => r.id === id);
    if (!row || row.updated_at === null) return 'That plan changed since this opened, so it wasn’t made your plan: open it again.';
    mainSeen.current = id;
    const r = await plansClient.makeMain(id, row.updated_at);
    if ('error' in r) return r.error;
    planInputs.adopt(r.ok.body);
    void store.load();
    if (openId === id) {
      setNotice(null);
      setOpenId(null);
      if (!plansOpen) focusNext.current = 'plans';
    }
    setMainSaid(`“${row.name}” is your plan now.`);
    return true;
  };
  const relabelCopy = async (): Promise<true | string> => {
    if (!entry || !planCurrency) return 'It wasn’t saved. Try again in a moment.';
    const r = await plansClient.relabel(entry.id, planCurrency, entry.updated_at);
    return 'error' in r ? r.error : true;
  };
  const outcomeOf = (f: PlanFigures | FiguresRefused | null, a: Pick<DetailedAnswer, 'working' | 'failed'>): PlanOutcome =>
    !f || 'refused' in f ? { kind: 'not-run', reason: REFUSED_TEXT } : a.failed ? { kind: 'not-run', reason: JOB_FAILED_TEXT } : { kind: 'figures', figures: f, working: a.working, held: detailHeld };
  // Every plan that reads, as the sheet lists it: yours first, then the
  // copies, each with its figures (the sheet words how each differs).
  const sheetPlans: SheetPlan[] =
    !planLoaded || plansState.status !== 'ready'
      ? []
      : plansState.list.flatMap((row): SheetPlan[] => {
          if (row.id === plansState.main) return [{ id: row.id, name: row.name, isMain: true, updatedAt: row.updated_at, plan: basePlan, outcome: outcomeOf(baseRun, baseAnswer) }];
          const v = views.get(row.id);
          if (!v) return [];
          const outcome: PlanOutcome = v.other ? { kind: 'not-run', reason: currencyText(v.other, planCurrency ?? v.other, currencyKnown) } : outcomeOf(v.figures, v);
          return [{ id: row.id, name: row.name, isMain: false, updatedAt: row.updated_at, plan: v.plan, outcome, choices: choicesBeside(row.tax), taxWorked: detailShown }];
        });
  // Mounted always, closed or open, from its first render: the plans picked
  // for Compare last for the visit, and the sheet can be opened while the
  // plan loads (it says why nothing opens yet).
  const plansSheet = (
    <PlansSheet
      open={plansOpen}
      onClose={closePlans}
      state={plansState}
      plans={sheetPlans}
      measuring={txnsLoading}
      planState={planLoaded ? 'ready' : state.status}
      whyNot={
        state.status === 'error'
          ? 'Your saved plan couldn’t be read, so your plans can’t be worked out against it: try again at the top of the Plan tab.'
          : !planLoaded
            ? 'Your plan is still loading: plans open, and are compared, once it has.'
            : repairing
              ? 'Your saved plan has values to fix first (at the top of the Plan tab): plans open once it is saved.'
              : null
      }
      openId={entry ? entry.id : null}
      onOpen={openCopy}
      onCreate={(from, name, openIt) => createCopy(from, name, openIt)}
      onRename={renamePlan}
      onDelete={deletePlan}
      onMakeMain={makeMain}
      onRetry={() => void plansClient.load()}
      run={(job, signal) => runner().run(job, signal)}
      cache={answers}
      method={basePlan.method}
      money={money}
      today={inputs.today}
    />
  );
  // Lasting changes below zero: nothing is worked out, and the Timeline's
  // items are what to change, so they stay with the card, on every segment.
  const refused = !!openFigures && 'refused' in openFigures;
  const choicesOpen = entry ? choicesBeside(entry.tax) : null;
  const copyCard = entry && openView && (
    <CopyCard
      parts={[...copyDiffParts(basePlan, openView.plan, money, { taxWorked: detailShown }), ...(choicesOpen ? choicesDiffParts(choicesOpen, money) : [])]}
      taxLine={detailShown && entry.tax === null ? 'It takes your plan’s tax settings.' : null}
      other={other}
      currencyLine={other && planCurrency ? currencyText(other, planCurrency, currencyKnown) : null}
      confirmWhyNot={confirmWhyNot}
      planCurrency={planCurrency}
      problem={problem}
      repair={copyFixing ? { text: copyRepairText(openView.fixed, money), onSave: async () => said(await saveShown(openView.plan)) } : null}
      notice={notice && notice.for === entry.id ? notice.text : null}
      editable={editable}
      onRelabel={relabelCopy}
      onMakeMain={() => makeMain(entry.id)}
      plansCount={plansShown}
      onPlans={() => openPlans(cardRef.current)}
    />
  );

  // Until the saved plan has first loaded, each segment is its skeleton, never
  // the defaults as if they were saved. Everything else is drawn the same
  // way loaded or not, so the bar and the sheets stay the same elements when
  // the plan arrives: its heading keeps focus, an open sheet stays open.
  const firstLoad = state.status === 'loading' && state.value === null;
  // Each panel's cards stacked 16px apart, as Budgets' segments are; the
  // stack is inside the panel, whose [hidden] its display would beat.
  const panel = (s: PlanSegment, body: React.ReactNode) => (
    <div className="plan-panel" id={planPanelId(s)} role="tabpanel" aria-labelledby={planTabId(s)} hidden={s !== segment} ref={s === segment ? panelRef : undefined}>
      {firstLoad ? (
        <PlanPanelSkeleton segment={s} />
      ) : (
        <div className="stack loose">{body}</div>
      )}
    </div>
  );
  // While the saved plan is read again with one kept (Try again, a currency
  // record that changed elsewhere), the figures' rows open nothing: a sheet
  // opened then would hold the plan the load replaces, and save it back.
  const reloading = state.status === 'loading' && !firstLoad;
  // An open copy with amounts typed in another currency, or lasting changes
  // below zero, has nothing worked out: its card says why, on every segment.
  const worked = shown !== null;
  // Every plan listed counts toward the most kept, readable or not; a copy's
  // amounts are in your plan's currency.
  const plansFull = plansCount(plansState) >= MAX_FIRE_PLANS;
  const canTry = editable && canOpen && plansState.status === 'ready' && !plansState.saving && !plansFull && basePlan.age !== null && planCurrency !== null;
  const tryWhy = !currencyKnown ? (
    <p className="helper">Say which currency your plan’s figures are in first (above): a copy’s amounts are in it.</p>
  ) : planCurrency === null ? (
    <p className="helper">Your plan has no currency yet (no accounts to take it from), so an item’s amounts have none: add an account first.</p>
  ) : plansState.status === 'loading' ? (
    <p className="helper">Your plans are still loading.</p>
  ) : plansState.status === 'error' ? (
    <Notice level="caution">
      {plansState.error}{' '}
      <button type="button" className="btn secondary" onClick={() => void plansClient.load()}>
        Try again
      </button>
    </Notice>
  ) : plansFull ? (
    <p className="helper">You have {MAX_FIRE_PLANS} plans, the most Nya keeps: delete one in Plans to try another.</p>
  ) : null;
  const timeline = planLoaded && (
    <TimelineCard
      plan={shownPlan}
      figures={shown}
      refused={refused || baseRefused}
      measured={measured}
      count={count}
      figuresFor={(slot, p) => figuresFor(slot, p, entry ? entry.tax : yourChoices)}
      figuresVersion={`${searchVersion}:${detailKey}`}
      firedFor={({ sim: run, trigger, offset }, signal) => runner().run({ kind: 'fired', method: plan.method, plan: run, trigger, offset }, signal).then((r) => (r.ok && r.kind === 'fired' ? r.fired : null))}
      copyName={copyName}
      version={shownFor ?? storedKey}
      editable={timelineEditable}
      paused={timelinePaused}
      money={money}
      planInWalk={planInWalk}
      savings={view.savings.value}
      onSave={saveTimeline}
      alsoFor={(id) => itemChoices(alsoTargets, id, money)}
      tryIt={entry ? null : { can: canTry, why: tryWhy, plans: plansState.list, onTry: tryItem }}
      onAskAge={() => open({ kind: 'about' }, 'ask-timeline')}
      askRef={(el) => inputRowRef('ask-timeline', el)}
      firstRef={(el) => inputRowRef('timeline-first', el)}
      reloading={reloading}
    />
  );
  // The currency, quiet, is a line at the foot of Your figures, beside the
  // figures it is about, so nothing above the bar arrives as the plan loads;
  // above the bar while it needs the person, or with Your figures not drawn.
  const currencyInFigures = planLoaded && quietCurrency && worked;
  regionShown.current = !currencyInFigures || segment === 'path';
  // Whether focus is in the card or its line as it is now, read before it
  // moves: when it moves on its own (the accounts say something new, a
  // copy opens), focus follows it rather than falling to the page.
  if (typeof document !== 'undefined' && regionRef.current) currencyHadFocus.current = regionRef.current.contains(document.activeElement);
  useEffect(() => {
    const lost = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;
    if (currencyHadFocus.current && lost) currencyTarget()?.focus();
    currencyHadFocus.current = false;
    // currencyTarget reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currencyInFigures]);

  return (
    <>
      {state.status === 'error' && (
        <div className="card">
          <Notice level="critical" role="alert">
            {state.error}
          </Notice>
          <p className="panel-note">The figures below use the default assumptions until your saved ones load.</p>
          <button className="secondary" style={{ marginTop: 12 }} onClick={() => void store.load()}>
            Try again
          </button>
        </div>
      )}
      {state.saveError && (
        <div className="plan-save-error">
          <Notice level="critical" role="alert">
            {state.saveError}
          </Notice>
        </div>
      )}
      {repairing && savers.repair && <RepairCard fixed={repair.fixed} editable={state.status === 'ready' && !state.saving && currencyKnown} onSave={savers.repair} money={money} />}
      {planLoaded && !currencyInFigures && currencyCard}
      <CurrencyChangeSheet
        mode={currencyMode.kind === 'recorded' ? currencyMode : null}
        changing={changing}
        onChanging={setChanging}
        disabled={currencyBusy || !planLoaded}
        onAnswer={(c) => recordCurrency(c, true)}
      />
      <div className="visually-hidden" role="status">
        {shownStatus}
      </div>
      <div className="visually-hidden" role="status">
        {currencySaid}
      </div>
      <div className="visually-hidden" role="status">
        {mainSaid}
      </div>
      <PlanBar
        ref={barRef}
        titleRef={titleRef}
        plansRef={plansButtonRef}
        segment={segment}
        onSegment={switchSegment}
        copy={copyName}
        plansCount={plansShown}
        onPlans={() => openPlans(plansButtonRef.current)}
        onBack={leave}
      />
      {/* The open copy's card, under the bar on every segment, and when it
          is refused for lasting changes below zero, its Timeline, the items
          to change, with it. */}
      {entry && (
        <div ref={cardRef}>
          {copyCard}
          {refused && timeline}
        </div>
      )}

      {panel(
        'path',
        <>
        {worked && (
          <>
            <FiCard
              copyName={copyName}
              lifeNotes={lifeNotes}
              retirementSpending={shown ? (numberSpending(shown)?.spending ?? null) : null}
              walked={shown?.walked ?? false}
              walkedSavings={shown?.walkedSavings ?? null}
              walkFrom={shown?.walkFrom}
              moved={movedText}
              onMovedSeen={onMovedSeen}
              childMoved={childMoved}
              onChildMovedSeen={onChildMovedSeen}
              fiShort={shown?.short ? shortText(shown.short, plan.age, money) : null}
              stopShort={
                stopShort && view.stopAge !== null
                  ? sameShort(stopShort, shown?.short ?? null)
                    ? `Nothing is projected at ${view.stopAge}, for the reason under the answer.`
                    : shortText(stopShort, plan.age, money, `nothing is projected at ${view.stopAge}`)
                  : null
              }
              stopWalked={stopWalked}
              path={path}
              range={range}
              onRange={chooseRange}
              ticks={drawn?.whole && yearContext ? drawdownMarks(drawn.whole.years, yearContext.rmdAge) : null}
              recorded={overlay}
              currency={displayCurrency}
              onAskAges={() => open({ kind: 'about' }, 'ask-about')}
              askRef={(el) => inputRowRef('ask-about', el)}
              onFiNumber={() => open({ kind: 'fi-number' }, 'fi-how')}
              fiNumberRef={(el) => inputRowRef('fi-how', el)}
              held={reloading}
              working={shownWorking}
              failed={shownFailed}
              onRetryDetail={search.retry}
              plan={plan}
              view={view}
              unread={unread}
              withoutTransactions={txnWithout}
              transactionCount={figureArgs.transactionCount}
              assets={assets}
              currencyNote={currencyNote}
              convertedNote={convertedNote}
              money={money}
            />

            <InputsCard
              figures={figureTexts}
              view={view}
              plan={plan}
              money={money}
              copyName={copyName}
              held={reloading}
              onOpen={(kind) => {
                // Flat, this row is the way in.
                if (kind === 'tax') open(taxWorked ? { kind } : shownPlan.age === null ? { kind: 'about' } : { kind: 'opt-in' }, kind);
                else open(kind === 'about' || kind === 'assumptions' || kind === 'fi-number' || kind === 'health' ? { kind } : { kind: 'figure', figure: kind }, kind);
              }}
              rowRef={inputRowRef}
              health={healthRow}
              tax={taxRow}
              fiSub={fiSub}
              fiHeld={fiHeld}
              currency={currencyInFigures ? currencyCard : null}
            />

            {timeline}
          </>
        )}
        {/* Your plan isn't worked out: why, and its Timeline, to fix it. */}
        {baseRefused && (
          <>
            <Notice level="critical">{REFUSED_TEXT}</Notice>
            {timeline}
          </>
        )}
        {/* Progress against the plan saved as your plan (rollout 8e): the
            Plan's, whatever is open, so outside what a copy can refuse. */}
        {planLoaded && (
          <PlanProgress
            progress={progress}
            plan={basePlan}
            savings={figures.view.savings}
            currency={figures.currency}
            institutions={institutions}
            blocked={progressBlocked}
            copyOpen={entry !== null}
            items={savedItems}
            moved={movedNew}
            onMovedSeen={onMovedSeen}
            childOut={childOut}
            flatLine={progressFlatLine}
          />
        )}
        </>
      )}

      {panel(
        'drawdown',
        <>
          {/* What may leave the inputs the simulation uses low, once, above
              the cards it is about, each of which has its badge. */}
          {worked && <FigureCaveats notes={[...stressNotes, ...honesty]} />}

          {worked && (
            <SimulationCard
              copyName={copyName}
              startsWith={shown?.startsWith ?? null}
              ages={shown?.resolution.ages ?? []}
              retirementLine={shown?.retirement && view.spending.value !== null ? `Spending in retirement: ${retirementText(shown.retirement.spending, shown.retirement.lasting, view.spending.value, money)}.` : null}
              plan={plan}
              notes={shown?.itemNotes ?? []}
              view={shown?.retirement ? { ...view, spending: { ...view.spending, value: shown.retirement.spending } } : view}
              engine={engine}
              outcome={outcome}
              pending={pending}
              failed={shownFailed}
              detail={drawn ? { t: shownShares && plan.start === 'fi-number' && plan.fiNumber === null ? shownShares.t : drawn.start.t, lawYear: drawn.law.year } : null}
              setupHeld={holdSim}
              money={money}
              currency={displayCurrency}
              badge={stressBadge}
              onRetry={retry}
              onRetryDetail={search.retry}
              startAtStop={(editable || state.saving || plansState.saving) && !other && !copyFixing && formPlan.start !== 'at-stop' && view.stopAge !== null ? () => savers.form({ ...formPlan, start: 'at-stop' }) : null}
              startBusy={state.saving || plansState.saving}
            />
          )}

          {/* A detailed plan's years at a steady growth; a flat plan's way to them. */}
          {worked && detailStuck && <Notice level="caution">Tax couldn’t be worked out for this plan, so it uses the flat rate.</Notice>}
          {worked && drawn && yearContext && !shownFailed && (
            <>
              <DrawdownCard
                copyName={copyName}
                detail={drawn}
                realReturn={plan.realReturn}
                money={money}
                rmdAge={yearContext.rmdAge}
                joint={shared.taxFacts.filing === 'joint' && plan.partnerAge !== null}
                held={reloading}
                working={shownWorking}
                onStage={(at) => open({ kind: 'stage', at }, `stage-${at}`)}
                stageRef={(at, el) => inputRowRef(`stage-${at}`, el)}
                titleRef={(el) => inputRowRef('years', el)}
              />
              <HowYouDrawCard
                copyName={copyName}
                strategy={detailChoices.strategy}
                defaultUntil={shownUntil ?? yearContext.rmdAge - 1}
                money={money}
                held={reloading}
                onOrder={() => open({ kind: 'order' }, 'order')}
                onConversions={() => open({ kind: 'conversions' }, 'conversions')}
                orderRef={(el) => inputRowRef('order', el)}
                conversionsRef={(el) => inputRowRef('conversions', el)}
              />
              {compare.length > 0 && (
                <CompareCard
                  rows={compare}
                  money={money}
                  realReturn={plan.realReturn}
                  lawYear={drawn.law.year}
                  healthGrowth={yearContext.healthGrowth}
                  acaLaw={yearContext.acaLaw}
                  copyName={copyName}
                  held={reloading}
                  working={shownWorking}
                  onRule={(r) => open({ kind: 'rule', key: r.key }, `rule-${r.key}`)}
                  ruleRef={(key, el) => inputRowRef(`rule-${key}`, el)}
                  tunable={shownPlan.rule === 'constant'}
                  onTune={() => open({ kind: 'tune' }, 'tune')}
                  tuneRef={(el) => inputRowRef('tune', el)}
                />
              )}
              <DrawdownMore onGoPath={() => switchSegment('path')} />
            </>
          )}
          {worked && offerDetail && (
            <OptInRow
              copy={entry !== null}
              noAge={plan.age === null}
              held={reloading}
              onOpen={() => (plan.age === null ? open({ kind: 'about' }, 'opt-in') : open({ kind: 'opt-in' }, 'opt-in'))}
              rowRef={(el) => inputRowRef('opt-in', el)}
            />
          )}

          {worked && 'sim' in engine && !holdSim && (
            <GridCard
              copyName={copyName}
              plan={plan}
              cells={shownGrid?.cells ?? null}
              failed={shownGrid?.failed ?? []}
              unavailable={shownGrid?.unavailable ?? false}
              onRetry={retry}
              rates={gridRates}
              years={gridYears}
              current={{ rate: vpw ? null : engine.rate, years: engine.sim.years }}
              ownCell={engine.sim.tax && !pending && outcome && 'result' in outcome ? answerCell(outcome.result, vpw ? null : engine.rate) : null}
              sampled={engine.sim.tax !== undefined}
              startBalance={engine.sim.startBalance}
              money={money}
              badge={stressBadge}
              sayHypothetical={!simulationAnswered(engine, outcome)}
            />
          )}

          <StressRows plan={plan} held={reloading} onOpen={(kind) => open(kind === 'stress-assumptions' ? { kind: 'assumptions', at: 'stress' } : { kind: 'numbers' }, kind)} rowRef={inputRowRef} />
        </>
      )}

      {panel(
        'portfolio',
        worked && (
          <AllocationCard
            allocation={allocation}
            plan={plan}
            onUseMix={(mix, returnTo) => {
              mixHeading.current = returnTo;
              open({ kind: 'assumptions', at: 'mix', mix }, 'mix');
            }}
            settingsLocked={!savers.allocationSettings}
            copyName={copyName}
            planKey={shownFor ?? 'plan'}
            institutions={institutions}
            balancesAsOf={balancesAsOf}
            typedBasis={typedBasis}
          />
        )
      )}
      {/* Before the Plan has decided where it opens, no panel is shown: a
          skeleton in none of them, of no segment's words. */}
      {segment === null && <PlanPanelSkeleton segment={null} />}

      <Sheet
        open={!!sheet}
        title={shownSheet ? (shownSheet.kind === 'figure' ? (figureLevel?.title ?? FIGURE_TITLES[shownSheet.figure]) : shownSheet.kind === 'stage' ? (sheetYear ? yearTitle(sheetYear) : sheetStage ? stageTitle(sheetStage) : 'Year by year') : shownSheet.kind === 'rule' ? (sheetRule ? ruleTitle(sheetRule.strategy.conversions, sheetRule.strategy.convertUntil) : 'Roth conversions') : tuneLevelShown ? ruleTitle(tuneLevelShown.run.strategy.conversions, tuneLevelShown.run.strategy.convertUntil) : SHEET_TITLES[shownSheet.kind]) : ''}
        onClose={() => {
          if (levelSaves === 0) close();
        }}
        onBack={
          figureLevel
            ? () => {
                if (levelSaves === 0) setFigureLevel(figureLevel.kind === 'bucket' ? { kind: 'account', account_id: figureLevel.account_id, title: figureLevel.back } : null);
              }
            : sheetYear
              ? () => setYearLevel(null)
              : tuneLevelShown
                ? () => {
                    if (levelSaves === 0) setTuneLevel(null);
                  }
                : undefined
        }
        level={figureLevel ? `${figureLevel.kind}:${figureLevel.title}` : sheetYear ? `year:${sheetYear.age}` : tuneLevelShown ? `tune:${tuneLevelShown.key}` : undefined}
      >
        {/* Atop every sheet of the copy open, so one isn't taken for your plan. */}
        {shownSheet && shownSheet.kind !== 'numbers' && <CopyTag name={copyName} />}
        {shownSheet?.kind === 'about' && <AboutForm key={opened} {...formProps} detail={detailForm} />}
        {shownSheet?.kind === 'health' && detailForm && (
          <PlanHealthForm
            key={opened}
            {...formProps}
            detail={detailForm}
            stateName={detailChoices.state ? STATE_NAMES[detailChoices.state] : null}
            medicaid={detailChoices.state === null ? null : lawNow.medicaidStates[detailChoices.state]}
            defaultGrowth={defaultGrowth}
            partner={plan.partnerAge !== null}
            paidChoices={paidChoices}
            paidAmount={inputs.paidFor}
            stages={shownShares ? stageHealthLines(shownShares.drawn.stages, shownShares.drawn.years, money) : drawn ? stageHealthLines(drawn.start.stages, drawn.start.years, money) : []}
            lawYear={lawNow.year}
            money={money}
          />
        )}
        {shownSheet?.kind === 'fi-number' && (
          <FiNumberForm
            key={opened}
            {...formProps}
            view={view}
            retirementSpending={shown ? (numberSpending(shown)?.spending ?? null) : null}
            leftOut={path?.after?.leftOut ?? null}
            money={money}
            shares={shownShares}
            held={fiHeld}
            cautions={shownShares && detailChoices.health.beforeMedicare === null ? [HEALTH_NOT_SET] : []}
            lawYear={lawNow.year}
          />
        )}
        {shownSheet?.kind === 'tax' && (
          <PlanTaxSheet
            key={opened}
            shares={shownShares}
            held={fiHeld}
            number={view.workedOut ?? (plan.fiNumber === null ? view.fiNumber : null)}
            ownNumber={plan.fiNumber !== null}
            converts={detailChoices.strategy.conversions.kind !== 'none'}
            withdrawalRate={plan.withdrawalRate}
            realReturn={plan.realReturn}
            start={drawn && (plan.start !== 'fi-number' || plan.fiNumber !== null) ? drawn.start : null}
            startBalance={'sim' in engine ? engine.sim.startBalance : null}
            hypothetical={taxHypothetical({ lawYear: lawNow.year, state: detailChoices.state, stateRate: detailChoices.stateRate, stateTaxes: detailChoices.state ? lawNow.stateIncomeTax[detailChoices.state] : null, converts: detailChoices.strategy.conversions.kind !== 'none', realReturn: plan.realReturn, healthGrowth: detailChoices.health.growth ?? lawNow.healthGrowth.overPrices })}
            money={money}
            onYears={
              drawn
                ? () => {
                    openedFrom.current = 'years';
                    close();
                    switchSegment('drawdown');
                  }
                : null
            }
            onFlatRate={entry ? null : () => chooseModel({ kind: 'model', model: 'flat' })}
            onDone={closeFor(opened)}
          />
        )}
        {shownSheet?.kind === 'order' && detailForm && <OrderForm key={opened} {...formProps} detail={detailForm} />}
        {shownSheet?.kind === 'conversions' && detailForm && (
          <ConversionsForm
            key={opened}
            {...formProps}
            detail={detailForm}
            defaultUntil={shownUntil ?? (yearContext ? yearContext.rmdAge - 1 : 74)}
            onAca={(drawn?.start.aca.on ?? 0) > 0}
            partner={shared.taxFacts.filing === 'joint' && plan.partnerAge !== null}
            preview={previewConversions}
            movingStart={plan.start === 'fi-number' && plan.fiNumber === null && 'sim' in engine ? engine.sim.startBalance : null}
            lawYear={drawn?.law.year ?? lawNow.year}
            money={money}
          />
        )}
        {sheetRule && drawn && (
          <RuleLevel
            key={opened}
            row={sheetRule}
            money={money}
            lawYear={drawn.law.year}
            copyOpen={entry !== null}
            whyNot={editable && canOpen && plansState.status === 'ready' && !plansState.saving && planCurrency !== null ? null : (paused ?? 'A copy can’t be made just yet. Try again in a moment.')}
            onTry={() => tryRule(sheetRule.strategy)}
          />
        )}
        {shownSheet?.kind === 'tune' && detailForm && (
          <TuneForm
            key={opened}
            {...formProps}
            detail={{ ...detailForm, save: (next, more, also) => heldBy(detailForm.save(next, more, also)) }}
            job={drawn && shownInput ? { tune: true, plan: shownPlan, measured, count, detailed: shownInput } : null}
            offers={{
              aca: !!drawn && drawn.start.aca.on > 0 && shownInput?.health.acaLaw !== 'enhanced',
              irmaa: !!drawn && drawn.start.years.some((y) => y.care.people.some((p) => p.status === 'medicare')),
            }}
            irmaaUnknown={!!drawn && drawn.start.notes.includes('irmaa-unknown')}
            held={shownWorking}
            level={tuneLevelShown}
            onLevel={setTuneLevel}
            money={money}
            lawYear={drawn?.law.year ?? lawNow.year}
            healthGrowth={yearContext?.healthGrowth ?? 0}
            copyOpen={entry !== null}
            whyNot={editable && canOpen && plansState.status === 'ready' && !plansState.saving && planCurrency !== null ? null : (paused ?? 'A copy can’t be made just yet. Try again in a moment.')}
            now={drawn ? { drawn: drawn.start, stop: shown?.view.stopAge ?? null, start: shown && 'sim' in shown.engine ? shown.engine.sim.startBalance : null } : null}
            used={(strategy) => {
              const a = figuresFor('tune-level', shownPlan, { ...detailChoices, strategy });
              const f = a.figures;
              if ('refused' in f) return { drawn: null, stop: null, start: null, working: false, failed: true };
              const d = f.detail && !('failed' in f.detail) ? f.detail.start : null;
              return { drawn: d, stop: f.view.stopAge, start: 'sim' in f.engine ? f.engine.sim.startBalance : null, working: a.working, failed: a.failed || (d === null && !a.working) };
            }}
            onTry={(strategy) => heldBy(tryRule(strategy, strategy.convertUntil))}
          />
        )}
        {shownSheet?.kind === 'assumptions' && (
          <AssumptionsForm
            key={opened}
            {...formProps}
            fiSpending={shown ? (shown.retirement?.spending ?? view.spending.value) : null}
            assets={view.assets.value}
            spending={shown?.retirement?.spending ?? view.spending.value}
            currency={displayCurrency}
            allocationMix={shownSheet.mix ?? mixToOffer(allocation)}
            at={shownSheet.at ?? null}
            taxOnHold={figureArgs.taxOnHold}
            detail={detailForm}
            drawnRate={drawn?.start.rate ?? null}
            taxWorked={taxWorked}
            workedNumber={fiHeld ? null : view.workedOut}
            onFlatRate={entry ? null : () => chooseModel({ kind: 'model', model: 'flat' })}
            defaultGrowth={defaultGrowth}
            measuredYield={detailBuckets ? measuredYield(detailBuckets) : null}
          />
        )}
        {shownSheet?.kind === 'numbers' && <AboutNumbers detailed={detailShown} />}
        {shownSheet?.kind === 'opt-in' && (
          <OptInSheet
            key={opened}
            before={baseFigures}
            after={optInAfter && !optInAfter.failed && !('refused' in optInAfter.figures) ? optInAfter.figures : null}
            working={!optInAfter || optInAfter.working}
            coverageSet={detailChoices.health.beforeMedicare !== null}
            money={money}
            lawYear={lawFor(calendarYear).law.year}
            paused={formEditable ? null : (paused ?? 'This can’t be saved yet.')}
            onConfirm={() => chooseModel({ kind: 'opt-in' })}
            onDone={closeFor(opened)}
          />
        )}
        {sheetStage && drawn && yearContext && !sheetYear && <StageLevel stage={sheetStage} years={drawn.start.years} context={yearContext} cautions={sheetStage.key === 'before-60' ? rothCautions : []} openRuns={stageRuns} onRuns={setStageRuns} onYear={setYearLevel} />}
        {sheetYear && yearContext && <YearLevel year={sheetYear} context={yearContext} />}
        {shownSheet?.kind === 'figure' && (
          <FigureForm
            key={opened}
            {...formProps}
            kind={shownSheet.figure}
            currency={displayCurrency}
            measured={measuredInputs(inputs)[shownSheet.figure]}
            measuredText={flows ? `from ${windowText(flows)}` : ''}
            why={figureTexts[shownSheet.figure].why}
            assetsFor={(includeCash) => investedAssets(institutions, includeCash, balanceFx, Date.now(), ownCurrency, leaveOut)}
            workplacePlans={workplacePlansOf(institutions).map((p) => ({ account_id: p.account_id, label: `${p.institution} ${p.name}` }))}
            also={figureChoices(alsoTargets, shownSheet.figure, money)}
            buckets={bucketSheet(shownSheet.figure)}
            split={splitFor(shownSheet.figure)}
            mix={mixFor(shownSheet.figure)}
            detail={detailForm}
          />
        )}
      </Sheet>
      {plansSheet}
    </>
  );
}

/** What the repaired values were, for the card that says so. */
const REPAIR_NAMES: Record<string, string> = {
  age: 'your age',
  targetAge: 'your stop age',
  spending: 'the spending you typed',
  savings: 'the savings you typed',
  assets: 'the invested assets you typed',
  includeCash: 'whether cash counts as invested',
  withdrawalRate: 'the withdrawal rate',
  realReturn: 'the growth after inflation',
  taxRate: 'the tax rate',
  partTimeIncome: 'the part-time income',
  method: 'the method',
  rule: 'the withdrawal rule',
  start: 'where the simulation starts',
  startBalance: 'the starting balance',
  horizon: 'the length',
  allocation: 'the stock and bond mix',
  stocksPct: 'the stock and bond mix',
  bondsPct: 'the stock and bond mix',
  rebalance: 'the rebalancing',
  fee: 'the fund fee',
  floor: 'the floor',
  ceiling: 'the ceiling',
  income: 'other income',
  expenses: 'one-off expenses',
  items: 'the items past the 25 a plan holds',
  partnerAge: 'your partner’s age',
  stopAtFi: 'stopping when you reach FI',
  fiNumber: 'your own FI number',
  planFunding: 'how a workplace plan is paid into',
};

/** What a repair changed, in words: an income or one-off by its label, or by
 *  what it was when it has none; any other item (lib/fire/plan-v2.ts
 *  repairOf names it `items`) by its label. */
function repairName(f: Repair, money: (n: number) => string): string {
  if (!f.item) return REPAIR_NAMES[f.field] ?? f.field;
  const label = f.item.label.trim();
  if (f.field === 'income') return label ? `the income "${label}"` : `an income of ${money(f.item.amount)} a year from age ${f.item.age}`;
  if (f.field === 'items') return label ? `the item "${label}"` : 'an item';
  return label ? `the one-off "${label}"` : `a one-off of ${money(f.item.amount)} at age ${f.item.age}`;
}

/** A saved plan this release can't use as it is, and what the tab uses
 *  instead. Saved only from here: editing is paused until then, so no other
 *  save commits it unseen. */
export function RepairCard({ fixed, editable, onSave, money }: { fixed: Repair[]; editable: boolean; onSave: () => void; money: (n: number) => string }) {
  const whole = fixed.some((f) => f.field === 'plan');
  const what = names(fixed.map((f) => repairName(f, money)));
  const dropped = fixed.some((f) => f.item !== undefined || f.field === 'planFunding');
  return (
    <div className="card">
      <Notice level="critical" role="alert">
        <Masked>
          {whole
            ? "Your saved plan can't be used by this version of Nya, so the figures below use the defaults."
            : `Your saved plan has ${fixed.length === 1 ? 'a value' : 'values'} this version of Nya can't use: ${what}.`}
        </Masked>
      </Notice>
      <p className="panel-note">
        {whole
          ? 'Nothing is saved until you choose Save it this way, and editing is paused until then.'
          : `The figures below use the defaults instead${dropped ? ' and leave out what is named' : ''}. Nothing is saved until you choose Save it this way, and editing is paused until then, so nothing is dropped by accident. Everything else is as you saved it.`}
      </p>
      <button className="secondary" style={{ marginTop: 12 }} onClick={onSave} disabled={!editable}>
        Save it this way
      </button>
    </div>
  );
}

/** What a copy holds that doesn't fit your plan as it is now (your age
 *  moved past its stop age, say), for its card. */
function copyRepairText(fixed: Repair[], money: (n: number) => string): string {
  if (fixed.some((f) => f.field === 'plan')) return 'This copy can’t be used by this version of Nya with your plan as it is now, so it shows the defaults. Nothing is saved to it until you choose Save it this way.';
  const what = names(fixed.map((f) => repairName(f, money)));
  const dropped = fixed.some((f) => f.item !== undefined || f.field === 'planFunding');
  return `This copy has ${fixed.length === 1 ? 'a value that doesn’t' : 'values that don’t'} fit your plan as it is now: ${what}. It shows the defaults instead${dropped ? ' and leaves out what is named' : ''}, and nothing is saved to it until you choose Save it this way.`;
}

/** One line of the FI card: a label, its figure, and notes under them. */
function Row({ label, value, note, action }: { label: string; value: React.ReactNode; note?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="plan-row">
      <div className="plan-row-main">
        <span className="plan-row-label">{label}</span>
        <span className="plan-row-value">{typeof value === 'string' ? <Masked>{value}</Masked> : value}</span>
      </div>
      {(note || action) && (
        <div className="plan-row-note">
          <span>{typeof note === 'string' ? <Masked>{note}</Masked> : note}</span>
          {action}
        </div>
      )}
    </div>
  );
}

/** A detailed plan's search couldn't be run in a worker or on the page. */
const DETAIL_FAILED = 'Tax on this plan couldn’t be worked out on this page. It needs a connection the first time it runs after an update.';

/** The FI card: the FI number and how it is worked out, with what may leave
 *  it short said on it, and what follows from it (years to FI, Coast and
 *  Barista FI, the balance at the target age). The figures it rests on are
 *  the rows under it (InputsCard): of their inputs it reads only what its
 *  lines on the number need. */
export function FiCard({
  copyName = null,
  lifeNotes = [],
  retirementSpending = null,
  onFiNumber,
  fiNumberRef,
  walked = false,
  walkedSavings = null,
  walkFrom = { items: false, events: true },
  moved = null,
  onMovedSeen,
  childMoved = null,
  onChildMovedSeen,
  fiShort = null,
  stopShort = null,
  stopWalked = false,
  path = null,
  ticks = null,
  range,
  onRange,
  recorded = null,
  currency = null,
  onAskAges,
  askRef,
  held = false,
  working = false,
  failed = false,
  onRetryDetail,
  plan,
  view,
  unread,
  withoutTransactions = NO_CONNECTIONS_WITHOUT,
  transactionCount = 0,
  assets: measuredAssets,
  currencyNote,
  convertedNote = null,
  money,
}: {
  /** The open copy's name, said at the top; null with your plan open. */
  copyName?: string | null;
  /** What the plan's items do to these figures, a line each. */
  lifeNotes?: string[];
  /** Spending in retirement with the items' lasting changes, which
   *  the FI number is worked out from, when it differs from today's. */
  retirementSpending?: number | null;
  /** Opens the FI number's sheet, from How it's worked out. */
  onFiNumber?: () => void;
  fiNumberRef?: (el: HTMLButtonElement | null) => void;
  /** The answer came from the walk with the plan's items. */
  walked?: boolean;
  /** What that walk saves a year after the last change. */
  walkedSavings?: number | null;
  /** What moved the walk (lib/fire/plan-figures.ts walkFrom), for its words;
   *  left out, the plan's items. */
  walkFrom?: { items: boolean; events: boolean; tax?: boolean };
  /** D15's line while new (components/plan-moved.ts fiMovedText), under the
   *  answer's lines with Got it, which hides it for the session. */
  moved?: string | null;
  onMovedSeen?: () => void;
  /** D7's line while new (childMovedText), the same way with its own Got it. */
  childMoved?: string | null;
  onChildMovedSeen?: () => void;
  /** Why there is no FI date: a cost the walk can't pay. */
  fiShort?: string | null;
  /** Why there is no balance at the stop age: the walk can't get there. */
  stopShort?: string | null;
  /** The balance at the stop age is the walk's, with the plan's items. */
  stopWalked?: boolean;
  /** The plan's path from today (lib/fire/path.ts), drawn under the answer. */
  path?: PlanPath | null;
  /** The ages a detailed plan's rules change at, on Whole path. */
  ticks?: readonly DrawdownMark[] | null;
  /** The chart's range, and the switch between them (PlanPathChart); left
   *  out, the chart runs to the stop with no switch. */
  range?: PathRange;
  onRange?: (r: PathRange) => void;
  /** What was recorded since the plan saved as your plan, and where it had
   *  you, drawn before today on the chart (rollout 8e). */
  recorded?: ProgressOverlay | null;
  /** The currency the figures are in, for the chart. */
  currency?: string | null;
  /** Opens the Household sheet, from the ask under the answer while an age it
   *  needs isn't typed; and the ask's ref, for focus to come back to. */
  onAskAges?: () => void;
  askRef?: (el: HTMLElement | null) => void;
  /** The plan is being read again: the ask does nothing meanwhile. */
  held?: boolean;
  /** A detailed plan's answer is still being worked out: this one is dimmed. */
  working?: boolean;
  /** It couldn't be, so this says so in its place, with Try again. */
  failed?: boolean;
  onRetryDetail?: () => void;
  plan: PlanCore;
  view: FiView;
  /** Institutions whose transactions couldn't all be read. */
  unread: UnreadTransactions[];
  /** Connections that bring in no transactions (lib/no-transactions.ts). */
  withoutTransactions?: NoTransactionsView;
  /** How many transactions there are, entered by hand included: with any,
   *  there is spending to measure, whatever the connections bring in. */
  transactionCount?: number;
  assets: InvestedAssets;
  currencyNote: string | null;
  /** What was converted into the Plan's currency (lib/fire/progress.ts
   *  convertedNote), with a home currency. */
  convertedNote?: string | null;
  money: (n: number) => string;
}) {
  const { spending, savings, assets } = view;
  // What the figures under the card may be missing, said on the number:
  // the same flags as Drawdown's notice (components/plan-figure-notes.ts),
  // from the same inputs as the rows that say which.
  const { spendingMissing, assetsShort } = inputFlags({ view, unread, withoutTransactions, transactionCount, assets: measuredAssets });

  // Spending there but not measured is said so, never as none to count.
  const spendingNeed = view.spending.source === 'unmeasured' ? 'Needs your annual spending, which isn’t measured (below).' : null;
  // Under the answer, how it is worked out (or why there is none), said once:
  // it was the Years to FI row's note, whose figure only said the answer
  // again. Its "Around age 39" is the answer's own, so not said twice; with no
  // FI number the line on the FI number says why, so nothing here.
  const takes = formulasTake(plan);
  const need = view.yearsToFi === null && !fiShort ? figuresNeed(view, takes) : null;
  // What moved the walk, in its words (never none where the walk counts).
  const words = walkWords(walkFrom) ?? EVENTS_WORDS;
  const inTheirYears = walkFrom.items || walkFrom.events ? ' in their years' : '';
  let howLine = '';
  if (fiShort) {
    howLine = fiShort;
  } else if (walked && view.yearsToFi !== null && view.yearsToFi > 0 && view.yearsToFi !== Infinity) {
    howLine =
      words === EVENTS_WORDS
        ? `Growing a steady ${pct(plan.realReturn)} a year after inflation, with this plan’s items changing what is saved in their years.`
        : `Growing a steady ${pct(plan.realReturn)} a year after inflation, with ${words}${inTheirYears}.`;
  } else if (walked && view.yearsToFi === Infinity) {
    howLine =
      words === EVENTS_WORDS
        ? `With this plan’s items you’d save ${money(walkedSavings ?? 0)} a year after its last change, and growing ${pct(plan.realReturn)} a year after inflation that never reaches it.`
        : `With ${words}${inTheirYears} you’d save ${money(walkedSavings ?? 0)} a year after the last change, and growing ${pct(plan.realReturn)} a year after inflation that never reaches it.`;
  } else if (view.yearsToFi === Infinity) {
    howLine = `Saving ${money(savings.value ?? 0)} a year, growing ${pct(plan.realReturn)} a year after inflation, never reaches it.`;
  } else if (view.yearsToFi !== null && view.yearsToFi > 0) {
    howLine = `Saving ${money(savings.value ?? 0)} a year, growing a steady ${pct(plan.realReturn)} a year after inflation.`;
  } else if (view.yearsToFi === null && view.fiNumber !== null) {
    // A figure not measured is never taken as zero: the answer names what it
    // needs, and this says why (nothing when the answer says it all).
    howLine = notWorkedOutText(view, 'below', false) ?? '';
  }
  const notWorkedOut = notWorkedOutText(view, 'below', false);

  const fiSpending = retirementSpending ?? spending.value;
  // The answer first (rollout phase 8b): when FI comes, against the age you'd
  // like to stop, in the same words as Home's FI line. Where the projection
  // runs out before the stop age (at FI already, or after a copy reaches
  // it), it says so; a walk that never gets there says why under the answer.
  // Not worked out, the answer names what it needs, never "--".
  const runsOutAt = !fiShort && path?.short && plan.age !== null ? plan.age + path.short.year : null;
  const head = fiHeadline(view, { age: plan.age, stopAge: view.stopAge, stopAtFi: plan.stopAtFi }, { noDate: !!fiShort, runsOutAt, need, saving: (view.savings.value ?? 0) > 0 });
  // What qualifies the answer, under it by the hero's rules (design-system.md
  // "Status and honesty"): one in full, two or more on one line that opens to
  // each, every note in its own words. None is critical.
  const caveats: FigureNote[] = [];
  const caveat = (level: FigureNote['level'], kind: string, text: string | null | undefined) => {
    if (text) caveats.push({ key: `answer:${kind}`, level, kind, text });
  };
  caveat('caution', 'runs out before you stop', head.runsOut && `${head.runsOut} (below).`);
  caveat('caution', 'invested assets may be low', view.progress !== null && view.fiNumber !== null && assetsShort ? 'Invested assets may be low (below).' : null);
  caveat('caution', 'spending may be low', spendingMissing && `May be low: spending is missing ${spendingMissing} (below).`);
  caveat('caution', 'currency', currencyNote);
  caveat('info', 'converted', convertedNote);
  const asks = !!head.ask && !!onAskAges;
  if (failed) {
    return (
      <Hero id="plan-fi-title" level={3} label="Financial independence" className="plan-hero" top={copyName ? <CopyTag name={copyName} /> : undefined} figure="Not worked out" figureClass="plan-answer" line={<p className="helper">{DETAIL_FAILED}</p>}>
        <div>
          <button type="button" className="btn secondary" onClick={onRetryDetail}>
            Try again
          </button>
        </div>
      </Hero>
    );
  }
  return (
    <Hero
      id="plan-fi-title"
      level={3}
      label="Financial independence"
      className={working ? 'plan-hero plan-answer-pending' : 'plan-hero'}
      top={
        copyName || working ? (
          <>
            {copyName && <CopyTag name={copyName} />}
            {working && (
              <p className="plan-working-line" role="status">
                Working it out
              </p>
            )}
          </>
        ) : undefined
      }
      // Words, not amounts, but from the figures: through Masked, as every
      // line read from them is (test/amount-sources.ts).
      figure={<Masked>{head.headline}</Masked>}
      figureClass="plan-answer"
      line={
        (head.against || howLine || asks || moved || childMoved) && (
          <div className="stack tight plan-answer-lines">
            {head.against && (
              <p className="helper">
                <Masked>{head.against}</Masked>
              </p>
            )}
            {howLine && (
              <p className="helper">
                <Masked>{howLine}</Masked>
              </p>
            )}
            {/* Ages and names only, never an amount. */}
            {moved && (
              <Notice level="info">
                {moved}
                <div className="btn-row">
                  <button type="button" className="btn ghost" onClick={onMovedSeen}>
                    Got it
                  </button>
                </div>
              </Notice>
            )}
            {childMoved && (
              <Notice level="info">
                {childMoved}
                <div className="btn-row">
                  <button type="button" className="btn ghost" onClick={onChildMovedSeen}>
                    Got it
                  </button>
                </div>
              </Notice>
            )}
            {/* What the answer still needs from you: a line under it that
                opens the Household sheet, never a full-width button. */}
            {asks && (
              <div>
                <button
                  type="button"
                  className="btn ghost hero-ask"
                  ref={askRef}
                  aria-disabled={held ? 'true' : undefined}
                  onClick={() => {
                    if (!held) onAskAges!();
                  }}
                >
                  <Masked>{askAgesText(head.ask!)}</Masked>
                </button>
              </div>
            )}
          </div>
        )
      }
    >
      <FigureCaveats notes={caveats} />
      {view.progress !== null && view.fiNumber !== null && (
        <div>
          <div
            className="meter-track"
            role="meter"
            aria-label={`Invested assets are ${progressText(view.progress)} of the FI number`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(100, view.progress * 100))}
          >
            <div className={`meter-fill${view.progress >= 1 ? ' done' : ''}`} style={{ width: `${Math.min(100, view.progress * 100)}%` }} />
          </div>
          <div className="as-of">
            {view.progress >= 1 ? (
              <>
                <Masked>{money(assets.value ?? 0)}</Masked> invested · {progressText(view.progress)} of the FI number
              </>
            ) : (
              <>
                <Masked>{`${money(assets.value ?? 0)} of ${money(view.fiNumber)}`}</Masked> invested · {progressText(view.progress)} of the way
              </>
            )}
          </div>
        </div>
      )}
      {view.fiNumber !== null && onFiNumber && (
        <button type="button" className="btn ghost" aria-haspopup="dialog" ref={fiNumberRef} onClick={onFiNumber}>
          How it&apos;s worked out
        </button>
      )}
      {/* A worked-out number's arithmetic is in its sheet; your own number
          against it, and why there is none, stay here. */}
      {!(view.fiNumber !== null && plan.fiNumber == null && fiSpending !== null) && (
        <div className="as-of">
          <Masked>
            {view.fiNumber !== null && plan.fiNumber != null
              ? `Your own FI number ${money(view.fiNumber)}${view.workedOut !== null ? ` · worked out ${money(view.workedOut)}` : ''}`
              : !takes
                ? "Can't be worked out from the saved withdrawal rate, tax or growth after inflation: change them under Assumptions."
                : // With the answer just over it saying "Needs your annual
                  // spending", this says only why, or how, not that again.
                  head.headline === SPENDING_NEED
                  ? view.spending.source === 'unmeasured'
                    ? 'Your annual spending isn’t measured (below).'
                    : 'Connect accounts with transactions, or type it below.'
                  : (spendingNeed ?? 'Needs your annual spending: connect accounts with transactions, or type it below.')}
          </Masked>
        </div>
      )}
      {lifeNotes.map((n) => (
        <div key={n} className="as-of">
          <Masked>{n}</Masked>
        </div>
      ))}
      {path && (path.points.length >= 2 || wholeShown(path.points, path.after, range)) && plan.age !== null && view.stopAge !== null && (
        <PlanPathChart
          points={path.points}
          today={plan.age}
          stopAge={view.stopAge}
          fiNumber={view.fiNumber}
          fiAge={view.fiAge}
          realReturn={plan.realReturn}
          currency={currency}
          withEvents={path.fromWalk}
          walkWords={path.fromWalk ? words : null}
          recorded={recorded}
          after={path.after}
          range={range}
          onRange={onRange}
          ticks={ticks}
        />
      )}

      {/* What follows from the answer, at the hero's foot, as Home's foot
          row is in its hero. A figure not worked out says what it needs. */}
      <div className="plan-rows">
        <Row
          label="Coast FI"
          value={view.coast ? money(view.coast.number) : coastNeed({ age: plan.age, stopAge: view.stopAge, stopAtFi: plan.stopAtFi }, view, takes)}
          note={
            view.coast
              ? `With this much invested today you could stop saving now: growing ${pct(plan.realReturn)} a year after inflation, it reaches your FI number by age ${view.stopAge}. ${view.coast.reached === null ? 'Your invested assets aren’t measured (below), so whether you have that much isn’t said.' : view.coast.reached ? 'You have that much.' : `You have ${money(assets.value ?? 0)}.`}`
              : undefined
          }
        />
        {!view.barista && plan.fiNumber != null && plan.partTimeIncome > 0 && (
          <Row label="Barista FI" value="Not shown" note="Worked out from your spending, it could sit above your own FI number, so it isn’t shown while you have one." />
        )}
        {view.barista && (
          <Row
            label="Barista FI"
            value={money(view.barista.number)}
            note={`With ${money(plan.partTimeIncome)} a year of part-time income covering part of your spending${view.barista.yearsTo !== null ? (view.barista.yearsTo === 0 ? '. You have that much.' : view.barista.yearsTo === Infinity ? '. Not reached at this rate.' : `, ${yearsText(view.barista.yearsTo)} away.`) : notMeasuredWhat(view) ? `. How far away isn’t worked out: ${notMeasuredWhat(view)} measured (below).` : '.'}`}
          />
        )}
        {view.atTargetAge !== null && view.stopAge !== null && (
          <Row label={`At age ${view.stopAge}`} value={money(view.atTargetAge)} note={`Projected growing a steady ${pct(plan.realReturn)} a year after inflation${stopWalked ? `, with ${words} in the years they cover` : ''}. Real markets don't move steadily; the simulation on Drawdown shows how much that matters.`} />
        )}
        {view.atTargetAge === null && (notWorkedOut ?? stopShort) && plan.age !== null && view.stopAge !== null && (
          <Row
            label={`At age ${view.stopAge}`}
            // Projected from the invested assets and savings alone, so what
            // it needs is one of them, never the spending.
            value={notWorkedOut ? (projectionNeed(view, takes) ?? 'Not worked out') : 'Not projected'}
            note={(notWorkedOut ?? stopShort) as string}
          />
        )}
      </div>
    </Hero>
  );
}

/** A figure's notes, or Drawdown's notice, as TotalCaveats draws
 *  them: one in full, two or more gathered into a line that opens in place,
 *  each note's words through Masked. */
function FigureCaveats({ notes }: { notes: readonly FigureNote[] }) {
  return <TotalCaveats items={notes.map((n) => ({ key: n.key, severity: n.level, summary: n.kind, body: <Masked>{n.text}</Masked> }))} />;
}

/** Which sheet a figure's row opens. */
export type InputKind = 'fi-number' | 'spending' | 'savings' | 'assets' | 'about' | 'assumptions' | 'health' | 'tax';

/** Every row a sheet opens from, which focus goes back to as it closes:
 *  Your figures', Drawdown's, and Portfolio's "Use my allocation". */
type RowKind = InputKind | 'stress-assumptions' | 'numbers' | 'mix' | 'ask-about' | 'ask-timeline' | 'timeline-first' | 'fi-how' | 'opt-in' | 'years' | 'order' | 'conversions' | 'tune' | `stage-${number}` | `rule-${string}`;

/** A rule's name in a few words, for the Assumptions row. */
const RULE_SHORT: Record<FirePlan['rule'], string> = {
  constant: 'Constant',
  percent: 'Percent of portfolio',
  guardrails: 'Guardrails',
  vpw: 'VPW',
  'floor-ceiling': 'Floor and ceiling',
};

/**
 * Drawdown's last card (rollout 6d): Assumptions, a row opening the sheet
 * of every setting the test uses at its part, its sub what is set ("Historical
 * cycles · 75/25/0 · Constant · 0.1% fee"); and About these numbers, a row
 * opening the full statement and the data sources, said once here where each
 * result keeps its short label. Shown whatever the plan's state, as the
 * About card was. Held, a row stays in the tab order and opens nothing.
 */
export function StressRows({
  plan,
  held = false,
  onOpen,
  rowRef,
}: {
  plan: PlanCore;
  held?: boolean;
  onOpen: (kind: 'stress-assumptions' | 'numbers') => void;
  rowRef?: (kind: RowKind, el: HTMLElement | null) => void;
}) {
  const cash = 100 - plan.stocksPct - plan.bondsPct;
  const row = (kind: 'stress-assumptions' | 'numbers', title: string, sub: string | null) => (
    <li>
      <button
        ref={rowRef ? (el) => rowRef(kind, el) : undefined}
        type="button"
        className="list-row"
        aria-haspopup="dialog"
        aria-disabled={held ? 'true' : undefined}
        onClick={() => {
          if (!held) onOpen(kind);
        }}
      >
        <span className="list-row-text">
          <span className="list-row-title">{title}</span>
          {sub && <span className="list-row-sub">{sub}</span>}
        </span>
        {chevron(RIGHT)}
      </button>
    </li>
  );
  return (
    <ul className="card list-rows" aria-label="Drawdown's settings">
      {row('stress-assumptions', 'Assumptions', `${METHOD_NAMES[plan.method]} · ${plan.stocksPct}/${plan.bondsPct}/${cash} · ${RULE_SHORT[plan.rule]} · ${pct(plan.fee)} fee`)}
      {row('numbers', 'About these numbers', null)}
    </ul>
  );
}

/** About these numbers: what every result is, the data and what it can't
 *  say, once (each result keeps its short label). The words are the card's
 *  before 6d. */
export function AboutNumbers({ detailed = false }: { detailed?: boolean }) {
  return (
    <div className="stack">
      <p className="helper">{HYPOTHETICAL}</p>
      <p className="helper">
        Stocks are {DATA_STOCKS} and bonds are {DATA_BONDS}, from Robert Shiller&apos;s monthly data (January 1871 to June 2023, so the monthly
        returns, each from one month to the next, run from January 1871 to May 2023). Everything is in today&apos;s dollars: returns are after
        inflation, so a constant withdrawal keeps its buying power.
      </p>
      {detailed ? (
        <>
          <p className="helper">
            What this can&apos;t tell you: other countries&apos; markets, or what is inside your funds (the mix is what you set). Spending from bank data misses anything paid outside the accounts you have
            connected.
          </p>
          <h3 className="section-label">How tax is worked out</h3>
          <p className="helper">{ABOUT_DETAIL.how}</p>
          <h3 className="section-label">What stands in for what</h3>
          {ABOUT_DETAIL.standIns.map((line) => (
            <p key={line} className="helper">
              {line}
            </p>
          ))}
          <p className="helper">{ABOUT_DETAIL.notModeled}</p>
        </>
      ) : (
        <p className="helper">
          What this can&apos;t tell you: other countries&apos; markets, taxes beyond one flat rate (no brackets, account types or required
          withdrawals), or what is inside your funds (the mix is what you set). Spending from bank data misses anything paid outside the
          accounts you have connected.
        </p>
      )}
    </div>
  );
}

/**
 * Your figures (rollout phase 6c): what the FI card rests on, under it on
 * Your path, each one row that opens its sheet, where Why? says how a
 * measured figure was worked out. A row says where its figure comes from and
 * the figure; what qualifies it is under the row, outside the button (a
 * <details> can't be in one), in full when there is one note, gathered into
 * a line that opens in place when there are two or more, as Home's FI line
 * (components/FiProgressCard.tsx FiRow). What each says is worked out in
 * components/plan-figure-notes.ts. Ages and Assumptions have no trailing
 * value: their figures are their subs.
 */
export function InputsCard({
  figures,
  view,
  plan,
  money,
  copyName = null,
  held = false,
  onOpen,
  rowRef,
  currency = null,
  health = null,
  tax = null,
  fiSub = null,
  fiHeld = false,
}: {
  /** What each row says (components/plan-figure-notes.ts figureNotes). */
  figures: FigureNotes;
  /** A detailed plan's Health coverage row. */
  health?: (FigureText & { value: string | null }) | null;
  /** The Tax after you stop row. */
  tax?: (FigureText & { value: string }) | null;
  /** How a detailed plan's FI number is worked out; null: as a flat plan's is. */
  fiSub?: string | null;
  /** What a detailed plan's FI number rests on hasn't settled: no flat one meanwhile. */
  fiHeld?: boolean;
  /** The figures themselves, as the plan shown has them. */
  view: FiView;
  /** The plan shown, for its FI number's row. */
  plan: Pick<PlanCore, 'fiNumber' | 'withdrawalRate'>;
  money: (n: number) => string;
  /** The open copy's name, said at the top; null with your plan open. */
  copyName?: string | null;
  /** The saved plan is being read again: the rows open nothing meanwhile,
   *  and stay in the tab order. */
  held?: boolean;
  /** Opens a row's sheet; the row is where focus goes back when it closes. */
  onOpen: (kind: InputKind, row: HTMLButtonElement) => void;
  /** Each row's button as it is drawn, by kind, so focus can find the row
   *  drawn now when the one pressed has gone. */
  rowRef?: (kind: InputKind, el: HTMLButtonElement | null) => void;
  /** The plan's currency as one line (components/PlanCurrency.tsx), at the
   *  card's foot while nothing about it needs the person. */
  currency?: React.ReactNode;
}) {
  const figure = (v: number | null) => (v !== null ? money(v) : '--');
  const row = (kind: InputKind) => ({
    held,
    onOpen: (el: HTMLButtonElement) => onOpen(kind, el),
    buttonRef: rowRef ? (el: HTMLButtonElement | null) => rowRef(kind, el) : undefined,
  });
  return (
    <section className="card plan-inputs" aria-labelledby="plan-inputs-title">
      <CopyTag name={copyName} />
      <div className="card-header">
        <h3 id="plan-inputs-title">Your figures</h3>
      </div>
      <ul className="list-rows">
        <InputRow title="FI number" said={{ sub: plan.fiNumber != null ? 'Set by you' : (fiSub ?? `Worked out from spending and tax, at ${pct(plan.withdrawalRate)}`), line: null, why: null, notes: [] }} value={fiHeld && plan.fiNumber == null ? '--' : figure(view.fiNumber)} {...row('fi-number')} />
        <InputRow title="Annual spending" said={figures.spending} value={figure(view.spending.value)} {...row('spending')} />
        <InputRow title="Invested assets" said={figures.assets} value={figure(view.assets.value)} {...row('assets')} />
        <InputRow title="Annual savings" said={figures.savings} value={figure(view.savings.value)} {...row('savings')} />
        {health && <InputRow title="Health coverage" said={health} value={health.value} {...row('health')} />}
        {tax && <InputRow title="Tax after you stop" said={tax} value={tax.value} {...row('tax')} />}
        <InputRow title="Household" said={figures.ages} {...row('about')} />
        <InputRow title="Assumptions" said={figures.assumptions} {...row('assumptions')} />
      </ul>
      {currency}
    </section>
  );
}

/** One of Your figures' rows: its title, where the figure comes from, the
 *  figure (with measured savings' rate under it), and its notes under the
 *  row, which describe it, so moving from row to row a screen reader says
 *  them too (a note in full is no stop of its own). Held, it stays in the
 *  tab order and a press opens nothing. */
function InputRow({
  title,
  said,
  value = null,
  held,
  onOpen,
  buttonRef,
}: {
  title: string;
  said: FigureText;
  /** The figure, or "--"; null for a row whose figures are its sub. */
  value?: string | null;
  held: boolean;
  onOpen: (row: HTMLButtonElement) => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
}) {
  const notesId = useId();
  const noted = said.notes.length > 0;
  return (
    <li>
      <button
        ref={buttonRef}
        type="button"
        className="list-row"
        aria-haspopup="dialog"
        aria-disabled={held ? 'true' : undefined}
        aria-describedby={noted ? notesId : undefined}
        onClick={(e) => {
          if (!held) onOpen(e.currentTarget);
        }}
      >
        <span className="list-row-text">
          <span className="list-row-title">{title}</span>
          <span className="list-row-sub">
            <Masked>{said.sub}</Masked>
          </span>
        </span>
        {value !== null && (
          <span className="list-row-value money plan-input-value">
            <span>
              <Masked>{value}</Masked>
            </span>
            {said.line && (
              <span className="plan-input-line">
                <Masked>{said.line}</Masked>
              </span>
            )}
          </span>
        )}
        {chevron(RIGHT)}
      </button>
      {noted && (
        <div className="row-notes" id={notesId}>
          <FigureCaveats notes={said.notes} />
        </div>
      )}
    </li>
  );
}

// Said on Drawdown, of the figures on Your path (Your figures).
const MISSING_TEXT: Record<Missing, string> = {
  spending: 'The simulation withdraws your annual spending, so it needs it. Type it on Your path, or connect accounts with transactions.',
  assets: 'The simulation starts with your invested assets, and there are none to count yet. Type them on Your path, or start from your FI number (Assumptions, below).',
  balance: 'Type the balance to start with (Assumptions, below).',
  'stop-balance': 'The simulation starts with what you’d have at your stop age, which needs your age, your stop age, and your invested assets or savings. If those are in, your path doesn’t get that far (Your path says why).',
};

/** Why the simulation can't run: what it needs, and when that is there but
 *  isn't measured, said so in compare mode's words (unmeasuredNeed). */
function missingText(missing: Missing, view: FiView): string {
  const need = unmeasuredNeed(missing, view);
  if (need && missing === 'assets') return `The simulation starts with ${need} (Your path says why). Type them on Your path, or start from your FI number (Assumptions, below).`;
  if (need) return `The simulation withdraws ${need} (Your path says why). Type it on Your path.`;
  return MISSING_TEXT[missing];
}

// Will it last?'s answer in words, where it can't be worked out.
const MISSING_FIGURE: Record<Missing, string> = {
  spending: SPENDING_NEED,
  assets: 'Needs your invested assets',
  balance: 'Needs a starting balance',
  'stop-balance': 'Needs what you’d have at your stop age',
};

/** Drawdown's hero (the tax plan's P, Fue's call 2026-11-01): Will it last?,
 *  the success rate at the hero size, over what it counts and what it means;
 *  then what it starts from, the setup it tests, and the result's chart, its
 *  worst starts and its ending balances. Its settings are the Assumptions
 *  row's, under the cards (rollout 6d): the line's "historical starts" or
 *  "Monte Carlo runs" names the method, which is set there. */
/** The start line's way to what the plan would have at the stop. Its failure is said
 *  here, where the person pressed it. */
function StartAtStop({ stopAge, busy, onStart }: { stopAge: number; busy: boolean; onStart: () => Promise<boolean | string> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const press = async () => {
    setError(null);
    setSaving(true);
    const saved = await onStart();
    setSaving(false);
    if (saved !== true) setError(typeof saved === 'string' ? saved : 'It was not saved. Try again in a moment.');
  };
  return (
    <>
      <div>
        <button type="button" className="btn ghost" disabled={saving || busy} onClick={() => void press()}>
          Start from what you&apos;d have at {stopAge}
        </button>
      </div>
      {error && (
        <p className="plan-warning" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function SimulationCard({
  copyName = null,
  startsWith = null,
  ages = [],
  retirementLine = null,
  plan,
  notes,
  view,
  engine,
  outcome,
  pending,
  failed = false,
  detail = null,
  setupHeld = false,
  money,
  currency,
  badge = null,
  onRetry,
  onRetryDetail,
  startAtStop = null,
  startBusy = false,
}: {
  /** The open copy's name, said at the top; null with your plan open. */
  copyName?: string | null;
  /** What the plan starts with, and what it would have then
   *  (lib/fire/plan-figures.ts): the start line under the answer. */
  startsWith?: StartsWith | null;
  /** Where each of the plan's items falls on the steady path (null: not
   *  placed), for what this says it takes from Your path. */
  ages?: readonly ItemAges[];
  /** Spending in retirement with its items' lasting changes, in words:
   *  what the simulation withdraws in place of what is spent now. */
  retirementLine?: string | null;
  plan: FirePlanV2;
  /** The plan's items' notes (lib/fire/plan-figures.ts itemNotes). */
  notes: readonly ItemNote[];
  view: FiView;
  engine: EnginePlan | { missing: Missing };
  /** The last answer, null before the first. */
  outcome: Outcome | null;
  /** A new answer is being worked out: the last one is held hidden. */
  pending: boolean;
  /** A detailed plan's date couldn't be worked out, so nothing was run on it. */
  failed?: boolean;
  /** A detailed plan's share of tax and its law: withdrawals pay health coverage and
   *  that tax, not just your spending. */
  detail?: { t: number; lawYear: number } | null;
  money: (n: number) => string;
  currency: string | null;
  /** Drawdown's notice is about this answer's inputs: its badge. */
  badge?: string | null;
  /** Runs it again, when it couldn't be run at all. */
  onRetry: () => void;
  onRetryDetail?: () => void;
  /** Saves the plan starting from what it would have at the stop; null: it does, or can't be saved here. */
  startAtStop?: (() => Promise<boolean | string>) | null;
  /** A save is under way: the link waits, and stays, so a save that fails can say so. */
  startBusy?: boolean;
  /** A detailed plan's years aren't in, so the setup would say what's about to change. */
  setupHeld?: boolean;
}) {
  // Over the label: an open copy's tag, and the badge.
  const top =
    copyName || badge ? (
      <>
        <CopyTag name={copyName} />
        {badge && (
          <div className="plan-card-badge">
            <span className="badge warn">{badge}</span>
          </div>
        )}
      </>
    ) : undefined;
  const hero = (figure: React.ReactNode, figureClass: string | undefined, line: React.ReactNode, body: React.ReactNode) => (
    <Hero id="plan-last-title" level={3} label="Will it last?" className={pending && outcome && 'result' in outcome ? 'drawdown-hero drawdown-pending' : 'drawdown-hero'} top={top} figure={figure} figureClass={figureClass} line={line}>
      {body}
    </Hero>
  );
  const retirementNote = retirementLine ? (
    <p className="panel-note">
      <Masked>{retirementLine}</Masked>
    </p>
  ) : null;
  // What it starts from, against what the steady path has where Whole path
  // starts drawing: with more, the caution it always had (it reads safer
  // than it is); with less, or from today's assets, a note.
  const startLine = startsWith && !startsWith.more ? startLineText(startsWith, money, { age: plan.age, stopAge: view.stopAge, atStop: view.atTargetAge }) : null;
  const startLink = startAtStop && view.stopAge !== null ? <StartAtStop stopAge={view.stopAge} busy={startBusy} onStart={startAtStop} /> : null;
  const startNote = setupHeld ? null : startsWith?.more ? (
    <Notice level="caution">
      <Masked>{`It starts with ${startsWithText(startsWith, money, 'on Your path').replace(/\.$/, '')}: it starts with money it wouldn’t have then, so it reads safer than it is.`}</Masked>
      {startLink}
    </Notice>
  ) : startLine ? (
    <Notice level="info">
      <Masked>{startLine}</Masked>
      {startLink}
    </Notice>
  ) : null;

  if ('missing' in engine) {
    return hero(MISSING_FIGURE[engine.missing], 'plan-answer', <p className="helper">{missingText(engine.missing, view)}</p>, null);
  }
  if (failed) {
    return hero(
      'Not worked out',
      'plan-answer',
      <p className="helper">{DETAIL_FAILED}</p>,
      <div>
        <button type="button" className="btn secondary" onClick={onRetryDetail}>
          Try again
        </button>
      </div>
    );
  }
  const { sim, startAge, rate, rateFrom } = engine;
  // Placed by the compile (lib/fire/compile.ts): not one left out for want
  // of an age or already in today's figures, nor one with none of it between
  // the start and the plan's end. One begun before the start counts from it.
  const unplaced = new Set(notes.filter((n) => n.part === 'no-age' || n.part === 'already').map((n) => n.id));
  const placed = plan.items.filter((x, i) => {
    const at = ages[i];
    if (!at || unplaced.has(x.id)) return false;
    return startAge === null ? x.kind !== 'pay' : reachesStart(x, at, startAge) && at.start < startAge + sim.years;
  });
  const startLabel = plan.start === 'fi-number' ? (plan.fiNumber != null ? 'your own FI number' : 'your FI number') : plan.start === 'assets' ? 'your invested assets' : plan.start === 'at-stop' ? 'what you’d have' : 'the balance you typed';
  const when = plan.start === 'assets' ? `today${startAge !== null ? `, at ${startAge},` : ''}` : startAge !== null ? `at ${startAge}` : 'at your stop age';
  const spendingNow = view.spending.value;
  const vpw = plan.rule === 'vpw';

  // The setup, and what the starting choice means for it.
  let setup: React.ReactNode;
  if (vpw) {
    setup = `Stop working ${when} with ${money(sim.startBalance)} (${startLabel}), for ${sim.years} years${startAge !== null ? ` (to age ${startAge + sim.years})` : ''}. VPW sets each year's spending from the balance and the years left.${detail ? ` ${WITH_EACH_YEARS_TAX}` : ''}`;
  } else if (detail) {
    const balance = <Masked>{money(sim.startBalance)}</Masked>;
    const startsWithIt = plan.start === 'fi-number' ? <>{startLabel}, {balance}</> : plan.start === 'assets' ? <>your invested assets, {balance}</> : plan.start === 'at-stop' ? <>the {balance} you’d have then</> : <>the {balance} you typed</>;
    setup = (
      <>
        Stop working {when} with {startsWithIt}, for {sim.years} years{startAge !== null ? `, to age ${startAge + sim.years}` : ''}. Your spending, health coverage and tax come to {plan.rule === 'constant' ? 'about ' : ''}
        <strong>{pct(saidRate(rate, plan.withdrawalRate))}</strong> of it {plan.rule === 'constant' ? 'a year' : 'in the first year'}.{saidAbove(rate, plan.withdrawalRate) ? ` That’s above the ${pct(plan.withdrawalRate)} your FI number assumes.` : ''} {WITH_EACH_YEARS_TAX}
      </>
    );
  } else if (rateFrom === 'spending') {
    setup = (
      <>
        Stop working {when} with <Masked>{money(sim.startBalance)}</Masked> ({startLabel}), spending what you spend now,{' '}
        <Masked>{money(spendingNow ?? 0)}</Masked> a year after tax, for {sim.years} years{startAge !== null ? ` (to age ${startAge + sim.years})` : ''}. That is a{' '}
        <strong>{pct(saidRate(rate, plan.withdrawalRate))}</strong> withdrawal rate{saidAbove(rate, plan.withdrawalRate) ? `, above the ${pct(plan.withdrawalRate)} your FI number assumes` : ''}.
      </>
    );
  } else {
    setup = `Stop working ${when} with ${money(sim.startBalance)} (${startLabel}), withdrawing ${pct(rate)} of it, ${money(spendingNow ?? 0)} a year after tax, your spending now, for ${sim.years} years${startAge !== null ? ` (to age ${startAge + sim.years})` : ''}.`;
  }
  const setupNote = setupHeld ? null : <p className="panel-note">{typeof setup === 'string' ? <Masked>{setup}</Masked> : setup}</p>;

  if (!outcome) {
    return hero(
      <span className="skeleton drawdown-skeleton-figure" />,
      undefined,
      <p className="helper" role="status">
        Working it out…
      </p>,
      <>
        {startNote}
        {setupNote}
        {retirementNote}
      </>
    );
  }
  if ('error' in outcome) {
    return hero(
      'Not worked out',
      'plan-answer',
      outcome.unavailable ? (
        <p className="helper">
          The simulation couldn&apos;t be loaded. It needs a connection the first time it runs after an update. The figures on Your path and Portfolio don&apos;t
          depend on it.
        </p>
      ) : (
        <p className="helper">This plan can&apos;t be simulated: {outcome.error}.</p>
      ),
      <>
        {startNote}
        {setupNote}
        {retirementNote}
        {outcome.unavailable && (
          <div>
            <button type="button" className="btn secondary" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}
      </>
    );
  }
  const r = outcome.result;
  const flexible = plan.rule !== 'constant';
  const nouns = r.method === 'historical' ? 'historical starts' : 'Monte Carlo runs';
  const lowShare = r.lowestSpending && r.firstYearSpending > 0 ? r.lowestSpending.amount / r.firstYearSpending : null;

  return hero(
    successText(r.successRate, 1),
    undefined,
    // While a new answer is worked out, held hidden with the result under
    // it (.drawdown-pending): it read the last result's starts with the new
    // length.
    <div className="stack tight plan-answer-lines drawdown-line">
      <p className="helper">{`of ${plainNumber(r.paths)} ${nouns}${r.firstStart && r.lastStart ? ` (${monthName(r.firstStart)} to ${monthName(r.lastStart)})` : ''} lasted ${sim.years} years${startAge !== null ? `, from ${startAge}` : ''}`}</p>
      <p className="plan-definition">
        {successDefinition(sim.years)}
        {flexible ? ' This rule lasts by cutting spending when markets fall; Lowest year, below, says how far.' : ''}
        {detail && setupHeld ? ` ${WITH_EACH_YEARS_TAX}` : ''}
      </p>
      <p className="plan-definition">{detail ? hypotheticalDrawdown(detail.lawYear) : HYPOTHETICAL_LABEL}</p>
    </div>,
    <>
      {startNote}
      {setupNote}
      {retirementNote}

      {/* While a new answer is worked out, the last one keeps its place but
          is hidden: it answered other assumptions than the ones above. */}
      <div className={pending ? 'plan-result plan-result-pending' : 'plan-result'} aria-busy={pending}>
        {pending && (
          <div className="plan-working" role="status">
            Working out the new answer…
          </div>
        )}
        {vpw && spendingNow !== null && (
          <p className="panel-note">
            Its first year spends <Masked>{money(r.firstYearSpending)}</Masked> after tax{detail ? ', health coverage included' : ''}, against the <Masked>{money(spendingNow)}</Masked> you spend now{detail ? ' before coverage' : ''}.
          </p>
        )}

        <PlanFanChart bands={r.balance} startAge={startAge} currency={currency} />

        {r.method === 'historical' && r.worst.length > 0 && (
          <Why label="Worst starting years">
            <ul className="plan-worst">
              {r.worst.slice(0, 5).map((w) => (
                <li key={w.start}>
                  <span>{monthName(w.start!)}</span>
                  <span className="plan-muted">
                    <Masked>
                      {w.failedYear !== null
                        ? `ran out in year ${w.failedYear + 1}${startAge !== null ? ` (age ${startAge + w.failedYear})` : ''}`
                        : `lasted, ${money(w.endBalance)} left${flexible ? `, lowest year ${money(w.lowestSpending)}` : ''}`}
                    </Masked>
                  </span>
                </li>
              ))}
            </ul>
          </Why>
        )}

        <div className="as-of">
          Ending balance: <Masked>{money(r.ending.p10)}</Masked> (10th percentile), <Masked>{money(r.ending.p50)}</Masked> (median), <Masked>{money(r.ending.p90)}</Masked> (90th).
        </div>

        {canRunOut(plan.rule) === false && r.successRate === 1 && (
          <p className="panel-note">
            {detail
              ? 'This rule withdraws a share of what is there, with health coverage on top, and it lasted every start; how far spending falls is the risk to watch.'
              : 'This rule only ever withdraws a share of what is there, so it cannot run out; how far spending falls is the risk to watch.'}
          </p>
        )}

        {/* How far a flexible rule cut spending: a row at the hero's foot,
            in words where no start lasted (one figure at the hero size). */}
        {flexible && (
          <div className="plan-rows">
            <Row
              label="Lowest year"
              value={lowShare === null ? 'None lasted' : successText(lowShare)}
              note={
                lowShare === null
                  ? `No ${r.method === 'historical' ? 'start' : 'run'} lasted, so there is no spending to compare.`
                  : `of the first year's spending in the lowest year, in the worst ${r.method === 'historical' ? 'start' : 'run'} that lasted${r.lowestSpending?.start ? ` (${monthName(r.lowestSpending.start)})` : ''}: ${money(r.lowestSpending!.amount)} against ${money(r.firstYearSpending)}${detail ? ', health coverage included' : ''}`
              }
            />
          </div>
        )}

        {/* Its settings are in the Assumptions sheet (rollout 6d); what it
            takes from Your path is said here. */}
        {placed.length > 0 && (
          <>
            <h4 className="plan-heading">From Your path</h4>
            <ul className="plan-assumptions">
              {placed.map((x) => (
                <li key={x.id}>
                  {x.label}: <Masked>{itemSentence(x, plan, money)}</Masked>.
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}

/** Whether "Will it last?" shows an answer, and with it that the figures are
 *  hypothetical: then the grid under it doesn't say so again. Working it out,
 *  or with no answer, it doesn't, and the grid does. */
export function simulationAnswered(engine: EnginePlan | { missing: Missing }, outcome: Outcome | null): boolean {
  return 'sim' in engine && outcome !== null && 'result' in outcome;
}

export function GridCard({
  copyName = null,
  plan,
  cells,
  failed = [],
  unavailable = false,
  onRetry,
  rates,
  years,
  current,
  ownCell = null,
  sampled = false,
  startBalance,
  money,
  badge = null,
  sayHypothetical = true,
}: {
  /** That its figures are hypothetical, from US history: false when "Will it
   *  last?" above it says so (simulationAnswered), so one view says it once. */
  sayHypothetical?: boolean;
  /** The open copy's name, said at the top; null with your plan open. */
  copyName?: string | null;
  plan: PlanCore;
  cells: GridCell[] | null;
  /** Cells that couldn't be worked out, and whether that was because the
   *  simulation couldn't be loaded. */
  failed?: FailedCell[];
  unavailable?: boolean;
  onRetry?: () => void;
  rates: (number | null)[];
  years: number[];
  current: { rate: number | null; years: number };
  /** What the plan's own cell says, when it isn't one of `cells`. */
  ownCell?: GridCell | null;
  /** Each cell runs a sample, with each year's tax (TAXED_GRID_STEP, TAXED_GRID_RUNS). */
  sampled?: boolean;
  startBalance: number;
  money: (n: number) => string;
  /** Drawdown's notice is about this card's inputs: its badge. */
  badge?: string | null;
}) {
  const noun = plan.method === 'historical' ? 'starts' : 'runs';
  const flexible = plan.rule !== 'constant';
  // Each historical column's starts, for the line under the grid.
  const spans = years
    .map((y) => cells?.find((c) => c.years === y && c.firstStart && c.lastStart))
    .filter((c): c is GridCell => !!c)
    .map((c) => {
      const from = Number(c.firstStart!.slice(0, 4));
      const to = Number(c.lastStart!.slice(0, 4));
      return `${c.years} years, ${c.paths.toLocaleString()} starts over ${to - from + 1} years (to ${monthName(c.lastStart!)})`;
    });
  return (
    <div className="card">
      <CopyTag name={copyName} />
      <div className="card-header">
        <h3>{plan.rule === 'vpw' ? 'By length' : 'By withdrawal rate and length'}</h3>
      </div>
      {badge && (
        <div className="plan-card-badge">
          <span className="badge warn">{badge}</span>
        </div>
      )}
      <p className="panel-note">
        <Masked>
          {plan.rule === 'vpw'
            ? `VPW has no withdrawal rate to vary, so this is the plan at each length, starting with ${money(startBalance)}.`
            : `The share of ${noun} that lasted, each starting with ${money(startBalance)} and everything else as your Assumptions set it.`}
        </Masked>
        {flexible ? " This rule lasts by cutting spending, so each cell's second line is the lowest year's spending, as a share of the first year's, in the worst one that lasted." : ''}{' '}
        Your plan is outlined.{sampled ? ` ${gridSampleLine(plan.method)}` : ''}
      </p>
      <PlanGrid cells={cells} failed={failed} rates={rates} horizons={years} current={current} ownCell={ownCell} flexible={flexible} pathsNoun={noun} />
      {failed.length > 0 && (
        <>
          <p className="empty-note">
            {failed.length === 1 ? 'One cell' : `${failed.length} cells`} couldn&apos;t be worked out
            {unavailable ? ": the simulation couldn't be loaded, which needs a connection the first time after an update" : ''}.
          </p>
          {onRetry && (
            <button className="secondary" style={{ marginTop: 12 }} onClick={onRetry}>
              Try again
            </button>
          )}
        </>
      )}
      {plan.method === 'historical' ? (
        <>
          <p className="plan-definition">A longer column leaves out the latest starts, which is why it can read safer than a shorter one.</p>
          <Why label="Which starts">
            <p>
              Each length starts {sampled ? 'every sixth month' : 'in every month'} that leaves all of it inside the data, so a longer one has fewer, earlier starts
              {spans.length ? `: ${spans.join('; ')}` : ''}.
            </p>
          </Why>
        </>
      ) : (
        <p className="plan-definition">Every column uses the same runs, each extended to the longer lengths.</p>
      )}
      {sayHypothetical && <p className="plan-definition">{HYPOTHETICAL_LABEL}</p>}
    </div>
  );
}
