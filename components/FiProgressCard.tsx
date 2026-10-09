'use client';

// The FI card on Home: the Plan's FI number, years to FI and the trailing
// year's savings rate, small, with a way to the Plan tab.
//
// THE PLAN'S OWN FIGURES. It reads the saved plan (/api/fire-plan), repairs
// it as the Plan tab does (lib/fire/plan.ts repairPlan), measures from the
// same hook (components/plan-inputs.ts: a year of transactions, invested
// assets, workplace plan contributions) and works the figures out with the
// same function (lib/fire/progress.ts fiFigures), so Home and the Plan
// always agree. Never a simulation: the engine's code stays out of Home's
// bundle (components/FiProgressLoader.tsx loads this after Home paints), and
// nothing here runs it.
//
// WITH NO PLAN SAVED it shows what the Plan's defaults give (a 4% withdrawal
// rate, a 5% real return), says so, and links to the Plan tab: the FI number
// is a person's own spending over a rate the plan names, which is worth
// seeing before anything is set, and nothing in it is a guess about them.
// It shows nothing while what it needs loads, when there is no spending to
// work from, or when the plan can't be read: Home stays as it was, and the
// Plan tab says why.
//
// Every figure is an estimate, and says so: savings from bank data miss
// pre-tax contributions to a plan Nya can't see and an employer's match, in
// the Plan's own words.

import { useEffect, useMemo, useState } from 'react';
import type { Txn } from './MonthBreakdown';
import { usePlanInputs, workplacePlansOf, type PlanInputs } from './plan-inputs';
import { PAYROLL_NOTE, dayName, pct, progressText, savingsRateText, wholeMoney, yearsToFiText } from './plan-text';
import { DEFAULT_PLAN, isFirePlan, repairPlan, type FirePlan } from '@/lib/fire/plan';
import { fiFigures, type FiFigures } from '@/lib/fire/progress';
import type { AssetInstitution } from '@/lib/fire/inputs';

export type FiProgressProps = {
  txns: Txn[] | null;
  txnsLoading: boolean;
  txnNotes: string[];
  /** As the Plan tab gets them (components/Dashboard.tsx planInstitutions). */
  institutions: AssetInstitution[];
  currency: string | null;
  /** Opens the Plan tab. */
  onOpenPlan: () => void;
};

/** What /api/fire-plan answered: the saved plan, or null for none. */
type Loaded = { plan: FirePlan | null } | 'failed' | null;

export default function FiProgressCard({ txns, txnsLoading, txnNotes, institutions, currency, onOpenPlan }: FiProgressProps) {
  const [loaded, setLoaded] = useState<Loaded>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/fire-plan')
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        const plan: unknown = body?.plan;
        if (live) setLoaded(res.ok && (plan === null || isFirePlan(plan)) ? { plan } : 'failed');
      })
      .catch(() => {
        if (live) setLoaded('failed');
      });
    return () => {
      live = false;
    };
  }, []);
  const stored = loaded && loaded !== 'failed' ? loaded.plan : null;
  // As the Plan tab works from it: a value this release can't take is
  // replaced by its default there too, with the same result.
  const repair = useMemo(() => repairPlan(stored ?? DEFAULT_PLAN), [stored]);
  const plan = repair.plan;
  const inputs = usePlanInputs({ txns, txnNotes, institutions, includeCash: plan.includeCash, planFunding: plan.planFunding });
  if (
    !ready({
      plan: loaded === null ? 'loading' : loaded === 'failed' ? 'failed' : 'loaded',
      txns,
      txnsLoading,
      contributionsPending: inputs.contributions === null && workplacePlansOf(institutions).length > 0,
    })
  ) {
    return null;
  }
  return (
    <FiProgressView
      figures={fiFigures(plan, inputs, currency)}
      plan={plan}
      saved={stored !== null}
      repaired={repair.fixed.length > 0}
      inputs={inputs}
      onOpenPlan={onOpenPlan}
    />
  );
}

/**
 * Whether the card has what it needs to show figures that won't change a
 * moment later: the plan read (a plan that can't be read shows nothing, and
 * the Plan tab says why), the first load of transactions done (a refresh
 * keeps the card, with the transactions on screen, as the Plan tab does), and
 * the contributions to workplace plans in, since they change savings.
 */
export function ready(s: { plan: 'loading' | 'failed' | 'loaded'; txns: Txn[] | null; txnsLoading: boolean; contributionsPending: boolean }): boolean {
  if (s.plan !== 'loaded') return false;
  if (s.txns === null && s.txnsLoading) return false;
  return !s.contributionsPending;
}

/** The card itself, from figures already worked out. Null when there is no
 *  FI number to show. */
export function FiProgressView({
  figures,
  plan,
  saved,
  repaired,
  inputs,
  onOpenPlan,
}: {
  figures: FiFigures;
  plan: FirePlan;
  /** A plan was saved; otherwise these are the defaults. */
  saved: boolean;
  /** The saved plan had values this release can't use (the Plan tab shows them). */
  repaired: boolean;
  inputs: Pick<PlanInputs, 'unread' | 'assets' | 'workplace' | 'flows'>;
  onOpenPlan: () => void;
}) {
  const { view, savingsRate, currency, currencyNote } = figures;
  if (view.fiNumber === null) return null;
  const money = (n: number) => wholeMoney(n, currency);
  // As the Plan's FI card warns (components/PlanTab.tsx FiCard).
  const spendingShort = view.spending.source === 'measured' && inputs.unread.length > 0;
  const assetsShort = view.assets.source === 'measured' && inputs.assets.caveats.some((c) => c.kind !== 'stale');
  const workplaceAdded = (inputs.workplace?.total ?? 0) > 0;
  const typed = [view.spending.source === 'typed' && 'spending', view.savings.source === 'typed' && 'savings', view.assets.source === 'typed' && 'invested assets'].filter(
    (x): x is string => !!x
  );
  const rates = `a ${pct(plan.withdrawalRate)} withdrawal rate${plan.taxRate > 0 ? `, ${pct(plan.taxRate)} tax on withdrawals` : ''} and a ${pct(plan.realReturn)} real return`;
  return (
    <div className="card fi-card">
      <div className="inst-header">
        <div className="inst-name">Financial independence</div>
        <button className="plan-edit" onClick={onOpenPlan}>
          {saved ? 'Your plan' : 'Set up your plan'}
        </button>
      </div>
      <div className="plan-stats fi-stats">
        <div className="plan-stat">
          <span className="plan-stat-value">{money(view.fiNumber)}</span>
          <span className="plan-stat-label">FI number</span>
        </div>
        <div className="plan-stat">
          <span className="plan-stat-value">{yearsToFiText(view.yearsToFi)}</span>
          <span className="plan-stat-label">to FI</span>
        </div>
        {savingsRate !== null && (
          <div className="plan-stat">
            <span className="plan-stat-value">{savingsRateText(savingsRate)}</span>
            <span className="plan-stat-label">savings rate, {inputs.flows?.scaled ? `since ${dayName(inputs.flows.from)}` : 'last 12 months'}</span>
          </div>
        )}
      </div>
      {view.progress !== null && (
        <>
          <div className="meter-track" role="img" aria-label={`Invested assets are ${progressText(view.progress)} of the FI number`}>
            <div className={`meter-fill${view.progress >= 1 ? ' done' : ''}`} style={{ width: `${Math.min(100, view.progress * 100)}%` }} />
          </div>
          <div className="as-of">
            {money(view.assets.value ?? 0)} invested · {progressText(view.progress)} of the way
          </div>
        </>
      )}
      <p className="panel-note">
        Estimates, {saved ? `from your plan: ${rates}` : `from the Plan's default assumptions: ${rates}. Set your own on the Plan tab`}.
        {typed.length ? ` Using the ${typed.join(' and ')} you typed there.` : ''} The savings rate is income minus spending as a share of income
        {workplaceAdded ? ', with what went into workplace plans counted on both sides' : ''}.
      </p>
      {!workplaceAdded && view.savings.source === 'measured' && <p className="panel-note">{PAYROLL_NOTE}</p>}
      {spendingShort && <div className="as-of stale">May be low: spending is missing transactions that couldn&apos;t be read. The Plan tab says which.</div>}
      {assetsShort && <div className="as-of stale">Invested assets may be low: some couldn&apos;t be counted. The Plan tab says which.</div>}
      {currencyNote && <div className="as-of stale">{currencyNote}</div>}
      {repaired && <div className="as-of stale">Your saved plan has values this version of Nya can&apos;t use, so these use the defaults for them. The Plan tab says which.</div>}
    </div>
  );
}
