'use client';

// The Plan tab: financial independence, and how a retirement plan would have
// lasted. Loaded on demand (next/dynamic in Dashboard.tsx), since it carries
// the engine and 44 KB of market history the other tabs never need.
//
// What it shows, top to bottom:
//   - The FI view (lib/fire/plan.ts fiView): the FI number, years to FI,
//     Coast and Barista FI, each beside the inputs it came from and where
//     each input came from (measured by Nya, typed by you, or missing).
//   - "Will it last?": the plan run through history or Monte Carlo
//     (lib/fire/simulate.ts), with the success rate and its definition, a fan
//     chart, the worst starting years, and every assumption listed under it.
//   - The success grid by withdrawal rate and length, worked out after the
//     page has painted, one length at a time.
//   - Other income and one-off expenses, and what the numbers can't say.
//
// The math runs here in the browser from pure functions; only the plan's
// assumptions go to the server (/api/fire-plan), saved whole on each change
// through lib/whole-list-store.ts, which never lets an unloaded plan be
// saved over the real one.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Txn } from './MonthBreakdown';
import { Sheet } from './Sheet';
import PlanFanChart from './PlanFanChart';
import PlanGrid, { type GridMetric } from './PlanGrid';
import { AboutForm, AssumptionsForm, Choice, ExpenseForm, FigureForm, IncomeForm, SimulationForm, type FigureKind } from './PlanForms';
import {
  HYPOTHETICAL,
  METHOD_NAMES,
  REBALANCE_TEXT,
  RULE_NAMES,
  monthName,
  pct,
  ruleText,
  successDefinition,
  successText,
  wholeMoney,
  yearsText,
} from './plan-text';
import { createWholeListStore, initialListState, type ListState } from '@/lib/whole-list-store';
import { localDate } from '@/lib/local-date';
import { investedAssets, trailingFlows, type AssetAccount, type TrailingFlows } from '@/lib/fire/inputs';
import {
  allocationOf,
  DEFAULT_PLAN,
  enginePlan,
  fiView,
  isFirePlan,
  planYears,
  type EnginePlan,
  type FirePlan,
  type FiView,
  type PlanExpense,
  type PlanIncome,
} from '@/lib/fire/plan';
import { BLOCK_MONTHS, DEFAULT_RUNS, DEFAULT_SEED, simulate, successGrid, type GridCell, type SimResult } from '@/lib/fire/simulate';
import { canRunOut, vpwExpectedReturn } from '@/lib/fire/rules';
import { usMarket } from '@/lib/fire/us-market';

/** The grid's rows and columns; the plan's own rate and length are added. */
const GRID_RATES = [0.03, 0.035, 0.04, 0.045, 0.05];
const GRID_YEARS = [20, 30, 40, 50];

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

/** Where the spending and savings figures came from, for the line beside them. */
function flowsSource(flows: TrailingFlows): string {
  const span = flows.scaled ? `${Math.max(1, Math.round(flows.days / 30.4))} months of transactions, scaled to a year` : 'your last 12 months of transactions';
  return `from ${span}`;
}

export default function PlanTab({
  txns,
  txnsLoading,
  accounts,
  currency,
}: {
  /** The dashboard's transactions, null until they load. */
  txns: Txn[] | null;
  txnsLoading: boolean;
  /** Every account, hidden ones included (they are left out here). */
  accounts: AssetAccount[];
  /** The accounts' main currency, for amounts nothing else labels. */
  currency: string | null;
}) {
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
      }),
    []
  );
  useEffect(() => {
    void store.load();
  }, [store]);

  const plan = state.value ?? DEFAULT_PLAN;
  const editable = state.status === 'ready' && !state.saving;

  // What Nya measures. "Today" is the viewer's calendar day.
  const today = localDate();
  const flows = useMemo(() => (txns ? trailingFlows(txns, today) : null), [txns, today]);
  const assets = useMemo(() => investedAssets(accounts, plan.includeCash), [accounts, plan.includeCash]);
  const view = fiView(plan, { spending: flows?.spending ?? null, savings: flows?.savings ?? null, assets: assets.total });
  // Plan amounts are in the accounts' own currency, or the transactions'.
  const displayCurrency = assets.currency ?? flows?.currency ?? currency;
  const money = (n: number) => wholeMoney(n, displayCurrency);
  const mixedCurrency = assets.mixedCurrency || !!flows?.mixedCurrency;

  // The simulation, recomputed only when what it runs on changes.
  const engine = enginePlan(plan, view);
  const sim = 'sim' in engine ? engine.sim : null;
  const simKey = sim ? JSON.stringify([plan.method, sim]) : null;
  const outcome = useMemo((): { result: SimResult } | { error: string } | null => {
    if (!sim) return null;
    try {
      return { result: simulate(plan.method, sim, usMarket()) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'the plan could not be run' };
    }
    // simKey stands for plan.method and sim, which are new objects each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simKey]);

  // The grid: after the page has painted, one length at a time, so a phone
  // stays responsive while twenty plans run.
  const years = planYears(plan);
  const gridRates = useMemo(() => withOwn(GRID_RATES, plan.withdrawalRate), [plan.withdrawalRate]);
  const gridYears = useMemo(() => withOwn(GRID_YEARS, years), [years]);
  const gridKey = sim && plan.rule !== 'vpw' ? JSON.stringify([simKey, gridRates, gridYears]) : null;
  const [grid, setGrid] = useState<{ key: string; cells: GridCell[] } | null>(null);
  const simRef = useRef(sim);
  simRef.current = sim;
  useEffect(() => {
    const s = simRef.current;
    if (!gridKey || !s) return;
    const method = plan.method;
    let cancelled = false;
    const cells: GridCell[] = [];
    let next = 0;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      if (cancelled) return;
      try {
        cells.push(...successGrid(method, s, usMarket(), gridRates, [gridYears[next]]));
      } catch {
        return; // a length the history can't cover stays blank
      }
      next++;
      setGrid({ key: gridKey, cells: cells.slice() });
      if (next < gridYears.length) timer = setTimeout(step, 0);
    };
    timer = setTimeout(step, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // gridKey stands for everything the grid is computed from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridKey]);
  const gridCells = grid && grid.key === gridKey ? grid.cells : null;

  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [opened, setOpened] = useState(0);
  const shownSheet = useLast(sheet);
  const open = (s: SheetState) => {
    setOpened((n) => n + 1);
    setSheet(s);
  };
  const close = () => setSheet(null);
  const formProps = { plan, onSave: store.save, onDone: close, editable };

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

      <FiCard plan={plan} view={view} flows={flows} assetsCount={assets.accounts.length} unknownAssets={assets.unknown} txnsLoading={txnsLoading} mixedCurrency={mixedCurrency} money={money} editable={editable} open={open} />

      <SimulationCard
        plan={plan}
        engine={engine}
        outcome={outcome}
        money={money}
        currency={displayCurrency}
        editable={editable}
        onMethod={(method) => void store.save({ ...plan, method })}
        open={open}
      />

      {sim && (
        <GridCard plan={plan} cells={gridCells} rates={gridRates} years={gridYears} ownYears={sim.years} startBalance={sim.startBalance} money={money} />
      )}

      <EventsCard plan={plan} engine={engine} money={money} editable={editable} open={open} />

      <div className="card">
        <div className="inst-header">
          <div className="inst-name">About these numbers</div>
        </div>
        <p className="panel-note">{HYPOTHETICAL}</p>
        <p className="panel-note">
          Stocks are the S&amp;P 500 with dividends reinvested and bonds are 10-year US Treasuries, from Robert
          Shiller&apos;s monthly data (January 1871 to June 2023). Everything is in today&apos;s dollars: returns are
          after inflation, so a constant withdrawal keeps its buying power.
        </p>
        <p className="panel-note">
          What this can&apos;t tell you: other countries&apos; markets, taxes beyond one flat rate (no brackets, account
          types or required withdrawals), or what is inside your funds (the mix is what you set). Spending from bank
          data misses anything paid outside the accounts you have connected.
        </p>
      </div>

      <Sheet
        open={!!sheet}
        title={shownSheet ? (shownSheet.kind === 'figure' ? FIGURE_TITLES[shownSheet.figure] : SHEET_TITLES[shownSheet.kind]) : ''}
        onClose={close}
      >
        {shownSheet?.kind === 'about' && <AboutForm key={opened} {...formProps} />}
        {shownSheet?.kind === 'assumptions' && <AssumptionsForm key={opened} {...formProps} />}
        {shownSheet?.kind === 'simulation' && (
          <SimulationForm key={opened} {...formProps} fiNumber={view.fiNumber} assets={view.assets.value} currency={displayCurrency} />
        )}
        {shownSheet?.kind === 'figure' && (
          <FigureForm
            key={opened}
            {...formProps}
            kind={shownSheet.figure}
            currency={displayCurrency}
            measured={shownSheet.figure === 'assets' ? assets.total : shownSheet.figure === 'spending' ? (flows?.spending ?? null) : (flows?.savings ?? null)}
            measuredText={
              shownSheet.figure === 'assets'
                ? `from ${assets.accounts.length} account${assets.accounts.length === 1 ? '' : 's'}`
                : flows
                  ? flowsSource(flows)
                  : ''
            }
            accounts={assets.accounts}
          />
        )}
        {shownSheet?.kind === 'income' && <IncomeForm key={opened} {...formProps} item={shownSheet.item} />}
        {shownSheet?.kind === 'expense' && <ExpenseForm key={opened} {...formProps} item={shownSheet.item} />}
      </Sheet>
    </>
  );
}

/** One line of the FI card: a label, its figure, and a note under them. */
function Row({ label, value, note, action }: { label: string; value: React.ReactNode; note?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="plan-row">
      <div className="plan-row-main">
        <span className="plan-row-label">{label}</span>
        <span className="plan-row-value">{value}</span>
      </div>
      {(note || action) && (
        <div className="plan-row-note">
          <span>{note}</span>
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

export function FiCard({
  plan,
  view,
  flows,
  assetsCount,
  unknownAssets,
  txnsLoading,
  mixedCurrency,
  money,
  editable,
  open,
}: {
  plan: FirePlan;
  view: FiView;
  flows: TrailingFlows | null;
  assetsCount: number;
  unknownAssets: number;
  txnsLoading: boolean;
  mixedCurrency: boolean;
  money: (n: number) => string;
  editable: boolean;
  open: (s: SheetState) => void;
}) {
  const { spending, savings, assets } = view;
  const source = (kind: 'spending' | 'savings' | 'assets'): string => {
    const input = view[kind];
    if (input.source === 'typed') return 'typed by you';
    if (kind === 'assets') {
      if (input.source === 'none') return 'no investment accounts to measure from';
      const what = `${assetsCount} ${plan.includeCash ? 'investment and cash account' : 'investment account'}${assetsCount === 1 ? '' : 's'}`;
      return `from ${what}${unknownAssets > 0 ? `; ${unknownAssets} more had no balance` : ''}`;
    }
    if (input.source === 'none' || !flows) return txnsLoading ? 'loading your transactions…' : 'not enough transactions to measure from yet';
    return kind === 'savings'
      ? `an estimate: income minus spending ${flowsSource(flows).replace(/^from /, 'over ')}. Pre-tax 401(k) contributions and an employer match aren't in bank data`
      : flowsSource(flows);
  };

  let yearsLine: React.ReactNode = '--';
  let yearsNote = '';
  if (view.yearsToFi === 0) yearsLine = 'You’re there';
  else if (view.yearsToFi === Infinity) {
    yearsLine = 'Not at this rate';
    yearsNote = `Saving ${money(savings.value ?? 0)} a year at ${pct(plan.realReturn)} real never reaches it.`;
  } else if (view.yearsToFi !== null) {
    yearsLine = yearsText(view.yearsToFi);
    yearsNote = `${view.fiAge !== null ? `Around age ${Math.round(view.fiAge)}, saving` : 'Saving'} ${money(savings.value ?? 0)} a year at a steady ${pct(plan.realReturn)} real return.`;
  } else {
    yearsNote = 'Needs your invested assets or savings.';
  }

  return (
    <div className="card">
      <div className="total-label">FI number</div>
      <div className="total-value">{view.fiNumber !== null ? money(view.fiNumber) : '--'}</div>
      <div className="as-of">
        {view.fiNumber !== null && spending.value !== null
          ? `${money(spending.value)} a year${plan.taxRate > 0 ? `, grossed up for ${pct(plan.taxRate)} tax,` : ''} ÷ ${pct(plan.withdrawalRate)} withdrawal rate`
          : 'Needs your annual spending: connect accounts with transactions, or type it below.'}
      </div>
      {view.progress !== null && (
        <>
          <div className="meter-track" role="img" aria-label={`Invested assets are ${pct(Math.min(view.progress, 9.99), 0)} of the FI number`}>
            <div className={`meter-fill${view.progress >= 1 ? ' done' : ''}`} style={{ width: `${Math.min(100, view.progress * 100)}%` }} />
          </div>
          <div className="as-of">
            {money(assets.value ?? 0)} invested · {pct(view.progress, 0)} of the way
          </div>
        </>
      )}
      {mixedCurrency && <div className="as-of stale">Accounts use more than one currency; amounts are added without converting them.</div>}

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
          note={source('spending')}
          action={<EditButton onClick={() => open({ kind: 'figure', figure: 'spending' })} disabled={!editable} label="Edit annual spending" />}
        />
        <Row
          label="Invested assets"
          value={assets.value !== null ? money(assets.value) : '--'}
          note={source('assets')}
          action={<EditButton onClick={() => open({ kind: 'figure', figure: 'assets' })} disabled={!editable} label="Edit invested assets" />}
        />
        <Row
          label="Annual savings"
          value={savings.value !== null ? money(savings.value) : '--'}
          note={source('savings')}
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

export function SimulationCard({
  plan,
  engine,
  outcome,
  money,
  currency,
  editable,
  onMethod,
  open,
}: {
  plan: FirePlan;
  engine: EnginePlan | { missing: string };
  outcome: { result: SimResult } | { error: string } | null;
  money: (n: number) => string;
  currency: string | null;
  editable: boolean;
  onMethod: (m: FirePlan['method']) => void;
  open: (s: SheetState) => void;
}) {
  const header = (
    <>
      <div className="inst-header">
        <div className="inst-name">Will it last?</div>
        <button className="plan-edit" onClick={() => open({ kind: 'simulation' })} disabled={!editable}>
          Change
        </button>
      </div>
      <Choice
        label="Method"
        value={plan.method}
        disabled={!editable}
        onChange={onMethod}
        options={[
          ['historical', 'History'],
          ['monte-carlo', 'Monte Carlo'],
        ]}
      />
    </>
  );

  if ('missing' in engine) {
    return (
      <div className="card">
        {header}
        <p className="empty-note">
          {engine.missing === 'spending'
            ? 'The simulation starts with your FI number, which needs your annual spending. Type it above, or start from your invested assets instead (Change).'
            : engine.missing === 'assets'
              ? 'The simulation starts with your invested assets, and there are none to count yet. Type them above, or start from your FI number (Change).'
              : 'Type the balance to start with (Change).'}
        </p>
      </div>
    );
  }
  const { sim, startAge, left } = engine;
  const placedIncome = plan.income.filter((x) => !left.income.includes(x));
  const placedExpenses = plan.expenses.filter((x) => !left.expenses.includes(x));
  if (!outcome || 'error' in outcome) {
    return (
      <div className="card">
        {header}
        <p className="empty-note">This plan can&apos;t be simulated: {outcome && 'error' in outcome ? outcome.error : 'unknown reason'}.</p>
      </div>
    );
  }
  const r = outcome.result;
  const startLabel = plan.start === 'fi-number' ? 'your FI number' : plan.start === 'assets' ? 'your invested assets' : 'the balance you typed';
  const ageText = startAge !== null ? ` at ${startAge}` : '';
  const flexible = plan.rule !== 'constant';
  const nouns = r.method === 'historical' ? 'historical starts' : 'Monte Carlo runs';
  const expected = vpwExpectedReturn(allocationOf(plan));
  const alloc = allocationOf(plan);

  return (
    <div className="card">
      {header}
      <p className="panel-note">
        Retire{ageText} with {money(sim.startBalance)} ({startLabel}), spending {money(r.firstYearSpending)} after tax in the first year, for{' '}
        {sim.years} years{startAge !== null ? ` (to age ${startAge + sim.years})` : ''}.
      </p>

      <div className="plan-stat">
        <span className="plan-stat-value">{successText(r.successRate, 1)}</span>
        <span className="plan-stat-label">
          of {r.paths.toLocaleString()} {nouns}
          {r.firstStart && r.lastStart ? ` (${monthName(r.firstStart)} to ${monthName(r.lastStart)})` : ''} lasted {sim.years} years
        </span>
      </div>
      <p className="plan-definition">
        {successDefinition(sim.years)} Hypothetical, from US history: not a prediction, and not advice.
      </p>

      <PlanFanChart bands={r.balance} startAge={startAge} currency={currency} />
      <div className="as-of">
        Ending balance: {money(r.ending.p10)} (10th percentile), {money(r.ending.p50)} (median), {money(r.ending.p90)} (90th).
      </div>

      {flexible && r.lowestSpending && r.firstYearSpending > 0 && (
        <p className="panel-note">
          Spending moves with this rule: in the worst {r.method === 'historical' ? 'start' : 'run'} that lasted
          {r.lowestSpending.start ? ` (${monthName(r.lowestSpending.start)})` : ''}, the lowest year was {money(r.lowestSpending.amount)}, {pct(r.lowestSpending.amount / r.firstYearSpending, 0)} of the first year&apos;s.
        </p>
      )}
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
                  {w.failedYear !== null
                    ? `ran out in year ${w.failedYear + 1}${startAge !== null ? ` (age ${startAge + w.failedYear})` : ''}`
                    : `lasted, ${money(w.endBalance)} left${flexible ? `, lowest year ${money(w.lowestSpending)}` : ''}`}
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
          {RULE_NAMES[plan.rule]}: {ruleText(plan.rule, { rate: plan.withdrawalRate, floor: plan.floor, ceiling: plan.ceiling, expectedReturn: expected })}
        </li>
        <li>
          Withdrawals once a year, at the start of the year. Fund fees {pct(plan.fee)} a year. Tax {pct(plan.taxRate)} of every withdrawal.
        </li>
        {placedIncome.map((x) => (
          <li key={x.id}>
            {x.label}: {money(x.amount)} a year after tax from age {x.fromAge}, {x.inflationAdjusted ? 'rising with inflation' : 'fixed, so it loses value to inflation once it starts'}.
          </li>
        ))}
        {placedExpenses.map((x) => (
          <li key={x.id}>
            {x.label}: {money(x.amount)} at age {x.atAge}, on top of the year&apos;s spending.
          </li>
        ))}
        <li>Returns are after inflation, from US history only: stocks are the S&amp;P 500, bonds 10-year Treasuries.</li>
      </ul>
    </div>
  );
}

export function GridCard({
  plan,
  cells,
  rates,
  years,
  ownYears,
  startBalance,
  money,
}: {
  plan: FirePlan;
  cells: GridCell[] | null;
  rates: number[];
  years: number[];
  ownYears: number;
  startBalance: number;
  money: (n: number) => string;
}) {
  const noun = plan.method === 'historical' ? 'starts' : 'runs';
  const metric: GridMetric = canRunOut(plan.rule) ? 'success' : 'spending';
  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">By withdrawal rate and length</div>
      </div>
      {plan.rule === 'vpw' ? (
        <p className="empty-note">VPW has no withdrawal rate to vary: its share each year comes from the years left.</p>
      ) : (
        <>
          <p className="panel-note">
            {metric === 'success'
              ? `The share of ${noun} that lasted, each starting with ${money(startBalance)} and everything else as above. Your plan is outlined.`
              : `This rule never runs out, so each cell shows the lowest year's spending as a share of the first year's, in the worst of the ${noun} that lasted. Your plan is outlined.`}
          </p>
          <PlanGrid cells={cells} rates={rates} horizons={years} current={{ rate: plan.withdrawalRate, years: ownYears }} metric={metric} pathsNoun={noun} />
          <p className="plan-definition">
            {metric === 'success' ? 'Success: the portfolio never ran out over the whole length. ' : ''}Hypothetical, from US history: not a
            prediction, and not advice.
          </p>
        </>
      )}
    </div>
  );
}

export function EventsCard({
  plan,
  engine,
  money,
  editable,
  open,
}: {
  plan: FirePlan;
  engine: EnginePlan | { missing: string };
  money: (n: number) => string;
  editable: boolean;
  open: (s: SheetState) => void;
}) {
  const left = 'left' in engine ? engine.left : { income: [], expenses: [] };
  const leftOut = new Set([...left.income.map((x) => x.id), ...left.expenses.map((x) => x.id)]);
  return (
    <div className="card">
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
            note={`from age ${x.fromAge}, after tax${x.inflationAdjusted ? ', rises with inflation' : ', fixed (loses value to inflation)'}${leftOut.has(x.id) ? '. Not in the simulation: add your age.' : ''}`}
            action={<EditButton onClick={() => open({ kind: 'income', item: x })} disabled={!editable} label={`Edit ${x.label}`} />}
          />
        ))}
        {plan.expenses.map((x) => (
          <Row
            key={x.id}
            label={x.label}
            value={money(x.amount)}
            note={`at age ${x.atAge}${leftOut.has(x.id) ? '. Not in the simulation: it falls outside the plan’s years, or your age is not set.' : ''}`}
            action={<EditButton onClick={() => open({ kind: 'expense', item: x })} disabled={!editable} label={`Edit ${x.label}`} />}
          />
        ))}
      </div>
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
