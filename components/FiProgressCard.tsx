'use client';

// The FI line on Home, the last row of This month (rollout phase 4c): years
// to FI and how far along, then the Plan's FI number and the trailing year's
// savings rate, opening the Plan tab; every note the FI card said sits under
// it, gathered into one line when there are two or more.
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
//
// IN THE PLAN'S CURRENCY: the one its typed figures were recorded in, which
// what is measured is converted into, or, with nothing typed, the accounts'
// (lib/fire/plan-currency.ts). A plan saved before that was recorded is
// shown in the accounts' currency, said to be unconfirmed: the Plan tab
// records it, or asks.

import { useEffect, useMemo, useState } from 'react';
import type { Txn } from './MonthBreakdown';
import { usePlanInputs, workplacePlansOf, type PlanInputs } from './plan-inputs';
import { PAYROLL_NOTE, dayName, pct, progressText, savingsRateText, wholeMoney, yearsToFiText } from './plan-text';
import { DEFAULT_PLAN, isFirePlan, repairPlan, type FirePlan } from '@/lib/fire/plan';
import { NO_ANSWER, planCurrencyState, readCurrencyAnswer, shownFrom, unconfirmedText, type CurrencyAnswer } from '@/lib/fire/plan-currency';
import { assetsGap, assetsLeftOut, fiFigures, gapText, notMeasuredWhat, spendingGap, spendingLeftOut, transactionsMissing, type FiFigures } from '@/lib/fire/progress';
import type { AssetInstitution } from '@/lib/fire/inputs';
import type { NoTransactionsView } from '@/lib/no-transactions';
import type { FxTable } from '@/lib/fx/rates';
import type { PageFx } from '@/lib/fx/view';
import { Masked } from './HideAmounts';
import TotalCaveats, { type Caveat } from './TotalCaveats';

export type FiProgressProps = {
  txns: Txn[] | null;
  txnsLoading: boolean;
  /** The notes that say transactions couldn't all be read (PlanTab's). */
  txnNotes: string[];
  /** The connections that bring in no transactions, as the Plan tab gets
   *  them (lib/no-transactions.ts). */
  txnWithout?: NoTransactionsView;
  /** As the Plan tab gets them (components/Dashboard.tsx planInstitutions). */
  institutions: AssetInstitution[];
  currency: string | null;
  /** With a home currency, what the transactions and balances convert with,
   *  as the Plan tab gets them. */
  txnFx?: FxTable | null;
  balanceFx?: PageFx | null;
  /** Opens the Plan tab. */
  onOpenPlan: () => void;
};

/** What /api/fire-plan answered: the saved plan, or null for none, and the
 *  currency its figures are in. */
type Loaded = { plan: FirePlan | null; currency: CurrencyAnswer } | 'failed' | null;

export default function FiProgressCard({ txns, txnsLoading, txnNotes, txnWithout, institutions, currency, txnFx = null, balanceFx = null, onOpenPlan }: FiProgressProps) {
  const [loaded, setLoaded] = useState<Loaded>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/fire-plan')
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        const plan: unknown = body?.plan;
        if (live) setLoaded(res.ok && (plan === null || isFirePlan(plan)) ? { plan, currency: readCurrencyAnswer(body) } : 'failed');
      })
      .catch(() => {
        if (live) setLoaded('failed');
      });
    return () => {
      live = false;
    };
  }, []);
  const stored = loaded && loaded !== 'failed' ? loaded.plan : null;
  const answer = loaded && loaded !== 'failed' ? loaded.currency : NO_ANSWER;
  // As the Plan tab works from it: a value this release can't take is
  // replaced by its default there too, with the same result.
  const repair = useMemo(() => repairPlan(stored ?? DEFAULT_PLAN), [stored]);
  const plan = repair.plan;
  const inputs = usePlanInputs({
    txns,
    txnNotes,
    without: txnWithout,
    institutions,
    includeCash: plan.includeCash,
    planFunding: plan.planFunding,
    fx: txnFx,
    balanceFx,
    currency: answer.currency,
  });
  const figures = fiFigures(plan, inputs, currency);
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
      figures={figures}
      unconfirmed={planCurrencyState(stored, answer, figures.currency).kind === 'unknown' ? unconfirmedText(figures.currency, shownFrom(figures.currency, inputs)) : null}
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

/** The row itself, from figures already worked out: an <li> for This month's
 *  list. Null when there is no FI number and nothing to say why. */
export function FiProgressView({
  figures,
  unconfirmed = null,
  plan,
  saved,
  repaired,
  inputs,
  onOpenPlan,
}: {
  figures: FiFigures;
  /** Which currency the plan's typed figures are in isn't known yet: what
   *  to say (lib/fire/plan-currency.ts unconfirmedText). */
  unconfirmed?: string | null;
  plan: FirePlan;
  /** A plan was saved; otherwise these are the defaults. */
  saved: boolean;
  /** The saved plan had values this release can't use (the Plan tab shows them). */
  repaired: boolean;
  inputs: Pick<PlanInputs, 'unread' | 'coverage' | 'assets' | 'workplace' | 'flows' | 'rates'>;
  onOpenPlan: () => void;
}) {
  const { view, savingsRate, currency, currencyNote, convertedNote } = figures;
  // Without a home currency, a figure that would rest on a part of what it
  // measures isn't measured (lib/fire/progress.ts): said, rather than an FI
  // number from the rest, or none and nothing said.
  // The year's own gap, whether spending is typed or not: savings and the
  // savings rate come from the year too. Said for spending when spending
  // isn't typed, else for what the year still gives.
  const yearGap = spendingGap(inputs.flows, inputs.rates);
  const flowsGap = view.spending.source === 'unmeasured' ? yearGap : null;
  const yearText = yearGap && !flowsGap ? gapText(yearGap, view.savings.source === 'typed' ? 'rate' : 'year') : null;
  const accountsGap = view.assets.source === 'unmeasured' ? assetsGap(inputs.assets, inputs.rates) : null;
  const waitsFor = view.yearsToFi === null ? notMeasuredWhat(view) : null;
  const notWorkedOut = waitsFor ? `Years to FI aren’t worked out: ${waitsFor} measured (above), and a figure that isn’t measured is never counted as zero.` : null;
  // Every note the card said, in its words and its level (amber where it says
  // a figure may be off or isn't measured, neutral where it explains): under
  // the row, gathered into one line that opens in place when there are two
  // or more (components/TotalCaveats.tsx). Built in a list, one at a time.
  const notes: Caveat[] = [];
  if (view.fiNumber === null) {
    if (!flowsGap) return null;
    notes.push({ key: 'flows-gap', severity: 'caution', summary: 'spending not measured', body: gapText(flowsGap) });
    if (accountsGap) notes.push({ key: 'accounts-gap', severity: 'caution', summary: 'invested assets not measured', body: gapText(accountsGap) });
    if (unconfirmed) notes.push({ key: 'unconfirmed', severity: 'caution', summary: 'the plan’s currency not confirmed', body: unconfirmed });
    return <FiRow what="FI isn’t worked out" onOpenPlan={onOpenPlan} notes={notes} />;
  }
  const money = (n: number) => wholeMoney(n, currency);
  // As the Plan's FI card warns (components/PlanTab.tsx FiCard), by the same
  // rule: transactions that couldn't be read, or that a connection doesn't
  // bring in. The savings rate is measured from the same transactions.
  const missing = transactionsMissing(inputs.unread, inputs.coverage);
  const spendingShort = view.spending.source === 'measured' && missing !== null;
  const rateShort = savingsRate !== null && missing !== null;
  const assetsShort = view.assets.source === 'measured' && inputs.assets.caveats.some((c) => c.kind !== 'stale');
  const workplaceAdded = (inputs.workplace?.total ?? 0) > 0;
  const leftOut = spendingLeftOut(inputs.flows);
  const otherAccounts = assetsLeftOut(inputs.assets, 'your invested assets', true);
  const typed = [view.spending.source === 'typed' && 'spending', view.savings.source === 'typed' && 'savings', view.assets.source === 'typed' && 'invested assets'].filter(
    (x): x is string => !!x
  );
  const rates = `a ${pct(plan.withdrawalRate)} withdrawal rate${plan.taxRate > 0 ? `, ${pct(plan.taxRate)} tax on withdrawals` : ''} and a ${pct(plan.realReturn)} real return`;
  notes.push({
    key: 'estimates',
    severity: 'info',
    summary: saved ? 'how these are estimated' : 'from the Plan’s defaults',
    body: (
      <>
        Estimates, {saved ? `from your plan: ${rates}` : `from the Plan's default assumptions: ${rates}. Set your own on the Plan tab`}.
        {typed.length ? ` Using the ${typed.join(' and ')} you typed there.` : ''} The savings rate is income minus spending as a share of income
        {workplaceAdded ? ', with what went into workplace plans counted on both sides' : ''}
        {view.savings.source === 'typed' && savingsRate !== null ? ', from your transactions, not the savings you typed' : ''}.
      </>
    ),
  });
  if (!workplaceAdded && view.savings.source === 'measured') notes.push({ key: 'payroll', severity: 'info', summary: 'pay before it reaches a bank', body: PAYROLL_NOTE });
  // What the year's figures leave out, in the Plan's own words: the savings
  // rate is always from the year's transactions, so these are said whenever
  // there are any.
  if (inputs.flows && leftOut.excluded) notes.push({ key: 'excluded', severity: 'info', summary: 'excluded transactions', body: <Masked>{leftOut.excluded}</Masked> });
  // Transactions entered by hand only: the connections that bring in none
  // are named, as the Plan names them beside its figures.
  if (inputs.flows && inputs.coverage.named) notes.push({ key: 'named', severity: 'info', summary: 'connections with no transactions', body: inputs.coverage.named });
  if (inputs.flows && !flowsGap && leftOut.otherCurrencies)
    notes.push({ key: 'other-currencies', severity: 'caution', summary: 'other currencies left out', body: <Masked>{leftOut.otherCurrencies}</Masked> });
  if (view.assets.source === 'measured' && otherAccounts) notes.push({ key: 'other-accounts', severity: 'caution', summary: 'other currencies left out', body: otherAccounts });
  if (spendingShort)
    notes.push({
      key: 'short',
      severity: 'caution',
      summary: 'spending may be low',
      body: `May be low: spending is missing ${missing}${rateShort ? ', so the savings rate may be off too' : ''}. The Plan tab says which.`,
    });
  else if (rateShort) notes.push({ key: 'short', severity: 'caution', summary: 'savings rate may be off', body: `The savings rate may be off: it is missing ${missing}. The Plan tab says which.` });
  if (assetsShort) notes.push({ key: 'assets-short', severity: 'caution', summary: 'invested assets may be low', body: "Invested assets may be low: some couldn't be counted. The Plan tab says which." });
  if (currencyNote) notes.push({ key: 'currency', severity: 'caution', summary: 'investments and spending in two currencies', body: currencyNote });
  if (flowsGap) notes.push({ key: 'flows-gap', severity: 'caution', summary: 'spending not measured', body: gapText(flowsGap) });
  if (yearText) notes.push({ key: 'year', severity: 'caution', summary: 'savings not measured', body: yearText });
  if (accountsGap) notes.push({ key: 'accounts-gap', severity: 'caution', summary: 'invested assets not measured', body: gapText(accountsGap) });
  if (notWorkedOut) notes.push({ key: 'not-worked-out', severity: 'caution', summary: 'years to FI not worked out', body: notWorkedOut });
  if (unconfirmed) notes.push({ key: 'unconfirmed', severity: 'caution', summary: 'the plan’s currency not confirmed', body: unconfirmed });
  if (convertedNote) notes.push({ key: 'converted', severity: 'info', summary: 'converted into the Plan’s currency', body: convertedNote });
  if (repaired)
    notes.push({
      key: 'repaired',
      severity: 'caution',
      summary: 'saved values replaced',
      body: "Your saved plan has values this version of Nya can't use, so these use the defaults for them. The Plan tab says which.",
    });

  // The row: how far, then the figures the notes speak of (the FI number,
  // what is invested, the savings rate).
  const years = view.yearsToFi;
  const there = view.progress !== null ? progressText(view.progress) : null;
  const rate = savingsRate !== null ? `${savingsRateText(savingsRate)} savings rate, ${inputs.flows?.scaled ? `since ${dayName(inputs.flows.from)}` : 'last 12 months'}` : null;
  let title: string;
  let withNumber = true;
  if (years === 0) title = 'You’re at FI';
  else if (years === Infinity) title = `FI not reached at this savings rate${there ? ` · ${there} there` : ''}`;
  else if (years !== null) title = `FI in ${yearsToFiText(years)}${there ? ` · ${there} there` : ''}`;
  else if (there) title = `${there} of the way to FI`;
  else {
    title = `FI number ${money(view.fiNumber)}`;
    withNumber = false;
  }
  const invested = there !== null ? `${money(view.assets.value ?? 0)} invested` : null;
  const sub = [withNumber ? `FI number ${money(view.fiNumber)}` : null, invested, rate].filter((s): s is string => !!s).join(' · ');
  return <FiRow what={title} detail={sub || undefined} onOpenPlan={onOpenPlan} notes={notes} />;
}

const CHEVRON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

/** The FI line in This month: the row opens the Plan tab; its notes sit
 *  under it, outside the button (a <details> can't be inside one). */
function FiRow({ what, detail, onOpenPlan, notes }: { what: string; detail?: string; onOpenPlan: () => void; notes: readonly Caveat[] }) {
  return (
    <li>
      <button type="button" className="list-row" onClick={onOpenPlan}>
        <span className="list-row-text">
          <span className="list-row-title">
            <Masked>{what}</Masked>
          </span>
          {detail && (
            <span className="list-row-sub">
              <Masked>{detail}</Masked>
            </span>
          )}
        </span>
        {CHEVRON}
      </button>
      {notes.length > 0 && (
        <div className="row-notes">
          <TotalCaveats items={notes} />
        </div>
      )}
    </li>
  );
}
