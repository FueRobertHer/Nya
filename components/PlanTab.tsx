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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Txn } from './MonthBreakdown';
import { Sheet } from './Sheet';
import PlanFanChart from './PlanFanChart';
import PlanGrid from './PlanGrid';
import { AboutForm, AssumptionsForm, Choice, ExpenseForm, FigureForm, IncomeForm, SimulationForm, type FigureKind } from './PlanForms';
import { createPlanRunner, type PlanRunner, type WorkerLike } from './plan-runner';
import {
  DATA_BONDS,
  DATA_STOCKS,
  HYPOTHETICAL,
  METHOD_NAMES,
  REBALANCE_TEXT,
  RULE_NAMES,
  dayName,
  monthName,
  pct,
  progressText,
  ruleText,
  successDefinition,
  successText,
  wholeMoney,
  yearsText,
} from './plan-text';
import { createWholeListStore, initialListState, type ListState } from '@/lib/whole-list-store';
import { instantDay, localDate } from '@/lib/local-date';
import {
  TRAILING_DAYS,
  investedAssets,
  isWorkplacePlan,
  trailingFlows,
  unreadTransactions,
  workplaceSavings,
  type AssetCaveat,
  type AssetInstitution,
  type InvestedAssets,
  type PlanContributions,
  type TrailingFlows,
  type UnreadTransactions,
  type WorkplaceSavings,
} from '@/lib/fire/inputs';
import {
  allocationOf,
  DEFAULT_PLAN,
  enginePlan,
  fiView,
  isFirePlan,
  type EnginePlan,
  type FirePlan,
  type FiView,
  type Missing,
  type PlanExpense,
  type PlanIncome,
} from '@/lib/fire/plan';
import { BLOCK_MONTHS, DEFAULT_RUNS, DEFAULT_SEED, type GridCell, type SimResult } from '@/lib/fire/simulate';
import { canRunOut, vpwExpectedReturn } from '@/lib/fire/rules';
import type { PlanJob } from '@/lib/fire/jobs';

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

export type Outcome = { result: SimResult } | { error: string };

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

/** One workplace plan contributions request per account, as the Accounts tab
 *  makes when an account is opened. Null until every answer is in. */
function useWorkplaceContributions(institutions: AssetInstitution[]): PlanContributions[] | null {
  const plans = institutions.flatMap((i) =>
    i.item_id
      ? i.accounts
          .filter((a) => !a.hidden && isWorkplacePlan(a.subtype))
          .map((a) => ({ item_id: i.item_id as string, account_id: a.account_id, name: a.name, institution: i.name }))
      : []
  );
  const key = plans.map((p) => `${p.item_id}:${p.account_id}`).join(',');
  const plansRef = useRef(plans);
  plansRef.current = plans;
  const [state, setState] = useState<{ key: string; plans: PlanContributions[] } | null>(null);
  useEffect(() => {
    const wanted = plansRef.current;
    let live = true;
    Promise.all(
      wanted.map(async (p): Promise<PlanContributions> => {
        const base = { account_id: p.account_id, name: p.name, institution: p.institution };
        try {
          const res = await fetch(`/api/investment-activity?id=${encodeURIComponent(p.account_id)}&item_id=${encodeURIComponent(p.item_id)}`);
          if (!res.ok) return { ...base, amount: null, from: null, note: null };
          const data = await res.json();
          return {
            ...base,
            amount: typeof data?.contributions_12m === 'number' ? data.contributions_12m : null,
            from: typeof data?.contributions_12m_from === 'string' ? data.contributions_12m_from : null,
            note: typeof data?.note === 'string' ? data.note : null,
          };
        } catch {
          return { ...base, amount: null, from: null, note: null };
        }
      })
    ).then((answers) => {
      if (live) setState({ key, plans: answers });
    });
    return () => {
      live = false;
    };
  }, [key]);
  return state && state.key === key ? state.plans : null;
}

export type PlanTabProps = {
  /** The dashboard's transactions, null until they load. */
  txns: Txn[] | null;
  txnsLoading: boolean;
  /** /api/transactions' notes: institutions whose transactions couldn't all
   *  be read ("Chase: needs to be reconnected"), or that the whole load failed. */
  txnNotes: string[];
  /** Every institution as the dashboard last loaded it, hidden accounts
   *  included (they are left out here), with its errors and stale state. */
  institutions: AssetInstitution[];
  /** When those balances were loaded: old when the dashboard is showing its
   *  saved copy (offline, or before it refreshes). */
  balancesAsOf: string | null;
  /** The accounts' main currency, for amounts nothing else labels. */
  currency: string | null;
};

export default function PlanTab({ txns, txnsLoading, txnNotes, institutions, balancesAsOf, currency }: PlanTabProps) {
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

  const plan = state.value ?? DEFAULT_PLAN;
  const editable = state.status === 'ready' && !state.saving;

  // What Nya measures, and what may be missing from it. "Today" is the
  // viewer's calendar day.
  const today = localDate();
  const flows = useMemo(() => (txns ? trailingFlows(txns, today) : null), [txns, today]);
  const unread = useMemo(() => unreadTransactions(txnNotes), [txnNotes]);
  const assets = useMemo(() => investedAssets(institutions, plan.includeCash), [institutions, plan.includeCash]);
  const contributions = useWorkplaceContributions(institutions);
  const yearAgo = useMemo(() => {
    const [y, m, d] = today.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d) - (TRAILING_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  }, [today]);
  const workplace = useMemo(() => (contributions ? workplaceSavings(contributions, yearAgo) : null), [contributions, yearAgo]);
  const view = fiView(plan, {
    spending: flows?.spending ?? null,
    savings: flows ? flows.savings + (workplace?.total ?? 0) : null,
    assets: assets.total,
  });
  // Plan amounts are in the accounts' own currency, or the transactions'.
  const displayCurrency = assets.currency ?? flows?.currency ?? currency;
  const money = (n: number) => wholeMoney(n, displayCurrency);
  // Nothing is converted between currencies in this app: investments in one
  // and spending in another can't be compared, nor added up within either.
  const currencyNote =
    assets.currency && flows?.currency && assets.currency !== flows.currency
      ? `Your investments are in ${assets.currency} and your spending in ${flows.currency}. Nya doesn't convert currencies, so the FI number and your assets can't be compared.`
      : assets.mixedCurrency || flows?.mixedCurrency
        ? "Your accounts use more than one currency; amounts are added without converting them."
        : null;

  const engine = enginePlan(plan, view);
  const sim = 'sim' in engine ? engine.sim : null;
  const simKey = sim ? JSON.stringify([plan.method, sim]) : null;

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

  // The simulation, recomputed only when what it runs on changes. While a new
  // answer is worked out the last one stays, dimmed, so nothing jumps.
  const simRef = useRef(sim);
  simRef.current = sim;
  const methodRef = useRef(plan.method);
  methodRef.current = plan.method;
  const [main, setMain] = useState<{ key: string; outcome: Outcome } | null>(null);
  useEffect(() => {
    const s = simRef.current;
    if (!simKey || !s) return;
    let live = true;
    void runner()
      .run({ kind: 'simulate', method: methodRef.current, plan: s })
      .then((r) => {
        if (!live) return;
        setMain({ key: simKey, outcome: r.ok && r.kind === 'simulate' ? { result: r.result } : { error: r.ok ? 'an unexpected answer' : r.error } });
      });
    return () => {
      live = false;
    };
    // simKey stands for plan.method and sim, which are new objects each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simKey]);

  // The grid, one cell per job, filling in as the answers arrive.
  const vpw = plan.rule === 'vpw';
  const ownRate = 'rate' in engine ? engine.rate : plan.withdrawalRate;
  const gridRates = useMemo<(number | null)[]>(
    () => (vpw ? [null] : ownRate <= GRID_MAX_OWN_RATE ? withOwn(GRID_RATES, ownRate) : GRID_RATES),
    [vpw, ownRate]
  );
  const gridYears = useMemo(() => withOwn(GRID_YEARS, sim?.years ?? 30), [sim?.years]);
  const gridKey = sim ? JSON.stringify([simKey, gridRates, gridYears]) : null;
  const [grid, setGrid] = useState<{ key: string; cells: GridCell[] } | null>(null);
  useEffect(() => {
    const s = simRef.current;
    if (!gridKey || !s) return;
    let live = true;
    const cells: GridCell[] = [];
    const method = methodRef.current;
    for (const years of gridYears) {
      for (const rate of gridRates) {
        void runner()
          .run({ kind: 'grid-cell', method, plan: s, rate, years })
          .then((r) => {
            if (!live || !r.ok || r.kind !== 'grid-cell') return;
            cells.push(r.cell);
            setGrid({ key: gridKey, cells: cells.slice() });
          });
      }
    }
    return () => {
      live = false;
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

      <FiCard
        plan={plan}
        view={view}
        flows={flows}
        unread={unread}
        txnsLoading={txnsLoading}
        txnsFailed={txns === null && !txnsLoading && txnNotes.length > 0}
        assets={assets}
        balancesAsOf={balancesAsOf}
        workplace={workplace}
        workplaceCount={contributions === null ? null : contributions.length}
        currencyNote={currencyNote}
        money={money}
        editable={editable}
        open={open}
      />

      <SimulationCard
        plan={plan}
        view={view}
        engine={engine}
        outcome={main?.outcome ?? null}
        pending={!!simKey && main?.key !== simKey}
        money={money}
        currency={displayCurrency}
        editable={editable}
        onMethod={(method) => void store.save({ ...plan, method })}
        open={open}
      />

      {'sim' in engine && (
        <GridCard
          plan={plan}
          cells={gridCells}
          rates={gridRates}
          years={gridYears}
          current={{ rate: vpw ? null : engine.rate, years: engine.sim.years }}
          startBalance={engine.sim.startBalance}
          money={money}
        />
      )}

      <EventsCard plan={plan} engine={engine} money={money} editable={editable} open={open} />

      <div className="card">
        <div className="inst-header">
          <div className="inst-name">About these numbers</div>
        </div>
        <p className="panel-note">{HYPOTHETICAL}</p>
        <p className="panel-note">
          Stocks are {DATA_STOCKS} and bonds are {DATA_BONDS}, from Robert Shiller&apos;s monthly data (January 1871 to June
          2023). Everything is in today&apos;s dollars: returns are after inflation, so a constant withdrawal keeps its
          buying power.
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
          <SimulationForm key={opened} {...formProps} fiNumber={view.fiNumber} assets={view.assets.value} spending={view.spending.value} currency={displayCurrency} />
        )}
        {shownSheet?.kind === 'figure' && (
          <FigureForm
            key={opened}
            {...formProps}
            kind={shownSheet.figure}
            currency={displayCurrency}
            measured={
              shownSheet.figure === 'assets'
                ? assets.total
                : shownSheet.figure === 'spending'
                  ? (flows?.spending ?? null)
                  : flows
                    ? flows.savings + (workplace?.total ?? 0)
                    : null
            }
            measuredText={flows ? `from ${windowText(flows)}` : ''}
            assetsFor={(includeCash) => investedAssets(institutions, includeCash)}
          />
        )}
        {shownSheet?.kind === 'income' && <IncomeForm key={opened} {...formProps} item={shownSheet.item} />}
        {shownSheet?.kind === 'expense' && <ExpenseForm key={opened} {...formProps} item={shownSheet.item} />}
      </Sheet>
    </>
  );
}

/** One line of the FI card: a label, its figure, and notes under them. */
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

/** Notes under a figure: what it came from, then each warning on its own line. */
function Notes({ source, warnings = [] }: { source: string; warnings?: (string | null)[] }) {
  const shown = warnings.filter((w): w is string => !!w);
  return (
    <>
      {source}
      {shown.map((w) => (
        <span key={w} className="plan-warning">
          {w}
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
  plan,
  view,
  flows,
  unread,
  txnsLoading,
  txnsFailed,
  assets: measuredAssets,
  balancesAsOf,
  workplace,
  workplaceCount,
  currencyNote,
  money,
  editable,
  open,
}: {
  plan: FirePlan;
  view: FiView;
  flows: TrailingFlows | null;
  /** Institutions whose transactions couldn't all be read. */
  unread: UnreadTransactions[];
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
  money: (n: number) => string;
  editable: boolean;
  open: (s: SheetState) => void;
}) {
  const { spending, savings, assets } = view;
  const spendingShort = spending.source === 'measured' && unread.length > 0;
  const assetLines = assets.source === 'measured' ? assetCaveatLines(measuredAssets.caveats) : [];
  const assetsShort = assets.source === 'measured' && measuredAssets.caveats.some((c) => c.kind !== 'stale');

  // Spending: the window, what is in it beyond the Activity tab's rule, and
  // what may be missing.
  let spendingNote: React.ReactNode;
  if (spending.source === 'typed') spendingNote = 'typed by you';
  else if (!flows) {
    spendingNote = txnsLoading
      ? 'loading your transactions…'
      : txnsFailed
        ? "your transactions couldn't be loaded; type your spending, or try again later"
        : 'not enough transactions to measure from yet';
  } else {
    const parts: string[] = [];
    if (flows.loanPayments > 0) parts.push(`${money(flows.loanPayments)} of loan payments (principal counts as spending until the loan ends)`);
    if (flows.cash > 0) parts.push(`${money(flows.cash)} of cash withdrawals`);
    spendingNote = (
      <Notes
        source={`from ${windowText(flows)}${parts.length ? `. Includes ${parts.join(' and ')}` : ''}${flows.refunds > 0 ? `, less ${money(flows.refunds)} of refunds` : ''}.`}
        warnings={[
          flows.unclearLoans > 0 ? `${money(flows.unclearLoans)} of loan payments Plaid gave no detail for isn't counted: it may be card payments, which settle spending already counted.` : null,
          unreadText(unread, 'low'),
        ]}
      />
    );
  }

  // Savings: bank income minus spending, plus workplace plan contributions.
  let savingsNote: React.ReactNode;
  if (savings.source === 'typed') savingsNote = 'typed by you';
  else if (!flows) savingsNote = txnsLoading ? 'loading your transactions…' : 'needs a year of transactions';
  else {
    const plans = workplace && workplace.measured.length ? ` plus ${money(workplace.total)} contributed to ${names(workplace.measured)}` : '';
    savingsNote = (
      <Notes
        source={`an estimate: income minus spending over the same ${flows.scaled ? 'span' : '12 months'}${plans}.`}
        warnings={[
          workplaceCount === null ? 'Checking contributions to workplace plans…' : null,
          workplaceCount === 0
            ? "Contributions taken from pay before it reaches a bank (a 401(k) Nya can't see, an employer's match) aren't in bank data."
            : null,
          ...(workplace?.partial ?? []).map((p) => `${p.name} is counted from ${dayName(p.from)}, when Nya's record of it starts.`),
          workplace && workplace.unmeasured.length ? `Contributions to ${names(workplace.unmeasured)} couldn't be measured, so this figure may be low.` : null,
          ...(workplace?.problems ?? []).map((p) => `${p.name}'s activity couldn't all be read, so this figure may be low.`),
          unreadText(unread, 'off'),
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
        warnings={[...assetLines, measuredAssets.unknown > 0 ? `${measuredAssets.unknown} more had no balance to count, so this figure may be low.` : null]}
      />
    );
  }

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
    yearsNote = view.fiNumber === null ? 'Needs your annual spending.' : 'Needs your invested assets or savings.';
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
      {spendingShort && <div className="as-of stale">May be low: spending is missing transactions that couldn&apos;t be read (below).</div>}
      {view.progress !== null && (
        <>
          <div className="meter-track" role="img" aria-label={`Invested assets are ${progressText(view.progress)} of the FI number`}>
            <div className={`meter-fill${view.progress >= 1 ? ' done' : ''}`} style={{ width: `${Math.min(100, view.progress * 100)}%` }} />
          </div>
          <div className="as-of">
            {money(assets.value ?? 0)} invested · {progressText(view.progress)} of the way
          </div>
          {assetsShort && <div className="as-of stale">Invested assets may be low (below).</div>}
        </>
      )}
      {currencyNote && <div className="as-of stale">{currencyNote}</div>}

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
  plan,
  view,
  engine,
  outcome,
  pending,
  money,
  currency,
  editable,
  onMethod,
  open,
}: {
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
        Retire {when} with {money(sim.startBalance)} ({startLabel}), spending what you spend now,{' '}
        {money(spendingNow ?? 0)} a year after tax, for {sim.years} years{startAge !== null ? ` (to age ${startAge + sim.years})` : ''}. That is a{' '}
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
        <p className="panel-note">{setup}</p>
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
        <p className="panel-note">{setup}</p>
        <p className="empty-note">This plan can&apos;t be simulated: {outcome.error}.</p>
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
      <p className="panel-note">{setup}</p>
      {vpw && spendingNow !== null && (
        <p className="panel-note">
          Its first year spends {money(r.firstYearSpending)} after tax, against the {money(spendingNow)} you spend now.
        </p>
      )}

      <div className={pending ? 'plan-result plan-result-pending' : 'plan-result'} aria-busy={pending}>
        <div className="plan-stats">
          <div className="plan-stat">
            <span className="plan-stat-value">{successText(r.successRate, 1)}</span>
            <span className="plan-stat-label">
              of {r.paths.toLocaleString()} {nouns}
              {r.firstStart && r.lastStart ? ` (${monthName(r.firstStart)} to ${monthName(r.lastStart)})` : ''} lasted {sim.years} years
            </span>
          </div>
          {flexible && (
            <div className="plan-stat">
              <span className="plan-stat-value">{lowShare === null ? '--' : successText(lowShare)}</span>
              <span className="plan-stat-label">
                {lowShare === null
                  ? 'no start lasted, so there is no spending to compare'
                  : `of the first year's spending in the lowest year, in the worst ${r.method === 'historical' ? 'start' : 'run'} that lasted${r.lowestSpending?.start ? ` (${monthName(r.lowestSpending.start)})` : ''}: ${money(r.lowestSpending!.amount)} against ${money(r.firstYearSpending)}`}
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
          Ending balance: {money(r.ending.p10)} (10th percentile), {money(r.ending.p50)} (median), {money(r.ending.p90)} (90th).
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
                    {w.failedYear !== null
                      ? `ran out in year ${w.failedYear + 1}${startAge !== null ? ` (age ${startAge + w.failedYear})` : ''}`
                      : `lasted, ${money(w.endBalance)} left${flexible ? `, lowest year ${money(w.lowestSpending)}` : ''}`}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

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
            {x.label}: {money(x.amount)} a year after tax from age {x.fromAge}, {x.inflationAdjusted ? 'rising with inflation' : "in today's dollars when it starts, then losing value to inflation"}.
          </li>
        ))}
        {placedExpenses.map((x) => (
          <li key={x.id}>
            {x.label}: {money(x.amount)} at age {x.atAge}, on top of the year&apos;s spending.
          </li>
        ))}
        <li>
          Returns are after inflation, from US history only: stocks are {DATA_STOCKS}, bonds {DATA_BONDS}.
        </li>
      </ul>
    </div>
  );
}

export function GridCard({
  plan,
  cells,
  rates,
  years,
  current,
  startBalance,
  money,
}: {
  plan: FirePlan;
  cells: GridCell[] | null;
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
      <div className="inst-header">
        <div className="inst-name">{plan.rule === 'vpw' ? 'By length' : 'By withdrawal rate and length'}</div>
      </div>
      <p className="panel-note">
        {plan.rule === 'vpw'
          ? `VPW has no withdrawal rate to vary, so this is the plan at each length, starting with ${money(startBalance)}.`
          : `The share of ${noun} that lasted, each starting with ${money(startBalance)} and everything else as above.`}
        {flexible ? " This rule lasts by cutting spending, so each cell's second line is the lowest year's spending, as a share of the first year's, in the worst one that lasted." : ''}{' '}
        Your plan is outlined.
      </p>
      <PlanGrid cells={cells} rates={rates} horizons={years} current={current} flexible={flexible} pathsNoun={noun} />
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

export function EventsCard({
  plan,
  engine,
  money,
  editable,
  open,
}: {
  plan: FirePlan;
  engine: EnginePlan | { missing: Missing };
  money: (n: number) => string;
  editable: boolean;
  open: (s: SheetState) => void;
}) {
  const left = 'left' in engine ? engine.left : { income: [], expenses: [] };
  const leftOut = new Set([...left.income.map((x) => x.id), ...left.expenses.map((x) => x.id)]);
  const beyond = new Set(('beyond' in engine ? engine.beyond : []).map((x) => x.id));
  const end = 'sim' in engine && engine.startAge !== null ? engine.startAge + engine.sim.years : null;
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
            note={`from age ${x.fromAge}, after tax${x.inflationAdjusted ? ', rises with inflation' : ", in today's dollars, then fixed (loses value to inflation)"}${leftOut.has(x.id) ? '. Not in the simulation: add your age.' : ''}`}
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
            }`}
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
