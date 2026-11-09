'use client';

// The FI line on Home, the last row of This month (rollout phase 4c): years
// to FI and how far along, then the Plan's FI number and the trailing year's
// savings rate, opening the Plan tab; every note the FI card said sits under
// it, gathered into one line when there are two or more.
//
// THE PLAN'S OWN FIGURES. It reads the saved plan from the copy of the
// Plan's inputs it shares with the Plan tab (lib/plan-inputs-store.ts: one
// request between the two, taken as it is for five minutes), repairs
// it as the Plan tab does (lib/fire/plan-v2.ts basePlanOf), measures from the
// same hook (components/plan-inputs.ts: a year of transactions, invested
// assets, workplace plan contributions) and works the figures out with the
// same functions (lib/fire/plan-figures.ts planFigures, with the plan's items
// and D15's switch as the Plan has it, and lib/fire/path.ts planPath for
// where it runs out), so Home and the Plan always agree. Never a simulation
// here: the market history and the simulator's jobs stay out of Home's bundle
// (components/FiProgressLoader.tsx loads this after Home paints). A plan with
// `lastsIn` (D9) answers with the earliest stop that lasts, which only the
// simulator finds: for such a plan alone, Home loads components/plan-lasting.ts
// and the page's store starts the simulator's worker (useLastingOnHome).
//
// WITH NO PLAN SAVED it shows what the Plan's defaults give (a 4% withdrawal
// rate, a 5% real return), says so, and links to the Plan tab: the FI number
// is a person's own spending over a rate the plan names, which is worth
// seeing before anything is set, and nothing in it is a guess about them.
// It shows nothing while what it needs first loads, when there is no
// spending to work from, or when the plan couldn't be fetched (a request
// that failed: Home stays as it was). A copy already there is shown while a
// newer one loads (after five minutes, or a refresh), so the line doesn't
// blink. A saved plan that can't be read (the store says
// so, or this release can't take its shape) gets a row saying so, which
// opens the Plan tab, where it says why (rollout phase 8b, from 4c's review).
//
// THE PLAN'S WORDS. The row's title is the Plan's answer (components/
// plan-text.ts fiHeadline): when FI comes, against the age you'd like to
// stop, with FI named, since the line stands on its own.
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

import { useEffect, useMemo } from 'react';
import type { Txn } from './MonthBreakdown';
import { leftOutOf } from '@/lib/fire/child-accounts';
import { planAccountsOf, planId, usePlanInputs, useSharedPlanInputs, workplacePlansOf, type PlanInputs } from './plan-inputs';
import { createPlanInputsStore, type PlanInputsCopy, type PlanInputsStore } from '@/lib/plan-inputs-store';
import { PAYROLL_NOTE, asksLasting, dayName, fiHeadline, pct, progressText, savingsRateText, wholeMoney } from './plan-text';
import { projectFrom, type PlanCore } from '@/lib/fire/plan';
import { basePlanOf, isStoredPlan, type StoredPlan } from '@/lib/fire/plan-v2';
import { planFigures } from '@/lib/fire/plan-figures';
import type { BasisHolding } from '@/lib/fire/buckets-today';
import { detailAttention, useDetailOnHome, useLastingOnHome, useSettingsRead } from './plan-detailed-home';
import type { FigureNote } from './plan-figure-notes';
import { planPath } from '@/lib/fire/path';
import { shortText } from './plan-scenario-text';
import { projectionShort } from '@/lib/fire/fi';
import { NO_ANSWER, planCurrencyState, readCurrencyAnswer, shownFrom, unconfirmedText, type CurrencyAnswer } from '@/lib/fire/plan-currency';
import { assetsGap, assetsLeftOut, childTaken, fiFigures, gapText, measuredInputs, notMeasuredWhat, spendingGap, spendingLeftOut, transactionsMissing, type FiFigures } from '@/lib/fire/progress';
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
  /** The copy of the Plan's inputs Home shares with the Plan tab
   *  (components/Dashboard.tsx); left out, the card keeps its own. */
  planInputs?: PlanInputsStore;
  /** D15's switch (the flag 'plan-items-in-fi'), as the Plan tab has it. */
  planInWalk?: boolean;
  /** D7's switch (the flag 'plan-child-accounts'), as the Plan tab has it. */
  childOut?: boolean;
  /** Every position, for what a detailed plan's buckets hold: read only for a
   *  detailed plan. */
  holdings?: readonly BasisHolding[];
  /** What a detailed plan still needs said, for Needs attention above: worked out here,
   *  since Dashboard can't hold the plan's inputs without loading them with Home. */
  onAttention?: (notes: readonly FigureNote[]) => void;
};

/** What /api/plan-inputs answered of the plan: the saved plan, or null for
 *  none, and the currency its figures are in; a saved plan that can't be
 *  read; or a request that failed. Null before any answer. */
type Loaded = { plan: StoredPlan | null; currency: CurrencyAnswer } | 'unreadable' | 'failed' | null;

function loadedFrom(answered: PlanInputsCopy['plan']): Loaded {
  if (!answered) return null;
  const { status, body } = answered;
  const plan: unknown = body?.plan;
  if (status === 200 && (plan === null || isStoredPlan(plan))) return { plan, currency: readCurrencyAnswer(body) };
  // The store says it can't read it, or it holds a plan this release can't
  // take (a newer one's): said. Anything else failed to arrive.
  return (status === 409 && body?.unreadable === true) || (status === 200 && plan !== undefined) ? 'unreadable' : 'failed';
}

const NO_HOLDINGS: readonly BasisHolding[] = [];
const NO_IDS: readonly string[] = [];
const NO_NOTES: readonly FigureNote[] = [];

export default function FiProgressCard({ txns, txnsLoading, txnNotes, txnWithout, institutions, currency, txnFx = null, balanceFx = null, onOpenPlan, planInputs, planInWalk = false, childOut = false, holdings = NO_HOLDINGS, onAttention }: FiProgressProps) {
  const own = useMemo(() => planInputs ?? createPlanInputsStore(), [planInputs]);
  const shared = useSharedPlanInputs(own, institutions, childOut);
  const leaveOut = useMemo(() => leftOutOf(childOut, shared.taxFacts.countAnyway), [childOut, shared.taxFacts.countAnyway]);
  const answered = shared.copy.plan;
  const loaded = useMemo(() => loadedFrom(answered), [answered]);
  const stored = loaded && typeof loaded === 'object' ? loaded.plan : null;
  const answer = loaded && typeof loaded === 'object' ? loaded.currency : NO_ANSWER;
  // As the Plan tab works from it: a value this release can't take is
  // replaced by its default there too, with the same result.
  const repair = useMemo(() => basePlanOf(stored), [stored]);
  const plan = repair.plan;
  const detailedOn = shared.factsKnown && shared.taxFacts.model === 'detailed';
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
    contributions: shared.contributions,
    childContributions: shared.childContributions,
    leaveOut,
    paid: detailedOn ? shared.taxFacts.paidToday : null,
  });
  const count = useMemo(() => ({ planInWalk }), [planInWalk]);
  // The Plan's own figures: its items placed and counted as the Plan's are,
  // the answer the walk's and where the path runs out the path's.
  const flat = useMemo(() => planFigures(plan, measuredInputs(inputs), { count }), [plan, inputs, count]);
  const measured = fiFigures(plan, inputs, currency);
  // A detailed plan works its answer out as the Plan does; a flat plan's is its flat
  // figures, so Home loads none of it.
  const worked = detailedOn && measured.currency === 'USD' && plan.age !== null;
  // D9: the earliest stop that lasts, from the simulator's worker.
  const lasts = asksLasting(plan, flat);
  const settings = useSettingsRead(worked);
  const deep = useDetailOnHome(worked, {
    plan,
    measured: measuredInputs(inputs),
    count,
    flat,
    assets: inputs.assets,
    holdings,
    facts: shared.taxFacts,
    choices: shared.choices,
    settings,
    store: own,
    rows: shared.copy.rows,
    ids: worked ? planAccountsOf(institutions).map(planId) : NO_IDS,
    paid: inputs.flows?.paid ?? 0,
    calendarYear: Number(inputs.today.slice(0, 4)),
    handOff: lasts,
  });
  const lasting = useLastingOnHome(lasts, { plan, measured: measuredInputs(inputs), count, flat, input: worked ? (deep?.input ?? null) : null, held: worked && !deep?.input && !deep?.failed });
  const deeper = lasting && !(worked && deep?.failed) ? lasting : deep;
  const shown = deeper?.figures ?? flat;
  // Null while they aren't known, so coming back to Home keeps the rows it had.
  const notes = useMemo(() => {
    if (!shared.factsKnown || !loaded || typeof loaded !== 'object') return null;
    if (!worked) return NO_NOTES;
    return settings && detailAttention({ assets: inputs.assets, holdings, facts: shared.taxFacts, settings: settings.value, plan });
  }, [shared.factsKnown, loaded, worked, settings, inputs.assets, holdings, shared.taxFacts, plan]);
  const notesKey = notes && JSON.stringify(notes);
  useEffect(() => {
    if (notes) onAttention?.(notes);
    // notesKey stands for notes, a new list whenever an input is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesKey, onAttention]);
  const planned = useMemo(() => {
    if ('refused' in shown) return null;
    const path = planPath(shown);
    return { view: shown.view, short: shown.short, runsOutAt: !shown.short && path?.short && plan.age !== null ? plan.age + path.short.year : null };
  }, [shown, plan.age]);
  const figures = planned ? { ...measured, view: planned.view } : measured;
  if (loaded === 'unreadable') return <FiRow what="FI isn’t worked out" detail="Your saved plan couldn’t be read: the Plan tab says why." onOpenPlan={onOpenPlan} notes={[]} />;
  if (
    !ready({
      plan: loaded === null ? 'loading' : loaded === 'failed' ? 'failed' : 'loaded',
      txns,
      txnsLoading,
      contributionsPending: (inputs.contributions === null && workplacePlansOf(institutions).length > 0) || shared.childPending,
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
      walk={planned ? { short: planned.short && shortText(planned.short, plan.age, (n) => wholeMoney(n, figures.currency)), runsOutAt: planned.runsOutAt } : { short: null, runsOutAt: null, refused: true }}
      working={deeper?.working ?? false}
      failed={deeper?.failed ?? false}
      lasting={!('refused' in shown) && shown.resolution.searched === 'lasts'}
      taxAfterStop={'refused' in shown ? null : (shown.shares?.t ?? null)}
    />
  );
}

/**
 * Whether the card has what it needs to show figures that won't change a
 * moment later: the plan read (a plan that can't be read shows nothing, and
 * the Plan tab says why), the first load of transactions done (a refresh
 * keeps the card, with the transactions on screen, as the Plan tab does), and
 * the contributions to workplace plans in, since they change savings. A
 * shared copy being refreshed counts as read: it is shown until the newer
 * one is in.
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
  walk = null,
  working = false,
  failed = false,
  lasting = false,
  taxAfterStop = null,
}: {
  figures: FiFigures;
  /** A detailed plan's tax in its FI number, in place of a flat rate. */
  taxAfterStop?: number | null;
  /** Which currency the plan's typed figures are in isn't known yet: what
   *  to say (lib/fire/plan-currency.ts unconfirmedText). */
  unconfirmed?: string | null;
  plan: PlanCore;
  /** A plan was saved; otherwise these are the defaults. */
  saved: boolean;
  /** The saved plan had values this release can't use (the Plan tab shows them). */
  repaired: boolean;
  inputs: Pick<PlanInputs, 'unread' | 'coverage' | 'assets' | 'workplace' | 'child' | 'flows' | 'rates'>;
  onOpenPlan: () => void;
  /** From the Plan's figures (lib/fire/plan-figures.ts): why the walk has no
   *  FI date (a cost it can't pay), in the Plan's words; the age the path
   *  runs out at; or `refused`, lasting changes that take spending in
   *  retirement below zero, which the Plan tab says. Left out, where the
   *  steady projection runs out is worked out here. */
  walk?: { short: string | null; runsOutAt: number | null; refused?: boolean } | null;
  /** A detailed plan's answer is still being worked out: this one is dimmed. */
  working?: boolean;
  /** It couldn't be: the Plan tab can try again. */
  failed?: boolean;
  /** The answer is the earliest stop that lasts (D9). */
  lasting?: boolean;
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
  if (walk?.refused) return <FiRow what="FI isn’t worked out" detail="Your plan’s changes take spending in retirement below zero: the Plan tab says which." onOpenPlan={onOpenPlan} notes={[]} />;
  if (failed) return <FiRow what="FI isn’t worked out" detail="Tax on your plan couldn’t be worked out on this page: the Plan tab can try again." onOpenPlan={onOpenPlan} notes={[]} />;
  const waitsFor = view.yearsToFi === null && !walk?.short ? notMeasuredWhat(view) : null;
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
  const rates = `a ${pct(plan.withdrawalRate)} withdrawal rate${taxAfterStop !== null ? `, ${pct(taxAfterStop, 1)} tax after you stop` : plan.taxRate > 0 && !working ? `, ${pct(plan.taxRate)} tax on withdrawals` : ''} and ${pct(plan.realReturn)} growth after inflation`;
  notes.push({
    key: 'estimates',
    severity: 'info',
    summary: saved ? 'how these are estimated' : 'from the Plan’s defaults',
    body: (
      <>
        Estimates, {saved ? `from your plan: ${rates}` : `from the Plan's default assumptions: ${rates}. Set your own on the Plan tab`}.
        {typed.length ? ` Using the ${typed.join(' and ')} you typed there.` : ''} The savings rate is income minus spending as a share of income
        {workplaceAdded ? ', with what went into workplace plans counted on both sides' : ''}
        {childTaken(inputs) > 0 ? ', less what your bank paid into accounts for a child’s education' : ''}
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
  if (walk?.short) notes.push({ key: 'no-date', severity: 'caution', summary: 'no FI date', body: <Masked>{walk.short}</Masked> });
  if (unconfirmed) notes.push({ key: 'unconfirmed', severity: 'caution', summary: 'the plan’s currency not confirmed', body: unconfirmed });
  if (convertedNote) notes.push({ key: 'converted', severity: 'info', summary: 'converted into the Plan’s currency', body: convertedNote });
  if (repaired)
    notes.push({
      key: 'repaired',
      severity: 'caution',
      summary: 'saved values replaced',
      body: "Your saved plan has values this version of Nya can't use, so these use the defaults for them. The Plan tab says which.",
    });

  // The row: the Plan's answer, then the figures the notes speak of (what
  // is invested of the FI number, how far, the savings rate). At FI already,
  // but with savings that run the steady projection out before the stop
  // age, it says so, as the Plan does.
  const from = walk ? null : projectFrom(plan, view);
  const runsOut = view.yearsToFi === 0 && from !== null && plan.age !== null ? projectionShort(from.assets, from.savings, plan.realReturn, from.years) : null;
  const runsOutAt = walk ? walk.runsOutAt : runsOut && plan.age !== null ? plan.age + runsOut.year : null;
  const head = fiHeadline(view, { age: plan.age, stopAge: view.stopAge, stopAtFi: plan.stopAtFi, lasting }, { noDate: !!walk?.short, runsOutAt, saving: (view.savings.value ?? 0) > 0 });
  const there = view.progress !== null ? progressText(view.progress) : null;
  const rate = savingsRate !== null ? `${savingsRateText(savingsRate)} savings rate, ${inputs.flows?.scaled ? `since ${dayName(inputs.flows.from)}` : 'last 12 months'}` : null;
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  let title: string;
  let withNumber = true;
  if (head.kind === 'age' && plan.stopAtFi) title = `FI and your stop around ${head.age}`;
  else if (head.kind === 'age') title = `FI around age ${head.age}${head.against ? `, ${lower(head.against)}` : ''}`;
  else if (head.kind === 'no-date') title = 'No FI date';
  else if (head.kind === 'years' || head.kind === 'later') title = `FI ${lower(head.headline)}`;
  else if (head.kind === 'there') title = head.against ? `You’re at FI, but ${lower(head.against)}` : 'You’re at FI';
  else if (head.kind === 'never') title = `FI ${lower(head.headline)}`;
  else if (there) title = `${there} of the way to FI`;
  else {
    title = `FI number ${money(view.fiNumber)}`;
    withNumber = false;
  }
  // "$942,000 of $1,520,000 invested (62%)", the percent said apart so it
  // reads while amounts are hidden, and not again when the title says it;
  // past the FI number, how far past it.
  const invested =
    there === null
      ? withNumber
        ? `FI number ${money(view.fiNumber)}`
        : null
      : (view.progress ?? 0) >= 1
        ? `${money(view.assets.value ?? 0)} invested · ${there} of the FI number ${money(view.fiNumber)}`
        : `${money(view.assets.value ?? 0)} of ${money(view.fiNumber)} invested${title.startsWith(there) ? '' : ` (${there})`}`;
  const sub = [saved ? null : 'Plan defaults', invested, rate].filter((s): s is string => !!s).join(' · ');
  return <FiRow what={title} detail={sub || undefined} working={working} onOpenPlan={onOpenPlan} notes={notes} />;
}

const CHEVRON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

/** The FI line in This month: the row opens the Plan tab; its notes sit
 *  under it, outside the button (a <details> can't be inside one). */
function FiRow({ what, detail, working = false, onOpenPlan, notes }: { what: string; detail?: string; working?: boolean; onOpenPlan: () => void; notes: readonly Caveat[] }) {
  return (
    <li>
      {working && (
        <div className="visually-hidden" role="status">
          Working it out
        </div>
      )}
      <button type="button" className="list-row" aria-busy={working || undefined} onClick={onOpenPlan}>
        <span className={working ? 'list-row-text plan-answer-pending' : 'list-row-text'}>
          {working && <span className="list-row-sub plan-working-line">Working it out</span>}
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
