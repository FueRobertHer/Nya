'use client';

// The Plan tab: financial independence, and how a retirement plan would have
// lasted. Loaded on demand (components/PlanTabLoader.tsx), since it carries
// the engine the other tabs never need; the simulations themselves run in a
// Web Worker (components/plan-runner.ts) with the market history, so the
// page stays responsive while 5,000 runs or the grid are worked out.
//
// What it shows, top to bottom:
//   - The FI view (lib/fire/plan.ts fiView): the FI number, years to FI,
//     Coast and Barista FI, each beside the inputs it came from, where each
//     input came from (measured by Nya, typed by you, or missing), and what
//     may be missing from it: an institution whose transactions couldn't be
//     read, balances that are old or short. A figure that may be short says
//     so; none is presented as complete when it may not be.
//   - Allocation (components/AllocationCard.tsx): what the investment
//     accounts hold by asset class and tax bucket, against a target, over
//     time, and the mix the simulation can take from it, on the person's word.
//   - "Will it last?": the plan run through history or Monte Carlo
//     (lib/fire/simulate.ts), with the success rate and its definition, for a
//     flexible rule the spending cuts beside it, a fan chart, the worst
//     starting years, and every assumption listed under it.
//   - The success grid by withdrawal rate and length.
//   - Other income and one-off expenses, and what the numbers can't say.
//
// Only the plan's assumptions go to the server (/api/fire-plan), saved whole
// on each change through lib/whole-list-store.ts, which never lets an
// unloaded plan be saved over the real one.
//
// SCENARIOS (lib/fire/scenarios.ts, components/PlanScenarios.tsx): named
// what-ifs beside the Plan, each only what it changes. Opening one shows the
// whole tab as that scenario, every card saying so, and every save the tab
// makes goes through components/plan-savers.ts, which sends the forms' and
// Use my allocation's saves to the scenario and gives the repair, the method
// and the allocation settings no saver at all: nothing done with a scenario
// open can reach the Plan.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Txn } from './MonthBreakdown';
import { Sheet } from './Sheet';
import PlanFanChart from './PlanFanChart';
import PlanGrid, { type FailedCell } from './PlanGrid';
import { AboutForm, AssumptionsForm, Choice, ExpenseForm, FigureForm, IncomeForm, SimulationForm, type FigureKind } from './PlanForms';
import { createPlanRunner, type PlanRunner, type WorkerLike } from './plan-runner';
import {
  DATA_BONDS,
  DATA_STOCKS,
  HYPOTHETICAL,
  METHOD_NAMES,
  PAYROLL_NOTE,
  REBALANCE_TEXT,
  RULE_NAMES,
  dayName,
  monthName,
  pct,
  progressText,
  ruleText,
  savingsRateText,
  successDefinition,
  successText,
  wholeMoney,
  yearsText,
  yearsToFiText,
} from './plan-text';
import { createWholeListStore, initialListState, type ListState } from '@/lib/whole-list-store';
import { instantDay } from '@/lib/local-date';
import { missingFigureNotes, NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';
import {
  investedAssets,
  type AssetCaveat,
  type AssetInstitution,
  type InvestedAssets,
  type TrailingFlows,
  type UnreadTransactions,
  type WorkplaceSavings,
} from '@/lib/fire/inputs';
import { assetsLeftOut, fiFigures, measuredInputs, spendingLeftOut, transactionCoverage, transactionsMissing } from '@/lib/fire/progress';
import { uncategorizedNote } from '@/lib/spending';
import { usePlanInputs, workplacePlansOf } from './plan-inputs';
import AllocationCard, { mixToOffer, useAllocation } from './AllocationCard';
import type { AllocHolding } from '@/lib/allocation/allocation';
import {
  allocationOf,
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
import { BLOCK_MONTHS, DEFAULT_RUNS, DEFAULT_SEED, type GridCell, type SimResult } from '@/lib/fire/simulate';
import { canRunOut, vpwExpectedReturn } from '@/lib/fire/rules';
import type { PlanJob } from '@/lib/fire/jobs';
import { Masked } from './HideAmounts';
import { ScenarioBar, ScenariosCard, REFUSED_TEXT, rememberResult, type FixForm } from './PlanScenarios';
import { ScenarioTag } from './ScenarioTag';
import { LifeEventsCard } from './PlanEvents';
import { createScenarioClient, INITIAL_SCENARIOS, type ScenariosState } from './plan-scenarios';
import { planSavers, type Save } from './plan-savers';
import { currencyText, laterText, resolveErrorText, retirementText, shortText, startsWithText } from './plan-scenario-text';
import { planFigures, type PlanFigures, type StartsWith } from '@/lib/fire/plan-figures';
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
function useLast<T>(value: T | null): T | null {
  const last = useRef<T | null>(value);
  if (value !== null) last.current = value;
  return last.current;
}

export type SheetState =
  | { kind: 'about' }
  | { kind: 'figure'; figure: FigureKind }
  | { kind: 'assumptions' }
  | { kind: 'simulation' }
  | { kind: 'income'; item: PlanIncome | null }
  | { kind: 'expense'; item: PlanExpense | null };

const SHEET_TITLES: Record<SheetState['kind'], string> = {
  about: 'Your ages',
  figure: '',
  assumptions: 'Assumptions',
  simulation: 'Simulation',
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

/** "your last 12 months of transactions (Oct 9, 2025 to Oct 8, 2026)", or how
 *  much shorter it was, scaled up. */
export function windowText(flows: TrailingFlows): string {
  const range = `(${dayName(flows.from)} to ${dayName(flows.to)})`;
  if (!flows.scaled) return `your last 12 months of transactions ${range}`;
  const span = flows.days >= 300 ? `${flows.days} days` : `${Math.max(1, Math.round(flows.days / 30.4))} months`;
  return `${span} of transactions ${range}, scaled up to a year`;
}

/** The local time an instant was, for "balances as of". */
function fmtInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The day recovered balances were observed: the local day of the instant
 *  when the server knew it, else the stored UTC day (as Dashboard.tsx does). */
function staleDay(asOf: string, at: string | null): string {
  const local = at && at.slice(0, 10) === asOf ? instantDay(at) : null;
  return local ?? dayName(asOf);
}

function names(list: string[]): string {
  const unique = [...new Set(list)];
  if (unique.length <= 1) return unique[0] ?? '';
  return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

/** What may be missing from transaction-based figures, in a sentence, or null. */
export function unreadText(unread: UnreadTransactions[], what: 'low' | 'off'): string | null {
  if (unread.length === 0) return null;
  const named = unread.filter((u) => u.institution).map((u) => u.institution as string);
  const consequence = what === 'low' ? 'so this figure may be low' : 'so this figure may be off';
  if (named.length > 0) return `Transactions from ${names(named)} couldn't all be read (the Activity tab says why), ${consequence}.`;
  return `Your latest transactions couldn't be loaded, ${consequence} or out of date.`;
}

/** What may be wrong with the invested assets figure, one sentence per problem. */
export function assetCaveatLines(caveats: AssetCaveat[]): string[] {
  const unreachable = caveats.filter((c) => c.kind === 'unreachable').map((c) => c.institution);
  const lines: string[] = [];
  if (unreachable.length) lines.push(`${names(unreachable)} couldn't be reached and ${unreachable.length === 1 ? "isn't" : "aren't"} counted, so this figure may be low.`);
  for (const c of caveats) {
    if (c.kind === 'stale') lines.push(`${c.institution}'s balances are from ${staleDay(c.asOf, c.at)}: it couldn't be reached since.`);
    if (c.kind === 'missing') lines.push(`${c.count} account${c.count === 1 ? '' : 's'} at ${c.institution} couldn't be shown, so this figure may be low.`);
  }
  return lines;
}

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
}: PlanTabProps) {
  const [state, setState] = useState<ListState<FirePlan | null>>(initialListState<FirePlan | null>(null));
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
  const editable = state.status === 'ready' && !state.saving && !repairing && (!entry || !scenState.saving);

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
  });
  const { flows, unread, assets, contributions, workplace, cashOn, cashUnmarked } = inputs;
  const figures = fiFigures(basePlan, inputs, currency);
  const measured = measuredInputs(inputs);
  // The Plan's figures by the same function a scenario's come from: with no
  // life events, fiView and enginePlan exactly (lib/fire/plan-figures.ts).
  const baseFigures = planFigures(basePlan, measured) as PlanFigures;
  // Plan amounts are in the accounts' own currency, or the transactions'.
  const displayCurrency = figures.currency;
  const money = (n: number) => wholeMoney(n, displayCurrency);
  // Nothing is converted between currencies in this app: investments in one
  // and spending in another can't be compared (lib/fire/progress.ts). Within
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
  const open = (s: SheetState) => {
    setOpened((n) => n + 1);
    setSheetFor(shownForRef.current);
    setSheet(s);
  };
  const close = () => setSheet(null);
  useEffect(() => {
    setSheet(null);
  }, [shownFor]);
  // What a scenario's save said that has no form left to say it in: changed
  // on another device, so the drawer closed on the version it was made to.
  const [notice, setNotice] = useState<{ for: string; text: string } | null>(null);

  // Saving into the open scenario: what a form's save changes, recorded as
  // the scenario's own changes (lib/fire/scenarios.ts recordSave), with the
  // currency its amounts are in (the Plan's when this is its first).
  const persist = async (changes: ScenarioChanges, currencyNow?: string | null): Promise<boolean | string> => {
    if (!entry) return false;
    const kept = pruneMoot(basePlan, changes);
    const draft: ScenarioDraft = { name: entry.name, currency: currencyNow !== undefined ? currencyNow : currencyFor(entry, kept, planCurrency), ...kept };
    if (hasAmounts(draft) && draft.currency === null) return 'Your plan has no currency yet (no accounts to take it from), so a scenario can’t hold amounts: add an account first.';
    const r = await scenarios.save(entry.id, draft, entry.rev);
    if ('ok' in r) {
      setNotice(null);
      return true;
    }
    if (r.stale) setNotice({ for: entry.id, text: `${r.error} Nothing of your change was kept: make it again if it still applies.` });
    return r.error;
  };
  const saveToScenario: Save | null = entry
    ? async (next) => {
        if (other && planCurrency) return currencyText(other, planCurrency);
        const r = recordSave(basePlan, entry, next);
        if ('error' in r) return r.error;
        return persist(r.ok);
      }
    : null;
  // Every save the tab makes, from one place (components/plan-savers.ts).
  const savers = planSavers({ scenario: saveToScenario, savePlan: store.save, plan: basePlan, repaired: repairing ? repair.plan : null });
  const formPlan = entry ? applyScenario(basePlan, entry).plan : basePlan;
  const saversRef = useRef(savers);
  saversRef.current = savers;
  // Bound when the drawer opened: refused once the plan shown isn't the one
  // it was opened for (the drawer is closing by then).
  const saveFor =
    (target: string | null): Save =>
    async (next) =>
      target === shownForRef.current ? saversRef.current.form(next) : 'This form was opened for another plan than the one shown now, so nothing was saved.';
  const formProps = { plan: formPlan, onSave: saveFor(sheetFor), onDone: close, editable: editable && !other && sheetFor === shownFor, scenario: entry?.name ?? null };
  const scenarioName = entry?.name ?? null;
  // Back to the Plan puts focus on that scenario's row, where it can be
  // opened again, rather than losing it with the card that goes.
  const [backFrom, setBackFrom] = useState<string | null>(null);
  const back = () => {
    setBackFrom(entry?.id ?? null);
    setOpenId(null);
  };
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // Opening one moves focus to its card's heading, and the status line says
  // which plan the tab shows, so the switch is never silent.
  const everOpened = useRef(false);
  if (entry) everOpened.current = true;
  useEffect(() => {
    if (openId !== null) headingRef.current?.focus();
  }, [openId]);
  const shownStatus = entry ? `Showing the scenario ${entry.name}.` : everOpened.current ? 'Showing your plan.' : '';
  // "They're in" is offered only once the accounts have all loaded without a
  // problem: the Plan's currency is the one most of them are in, and may
  // read otherwise while they load.
  const txnsFailed = txns === null && !txnsLoading && txnNotes.length > 0;
  const confirmWhyNot =
    !balancesAsOf || institutions.length === 0 || txnsLoading || txnsFailed || unread.length > 0 || assets.caveats.length > 0
      ? 'Your plan’s currency is the one most of your invested accounts are in, and your accounts haven’t all loaded without a problem, so it may read otherwise for now: this isn’t offered until they have.'
      : null;
  const changes = entry ? scenarioChanges(basePlan, entry) : [];
  const scenarioMarks = entry
    ? {
        name: entry.name,
        replaced: new Set(changes.flatMap((c) => (c.kind === 'replaced' ? [c.item.id] : []))),
        added: new Set(changes.flatMap((c) => (c.kind === 'added' ? [c.item.id] : []))),
        leftOut: changes.flatMap((c) => (c.kind === 'left-out' ? [{ list: c.list, item: c.item }] : [])),
        onRestore: async (list: 'income' | 'expenses', id: string) => {
          const r = restoreItem(basePlan, entry, list, id);
          return 'error' in r ? r.error : persist(r.ok);
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
  const scenariosCard = (
    <ScenariosCard
      state={scenState}
      client={scenarios}
      base={basePlan}
      baseFigures={baseFigures}
      measured={measured}
      planCurrency={planCurrency}
      canOpen={canOpen}
      planState={state.status}
      whyNot={
        state.status === 'error'
          ? 'Your saved plan couldn’t be read, so scenarios can’t be worked out against it: try again above.'
          : !planLoaded
            ? 'Your plan is still loading: scenarios open, and are compared, once it has.'
            : repairing
              ? 'Your saved plan has values to fix first (above): scenarios open once it is saved.'
              : null
      }
      openId={entry ? entry.id : null}
      onOpen={setOpenId}
      focusId={backFrom}
      onFocused={() => setBackFrom(null)}
      run={(job, signal) => runner().run(job, signal)}
      cache={answers}
      method={basePlan.method}
      money={money}
      today={inputs.today}
    />
  );
  const fixForm = (f: Exclude<FixForm, null>) =>
    open(f === 'about' ? { kind: 'about' } : f === 'assumptions' ? { kind: 'assumptions' } : f === 'simulation' ? { kind: 'simulation' } : { kind: 'figure', figure: f });
  const scenarioBar = entry && (
    <ScenarioBar
      entry={entry}
      base={basePlan}
      problem={problem}
      other={other}
      planCurrency={planCurrency}
      confirmWhyNot={confirmWhyNot}
      editable={editable}
      money={money}
      eventsCount={entry.events.length}
      headingRef={headingRef}
      onSave={(c) => persist(c)}
      onConfirmCurrency={() => persist(changesOf(entry), planCurrency)}
      onFix={fixForm}
      notice={notice && notice.for === entry.id ? notice.text : null}
      onBack={back}
    />
  );

  if (state.status === 'loading' && state.value === null) {
    return (
      <div className="card">
        <div className="spinner" role="status" aria-label="Loading" />
      </div>
    );
  }

  return (
    <>
      {state.status === 'error' && (
        <div className="card">
          <div className="error" style={{ marginTop: 0 }}>
            {state.error}
          </div>
          <p className="panel-note">The figures below use the default assumptions until your saved ones load.</p>
          <button className="secondary" style={{ marginTop: 12 }} onClick={() => void store.load()}>
            Try again
          </button>
        </div>
      )}
      {state.saveError && <div className="error plan-save-error">{state.saveError}</div>}
      {repairing && savers.repair && <RepairCard fixed={repair.fixed} editable={state.status === 'ready' && !state.saving} onSave={savers.repair} money={money} />}
      <div className="visually-hidden" role="status">
        {shownStatus}
      </div>
      {scenarioBar}
      {entry && !shown ? (
        <>
          {/* Lasting changes below zero: the life events are what to change,
              so they stay here to change. */}
          {openFigures && 'refused' in openFigures && (
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
          {scenariosCard}
        </>
      ) : (
        <>
      <FiCard
        scenarioName={scenarioName}
        scenarioNotes={scenarioNotes}
        retirementSpending={shown?.retirement?.spending ?? null}
        walked={shown?.walked ?? false}
        walkedSavings={shown?.walkedSavings ?? null}
        fiShort={shown?.short ? shortText(shown.short, plan.age, money) : null}
        plan={plan}
        view={view}
        flows={flows}
        unread={unread}
        withoutTransactions={txnWithout}
        transactionCount={txns?.length ?? 0}
        txnsLoading={txnsLoading}
        txnsFailed={txnsFailed}
        assets={assets}
        balancesAsOf={balancesAsOf}
        workplace={workplace}
        workplaceCount={contributions === null ? null : contributions.length}
        currencyNote={currencyNote}
        convertedNote={convertedNote}
        cashOn={cashOn}
        cashUnmarked={cashUnmarked}
        money={money}
        editable={editable}
        open={open}
        savingsRate={figures.savingsRate}
      />

      {scenariosCard}

      <AllocationCard
        allocation={allocation}
        plan={plan}
        onSavePlan={savers.allocationMix}
        planEditable={editable}
        settingsLocked={!savers.allocationSettings}
        scenarioName={scenarioName}
        planKey={shownFor ?? 'plan'}
        institutions={institutions}
        balancesAsOf={balancesAsOf}
      />

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
        editable={editable}
        onMethod={savers.method}
        onRetry={retry}
        open={open}
      />

      {'sim' in engine && (
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

      <div className="card">
        <div className="inst-header">
          <div className="inst-name">About these numbers</div>
        </div>
        <p className="panel-note">{HYPOTHETICAL}</p>
        <p className="panel-note">
          Stocks are {DATA_STOCKS} and bonds are {DATA_BONDS}, from Robert Shiller&apos;s monthly data (January 1871 to June
          2023, so the monthly returns, each from one month to the next, run from January 1871 to May 2023). Everything is in
          today&apos;s dollars: returns are after inflation, so a constant withdrawal keeps its buying power.
        </p>
        <p className="panel-note">
          What this can&apos;t tell you: other countries&apos; markets, taxes beyond one flat rate (no brackets, account
          types or required withdrawals), or what is inside your funds (the mix is what you set). Spending from bank
          data misses anything paid outside the accounts you have connected.
        </p>
      </div>

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
        {shownSheet?.kind === 'assumptions' && <AssumptionsForm key={opened} {...formProps} />}
        {shownSheet?.kind === 'simulation' && (
          <SimulationForm
            key={opened}
            {...formProps}
            fiNumber={view.fiNumber}
            assets={view.assets.value}
            spending={view.spending.value}
            currency={displayCurrency}
            allocationMix={mixToOffer(allocation)}
          />
        )}
        {shownSheet?.kind === 'figure' && (
          <FigureForm
            key={opened}
            {...formProps}
            kind={shownSheet.figure}
            currency={displayCurrency}
            measured={measuredInputs(inputs)[shownSheet.figure]}
            measuredText={flows ? `from ${windowText(flows)}` : ''}
            assetsFor={(includeCash) => investedAssets(institutions, includeCash, balanceFx)}
            workplacePlans={workplacePlansOf(institutions).map((p) => ({ account_id: p.account_id, label: `${p.institution} ${p.name}` }))}
          />
        )}
        {shownSheet?.kind === 'income' && <IncomeForm key={opened} {...formProps} item={shownSheet.item} />}
        {shownSheet?.kind === 'expense' && <ExpenseForm key={opened} {...formProps} item={shownSheet.item} />}
      </Sheet>
    </>
  );
}

/** What the repaired values were, for the card that says so. */
const REPAIR_NAMES: Record<string, string> = {
  age: 'your age',
  targetAge: 'your target age',
  spending: 'the spending you typed',
  savings: 'the savings you typed',
  assets: 'the invested assets you typed',
  includeCash: 'whether cash counts as invested',
  withdrawalRate: 'the withdrawal rate',
  realReturn: 'the real return',
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
      <div className="error" style={{ marginTop: 0 }}>
        <Masked>
          {whole
            ? "Your saved plan can't be used by this version of Nya, so the figures below use the defaults."
            : `Your saved plan has ${fixed.length === 1 ? 'a value' : 'values'} this version of Nya can't use: ${what}.`}
        </Masked>
      </div>
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

/** Notes under a figure: what it came from, then each warning on its own line. */
function Notes({ source, warnings = [] }: { source: string; warnings?: (string | null)[] }) {
  const shown = warnings.filter((w): w is string => !!w);
  return (
    <>
      <Masked>{source}</Masked>
      {shown.map((w) => (
        <span key={w} className="plan-warning">
          <Masked>{w}</Masked>
        </span>
      ))}
    </>
  );
}

function EditButton({ onClick, disabled, label }: { onClick: () => void; disabled: boolean; label: string }) {
  return (
    <button className="plan-edit" onClick={onClick} disabled={disabled} aria-label={label}>
      Edit
    </button>
  );
}

export function FiCard({
  scenarioName = null,
  scenarioNotes = [],
  retirementSpending = null,
  walked = false,
  walkedSavings = null,
  fiShort = null,
  plan,
  view,
  flows,
  unread,
  withoutTransactions = NO_CONNECTIONS_WITHOUT,
  transactionCount = 0,
  txnsLoading,
  txnsFailed,
  assets: measuredAssets,
  balancesAsOf,
  workplace,
  workplaceCount,
  currencyNote,
  convertedNote = null,
  cashOn = [],
  cashUnmarked = false,
  money,
  editable,
  open,
  savingsRate = null,
}: {
  /** The open scenario's name, said at the top; null with the Plan open. */
  scenarioName?: string | null;
  /** What an open scenario's life events do to these figures, a line each. */
  scenarioNotes?: string[];
  /** Spending in retirement with a scenario's lasting changes, which the FI
   *  number is worked out from, when it differs from today's. */
  retirementSpending?: number | null;
  /** Years to FI came from the walk with a scenario's life events. */
  walked?: boolean;
  /** What that walk saves a year after the scenario's last change. */
  walkedSavings?: number | null;
  /** Why there is no FI date: a cost the walk can't pay. */
  fiShort?: string | null;
  plan: FirePlan;
  view: FiView;
  flows: TrailingFlows | null;
  /** Institutions whose transactions couldn't all be read. */
  unread: UnreadTransactions[];
  /** Connections that bring in no transactions (lib/no-transactions.ts). */
  withoutTransactions?: NoTransactionsView;
  /** How many transactions there are, entered by hand included: with any,
   *  there is spending to measure, whatever the connections bring in. */
  transactionCount?: number;
  txnsLoading: boolean;
  /** The transactions couldn't be loaded at all. */
  txnsFailed: boolean;
  assets: InvestedAssets;
  balancesAsOf: string | null;
  /** Workplace plan contributions, null while they load. */
  workplace: WorkplaceSavings | null;
  /** How many workplace plans there are to measure, null while unknown. */
  workplaceCount: number | null;
  currencyNote: string | null;
  /** What was converted into the Plan's currency (lib/fire/progress.ts
   *  convertedNote), with a home currency. */
  convertedNote?: string | null;
  /** The names of the cash accounts the cash spending was entered on. */
  cashOn?: string[];
  /** Spending was entered by hand on a manual account not marked as cash. */
  cashUnmarked?: boolean;
  money: (n: number) => string;
  editable: boolean;
  open: (s: SheetState) => void;
  /** The trailing year's savings rate (lib/fire/progress.ts), as Home shows it. */
  savingsRate?: number | null;
}) {
  const { spending, savings, assets } = view;
  // A bank account or card whose transactions don't come in (Plaid doesn't
  // provide them, or they weren't allowed) leaves spending short as surely as
  // one that couldn't be read; no connection that can bring spending in at
  // all, and no transaction from anywhere else, is said in place of the
  // figure, not as waiting for it. With transactions entered by hand, the
  // connections that bring in none are named beside the figures instead. The
  // same function decides this for the FI card on Home (lib/fire/progress.ts),
  // from the same two inputs (components/plan-inputs.ts).
  const coverage = transactionCoverage(withoutTransactions, transactionCount);
  const noSpending = coverage.noSpending;
  // Said where the figure's source is, not as a warning: nothing is missing.
  const namedWithout = coverage.named;
  const alsoNamed = namedWithout ? ` ${namedWithout}` : '';
  const spendingMissing = spending.source === 'measured' ? transactionsMissing(unread, coverage) : null;
  const assetLines = assets.source === 'measured' ? assetCaveatLines(measuredAssets.caveats) : [];
  const assetsShort = assets.source === 'measured' && measuredAssets.caveats.some((c) => c.kind !== 'stale');

  // Spending: the window, what is in it beyond the Activity tab's rule, and
  // what may be missing.
  let spendingNote: React.ReactNode;
  if (spending.source === 'typed') spendingNote = 'typed by you';
  else if (!flows) {
    spendingNote = txnsLoading ? (
      'loading your transactions…'
    ) : txnsFailed ? (
      "your transactions couldn't be loaded; type your spending, or try again later"
    ) : noSpending ? (
      `${noSpending.lead}, so there are no bank or card transactions to measure spending from. Type it under Edit.`
    ) : (
      <Notes
        source={`not enough transactions to measure from yet${namedWithout ? `.${alsoNamed}` : ''}`}
        warnings={missingFigureNotes(withoutTransactions, 'uncounted')}
      />
    );
  } else {
    const parts: string[] = [];
    if (flows.loanPayments > 0) parts.push(`${money(flows.loanPayments)} of loan payments (principal counts as spending until the loan ends)`);
    // Cash withdrawn and cash spending entered by hand on an account marked
    // as cash are the same money: only the larger counts, and this says which,
    // and on which accounts (lib/fire/inputs.ts).
    const on = cashOn.length > 0 ? ` on ${names(cashOn)}` : '';
    if (flows.cash > 0) {
      parts.push(
        flows.cashEntered > 0
          ? `${money(flows.cash)} of cash withdrawals beyond the ${money(flows.cashEntered)} of cash spending you entered${on}, taken to be the same money`
          : `${money(flows.cash)} of cash withdrawals`
      );
    }
    const cashNote =
      flows.cashWithdrawn > 0 && flows.cash === 0
        ? ` Cash withdrawals (${money(flows.cashWithdrawn)}) aren't counted: the ${money(flows.cashEntered)} of cash spending you entered${on} is taken to be the same money.`
        : '';
    // Withdrawals counted beside spending entered on an account not marked as
    // cash: both count, so if that is the same cash, say how to stop it.
    const cashHint =
      flows.cashWithdrawn > 0 && flows.cashEntered === 0 && cashUnmarked
        ? "Cash withdrawals count as spent, and so does what you entered by hand. If what you entered is the cash you withdrew, mark its account as cash on hand (Update the account), so it isn't counted twice."
        : null;
    // Refunds are taken off, so the total and the largest are said: an odd
    // large one (a deposit returned, an insurance payout) can be seen.
    const big = flows.largestRefund;
    const refunds =
      flows.refunds > 0
        ? `, less ${money(flows.refunds)} of refunds${big ? ` (the largest, ${money(big.amount)} from ${big.name} on ${dayName(big.date)})` : ''}`
        : '';
    // Transactions the person left out of budgets and reports count in no
    // figure here either (lib/fire/inputs.ts), which the label says, and so
    // do those in another currency: in the words the FI card on Home uses
    // (lib/fire/progress.ts spendingLeftOut).
    const leftOut = spendingLeftOut(flows);
    // Loan payments not counted, by where they came from (lib/fire/inputs.ts).
    const unclearElsewhere = flows.unclearLoansElsewhere ?? 0;
    const unclearFromPlaid = flows.unclearLoans - unclearElsewhere;
    const excluded = leftOut.excluded ? ` ${leftOut.excluded}` : '';
    spendingNote = (
      <Notes
        source={`from ${windowText(flows)}${parts.length ? `. Includes ${parts.join(' and ')}` : ''}${refunds}.${cashNote}${excluded}${alsoNamed}`}
        warnings={[
          leftOut.otherCurrencies,
          uncategorizedNote(flows.uncategorized ?? 0),
          cashHint,
          // Said by where the rows came from: Plaid gives a loan's kind when it
          // knows it; a row entered, imported or from SimpleFIN has only its
          // category.
          unclearFromPlaid > 0.005
            ? `${money(unclearFromPlaid)} of loan payments isn't counted: Plaid doesn't say it is a mortgage, car, student or personal loan, so it may be paying off a card, which settles spending already counted.`
            : null,
          unclearElsewhere > 0.005
            ? `${money(unclearElsewhere)} of loan payments you entered, imported or categorized isn't counted: nothing says it pays a mortgage, car, student or personal loan rather than a card, whose payment settles spending already counted.`
            : null,
          unreadText(unread, 'low'),
          ...missingFigureNotes(withoutTransactions, 'low'),
        ]}
      />
    );
  }

  // Savings: bank income minus spending, plus workplace plan contributions.
  let savingsNote: React.ReactNode;
  if (savings.source === 'typed') {
    // The savings rate (Home's) is from the transactions whatever is typed
    // here, so it is said here too, as what they measure.
    savingsNote =
      flows && savingsRate !== null
        ? `typed by you. Measured from ${windowText(flows)} instead, your savings rate is ${savingsRateText(savingsRate)} of income.`
        : 'typed by you';
  }
  else if (!flows) {
    savingsNote = txnsLoading
      ? 'loading your transactions…'
      : noSpending
        ? `${noSpending.lead}, so there are no bank or card transactions to measure income and spending from. Type it under Edit.`
        : `needs a year of transactions${namedWithout ? `.${alsoNamed}` : ''}`;
  }
  else {
    // What was added for each workplace plan, what counted and what didn't,
    // so nothing is counted twice unseen (lib/fire/inputs.ts workplaceSavings).
    const plans = workplace?.plans ?? [];
    const addedTo = plans.filter((x) => x.added > 0).map((x) => x.name);
    const fromBank = workplace?.fromBank ?? [];
    const plus = addedTo.length ? `, plus ${money(workplace!.total)} paid into ${names(addedTo)}` : '';
    const planLines = plans.flatMap((x) => [
      x.added > 0
        ? x.count > 0
          ? `${x.name}: ${x.count} contribution${x.count === 1 ? '' : 's'} added, ${money(x.added)}${x.largest ? `, the largest ${money(x.largest.amount)} on ${dayName(x.largest.date)}` : ''}${x.paidFrom === 'payroll' ? ', all of them, as it is set as paid through payroll' : ''}.`
          : `${x.name}: ${money(x.added)} added.`
        : null,
      x.matched > 0
        ? `${money(x.matched)} more paid into ${x.name} matched transfers from your bank to investment and retirement funds, which already count as saved, so it isn't added again.`
        : null,
      x.paidFrom === null && x.added > 0
        ? `How ${x.name} is paid into isn't set: if you pay into it from your bank account, say so under Edit, or it may count twice.`
        : null,
    ]);
    const rate =
      savingsRate !== null
        ? ` That is a savings rate of ${savingsRateText(savingsRate)} of income${addedTo.length ? ', what went into those plans counted as income too' : ''}.`
        : '';
    savingsNote = (
      <Notes
        source={`an estimate: income minus spending over the same ${flows.scaled ? 'span' : '12 months'}${plus}.${rate}${alsoNamed}`}
        warnings={[
          workplaceCount === null ? 'Checking contributions to workplace plans…' : null,
          workplaceCount === 0 ? PAYROLL_NOTE : null,
          ...planLines,
          fromBank.length
            ? `${names(fromBank)} ${fromBank.length === 1 ? 'is' : 'are'} set as paid from your bank, so nothing paid into ${fromBank.length === 1 ? 'it' : 'them'} is added again.`
            : null,
          ...(workplace?.partial ?? []).map((p) => `${p.name} is counted from ${dayName(p.from)}, when Nya's record of it starts.`),
          ...(workplace?.shortHistory ?? []).map((p) => `Nya has activity for ${p.name} from ${dayName(p.from)}.`),
          workplace && workplace.unmeasured.length ? `Contributions to ${names(workplace.unmeasured)} couldn't be measured, so this figure may be low.` : null,
          ...(workplace?.problems ?? []).map((p) => `${p.name}'s activity couldn't all be read, so this figure may be low.`),
          unreadText(unread, 'off'),
          ...missingFigureNotes(withoutTransactions, 'off'),
        ]}
      />
    );
  }

  // Invested assets: what was counted, as of when, and what may be missing.
  let assetsNote: React.ReactNode;
  if (assets.source === 'typed') assetsNote = 'typed by you';
  else if (assets.source === 'none') {
    assetsNote = <Notes source="no investment accounts to measure from" warnings={assetCaveatLines(measuredAssets.caveats)} />;
  } else {
    const n = measuredAssets.accounts.length;
    const what = `${n} ${plan.includeCash ? 'investment and cash account' : 'investment account'}${n === 1 ? '' : 's'}`;
    assetsNote = (
      <Notes
        source={`from ${what}${balancesAsOf ? `, balances as of ${fmtInstant(balancesAsOf)}` : ''}.`}
        warnings={[
          ...assetLines,
          measuredAssets.unknown > 0 ? `${measuredAssets.unknown} more had no balance to count, so this figure may be low.` : null,
          assetsLeftOut(measuredAssets),
        ]}
      />
    );
  }

  // The same words as the FI card on Home (components/FiProgressCard.tsx).
  const yearsLine = fiShort ? 'None' : yearsToFiText(view.yearsToFi);
  let yearsNote = '';
  if (fiShort) {
    yearsNote = fiShort;
  } else if (walked && view.yearsToFi !== null && view.yearsToFi > 0 && view.yearsToFi !== Infinity) {
    yearsNote = `${view.fiAge !== null ? `Around age ${Math.round(view.fiAge)}, at` : 'At'} a steady ${pct(plan.realReturn)} real return, with this scenario’s life events changing what is saved in their years.`;
  } else if (walked && view.yearsToFi === Infinity) {
    yearsNote = `With this scenario’s life events you’d save ${money(walkedSavings ?? 0)} a year after its last change, and at ${pct(plan.realReturn)} real that never reaches it.`;
  } else if (view.yearsToFi === Infinity) {
    yearsNote = `Saving ${money(savings.value ?? 0)} a year at ${pct(plan.realReturn)} real never reaches it.`;
  } else if (view.yearsToFi !== null && view.yearsToFi > 0) {
    yearsNote = `${view.fiAge !== null ? `Around age ${Math.round(view.fiAge)}, saving` : 'Saving'} ${money(savings.value ?? 0)} a year at a steady ${pct(plan.realReturn)} real return.`;
  } else if (view.yearsToFi === null) {
    yearsNote = view.fiNumber === null ? 'Needs your annual spending.' : 'Needs your invested assets or savings.';
  }

  const fiSpending = retirementSpending ?? spending.value;
  return (
    <div className="card">
      <ScenarioTag name={scenarioName} />
      <div className="total-label">FI number</div>
      <div className="total-value">
        <Masked>{view.fiNumber !== null ? money(view.fiNumber) : '--'}</Masked>
      </div>
      <div className="as-of">
        <Masked>
          {view.fiNumber !== null && fiSpending !== null
            ? `${money(fiSpending)} a year${retirementSpending !== null ? ' in retirement' : ''}${plan.taxRate > 0 ? `, grossed up for ${pct(plan.taxRate)} tax,` : ''} ÷ ${pct(plan.withdrawalRate)} withdrawal rate`
            : !formulasTake(plan)
              ? "Can't be worked out from the saved withdrawal, tax or return rate: change them under Assumptions."
              : 'Needs your annual spending: connect accounts with transactions, or type it below.'}
        </Masked>
      </div>
      {spendingMissing && <div className="as-of stale">{`May be low: spending is missing ${spendingMissing} (below).`}</div>}
      {view.progress !== null && (
        <>
          <div className="meter-track" role="img" aria-label={`Invested assets are ${progressText(view.progress)} of the FI number`}>
            <div className={`meter-fill${view.progress >= 1 ? ' done' : ''}`} style={{ width: `${Math.min(100, view.progress * 100)}%` }} />
          </div>
          <div className="as-of">
            <Masked>{money(assets.value ?? 0)}</Masked> invested · {progressText(view.progress)} of the way
          </div>
          {assetsShort && <div className="as-of stale">Invested assets may be low (below).</div>}
        </>
      )}
      {currencyNote && <div className="as-of stale">{currencyNote}</div>}
      {convertedNote && <div className="as-of">{convertedNote}</div>}
      {scenarioNotes.map((n) => (
        <div key={n} className="as-of">
          <Masked>{n}</Masked>
        </div>
      ))}

      <div className="plan-rows">
        <Row label="Years to FI" value={yearsLine} note={yearsNote} />
        <Row
          label="Coast FI"
          value={view.coast ? money(view.coast.number) : '--'}
          note={
            view.coast
              ? `Invested today, this grows to your FI number by age ${plan.targetAge} at ${pct(plan.realReturn)} real with nothing more added. ${view.coast.reached ? 'You have that much.' : `You have ${money(assets.value ?? 0)}.`}`
              : 'Needs your age and target age.'
          }
        />
        {view.barista && (
          <Row
            label="Barista FI"
            value={money(view.barista.number)}
            note={`With ${money(plan.partTimeIncome)} a year of part-time income covering part of your spending${view.barista.yearsTo !== null ? (view.barista.yearsTo === 0 ? '. You have that much.' : view.barista.yearsTo === Infinity ? '. Not reached at this rate.' : `, ${yearsText(view.barista.yearsTo)} away.`) : '.'}`}
          />
        )}
        {view.atTargetAge !== null && plan.targetAge !== null && (
          <Row label={`At age ${plan.targetAge}`} value={money(view.atTargetAge)} note={`Projected at a steady ${pct(plan.realReturn)} real return. Real markets don't move steadily; the simulation below shows how much that matters.`} />
        )}
      </div>

      <div className="plan-subhead">From</div>
      <div className="plan-rows">
        <Row
          label="Annual spending"
          value={spending.value !== null ? money(spending.value) : '--'}
          note={spendingNote}
          action={<EditButton onClick={() => open({ kind: 'figure', figure: 'spending' })} disabled={!editable} label="Edit annual spending" />}
        />
        <Row
          label="Invested assets"
          value={assets.value !== null ? money(assets.value) : '--'}
          note={assetsNote}
          action={<EditButton onClick={() => open({ kind: 'figure', figure: 'assets' })} disabled={!editable} label="Edit invested assets" />}
        />
        <Row
          label="Annual savings"
          value={savings.value !== null ? money(savings.value) : '--'}
          note={savingsNote}
          action={<EditButton onClick={() => open({ kind: 'figure', figure: 'savings' })} disabled={!editable} label="Edit annual savings" />}
        />
        <Row
          label="Ages"
          value={plan.age !== null || plan.targetAge !== null ? `${plan.age ?? '?'} now, ${plan.targetAge ?? '?'} target` : 'Not set'}
          note={plan.age !== null || plan.targetAge !== null ? 'typed by you' : 'Add them for Coast FI and to place income by age'}
          action={<EditButton onClick={() => open({ kind: 'about' })} disabled={!editable} label="Edit your ages" />}
        />
        <Row
          label="Assumptions"
          value={`${pct(plan.withdrawalRate)} · ${pct(plan.realReturn)} · ${pct(plan.taxRate)}`}
          note={`withdrawal rate · real return until FI · tax on withdrawals${plan.partTimeIncome > 0 ? ` · ${money(plan.partTimeIncome)} part-time income` : ''}`}
          action={<EditButton onClick={() => open({ kind: 'assumptions' })} disabled={!editable} label="Edit assumptions" />}
        />
      </div>
    </div>
  );
}

const MISSING_TEXT: Record<Missing, string> = {
  spending: 'The simulation withdraws your annual spending, so it needs it. Type it above, or connect accounts with transactions.',
  assets: 'The simulation starts with your invested assets, and there are none to count yet. Type them above, or start from your FI number (Change).',
  balance: 'Type the balance to start with (Change).',
};

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
  editable,
  onMethod,
  onRetry,
  open,
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
  editable: boolean;
  /** Null: the method can't be changed here (a scenario uses the Plan's). */
  onMethod: ((m: FirePlan['method']) => void) | null;
  /** Runs it again, when it couldn't be run at all. */
  onRetry: () => void;
  open: (s: SheetState) => void;
}) {
  const header = (
    <>
      <ScenarioTag name={scenarioName} />
      <div className="inst-header">
        <div className="inst-name">Will it last?</div>
        <button className="plan-edit" onClick={() => open({ kind: 'simulation' })} disabled={!editable}>
          Change
        </button>
      </div>
      <Choice
        label="Method"
        value={plan.method}
        disabled={!editable || !onMethod}
        onChange={(m) => onMethod?.(m)}
        options={[
          ['historical', 'History'],
          ['monte-carlo', 'Monte Carlo'],
        ]}
      />
      {!onMethod && <p className="panel-note">The method is your plan’s: every scenario uses it, so they compare. Change it with your plan open.</p>}
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
        <Masked>{`It starts with ${startsWithText(startsWith, money).replace(/\.$/, '')}: it starts with money it wouldn’t have then, so it reads safer than it is.`}</Masked>
      </p>
    ) : null;

  if ('missing' in engine) {
    return (
      <div className="card">
        {header}
        <p className="empty-note">{MISSING_TEXT[engine.missing]}</p>
      </div>
    );
  }
  const { sim, startAge, left, rate, rateFrom } = engine;
  const placedIncome = plan.income.filter((x) => !left.income.includes(x));
  const placedExpenses = plan.expenses.filter((x) => !left.expenses.includes(x) && !engine.beyond.includes(x));
  const startLabel = plan.start === 'fi-number' ? 'your FI number' : plan.start === 'assets' ? 'your invested assets' : 'the balance you typed';
  const when = plan.start === 'assets' ? `today${startAge !== null ? `, at ${startAge},` : ''}` : startAge !== null ? `at ${startAge}` : 'at your target age';
  const spendingNow = view.spending.value;
  const vpw = plan.rule === 'vpw';

  // The setup, and what the starting choice means for it.
  let setup: React.ReactNode;
  if (vpw) {
    setup = `Retire ${when} with ${money(sim.startBalance)} (${startLabel}), for ${sim.years} years${startAge !== null ? ` (to age ${startAge + sim.years})` : ''}. VPW sets each year's spending from the balance and the years left.`;
  } else if (rateFrom === 'spending') {
    setup = (
      <>
        Retire {when} with <Masked>{money(sim.startBalance)}</Masked> ({startLabel}), spending what you spend now,{' '}
        <Masked>{money(spendingNow ?? 0)}</Masked> a year after tax, for {sim.years} years{startAge !== null ? ` (to age ${startAge + sim.years})` : ''}. That is a{' '}
        <strong>{pct(rate, 1)}</strong> withdrawal rate{rate > plan.withdrawalRate * 1.001 ? `, above the ${pct(plan.withdrawalRate)} your FI number assumes` : ''}.
      </>
    );
  } else {
    setup = `Retire ${when} with ${money(sim.startBalance)} (${startLabel}), withdrawing ${pct(rate)} of it, ${money(spendingNow ?? 0)} a year after tax, your spending now, for ${sim.years} years${startAge !== null ? ` (to age ${startAge + sim.years})` : ''}.`;
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
              above don&apos;t depend on it.
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
  const alloc = allocationOf(plan);
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
          {flexible ? ' This rule lasts by cutting spending when markets fall; the second figure is how far.' : ''} Hypothetical, from US
          history: not a prediction, and not advice.
        </p>

        <PlanFanChart bands={r.balance} startAge={startAge} currency={currency} />
        <div className="as-of">
          Ending balance: <Masked>{money(r.ending.p10)}</Masked> (10th percentile), <Masked>{money(r.ending.p50)}</Masked> (median), <Masked>{money(r.ending.p90)}</Masked> (90th).
        </div>

        {canRunOut(plan.rule) === false && r.successRate === 1 && (
          <p className="panel-note">This rule only ever withdraws a share of what is there, so it cannot run out; how far spending falls is the risk to watch.</p>
        )}

        {r.method === 'historical' && r.worst.length > 0 && (
          <>
            <div className="plan-subhead">Worst starting years</div>
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
          </>
        )}

        <div className="plan-subhead">Assumptions</div>
        <ul className="plan-assumptions">
          <li>
            {r.method === 'historical'
              ? `${METHOD_NAMES.historical}: the plan started in every month from ${monthName(r.firstStart!)} to ${monthName(r.lastStart!)}, each living through what followed.`
              : `${METHOD_NAMES['monte-carlo']}: ${(r.runs ?? DEFAULT_RUNS).toLocaleString()} runs, each built from ${(r.blockMonths ?? BLOCK_MONTHS) / 12}-year blocks of consecutive months drawn at random from the history (seed ${r.seed ?? DEFAULT_SEED}, so the same plan gives the same answer).`}
          </li>
          <li>
            Mix: {pct(alloc.stocks, 0)} stocks, {pct(alloc.bonds, 0)} bonds, {pct(alloc.cash, 0)} cash (cash keeps up with inflation and earns nothing more), {REBALANCE_TEXT[plan.rebalance]}.
          </li>
          <li>
            {RULE_NAMES[plan.rule]}: {ruleText(plan.rule, { rate, floor: plan.floor, ceiling: plan.ceiling, expectedReturn: vpwExpectedReturn(alloc) })}
          </li>
          <li>
            Withdrawals once a year, at the start of the year. Fund fees {pct(plan.fee)} a year. Tax {pct(plan.taxRate)} of every withdrawal.
          </li>
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
          {hasEvents && <li>This scenario’s life events, from the retirement age on, as the Life events card says.</li>}
          <li>
            Returns are after inflation, from US history only: stocks are {DATA_STOCKS}, bonds {DATA_BONDS}.
          </li>
        </ul>
      </div>
    </div>
  );
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
}: {
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
      <div className="inst-header">
        <div className="inst-name">{plan.rule === 'vpw' ? 'By length' : 'By withdrawal rate and length'}</div>
      </div>
      <p className="panel-note">
        <Masked>
          {plan.rule === 'vpw'
            ? `VPW has no withdrawal rate to vary, so this is the plan at each length, starting with ${money(startBalance)}.`
            : `The share of ${noun} that lasted, each starting with ${money(startBalance)} and everything else as above.`}
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
        <p className="plan-definition">
          Each length starts in every month that leaves all of it inside the data, so a longer one has fewer, earlier starts
          {spans.length ? `: ${spans.join('; ')}` : ''}. A longer column leaves out the latest starts, which is why it can read
          safer than a shorter one. Hypothetical, from US history: not a prediction, and not advice.
        </p>
      ) : (
        <p className="plan-definition">
          Every column uses the same runs, each extended to the longer lengths. Hypothetical, from US history: not a prediction,
          and not advice.
        </p>
      )}
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
  onRestore: (list: 'income' | 'expenses', id: string) => Promise<boolean | string>;
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
                  setRestoreError(r === true ? '' : typeof r === 'string' ? r : 'It wasn’t saved. Try again in a moment.');
                }}
              >
                Use your plan’s
              </button>
            }
          />
        ))}
      </div>
      {restoreError && <div className="error">{restoreError}</div>}
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
