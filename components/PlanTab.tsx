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
// the scenario open, over three segments, and with a scenario open its card
// under the bar, above every segment. All three segments stay mounted, the
// others hidden, and the bar is drawn before the plan has loaded, so Home's
// FI line has its heading to land on:
//   - Your path: the FI view (lib/fire/plan.ts fiView): the FI card, with
//     the FI number, years to FI, Coast and Barista FI, and on the number
//     what may leave it short; then the figures it rests on (rollout phase
//     6c), each a row that opens its sheet, saying where it came from
//     (measured by Nya, typed by you, or missing) and, under it, what may be
//     missing from it: an institution whose transactions couldn't be read,
//     balances that are old or short (components/plan-figure-notes.ts). How
//     a measured figure was worked out is behind Why? in its sheet. A figure
//     that may be short says so; none is presented as complete when it may
//     not be. Then other income and one-off expenses, and an open scenario's
//     life events.
//   - Stress test: one notice when the spending or invested assets the
//     simulation uses may be low, then "Will it last?": the plan run through
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
// Only the plan's assumptions go to the server (/api/fire-plan), saved whole
// on each change through lib/whole-list-store.ts, which never lets an
// unloaded plan be saved over the real one.
//
// SCENARIOS (lib/fire/scenarios.ts, components/PlanScenarios.tsx): named
// what-ifs beside the Plan, each only what it changes, listed, made and
// compared in the Scenarios sheet, which the bar opens on your plan and the
// scenario's card opens inside one. Opening one shows the whole tab as that
// scenario, every card saying so, and every save the tab makes goes through
// components/plan-savers.ts, which sends the forms' and Use my allocation's
// saves to the scenario and gives the repair, the method and the allocation
// settings no saver at all: nothing done with a scenario open can reach the
// Plan.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Txn } from './MonthBreakdown';
import { Sheet, focusInsteadOf } from './Sheet';
import PlanFanChart from './PlanFanChart';
import PlanGrid, { type FailedCell } from './PlanGrid';
import { AboutForm, AssumptionsForm, ExpenseForm, FigureForm, IncomeForm, type AssumptionsAt, type FigureKind } from './PlanForms';
import { Why } from './Why';
import { createPlanRunner, type PlanRunner, type WorkerLike } from './plan-runner';
import {
  DATA_BONDS,
  DATA_STOCKS,
  HYPOTHETICAL,
  HYPOTHETICAL_LABEL,
  METHOD_NAMES,
  monthName,
  pct,
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
} from './plan-text';
import { Hero } from './Hero';
import { createWholeListStore, initialListState, type ListState } from '@/lib/whole-list-store';
import { NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';
import { investedAssets, type AssetInstitution, type InvestedAssets, type TrailingFlows, type UnreadTransactions, type WorkplaceSavings } from '@/lib/fire/inputs';
import { fiFigures, measuredInputs, notMeasuredWhat, notWorkedOutText, unmeasuredNeed, type ShareRates } from '@/lib/fire/progress';
import { historyCount } from '@/lib/spending';
import { figureNotes, inputFlags, names, stressNotice, windowText, type FigureArgs, type FigureNote, type FigureNotes, type FigureText } from './plan-figure-notes';
import TotalCaveats, { Notice } from './TotalCaveats';
import { chevron, RIGHT } from './ActivityBar';
import { usePlanInputs, workplacePlansOf } from './plan-inputs';
import AllocationCard, { mixToOffer, useAllocation } from './AllocationCard';
import type { AllocHolding, PlanMix } from '@/lib/allocation/allocation';
import {
  DEFAULT_PLAN,
  formulasTake,
  isFirePlan,
  repairPlan,
  type EnginePlan,
  type FirePlan,
  type FiView,
  type Missing,
  type Repair,
  type PlanExpense,
  type PlanIncome,
} from '@/lib/fire/plan';
import type { GridCell, SimResult } from '@/lib/fire/simulate';
import { canRunOut } from '@/lib/fire/rules';
import type { PlanJob } from '@/lib/fire/jobs';
import { Masked } from './HideAmounts';
import { ScenarioCard, ScenariosSheet, REFUSED_TEXT, rememberResult, type FixForm } from './PlanScenarios';
import PlanBar, { planPanelId, planTabId, type PlanSegment } from './PlanBar';
import { PlanPanelSkeleton } from './LoadingSkeletons';
import PlanProgress, { progressOverlay, useProgress, type ProgressOverlay } from './PlanProgress';
import { ScenarioTag } from './ScenarioTag';
import { LifeEventsCard } from './PlanEvents';
import { WhatIfCard } from './PlanWhatIf';
import { createScenarioClient, INITIAL_SCENARIOS, type ScenariosState } from './plan-scenarios';
import { planSavers, type Save } from './plan-savers';
import { currencyText, laterText, resolveErrorText, retirementText, shortText, startsWithText } from './plan-scenario-text';
import { planFigures, type PlanFigures, type StartsWith } from '@/lib/fire/plan-figures';
import { planPath, type PlanPath } from '@/lib/fire/path';
import PlanPathChart from './PlanPathChart';
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
import {
  applyScenario,
  changesOf,
  currencyFor,
  hasAmounts,
  otherCurrency,
  pruneMoot,
  recordSave,
  resolveScenario,
  restoreItem,
  scenarioChanges,
  type ScenarioChanges,
  type ScenarioDraft,
} from '@/lib/fire/scenarios';
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

export type SheetState =
  | { kind: 'about' }
  | { kind: 'figure'; figure: FigureKind }
  // Every rate and setting, in one sheet (rollout 6d), opened at the stress
  // test's part or its mix; `mix` is the allocation's, filled in, as it was
  // when "Use my allocation in the plan" was pressed.
  | { kind: 'assumptions'; at?: AssumptionsAt; mix?: PlanMix & { ok: true } }
  | { kind: 'numbers' }
  | { kind: 'income'; item: PlanIncome | null }
  | { kind: 'expense'; item: PlanExpense | null };

const SHEET_TITLES: Record<SheetState['kind'], string> = {
  about: 'Your ages',
  figure: '',
  assumptions: 'Assumptions',
  numbers: 'About these numbers',
  income: 'Other income',
  expense: 'One-off expense',
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
   *  left out, the tab keeps its own. */
  segment?: PlanSegment;
  onSegment?: (s: PlanSegment) => void;
  /** When Home's FI line opened the tab (Date.now()): the bar's heading takes
   *  focus once, if that was under ten seconds ago. */
  landing?: number | null;
  /** Said once the heading has it, so the dashboard forgets the landing. */
  onLanded?: () => void;
};

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
  landing = null,
  onLanded,
}: PlanTabProps) {
  const [ownSegment, setOwnSegment] = useState<PlanSegment>('path');
  const segment = segmentShown ?? ownSegment;
  const chooseSegment = onSegment ?? setOwnSegment;
  const [state, setState] = useState<ListState<FirePlan | null>>(initialListState<FirePlan | null>(null));
  // The plan as the server last confirmed it, and the currency its typed
  // figures are in as the route answered with it (lib/fire/plan-currency.ts):
  // never the plan a save has yet to write, which the store shows at once.
  // And the currency each save sends (set below, once the tab knows it).
  const [confirmed, setConfirmed] = useState<{ plan: FirePlan | null; answer: CurrencyAnswer }>({ plan: null, answer: NO_ANSWER });
  const sendCurrency = useRef<string | null>(null);
  const store = useMemo(
    () =>
      createWholeListStore<FirePlan | null>({
        url: '/api/fire-plan',
        field: 'plan',
        noun: 'plan assumptions',
        empty: null,
        isValid: (v): v is FirePlan | null => v === null || isFirePlan(v),
        onChange: setState,
        reloadHint: 'use Try again below',
        // A save refused for what is stored now (its currency changed on
        // another device, say) says why.
        showRefusal: true,
        extra: () => ({ currency: sendCurrency.current }),
        onAnswer: (data) => setConfirmed({ plan: isFirePlan(data.plan) ? data.plan : null, answer: readCurrencyAnswer(data) }),
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
  const stored = state.value ?? DEFAULT_PLAN;
  const repair = useMemo(() => repairPlan(stored), [stored]);
  /** The Plan as the tab shows it: the repaired one while a repair waits. */
  const basePlan = repair.plan;
  // While a repair waits, nothing but "Save it this way" saves: a save from
  // anywhere else would commit it unseen, dropping what it leaves out.
  const repairing = repair.fixed.length > 0;

  // The Plan's scenarios, and the one open, if any. None opens before the
  // Plan has loaded, or while a repair of it waits (one open closes): a
  // scenario is a set of changes to the Plan, so it means nothing without it.
  const [scenState, setScenState] = useState<ScenariosState>(INITIAL_SCENARIOS);
  const scenarios = useMemo(() => createScenarioClient(setScenState), []);
  useEffect(() => {
    void scenarios.load();
  }, [scenarios]);
  const [openId, setOpenId] = useState<string | null>(null);
  const planLoaded = state.status === 'ready';
  const canOpen = planLoaded && !repairing;
  const entry = openId !== null && canOpen ? (scenState.list.find((s) => s.id === openId) ?? null) : null;
  useEffect(() => {
    if (openId === null) return;
    if ((planLoaded && repairing) || (scenState.status === 'ready' && !scenState.list.some((s) => s.id === openId))) setOpenId(null);
  }, [openId, planLoaded, repairing, scenState]);
  // And once the currency the plan's figures are in is known (below).
  const editableNow = state.status === 'ready' && !state.saving && !repairing && (!entry || !scenState.saving);

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
  // them for the label.
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
  });
  const { flows, unread, assets, contributions, workplace, cashOn, cashUnmarked } = inputs;
  const figures = fiFigures(basePlan, inputs, currency);
  // The plan's own currency once recorded, which everything above is in;
  // otherwise the accounts' (figures.currency), and with typed amounts and no
  // record that holds, not known until the tab can tell it reliably or the
  // person says (lib/fire/plan-currency.ts).
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
    const r = await recordPlanCurrency(c, typedAmounts(stored), byPerson);
    setRecordingNow(false);
    if (r.ok) {
      setConfirmed({ plan: r.plan ?? stored, answer: r.answer });
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
  // in, recorded once, and only while no save or answer is under way. A
  // record that no longer fits, or can't be read, is never replaced but on
  // the person's word. If it fails, the tab asks instead, and doesn't try
  // again for that plan.
  const autoCurrency =
    currencyState.kind === 'unknown' && currencyState.problem === null && reliably.ok && !currencyBusy && confirmed.plan ? currencyState.shown : null;
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
  const offer = candidates(figures.currency, inputs, { was: currencyState.kind === 'unknown' ? currencyState.was : null, home });
  const currencyMode: CurrencyCardMode =
    currencyState.kind === 'unknown'
      ? // Nothing said while the tab records it on its own; while it waits on
        // the accounts to tell it, that it waits (a record there is asked
        // about at once, and a load that failed is asked about too).
        autoKey !== null && autoFailed?.for !== autoKey
        ? { kind: 'none' }
        : waitingOnAccounts && currencyState.problem === null
          ? { kind: 'waiting', text: WAITING_TEXT }
          : { kind: 'ask', text: askText(currencyState, reliably.ok ? null : reliably.why, from), offer, was: currencyState.was, canAnswer: currencyState.problem !== 'newer' }
      : currencyState.kind === 'recorded'
        ? {
            kind: 'recorded',
            currency: currencyState.currency,
            kept: keptText(currencyState.currency, inputs, !!(txnFx || balanceFx)),
            relabelTo: relabelOffer(currencyState.currency, inputs),
            previous,
            scenariosIn: scenState.list.filter((x) => hasAmounts(x) && x.currency === currencyState.currency).length,
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
  // Every save of the Plan itself, through its store, with the currency its
  // figures are in: never a first typed amount without one.
  const savePlanIn = async (next: FirePlan): Promise<boolean | string> => {
    if (sendCurrency.current === null && currencyState.kind === 'follows' && hasTypedAmounts(next)) {
      return waitingOnAccounts
        ? 'Your accounts are still loading, and the currency your plan’s figures are in is taken from them: save again in a moment.'
        : 'Say which currency you type your plan’s figures in first (above the figures), then save again: nothing was saved.';
    }
    return store.save(next);
  };

  const measured = measuredInputs(inputs);
  // The Plan's figures by the same function a scenario's come from: with no
  // life events, fiView and enginePlan exactly (lib/fire/plan-figures.ts).
  const baseFigures = planFigures(basePlan, measured) as PlanFigures;
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
  const allocation = useAllocation({ institutions, holdings, currency: displayCurrency, includeCash: basePlan.includeCash, fx: balanceFx });

  // The open scenario: resolved against the Plan as shown, unless its
  // amounts were typed in another currency than the Plan's now, or it breaks
  // one of the Plan's rules now (then only why is shown, nothing worked out).
  const planCurrency = figures.currency;
  const other = entry ? otherCurrency(entry, planCurrency) : null;
  const resolved = entry ? resolveScenario(basePlan, entry) : null;
  const openFigures = entry && resolved?.ok && !other ? planFigures(resolved.plan, measured, entry.events) : null;
  const shown: PlanFigures | null = entry ? (openFigures && !('refused' in openFigures) ? openFigures : null) : baseFigures;
  const problem =
    entry && resolved && !resolved.ok
      ? { text: resolveErrorText(resolved.field, resolved.error, basePlan, entry), field: resolved.field }
      : openFigures && 'refused' in openFigures
        ? { text: REFUSED_TEXT, field: null }
        : null;
  const plan = shown?.plan ?? basePlan;
  const view = shown?.view ?? figures.view;
  // The path from today to the stop age (lib/fire/path.ts), the chart's
  // line, and where it can't go on, which the At age row says. Both plans'
  // ages are parsed (the Plan is repaired, a scenario resolved), so it is
  // never longer than a plan can be.
  const path = useMemo(() => (shown ? planPath(shown) : null), [shown]);
  const stopShort = path?.short ?? null;
  const stopWalked = path?.fromWalk ?? false;
  const engine: EnginePlan | { missing: Missing } = shown?.engine ?? { missing: 'spending' };
  const sim = 'sim' in engine ? engine.sim : null;
  // The Plan's method: a scenario never changes it.
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
  const simRunKey = simKey ? `${attempt}:${simKey}` : null;
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
  const pending = !!simRunKey && main?.key !== simRunKey;
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
  const gridKey = sim ? JSON.stringify([attempt, simKey, gridRates, gridYears]) : null;
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

  // The drawer, and the plan it was opened for: the open scenario, at the
  // version it was opened on, or null for the Plan. A form saves only to the
  // plan it was opened for, and the drawer closes whenever the plan shown
  // changes (a scenario opened, closed, deleted elsewhere, or changed on
  // another device), so a form left open can never send one plan's values
  // to another, or a version's values over a newer one.
  const shownFor = entry ? `${entry.id}@${entry.rev}` : null;
  const shownForRef = useRef(shownFor);
  shownForRef.current = shownFor;
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [sheetFor, setSheetFor] = useState<string | null>(null);
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
  };
  const close = () => setSheet(null);
  const closeFor = (n: number) => () => {
    if (openedNow.current === n) setSheet(null);
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
    // What if…'s goes once the age is saved: then to its first life choice
    // when one can be tried, or else its title (components/PlanWhatIf.tsx).
    if (openedFrom.current === 'ask-what-if' && !row?.isConnected) row = inputRows.current.get('what-if-first') ?? null;
    if (!closed || !row?.isConnected) return;
    let lost = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;
    for (let n: Element | null = document.activeElement; n && !lost; n = n.parentElement) lost = n.getAttribute('role') === 'dialog';
    if (lost) row.focus({ preventScroll: true });
  }, [sheetOpen]);
  // What a scenario's save said that has no form left to say it in: changed
  // on another device, so the drawer closed on the version it was made to.
  const [notice, setNotice] = useState<{ for: string; text: string } | null>(null);

  // Saving into the open scenario: what a form's save changes, recorded as
  // the scenario's own changes (lib/fire/scenarios.ts recordSave), with the
  // currency its amounts are in (the Plan's when this is its first).
  const persistIn = async (changes: ScenarioChanges, currencyNow?: string | null): Promise<true | { error: string; stale: boolean }> => {
    if (!entry) return { error: 'It wasn’t saved. Try again in a moment.', stale: false };
    const kept = pruneMoot(basePlan, changes);
    const draft: ScenarioDraft = { name: entry.name, currency: currencyNow !== undefined ? currencyNow : currencyFor(entry, kept, planCurrency), ...kept };
    if (hasAmounts(draft) && draft.currency === null) return { error: 'Your plan has no currency yet (no accounts to take it from), so a scenario can’t hold amounts: add an account first.', stale: false };
    const r = await scenarios.save(entry.id, draft, entry.rev);
    if ('ok' in r) {
      setNotice(null);
      return true;
    }
    if (r.stale) setNotice({ for: entry.id, text: `${r.error} Nothing of your change was kept: make it again if it still applies.` });
    return { error: r.error, stale: !!r.stale };
  };
  /** For a drawer's form: what to say in it (it closes on a stale save). */
  const persist = async (changes: ScenarioChanges, currencyNow?: string | null): Promise<boolean | string> => {
    const r = await persistIn(changes, currencyNow);
    return r === true ? true : r.error;
  };
  /** For a button on the page (the scenario's card, an item's row): null
   *  when the notice says it already, so it isn't said twice. */
  const persistHere = async (changes: ScenarioChanges, currencyNow?: string | null): Promise<boolean | string | null> => {
    const r = await persistIn(changes, currencyNow);
    return r === true ? true : r.stale ? null : r.error;
  };
  const saveToScenario: Save | null = entry
    ? async (next) => {
        if (other && planCurrency) return currencyText(other, planCurrency, currencyKnown);
        const r = recordSave(basePlan, entry, next);
        if ('error' in r) return r.error;
        return persist(r.ok);
      }
    : null;
  // Every save the tab makes, from one place (components/plan-savers.ts).
  const savers = planSavers({ scenario: saveToScenario, savePlan: savePlanIn, repaired: repairing ? repair.plan : null });
  const formPlan = entry ? applyScenario(basePlan, entry).plan : basePlan;
  const saversRef = useRef(savers);
  saversRef.current = savers;
  // Bound when the drawer opened: refused once the plan shown isn't the one
  // it was opened for (the drawer is closing by then).
  const saveFor =
    (target: string | null): Save =>
    async (next) =>
      target === shownForRef.current ? saversRef.current.form(next) : 'This form was opened for another plan than the one shown now, so nothing was saved.';
  const replaced = sheet !== null && !state.saving && state.status === 'ready' && storedKey !== openedOn.current;
  const formEditable = editable && !other && sheetFor === shownFor && !replaced;
  // The figures' rows open their sheets whatever the state: while saving is
  // paused for more than a moment, the sheet says why above its buttons.
  // Nothing for a save under way, or a sheet whose plan was replaced under
  // it, as before.
  const paused = formEditable
    ? null
    : state.status === 'error'
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
            : replaced && editable && !other && sheetFor === shownFor
              ? "Your saved plan was read again since this opened, so this can't be saved: close it and open it again."
              : null;
  // The plan saved as your plan and what was recorded since (rollout 8e), for
  // the Progress card and, with the Plan shown, the chart's lines before today.
  const progress = useProgress(institutions);
  const progressSaved = progress.savedState.kind === 'ready' ? progress.savedState.saved : null;
  // Only where both are of one thing: the saved plan's currency and include
  // cash are the path's (the Progress card says when they changed).
  const progressSeries = progress.series;
  const todayUtc = new Date().toISOString().slice(0, 10);
  const overlay = useMemo(
    () =>
      entry === null &&
      progressSaved &&
      progressSeries?.kind === 'ready' &&
      basePlan.age !== null &&
      progressSeries.answer.currency === displayCurrency &&
      progressSaved.plan.includeCash === basePlan.includeCash
        ? progressOverlay(progressSaved, progressSeries.answer, basePlan.age, todayUtc)
        : null,
    [entry, progressSaved, progressSeries, basePlan.age, basePlan.includeCash, displayCurrency, todayUtc]
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
            : baseFigures.view.savings.source === 'measured' && (txnsLoading || txnsFailed || unread.length > 0)
              ? "Some of your transactions haven't loaded or couldn't be read, so Nya's savings figure may be off: save once they have, or type your savings in Your figures."
              : null;
  const formProps = { plan: formPlan, onSave: saveFor(sheetFor), onDone: closeFor(opened), editable: formEditable, scenario: entry?.name ?? null, paused };
  const scenarioName = entry?.name ?? null;

  // What each figure the plan shown rests on says, worked out once for the
  // rows under the FI card, their sheets' Why? and the Stress test's notice
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
    cashOn,
    cashUnmarked,
    money,
    savingsRate: figures.savingsRate,
    shareRates: inputs.rates ?? null,
  };
  const figureTexts = figureNotes(figureArgs);
  const stressNotes = stressNotice(figureArgs, engine, shown?.startsWith ?? null);
  // Design-system rule 3: a badge on each card the notice is about.
  const stressBadge = stressNotes.length === 0 ? null : stressNotes.length === 1 ? 'An input may be low' : 'Inputs may be low';

  // The bar, its heading and its Scenarios button, the scenario's card (with
  // the life events that fix it, when it is refused) and the panel shown:
  // what a switch scrolls to, and what focus moves to.
  const barRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const scenariosRef = useRef<HTMLButtonElement | null>(null);
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
  // The Scenarios sheet, and the button that opened it. Closed, the sheet
  // gives focus back to that button; when the button went while it was open
  // (with the scenario's card: the scenario was deleted meanwhile), the
  // bar's Scenarios takes focus instead (below).
  const [scenariosOpen, setScenariosOpen] = useState(false);
  const scenariosFrom = useRef<Element | null>(null);
  /** `within`: the bar's button, or the card's place. The button pressed is
   *  the one focused, where a browser focuses what is pressed; where none is
   *  (Safari), its card stands for it, gone exactly when it is. */
  const openScenarios = (within: HTMLElement | null) => {
    const pressed = document.activeElement;
    scenariosFrom.current = within && pressed && within.contains(pressed) ? pressed : within;
    setScenariosOpen(true);
  };
  const closeScenarios = () => setScenariosOpen(false);
  // What takes focus once the bar has drawn the plan now shown: its heading
  // when a scenario opens (from the Scenarios sheet, on your plan or inside
  // another scenario), with the scenario's card scrolled into view, since
  // focus in the pinned bar scrolls nothing; its Scenarios button when one is
  // left, as the arrow, the card and the sheet's row that left it are gone,
  // or when the sheet closes and the button that opened it has gone. Set by
  // the handler that opens or leaves, which closes the sheet in the same
  // commit, so the sheet gives focus back first and loses it to this. Run
  // only by the commit that changes the plan shown or the sheet: a commit in
  // between (a simulation's answer, say), its effects still waiting when the
  // click comes, would otherwise take the request before the bar has drawn
  // what it is for. A scenario the tab closes itself (deleted elsewhere, a
  // repair waiting), or one deleted in the sheet, moves nothing.
  const focusNext = useRef<'title' | 'scenarios' | null>(null);
  useEffect(() => {
    const to = focusNext.current;
    focusNext.current = null;
    if (to === 'title') {
      titleRef.current?.focus({ preventScroll: true });
      underBar(cardRef.current);
    } else if (to === 'scenarios' || (!scenariosOpen && scenariosFrom.current && !scenariosFrom.current.isConnected)) {
      scenariosRef.current?.focus({ preventScroll: true });
    }
    if (!scenariosOpen) scenariosFrom.current = null;
    // underBar reads only refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, scenariosOpen]);
  // A notice is about the scenario as it was open: leaving it, or opening
  // one, starts without it.
  const leave = () => {
    setNotice(null);
    setOpenId(null);
    focusNext.current = 'scenarios';
  };
  const openScenario = (id: string | null) => {
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
  // bar, not where the last one was scrolled to; at the scenario's card
  // instead while that says something about the scenario never to be scrolled
  // past (its amounts typed in another currency, a rule it breaks, a save's
  // notice). An error after a change on the card stays where it is.
  const cardSays = !!entry && (other !== null || problem !== null || (notice !== null && notice.for === entry.id));
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
  // silent.
  const everOpened = useRef(false);
  if (entry) everOpened.current = true;
  const shownStatus = entry ? `Showing the scenario ${entry.name}.` : everOpened.current ? 'Showing your plan.' : '';
  // A scenario's "They're in" relabels its amounts into the Plan's currency.
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
  const changes = entry ? scenarioChanges(basePlan, entry) : [];
  const scenarioMarks = entry
    ? {
        name: entry.name,
        replaced: new Set(changes.flatMap((c) => (c.kind === 'replaced' ? [c.item.id] : []))),
        added: new Set(changes.flatMap((c) => (c.kind === 'added' ? [c.item.id] : []))),
        leftOut: changes.flatMap((c) => (c.kind === 'left-out' ? [{ list: c.list, item: c.item }] : [])),
        onRestore: async (list: 'income' | 'expenses', id: string) => {
          const r = restoreItem(basePlan, entry, list, id);
          return 'error' in r ? r.error : persistHere(r.ok);
        },
      }
    : null;
  const scenarioNotes: string[] = [];
  if (entry && shown) {
    if (shown.retirement && shown.view.spending.value !== null) scenarioNotes.push(`FI number from ${retirementText(shown.retirement.spending, shown.retirement.lasting, shown.view.spending.value, money)}.`);
    const later = laterText(shown.events?.later ?? [], money);
    if (later) scenarioNotes.push(later);
    if (entry.events.length > 0) scenarioNotes.push('Coast and Barista FI leave this scenario’s life events out, but for lasting changes in spending.');
  }
  // How many scenarios there are, for the bar's and the card's Scenarios:
  // none said until they are listed (after a failed reload the client keeps
  // the list it had, but the sheet shows only why it couldn't load).
  const scenariosCount = scenState.status === 'ready' ? scenState.list.length : null;
  // Mounted always, closed or open, from its first render: the plans picked
  // for Compare last for the visit, and the sheet can be opened while the
  // plan loads (it says why nothing opens yet).
  const scenariosSheet = (
    <ScenariosSheet
      open={scenariosOpen}
      onClose={closeScenarios}
      onLeave={leave}
      state={scenState}
      client={scenarios}
      base={basePlan}
      baseFigures={baseFigures}
      measured={measured}
      planCurrency={planCurrency}
      planCurrencyKnown={currencyKnown}
      canOpen={canOpen}
      planState={state.status}
      whyNot={
        state.status === 'error'
          ? 'Your saved plan couldn’t be read, so scenarios can’t be worked out against it: try again at the top of the Plan tab.'
          : !planLoaded
            ? 'Your plan is still loading: scenarios open, and are compared, once it has.'
            : repairing
              ? 'Your saved plan has values to fix first (at the top of the Plan tab): scenarios open once it is saved.'
              : null
      }
      openId={entry ? entry.id : null}
      onOpen={openScenario}
      run={(job, signal) => runner().run(job, signal)}
      cache={answers}
      method={basePlan.method}
      money={money}
      today={inputs.today}
    />
  );
  const fixForm = (f: Exclude<FixForm, null>) =>
    open(f === 'about' ? { kind: 'about' } : f === 'assumptions' ? { kind: 'assumptions' } : f === 'simulation' ? { kind: 'assumptions', at: 'stress' } : { kind: 'figure', figure: f });
  // Lasting changes below zero: nothing is worked out, and the life events
  // are what to change, so they stay with the card, on every segment.
  const refused = !!openFigures && 'refused' in openFigures;
  const scenarioCard = entry && (
    <ScenarioCard
      entry={entry}
      base={basePlan}
      problem={problem}
      other={other}
      planCurrency={planCurrency}
      planCurrencyKnown={currencyKnown}
      confirmWhyNot={confirmWhyNot}
      editable={editable}
      money={money}
      eventsCount={entry.events.length}
      eventsWhere={shown ? 'path' : refused ? 'below' : null}
      onSave={(c) => persistHere(c)}
      onConfirmCurrency={() => persistHere(changesOf(entry), planCurrency)}
      onFix={fixForm}
      notice={notice && notice.for === entry.id ? notice.text : null}
      scenariosCount={scenariosCount}
      onScenarios={() => openScenarios(cardRef.current)}
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
  // An open scenario with amounts typed in another currency, or one that
  // breaks a rule of the Plan's, has nothing worked out: its card says why,
  // on every segment.
  const worked = shown !== null;
  // The currency, quiet, is a line at the foot of Your figures, beside the
  // figures it is about, so nothing above the bar arrives as the plan loads;
  // above the bar while it needs the person, or with Your figures not drawn.
  const currencyInFigures = planLoaded && quietCurrency && worked;
  regionShown.current = !currencyInFigures || segment === 'path';
  // Whether focus is in the card or its line as it is now, read before it
  // moves: when it moves on its own (the accounts say something new, a
  // scenario opens), focus follows it rather than falling to the page.
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
      <PlanBar
        ref={barRef}
        titleRef={titleRef}
        scenariosRef={scenariosRef}
        segment={segment}
        onSegment={switchSegment}
        scenario={scenarioName}
        scenariosCount={scenariosCount}
        onScenarios={() => openScenarios(scenariosRef.current)}
        onBack={leave}
      />
      {/* The open scenario's card, under the bar on every segment, and when
          it is refused for lasting changes below zero, its life events, the
          ones to change, with it. */}
      {entry && (
        <div ref={cardRef}>
          {scenarioCard}
          {refused && (
            <LifeEventsCard
              scenarioName={entry.name}
              version={shownFor ?? ''}
              events={entry.events}
              notes={[]}
              money={money}
              editable={editable && !other}
              onSave={(events) => persist({ ...changesOf(entry), events })}
            />
          )}
        </div>
      )}

      {panel(
        'path',
        <>
        {worked && (
          <>
            <FiCard
              scenarioName={scenarioName}
              scenarioNotes={scenarioNotes}
              retirementSpending={shown?.retirement?.spending ?? null}
              walked={shown?.walked ?? false}
              walkedSavings={shown?.walkedSavings ?? null}
              fiShort={shown?.short ? shortText(shown.short, plan.age, money) : null}
              stopShort={
                stopShort && plan.targetAge !== null
                  ? sameShort(stopShort, shown?.short ?? null)
                    ? `Nothing is projected at ${plan.targetAge}, for the reason under the answer.`
                    : shortText(stopShort, plan.age, money, `nothing is projected at ${plan.targetAge}`)
                  : null
              }
              stopWalked={stopWalked}
              path={path}
              recorded={overlay}
              currency={displayCurrency}
              onAskAges={() => open({ kind: 'about' }, 'ask-about')}
              askRef={(el) => inputRowRef('ask-about', el)}
              held={reloading}
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
              money={money}
              scenarioName={scenarioName}
              held={reloading}
              onOpen={(kind) => open(kind === 'about' || kind === 'assumptions' ? { kind } : { kind: 'figure', figure: kind }, kind)}
              rowRef={inputRowRef}
              currency={currencyInFigures ? currencyCard : null}
            />

            {/* Only over your saved plan, never the defaults; the card is
                drawn with your plan shown, and its sheet stays mounted. */}
            {planLoaded && (
              <WhatIfCard
                shown={!entry}
                base={basePlan}
                baseFigures={baseFigures}
                measured={measured}
                state={scenState}
                client={scenarios}
                planCurrency={planCurrency}
                planCurrencyKnown={currencyKnown}
                editable={editable}
                canOpen={canOpen}
                money={money}
                onOpen={openScenario}
                onAskAge={() => open({ kind: 'about' }, 'ask-what-if')}
                reloading={reloading}
                askRef={(el) => inputRowRef('ask-what-if', el)}
                firstRef={(el) => inputRowRef('what-if-first', el)}
              />
            )}

            <EventsCard plan={plan} engine={engine} money={money} editable={editable} open={open} scenario={scenarioMarks} />

            {entry && shown && (
              <LifeEventsCard
                scenarioName={entry.name}
                version={shownFor ?? ''}
                events={entry.events}
                notes={shown.events?.notes ?? []}
                money={money}
                editable={editable && !other}
                onSave={(events) => persist({ ...changesOf(entry), events })}
              />
            )}
          </>
        )}
        {/* Progress against the plan saved as your plan (rollout 8e): the
            Plan's, whatever is open, so outside what a scenario can refuse. */}
        {planLoaded && (
          <PlanProgress progress={progress} plan={basePlan} savings={baseFigures.view.savings} currency={figures.currency} institutions={institutions} blocked={progressBlocked} scenarioOpen={entry !== null} />
        )}
        </>
      )}

      {panel(
        'stress',
        <>
          {/* What may leave the inputs the simulation uses low, once, above
              the cards it is about, each of which has its badge. */}
          {worked && <FigureCaveats notes={stressNotes} />}

          {worked && (
            <SimulationCard
              scenarioName={scenarioName}
              startsWith={shown?.startsWith ?? null}
              hasEvents={!!entry && entry.events.length > 0}
              retirementLine={shown?.retirement && view.spending.value !== null ? `Spending in retirement: ${retirementText(shown.retirement.spending, shown.retirement.lasting, view.spending.value, money)}.` : null}
              plan={plan}
              view={shown?.retirement ? { ...view, spending: { ...view.spending, value: shown.retirement.spending } } : view}
              engine={engine}
              outcome={outcome}
              pending={pending}
              money={money}
              currency={displayCurrency}
              badge={stressBadge}
              onRetry={retry}
            />
          )}

          {worked && 'sim' in engine && (
            <GridCard
              scenarioName={scenarioName}
              plan={plan}
              cells={shownGrid?.cells ?? null}
              failed={shownGrid?.failed ?? []}
              unavailable={shownGrid?.unavailable ?? false}
              onRetry={retry}
              rates={gridRates}
              years={gridYears}
              current={{ rate: vpw ? null : engine.rate, years: engine.sim.years }}
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
            scenarioName={scenarioName}
            planKey={shownFor ?? 'plan'}
            institutions={institutions}
            balancesAsOf={balancesAsOf}
          />
        )
      )}

      <Sheet
        open={!!sheet}
        title={
          shownSheet
            ? `${shownSheet.kind === 'figure' ? FIGURE_TITLES[shownSheet.figure] : SHEET_TITLES[shownSheet.kind]}${scenarioName ? ` (${scenarioName})` : ''}`
            : ''
        }
        onClose={close}
      >
        {shownSheet?.kind === 'about' && <AboutForm key={opened} {...formProps} />}
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
          />
        )}
        {shownSheet?.kind === 'numbers' && <AboutNumbers />}
        {shownSheet?.kind === 'figure' && (
          <FigureForm
            key={opened}
            {...formProps}
            kind={shownSheet.figure}
            currency={displayCurrency}
            measured={measuredInputs(inputs)[shownSheet.figure]}
            measuredText={flows ? `from ${windowText(flows)}` : ''}
            why={figureTexts[shownSheet.figure].why}
            assetsFor={(includeCash) => investedAssets(institutions, includeCash, balanceFx, Date.now(), ownCurrency)}
            workplacePlans={workplacePlansOf(institutions).map((p) => ({ account_id: p.account_id, label: `${p.institution} ${p.name}` }))}
          />
        )}
        {shownSheet?.kind === 'income' && <IncomeForm key={opened} {...formProps} item={shownSheet.item} />}
        {shownSheet?.kind === 'expense' && <ExpenseForm key={opened} {...formProps} item={shownSheet.item} />}
      </Sheet>
      {scenariosSheet}
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
  planFunding: 'how a workplace plan is paid into',
};

/** What a repair changed, in words: an income or one-off by its label, or by
 *  what it was when it has none. */
function repairName(f: Repair, money: (n: number) => string): string {
  if (!f.item) return REPAIR_NAMES[f.field] ?? f.field;
  const label = f.item.label.trim();
  if (f.field === 'income') return label ? `the income "${label}"` : `an income of ${money(f.item.amount)} a year from age ${f.item.age}`;
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

function EditButton({ onClick, disabled, label }: { onClick: () => void; disabled: boolean; label: string }) {
  return (
    <button className="plan-edit" onClick={onClick} disabled={disabled} aria-label={label}>
      Edit
    </button>
  );
}

/** The FI card: the FI number and how it is worked out, with what may leave
 *  it short said on it, and what follows from it (years to FI, Coast and
 *  Barista FI, the balance at the target age). The figures it rests on are
 *  the rows under it (InputsCard): of their inputs it reads only what its
 *  lines on the number need. */
export function FiCard({
  scenarioName = null,
  scenarioNotes = [],
  retirementSpending = null,
  walked = false,
  walkedSavings = null,
  fiShort = null,
  stopShort = null,
  stopWalked = false,
  path = null,
  recorded = null,
  currency = null,
  onAskAges,
  askRef,
  held = false,
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
  /** The open scenario's name, said at the top; null with the Plan open. */
  scenarioName?: string | null;
  /** What an open scenario's life events do to these figures, a line each. */
  scenarioNotes?: string[];
  /** Spending in retirement with a scenario's lasting changes, which the FI
   *  number is worked out from, when it differs from today's. */
  retirementSpending?: number | null;
  /** The answer came from the walk with a scenario’s life events. */
  walked?: boolean;
  /** What that walk saves a year after the scenario's last change. */
  walkedSavings?: number | null;
  /** Why there is no FI date: a cost the walk can't pay. */
  fiShort?: string | null;
  /** Why there is no balance at the stop age: the walk can't get there. */
  stopShort?: string | null;
  /** The balance at the stop age is the walk's, with a scenario's life events. */
  stopWalked?: boolean;
  /** The plan's path from today (lib/fire/path.ts), drawn under the answer. */
  path?: PlanPath | null;
  /** What was recorded since the plan saved as your plan, and where it had
   *  you, drawn before today on the chart (rollout 8e). */
  recorded?: ProgressOverlay | null;
  /** The currency the figures are in, for the chart. */
  currency?: string | null;
  /** Opens the Ages sheet, from the ask under the answer while an age it
   *  needs isn't typed; and the ask's ref, for focus to come back to. */
  onAskAges?: () => void;
  askRef?: (el: HTMLElement | null) => void;
  /** The plan is being read again: the ask does nothing meanwhile. */
  held?: boolean;
  plan: FirePlan;
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
  // the same flags as the Stress test's notice (components/plan-figure-notes.ts),
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
  let howLine = '';
  if (fiShort) {
    howLine = fiShort;
  } else if (walked && view.yearsToFi !== null && view.yearsToFi > 0 && view.yearsToFi !== Infinity) {
    howLine = `Growing a steady ${pct(plan.realReturn)} a year after inflation, with this scenario’s life events changing what is saved in their years.`;
  } else if (walked && view.yearsToFi === Infinity) {
    howLine = `With this scenario’s life events you’d save ${money(walkedSavings ?? 0)} a year after its last change, and growing ${pct(plan.realReturn)} a year after inflation that never reaches it.`;
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
  // runs out before the stop age (at FI already, or after a scenario reaches
  // it), it says so; a walk that never gets there says why under the answer.
  // Not worked out, the answer names what it needs, never "--".
  const runsOutAt = !fiShort && path?.short && plan.age !== null ? plan.age + path.short.year : null;
  const head = fiHeadline(view, plan, { noDate: !!fiShort, runsOutAt, need });
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
  return (
    <Hero
      id="plan-fi-title"
      level={3}
      label="Financial independence"
      className="plan-hero"
      top={scenarioName ? <ScenarioTag name={scenarioName} /> : undefined}
      // Words, not amounts, but from the figures: through Masked, as every
      // line read from them is (test/amount-sources.ts).
      figure={<Masked>{head.headline}</Masked>}
      figureClass="plan-answer"
      line={
        (head.against || howLine || asks) && (
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
            {/* What the answer still needs from you: a line under it that
                opens the Ages sheet, never a full-width button. */}
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
      <div className="as-of">
        <Masked>
          {view.fiNumber !== null && fiSpending !== null
            ? `FI number ${money(view.fiNumber)}: ${money(fiSpending)} a year${retirementSpending !== null ? ' in retirement' : ''}${plan.taxRate > 0 ? `, grossed up for ${pct(plan.taxRate)} tax,` : ''} ÷ ${pct(plan.withdrawalRate)} withdrawal rate`
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
      {scenarioNotes.map((n) => (
        <div key={n} className="as-of">
          <Masked>{n}</Masked>
        </div>
      ))}
      {path && path.points.length >= 2 && plan.age !== null && plan.targetAge !== null && (
        <PlanPathChart
          points={path.points}
          today={plan.age}
          stopAge={plan.targetAge}
          fiNumber={view.fiNumber}
          fiAge={view.fiAge}
          realReturn={plan.realReturn}
          currency={currency}
          withEvents={path.fromWalk}
          recorded={recorded}
        />
      )}

      {/* What follows from the answer, at the hero's foot, as Home's foot
          row is in its hero. A figure not worked out says what it needs. */}
      <div className="plan-rows">
        <Row
          label="Coast FI"
          value={view.coast ? money(view.coast.number) : coastNeed(plan, view, takes)}
          note={
            view.coast
              ? `With this much invested today you could stop saving now: growing ${pct(plan.realReturn)} a year after inflation, it reaches your FI number by age ${plan.targetAge}. ${view.coast.reached === null ? 'Your invested assets aren’t measured (below), so whether you have that much isn’t said.' : view.coast.reached ? 'You have that much.' : `You have ${money(assets.value ?? 0)}.`}`
              : undefined
          }
        />
        {view.barista && (
          <Row
            label="Barista FI"
            value={money(view.barista.number)}
            note={`With ${money(plan.partTimeIncome)} a year of part-time income covering part of your spending${view.barista.yearsTo !== null ? (view.barista.yearsTo === 0 ? '. You have that much.' : view.barista.yearsTo === Infinity ? '. Not reached at this rate.' : `, ${yearsText(view.barista.yearsTo)} away.`) : notMeasuredWhat(view) ? `. How far away isn’t worked out: ${notMeasuredWhat(view)} measured (below).` : '.'}`}
          />
        )}
        {view.atTargetAge !== null && plan.targetAge !== null && (
          <Row label={`At age ${plan.targetAge}`} value={money(view.atTargetAge)} note={`Projected growing a steady ${pct(plan.realReturn)} a year after inflation${stopWalked ? ', with this scenario’s life events in the years they cover' : ''}. Real markets don't move steadily; the simulation on Stress test shows how much that matters.`} />
        )}
        {view.atTargetAge === null && (notWorkedOut ?? stopShort) && plan.age !== null && plan.targetAge !== null && (
          <Row
            label={`At age ${plan.targetAge}`}
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

/** A figure's notes, or the Stress test's notice, as TotalCaveats draws
 *  them: one in full, two or more gathered into a line that opens in place,
 *  each note's words through Masked. */
function FigureCaveats({ notes }: { notes: readonly FigureNote[] }) {
  return <TotalCaveats items={notes.map((n) => ({ key: n.key, severity: n.level, summary: n.kind, body: <Masked>{n.text}</Masked> }))} />;
}

/** Which sheet a figure's row opens. */
export type InputKind = 'spending' | 'savings' | 'assets' | 'about' | 'assumptions';

/** Every row a sheet opens from, which focus goes back to as it closes:
 *  Your figures', Stress test's, and Portfolio's "Use my allocation". */
type RowKind = InputKind | 'stress-assumptions' | 'numbers' | 'mix' | 'ask-about' | 'ask-what-if' | 'what-if-first';

/** A rule's name in a few words, for the Assumptions row. */
const RULE_SHORT: Record<FirePlan['rule'], string> = {
  constant: 'Constant',
  percent: 'Percent of portfolio',
  guardrails: 'Guardrails',
  vpw: 'VPW',
  'floor-ceiling': 'Floor and ceiling',
};

/**
 * Stress test's last card (rollout 6d): Assumptions, a row opening the sheet
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
  plan: FirePlan;
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
    <ul className="card list-rows" aria-label="The stress test's settings">
      {row('stress-assumptions', 'Assumptions', `${METHOD_NAMES[plan.method]} · ${plan.stocksPct}/${plan.bondsPct}/${cash} · ${RULE_SHORT[plan.rule]} · ${pct(plan.fee)} fee`)}
      {row('numbers', 'About these numbers', null)}
    </ul>
  );
}

/** About these numbers: what every result is, the data and what it can't
 *  say, once (each result keeps its short label). The words are the card's
 *  before 6d. */
export function AboutNumbers() {
  return (
    <div className="stack">
      <p className="helper">{HYPOTHETICAL}</p>
      <p className="helper">
        Stocks are {DATA_STOCKS} and bonds are {DATA_BONDS}, from Robert Shiller&apos;s monthly data (January 1871 to June 2023, so the monthly
        returns, each from one month to the next, run from January 1871 to May 2023). Everything is in today&apos;s dollars: returns are after
        inflation, so a constant withdrawal keeps its buying power.
      </p>
      <p className="helper">
        What this can&apos;t tell you: other countries&apos; markets, taxes beyond one flat rate (no brackets, account types or required
        withdrawals), or what is inside your funds (the mix is what you set). Spending from bank data misses anything paid outside the
        accounts you have connected.
      </p>
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
  money,
  scenarioName = null,
  held = false,
  onOpen,
  rowRef,
  currency = null,
}: {
  /** What each row says (components/plan-figure-notes.ts figureNotes). */
  figures: FigureNotes;
  /** The figures themselves, as the plan shown has them. */
  view: FiView;
  money: (n: number) => string;
  /** The open scenario's name, said at the top; null with the Plan open. */
  scenarioName?: string | null;
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
      <ScenarioTag name={scenarioName} />
      <div className="card-header">
        <h3 id="plan-inputs-title">Your figures</h3>
      </div>
      <ul className="list-rows">
        <InputRow title="Annual spending" said={figures.spending} value={figure(view.spending.value)} {...row('spending')} />
        <InputRow title="Invested assets" said={figures.assets} value={figure(view.assets.value)} {...row('assets')} />
        <InputRow title="Annual savings" said={figures.savings} value={figure(view.savings.value)} {...row('savings')} />
        <InputRow title="Ages" said={figures.ages} {...row('about')} />
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

// Said on Stress test, of the figures on Your path (Your figures).
const MISSING_TEXT: Record<Missing, string> = {
  spending: 'The simulation withdraws your annual spending, so it needs it. Type it on Your path, or connect accounts with transactions.',
  assets: 'The simulation starts with your invested assets, and there are none to count yet. Type them on Your path, or start from your FI number (Assumptions, below).',
  balance: 'Type the balance to start with (Assumptions, below).',
};

/** Why the simulation can't run: what it needs, and when that is there but
 *  isn't measured, said so in compare mode's words (unmeasuredNeed). */
function missingText(missing: Missing, view: FiView): string {
  const need = unmeasuredNeed(missing, view);
  if (need && missing === 'assets') return `The simulation starts with ${need} (Your path says why). Type them on Your path, or start from your FI number (Assumptions, below).`;
  if (need) return `The simulation withdraws ${need} (Your path says why). Type it on Your path.`;
  return MISSING_TEXT[missing];
}

export function SimulationCard({
  scenarioName = null,
  startsWith = null,
  hasEvents = false,
  retirementLine = null,
  plan,
  view,
  engine,
  outcome,
  pending,
  money,
  currency,
  badge = null,
  onRetry,
}: {
  /** The open scenario's name, said at the top; null with the Plan open. */
  scenarioName?: string | null;
  /** What the plan starts with, and what it would have then
   *  (lib/fire/plan-figures.ts): said when it starts with more. */
  startsWith?: StartsWith | null;
  /** The open scenario has life events, which are in the simulation too. */
  hasEvents?: boolean;
  /** Spending in retirement with a scenario's lasting changes, in words:
   *  what the simulation withdraws in place of what is spent now. */
  retirementLine?: string | null;
  plan: FirePlan;
  view: FiView;
  engine: EnginePlan | { missing: Missing };
  /** The last answer, null before the first. */
  outcome: Outcome | null;
  /** A new answer is being worked out: the last one is shown dimmed. */
  pending: boolean;
  money: (n: number) => string;
  currency: string | null;
  /** Stress test's notice is about this card's inputs: its badge. */
  badge?: string | null;
  /** Runs it again, when it couldn't be run at all. */
  onRetry: () => void;
}) {
  // Its settings are the Assumptions row's, under the cards (rollout 6d):
  // the method is said here, and set there.
  const header = (
    <>
      <ScenarioTag name={scenarioName} />
      <div className="card-header">
        <h3>Will it last?</h3>
        <span className="meta">{METHOD_NAMES[plan.method]}</span>
      </div>
      {badge && (
        <div className="plan-card-badge">
          <span className="badge warn">{badge}</span>
        </div>
      )}
    </>
  );
  const retirementNote = retirementLine ? (
    <p className="panel-note">
      <Masked>{retirementLine}</Masked>
    </p>
  ) : null;
  const startNote =
    startsWith && startsWith.more ? (
      <p className="panel-note plan-warning">
        <Masked>{`It starts with ${startsWithText(startsWith, money, 'on Your path').replace(/\.$/, '')}: it starts with money it wouldn’t have then, so it reads safer than it is.`}</Masked>
      </p>
    ) : null;

  if ('missing' in engine) {
    return (
      <div className="card">
        {header}
        <p className="empty-note">{missingText(engine.missing, view)}</p>
      </div>
    );
  }
  const { sim, startAge, left, rate, rateFrom } = engine;
  const placedIncome = plan.income.filter((x) => !left.income.includes(x));
  const placedExpenses = plan.expenses.filter((x) => !left.expenses.includes(x) && !engine.beyond.includes(x));
  const startLabel = plan.start === 'fi-number' ? 'your FI number' : plan.start === 'assets' ? 'your invested assets' : 'the balance you typed';
  const when = plan.start === 'assets' ? `today${startAge !== null ? `, at ${startAge},` : ''}` : startAge !== null ? `at ${startAge}` : 'at your stop age';
  const spendingNow = view.spending.value;
  const vpw = plan.rule === 'vpw';

  // The setup, and what the starting choice means for it.
  let setup: React.ReactNode;
  if (vpw) {
    setup = `Stop working ${when} with ${money(sim.startBalance)} (${startLabel}), for ${sim.years} years${startAge !== null ? ` (to age ${startAge + sim.years})` : ''}. VPW sets each year's spending from the balance and the years left.`;
  } else if (rateFrom === 'spending') {
    setup = (
      <>
        Stop working {when} with <Masked>{money(sim.startBalance)}</Masked> ({startLabel}), spending what you spend now,{' '}
        <Masked>{money(spendingNow ?? 0)}</Masked> a year after tax, for {sim.years} years{startAge !== null ? ` (to age ${startAge + sim.years})` : ''}. That is a{' '}
        <strong>{pct(rate, 1)}</strong> withdrawal rate{rate > plan.withdrawalRate * 1.001 ? `, above the ${pct(plan.withdrawalRate)} your FI number assumes` : ''}.
      </>
    );
  } else {
    setup = `Stop working ${when} with ${money(sim.startBalance)} (${startLabel}), withdrawing ${pct(rate)} of it, ${money(spendingNow ?? 0)} a year after tax, your spending now, for ${sim.years} years${startAge !== null ? ` (to age ${startAge + sim.years})` : ''}.`;
  }

  if (!outcome) {
    return (
      <div className="card">
        {header}
        <p className="panel-note">{typeof setup === 'string' ? <Masked>{setup}</Masked> : setup}</p>
        {retirementNote}
        {startNote}
        <div className="plan-working" role="status">
          Working it out…
        </div>
      </div>
    );
  }
  if ('error' in outcome) {
    return (
      <div className="card">
        {header}
        <p className="panel-note">{typeof setup === 'string' ? <Masked>{setup}</Masked> : setup}</p>
        {retirementNote}
        {startNote}
        {outcome.unavailable ? (
          <>
            <p className="empty-note">
              The simulation couldn&apos;t be loaded. It needs a connection the first time it runs after an update. The figures
              on Your path and Portfolio don&apos;t depend on it.
            </p>
            <button className="secondary" style={{ marginTop: 12 }} onClick={onRetry}>
              Try again
            </button>
          </>
        ) : (
          <p className="empty-note">This plan can&apos;t be simulated: {outcome.error}.</p>
        )}
      </div>
    );
  }
  const r = outcome.result;
  const flexible = plan.rule !== 'constant';
  const nouns = r.method === 'historical' ? 'historical starts' : 'Monte Carlo runs';
  const lowShare = r.lowestSpending && r.firstYearSpending > 0 ? r.lowestSpending.amount / r.firstYearSpending : null;

  return (
    <div className="card">
      {header}
      <p className="panel-note">{typeof setup === 'string' ? <Masked>{setup}</Masked> : setup}</p>
        {retirementNote}
        {startNote}

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
            Its first year spends <Masked>{money(r.firstYearSpending)}</Masked> after tax, against the <Masked>{money(spendingNow)}</Masked> you spend now.
          </p>
        )}
        <div className="plan-stats">
          <div className="plan-stat">
            <span className="plan-stat-value">{successText(r.successRate, 1)}</span>
            <span className="plan-stat-label">
              of {plainNumber(r.paths)} {nouns}
              {r.firstStart && r.lastStart ? ` (${monthName(r.firstStart)} to ${monthName(r.lastStart)})` : ''} lasted {sim.years} years
            </span>
          </div>
          {flexible && (
            <div className="plan-stat">
              <span className="plan-stat-value">{lowShare === null ? '--' : successText(lowShare)}</span>
              <span className="plan-stat-label">
                <Masked>
                  {lowShare === null
                    ? 'no start lasted, so there is no spending to compare'
                    : `of the first year's spending in the lowest year, in the worst ${r.method === 'historical' ? 'start' : 'run'} that lasted${r.lowestSpending?.start ? ` (${monthName(r.lowestSpending.start)})` : ''}: ${money(r.lowestSpending!.amount)} against ${money(r.firstYearSpending)}`}
                </Masked>
              </span>
            </div>
          )}
        </div>
        <p className="plan-definition">
          {successDefinition(sim.years)}
          {flexible ? ' This rule lasts by cutting spending when markets fall; the second figure is how far.' : ''}
        </p>
        <p className="plan-definition">{HYPOTHETICAL_LABEL}</p>

        <PlanFanChart bands={r.balance} startAge={startAge} currency={currency} />
        <div className="as-of">
          Ending balance: <Masked>{money(r.ending.p10)}</Masked> (10th percentile), <Masked>{money(r.ending.p50)}</Masked> (median), <Masked>{money(r.ending.p90)}</Masked> (90th).
        </div>

        {canRunOut(plan.rule) === false && r.successRate === 1 && (
          <p className="panel-note">This rule only ever withdraws a share of what is there, so it cannot run out; how far spending falls is the risk to watch.</p>
        )}

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

        {/* Its settings are in the Assumptions sheet (rollout 6d); what it
            takes from Your path is said here. */}
        {(placedIncome.length > 0 || placedExpenses.length > 0 || hasEvents) && (
          <>
            <h4 className="plan-heading">From Your path</h4>
            <ul className="plan-assumptions">
          {placedIncome.map((x) => (
            <li key={x.id}>
              {x.label}: <Masked>{money(x.amount)}</Masked> a year after tax from age {x.fromAge}, {x.inflationAdjusted ? 'rising with inflation' : "in today's dollars when it starts, then losing value to inflation"}.
            </li>
          ))}
          {placedExpenses.map((x) => (
            <li key={x.id}>
              {x.label}: <Masked>{money(x.amount)}</Masked> at age {x.atAge}, on top of the year&apos;s spending.
            </li>
          ))}
          {hasEvents && <li>This scenario’s life events, from the stop age on, as the Life events card on Your path says.</li>}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/** Whether "Will it last?" shows an answer, and with it that the figures are
 *  hypothetical: then the grid under it doesn't say so again. Working it out,
 *  or with no answer, it doesn't, and the grid does. */
export function simulationAnswered(engine: EnginePlan | { missing: Missing }, outcome: Outcome | null): boolean {
  return 'sim' in engine && outcome !== null && 'result' in outcome;
}

export function GridCard({
  scenarioName = null,
  plan,
  cells,
  failed = [],
  unavailable = false,
  onRetry,
  rates,
  years,
  current,
  startBalance,
  money,
  badge = null,
  sayHypothetical = true,
}: {
  /** That its figures are hypothetical, from US history: false when "Will it
   *  last?" above it says so (simulationAnswered), so one view says it once. */
  sayHypothetical?: boolean;
  scenarioName?: string | null;
  plan: FirePlan;
  cells: GridCell[] | null;
  /** Cells that couldn't be worked out, and whether that was because the
   *  simulation couldn't be loaded. */
  failed?: FailedCell[];
  unavailable?: boolean;
  onRetry?: () => void;
  rates: (number | null)[];
  years: number[];
  current: { rate: number | null; years: number };
  startBalance: number;
  money: (n: number) => string;
  /** Stress test's notice is about this card's inputs: its badge. */
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
      <ScenarioTag name={scenarioName} />
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
        Your plan is outlined.
      </p>
      <PlanGrid cells={cells} failed={failed} rates={rates} horizons={years} current={current} flexible={flexible} pathsNoun={noun} />
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
              Each length starts in every month that leaves all of it inside the data, so a longer one has fewer, earlier starts
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

/** What an open scenario does to the Plan's income and one-offs, for the
 *  card that lists them: which it replaced or added, and which it left out,
 *  each of those with "Use your plan's", never just missing. */
export type ScenarioMarks = {
  name: string;
  replaced: Set<string>;
  added: Set<string>;
  leftOut: { list: 'income' | 'expenses'; item: PlanIncome | PlanExpense }[];
  /** null: not saved, and the scenario's card says why. */
  onRestore: (list: 'income' | 'expenses', id: string) => Promise<boolean | string | null>;
};

export function EventsCard({
  plan,
  engine,
  money,
  editable,
  open,
  scenario = null,
}: {
  plan: FirePlan;
  engine: EnginePlan | { missing: Missing };
  money: (n: number) => string;
  editable: boolean;
  open: (s: SheetState) => void;
  scenario?: ScenarioMarks | null;
}) {
  const [restoreError, setRestoreError] = useState('');
  const mark = (id: string) => (scenario?.replaced.has(id) ? ' Changed in this scenario.' : scenario?.added.has(id) ? ' Added in this scenario.' : '');
  const left = 'left' in engine ? engine.left : { income: [], expenses: [] };
  const leftOut = new Set([...left.income.map((x) => x.id), ...left.expenses.map((x) => x.id)]);
  const beyond = new Set(('beyond' in engine ? engine.beyond : []).map((x) => x.id));
  const end = 'sim' in engine && engine.startAge !== null ? engine.startAge + engine.sim.years : null;
  return (
    <div className="card">
      <ScenarioTag name={scenario?.name} />
      <div className="inst-header">
        <div className="inst-name">Income and one-off expenses</div>
      </div>
      {plan.income.length === 0 && plan.expenses.length === 0 && (
        <p className="empty-note">Add Social Security, a pension, or a big one-off cost such as a roof, to see how it changes the plan.</p>
      )}
      <div className="plan-rows">
        {plan.income.map((x) => (
          <Row
            key={x.id}
            label={x.label}
            value={`${money(x.amount)} a year`}
            note={`from age ${x.fromAge}, after tax${x.inflationAdjusted ? ', rises with inflation' : ", in today's dollars, then fixed (loses value to inflation)"}${leftOut.has(x.id) ? '. Not in the simulation: add your age.' : ''}${mark(x.id)}`}
            action={<EditButton onClick={() => open({ kind: 'income', item: x })} disabled={!editable} label={`Edit ${x.label}`} />}
          />
        ))}
        {plan.expenses.map((x) => (
          <Row
            key={x.id}
            label={x.label}
            value={money(x.amount)}
            note={`at age ${x.atAge}${
              leftOut.has(x.id)
                ? '. Not in the simulation: it is before the plan starts, or your age is not set.'
                : beyond.has(x.id)
                  ? `. After the plan ends${end !== null ? ` at ${end}` : ''}: only the grid's longer columns reach it.`
                  : ''
            }${mark(x.id)}`}
            action={<EditButton onClick={() => open({ kind: 'expense', item: x })} disabled={!editable} label={`Edit ${x.label}`} />}
          />
        ))}
        {scenario?.leftOut.map(({ list, item }) => (
          <Row
            key={`out-${item.id}`}
            label={item.label}
            value="Left out"
            note="Your plan has it; this scenario leaves it out."
            action={
              <button
                className="plan-edit"
                disabled={!editable}
                aria-label={`Use your plan’s ${item.label}`}
                onClick={async () => {
                  const r = await scenario.onRestore(list, item.id);
                  setRestoreError(r === true || r === null ? '' : typeof r === 'string' ? r : 'It wasn’t saved. Try again in a moment.');
                }}
              >
                Use your plan’s
              </button>
            }
          />
        ))}
      </div>
      {restoreError && (
        <Notice level="critical" role="alert">
          {restoreError}
        </Notice>
      )}
      <div className="card-actions">
        <button className="secondary" onClick={() => open({ kind: 'income', item: null })} disabled={!editable || plan.income.length >= 5}>
          Add income
        </button>
        <button className="secondary" onClick={() => open({ kind: 'expense', item: null })} disabled={!editable || plan.expenses.length >= 10}>
          Add a one-off
        </button>
      </div>
    </div>
  );
}
