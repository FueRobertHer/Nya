'use client';

// The debt payoff planner (lib/payoff.ts), opened from "Payoff plan" on the
// Accounts tab. Lists each credit card and loan that isn't hidden with the terms
// Plaid supplies and where each came from, takes what is missing (or a
// correction) from the person, and shows when everything is paid off and the
// interest that costs: avalanche or snowball, beside paying only the minimums.
//
// Nothing is saved. What the person types (rates, payments, the extra amount,
// the order) is state in this component, which the Dashboard mounts once outside
// the tabs: it lasts while the app is open, through closing the drawer and
// switching tabs, and a reload starts again from Plaid's terms. Keeping it in
// browser storage would be one more place for financial details to outlive a
// sign-out, to save retyping a rate.

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { compactMoney, formatMoney } from '@/lib/format';
import { instantDay, localMonth } from '@/lib/local-date';
import {
  HORIZON_MONTHS,
  MAX_APR,
  MAX_CENTS,
  addMonths,
  byCurrency,
  comparePlans,
  coversInterest,
  debtAccounts,
  durationLabel,
  firstInterestCents,
  parseCents,
  planRows,
  type Comparison,
  type Debt,
  type DebtAccount,
  type DebtInstitutionInput,
  type Plan,
  type PlanRow,
  type Strategy,
  type Term,
  type TypedTerms,
} from '@/lib/payoff';

export type PayoffInputs = {
  /** What was typed for each account's terms, by account id. */
  typed: Record<string, TypedTerms>;
  /** Accounts the person left out of the plan. */
  leftOut: Record<string, boolean>;
  /** The extra each month as typed, per currency: an amount means nothing in
   *  another currency, so switching currency doesn't carry it over. */
  extra: Record<string, string>;
  strategy: Strategy;
  /** The currency being planned when the debts are in several; null is the first. */
  currency: string | null;
};

export const NO_INPUTS: PayoffInputs = { typed: {}, leftOut: {}, extra: {}, strategy: 'avalanche', currency: null };

const STRATEGY_LABEL: Record<Strategy, string> = { avalanche: 'Avalanche', snowball: 'Snowball' };

const HORIZON_YEARS = HORIZON_MONTHS / 12;

/** The key a currency is kept under in PayoffInputs (a null currency is ''). */
const currencyKey = (c: string | null) => c ?? '';

/** "Mar 2029" from a YYYY-MM, on the local calendar. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

// "Aug 7" from a YYYY-MM-DD, parsed at local midnight so it never shows the day before.
function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// The day a recovered balance is from, as the Accounts tab shows it
// (fmtStaleDay in Dashboard.tsx): the instant's local day when it belongs to
// that date, else the date.
function staleDay(date: string, at: string | null): string {
  return (at && at.slice(0, 10) === date ? instantDay(at) : null) ?? fmtDay(date);
}

/** "A", "A and B", "A, B and C". */
function listNames(list: string[]): string {
  return list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}

function accountName(a: DebtAccount): string {
  return a.mask ? `${a.name} ••${a.mask}` : a.name;
}

/** The drawer, and the state that outlives it. */
export default function DebtPayoff({
  open,
  onClose,
  institutions,
}: {
  open: boolean;
  onClose: () => void;
  institutions: DebtInstitutionInput[];
}) {
  const [inputs, setInputs] = useState<PayoffInputs>(NO_INPUTS);
  return (
    <Sheet open={open} title="Payoff plan" onClose={onClose}>
      <PayoffPanel institutions={institutions} inputs={inputs} onChange={setInputs} />
    </Sheet>
  );
}

export function PayoffPanel({
  institutions,
  inputs,
  onChange,
  startMonth,
}: {
  institutions: DebtInstitutionInput[];
  inputs: PayoffInputs;
  onChange: (update: (prev: PayoffInputs) => PayoffInputs) => void;
  /** This month (YYYY-MM): the plan's first payment is a month on. Tests pin it. */
  startMonth?: string;
}) {
  const start = startMonth ?? localMonth();
  const groups = useMemo(() => byCurrency(debtAccounts(institutions)), [institutions]);
  const group = groups.find((g) => currencyKey(g.currency) === inputs.currency) ?? groups[0];
  const currency = group?.currency ?? null;
  const key = currencyKey(currency);

  const { rows, debts, waiting } = useMemo(
    () => planRows(group?.accounts ?? [], inputs.typed, inputs.leftOut),
    [group, inputs.typed, inputs.leftOut]
  );
  const extraText = inputs.extra[key] ?? '';
  const extra = parseCents(extraText);
  const comparison = useMemo(
    () =>
      waiting === 0 && debts.length > 0 && extra !== 'invalid'
        ? comparePlans(debts, { startMonth: start, extraCents: extra ?? 0 })
        : null,
    [debts, waiting, extra, start]
  );

  if (!group) return <p className="empty-note">No cards or loans to plan.</p>;

  const money = (cents: number) => formatMoney(cents / 100, currency);
  const nameOf = (id: string) => accountName(rows.find((r) => r.account.id === id)!.account);
  const setTerm = (id: string, field: keyof TypedTerms, value: string | undefined) =>
    onChange((prev) => ({ ...prev, typed: { ...prev.typed, [id]: { ...prev.typed[id], [field]: value } } }));
  const setLeftOut = (id: string, out: boolean) =>
    onChange((prev) => ({ ...prev, leftOut: { ...prev.leftOut, [id]: out } }));
  const owing = rows.filter((r) => r.status !== 'nothing-owed' && r.status !== 'no-balance');

  let summary: ReactNode;
  if (owing.length === 0) {
    summary = <p className="empty-note">Nothing is owed on these cards and loans.</p>;
  } else if (waiting > 0) {
    summary = (
      <div className="stale-note">
        Add the missing rate or payment for {waiting === 1 ? '1 debt' : `${waiting} debts`} below, or leave{' '}
        {waiting === 1 ? 'it' : 'them'} out, to see the plan.
      </div>
    );
  } else if (debts.length === 0) {
    summary = <p className="empty-note">Every debt is left out of the plan. Include one below to plan it.</p>;
  } else if (!comparison) {
    summary = <div className="stale-note">Enter an extra amount of 0 or more to see the plan.</div>;
  } else {
    summary = <PlanSummary comparison={comparison} strategy={inputs.strategy} money={money} nameOf={nameOf} />;
  }

  return (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        Pay a steady amount each month: every debt&apos;s own payment plus any extra, which goes to one debt
        at a time. When a debt is paid off, its payment moves on to the next.
      </p>

      {groups.length > 1 && (
        <section className="panel-section">
          <p className="section-label">Currency</p>
          <div className="button-pair payoff-choice">
            {groups.map((g) => (
              <button
                key={currencyKey(g.currency)}
                className="secondary"
                aria-pressed={g === group}
                onClick={() => onChange((prev) => ({ ...prev, currency: currencyKey(g.currency) }))}
              >
                {g.currency ?? 'Other'}
              </button>
            ))}
          </div>
          <p className="panel-note">
            Your cards and loans are in {groups.length} currencies. Each is planned on its own: nothing is
            converted between currencies.
          </p>
        </section>
      )}

      <section className="panel-section">{summary}</section>

      <section className="panel-section">
        <label className="field">
          Extra each month{groups.length > 1 && currency ? ` (${currency})` : ''}
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            placeholder="0.00"
            value={extraText}
            onChange={(e) => {
              const value = e.target.value;
              onChange((prev) => ({ ...prev, extra: { ...prev.extra, [key]: value } }));
            }}
          />
        </label>
        {extra === 'invalid' ? (
          <div className="error payoff-field-error">Enter an amount of 0 or more.</div>
        ) : (
          comparison && (
            <p className="panel-note payoff-field-note">
              On top of the payments below: {money(comparison[inputs.strategy].monthlyCents)} a month in all.
            </p>
          )
        )}
      </section>

      <section className="panel-section">
        <p className="section-label">Order</p>
        <div className="button-pair payoff-choice">
          {(['avalanche', 'snowball'] as const).map((s) => (
            <button
              key={s}
              className="secondary"
              aria-pressed={inputs.strategy === s}
              onClick={() => onChange((prev) => ({ ...prev, strategy: s }))}
            >
              {STRATEGY_LABEL[s]}
            </button>
          ))}
        </div>
        <p className="panel-note">
          {inputs.strategy === 'avalanche'
            ? 'Highest rate first. It costs the least interest.'
            : 'Smallest balance first. Debts are gone sooner, which some find easier to keep going with, and it can cost more interest.'}
        </p>
      </section>

      {comparison && (
        <PlanDetail
          comparison={comparison}
          strategy={inputs.strategy}
          money={money}
          nameOf={nameOf}
          currency={currency}
          start={start}
        />
      )}

      <section className="panel-section">
        <p className="section-label">Your cards and loans</p>
        {rows.map((row) => (
          <DebtRow
            key={row.account.id}
            row={row}
            typed={inputs.typed[row.account.id] ?? {}}
            money={money}
            onTerm={(field, value) => setTerm(row.account.id, field, value)}
            onLeftOut={(out) => setLeftOut(row.account.id, out)}
          />
        ))}
      </section>

      <p className="panel-note">
        Interest is worked out monthly, at the APR / 12, rounded to the cent. Card issuers charge it daily, so
        real interest on a card runs a little higher. Payments stay at today&apos;s amounts, nothing new is
        charged, and promotional rates and fees aren&apos;t included. Nothing typed here is saved: it lasts
        until the app is reloaded.
      </p>
    </>
  );
}

/** The headline: when the chosen order clears everything, what it costs, and what it saves. */
function PlanSummary({
  comparison,
  strategy,
  money,
  nameOf,
}: {
  comparison: Comparison;
  strategy: Strategy;
  money: (cents: number) => string;
  nameOf: (id: string) => string;
}) {
  const plan = comparison[strategy];
  if (plan.months === null) {
    return (
      <div className="stale-note">
        At {money(plan.monthlyCents)} a month these debts aren&apos;t paid off within {HORIZON_YEARS} years:
        the interest grows faster than the payments. Add more each month.
      </div>
    );
  }
  const neverOnMinimums = comparison.minimums.debts.filter((d) => d.months === null).map((d) => nameOf(d.id));
  const { interestCents, months } = plan.saved;
  let saving: string;
  if (neverOnMinimums.length > 0) {
    // There is no finite cost to measure a saving against.
    saving = `This clears ${listNames(neverOnMinimums)}, which paying only the minimums never would.`;
  } else if (months! > 0 || interestCents! > 0) {
    const parts = [
      interestCents! > 0 ? `${money(interestCents!)} in interest` : null,
      months! > 0 ? durationLabel(months!) : null,
    ].filter(Boolean);
    saving = `Saves ${parts.join(' and ')} against paying only the minimums.`;
  } else {
    saving = 'The same as paying only the minimums. An extra amount each month pays it off sooner.';
  }
  return (
    <>
      <div className="summary-row">
        <div>
          <div className="total-label">Debt-free</div>
          <div className="summary-value">{monthLabel(plan.month!)}</div>
          <div className="as-of">in {durationLabel(plan.months)}</div>
        </div>
        <div>
          <div className="total-label">Interest</div>
          <div className="summary-value">{money(plan.interestCents!)}</div>
          <div className="as-of">{STRATEGY_LABEL[strategy].toLowerCase()} order</div>
        </div>
      </div>
      <div className="status-note">{saving}</div>
    </>
  );
}

/** The comparison, the chart, and the order the debts are cleared in. */
function PlanDetail({
  comparison,
  strategy,
  money,
  nameOf,
  currency,
  start,
}: {
  comparison: Comparison;
  strategy: Strategy;
  money: (cents: number) => string;
  nameOf: (id: string) => string;
  currency: string | null;
  start: string;
}) {
  const plan = comparison[strategy];
  const { avalanche, snowball, minimums } = comparison;
  const line = (label: string, p: Plan, chosen: boolean) => (
    <tr className={chosen ? 'chosen' : undefined}>
      <td>{label}</td>
      <td>
        {p.month ? monthLabel(p.month) : 'Never'}
        <div className="payoff-sub">
          {p.months !== null ? durationLabel(p.months) : `not within ${HORIZON_YEARS} years`}
        </div>
      </td>
      <td className="num">{p.interestCents !== null ? money(p.interestCents) : '--'}</td>
    </tr>
  );
  let orders = '';
  if (avalanche.months !== null && snowball.months !== null) {
    const more = snowball.interestCents! - avalanche.interestCents!;
    const later = snowball.months - avalanche.months;
    orders =
      more === 0 && later === 0
        ? ' Both orders cost the same here.'
        : more >= 0
          ? ` The avalanche saves ${money(more)} more interest than the snowball${later > 0 ? ` and finishes ${durationLabel(later)} sooner` : ''}.`
          : ` Here the snowball costs ${money(-more)} less interest than the avalanche.`;
  }
  return (
    <>
      <section className="panel-section">
        <p className="section-label">Compared</p>
        <table className="payoff-compare">
          <thead>
            <tr>
              <th>Order</th>
              <th>Debt-free</th>
              <th className="num">Interest</th>
            </tr>
          </thead>
          <tbody>
            {line('Avalanche', avalanche, strategy === 'avalanche')}
            {line('Snowball', snowball, strategy === 'snowball')}
            {line('Minimums only', minimums, false)}
          </tbody>
        </table>
        <p className="panel-note">
          Minimums only pays each debt just its own payment, with no extra, and a debt&apos;s payment stops
          once it&apos;s cleared.{orders}
        </p>
      </section>

      {plan.months !== null && plan.months >= 1 && (
        <section className="panel-section">
          <p className="section-label">Owed over time</p>
          <PayoffChart
            plan={plan}
            baseline={minimums}
            planLabel={STRATEGY_LABEL[strategy]}
            currency={currency}
            start={start}
          />
        </section>
      )}

      <section className="panel-section">
        <p className="section-label">Payoff order</p>
        <ol className="payoff-steps">
          {plan.debts.map((d) => (
            <li key={d.id}>
              <div className="payoff-step">
                <span>{nameOf(d.id)}</span>
                <span className="payoff-step-when">{d.month ? monthLabel(d.month) : 'Never'}</span>
              </div>
              <div className="payoff-sub">
                {d.months !== null
                  ? `${durationLabel(d.months)} · ${money(d.interestCents!)} interest`
                  : `not paid off within ${HORIZON_YEARS} years`}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

const NO_TERMS_HINT: Record<NonNullable<DebtAccount['noTerms']>, string> = {
  manual: 'A manual account has no terms from a bank: type them from a statement.',
  unreachable:
    "This institution couldn't be reached, so Plaid's terms aren't here right now. Type them from a statement, or refresh later.",
  'not-enabled':
    "Payment details aren't enabled for this institution. Type them here, or tap Enable payment details on its card.",
  loading: 'Payment details are still importing from this institution. Type them here, or check back soon.',
  'not-reported': "Plaid doesn't report terms for this account. Type them from a statement.",
};

/** One card or loan: its balance, its two terms, and where each came from. */
function DebtRow({
  row,
  typed,
  money,
  onTerm,
  onLeftOut,
}: {
  row: PlanRow;
  /** What was typed for it, as typed (undefined fields are untouched). */
  typed: TypedTerms;
  money: (cents: number) => string;
  onTerm: (field: keyof TypedTerms, value: string | undefined) => void;
  onLeftOut: (out: boolean) => void;
}) {
  const { account: a, apr, minimum, status } = row;
  const card = a.type === 'credit';
  const updated = a.updatedAt ? instantDay(a.updatedAt) : null;
  const balanceNote = a.staleAsOf
    ? ` · balance from ${staleDay(a.staleAsOf, a.staleAsOfAt)}`
    : updated
      ? ` · updated ${updated}`
      : '';
  const owed =
    status === 'nothing-owed' ? 'Nothing owed' : status === 'no-balance' ? '--' : money(a.owedCents!);
  const head = (
    <>
      <div className="payoff-debt-head">
        <span>
          {a.name}
          {a.mask && <span className="acct-mask"> ••{a.mask}</span>}
        </span>
        <span className="payoff-debt-owed">{owed}</span>
      </div>
      <div className="type-tag">
        {a.institution} · {a.subtype || a.type}
        {balanceNote}
      </div>
    </>
  );

  if (status === 'nothing-owed') return <div className="payoff-debt">{head}</div>;
  if (status === 'no-balance') {
    return (
      <div className="payoff-debt">
        {head}
        <p className="panel-note">No balance was reported, so it isn&apos;t in the plan.</p>
      </div>
    );
  }
  if (status === 'left-out') {
    return (
      <div className="payoff-debt">
        {head}
        <p className="panel-note">
          Left out of the plan.{' '}
          <button className="link-btn" onClick={() => onLeftOut(false)}>
            Include
          </button>
        </p>
      </div>
    );
  }

  // Plaid's figure fills the field until something is typed over it. A figure
  // out of range is left out of the field, as it is out of the plan
  // (resolveApr, resolveMinimum).
  const plaidApr = a.plaidApr !== null && a.plaidApr >= 0 && a.plaidApr <= MAX_APR ? a.plaidApr : null;
  const plaidMinimum =
    a.plaidMinimumCents !== null && a.plaidMinimumCents >= 0 && a.plaidMinimumCents <= MAX_CENTS
      ? a.plaidMinimumCents
      : null;
  const aprText = typed.apr ?? (plaidApr !== null ? String(plaidApr) : '');
  const minimumText = typed.minimum ?? (plaidMinimum !== null ? (plaidMinimum / 100).toFixed(2) : '');
  // Why a term is needed, said only where Plaid has nothing usable for it. A
  // field the person cleared shows "Needed" with Plaid's figure a tap away
  // instead (TermSource).
  const noPlaid =
    (apr.value === null && !apr.error && plaidApr === null) ||
    (minimum.value === null && !minimum.error && plaidMinimum === null);
  const debt: Debt | null =
    status === 'ready' ? { id: a.id, balanceCents: a.owedCents!, apr: apr.value!, minimumCents: minimum.value! } : null;

  return (
    <div className="payoff-debt">
      {head}
      <div className="payoff-terms">
        <div>
          <label className="field">
            {card ? 'APR (%)' : 'Rate (%)'}
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={MAX_APR}
              step="any"
              placeholder="e.g. 24.99"
              value={aprText}
              onChange={(e) => onTerm('apr', e.target.value)}
            />
          </label>
          <TermSource
            term={apr}
            fromPlaid={`${a.plaidAprLabel ?? 'APR'} from Plaid`}
            plaid={plaidApr !== null ? `${plaidApr}%` : null}
            onUsePlaid={() => onTerm('apr', undefined)}
          />
        </div>
        <div>
          <label className="field">
            {card ? 'Minimum payment' : 'Monthly payment'}
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              placeholder="0.00"
              value={minimumText}
              onChange={(e) => onTerm('minimum', e.target.value)}
            />
          </label>
          <TermSource
            term={minimum}
            fromPlaid={a.kind === 'mortgage' ? 'Monthly payment from Plaid' : 'Minimum from Plaid'}
            plaid={plaidMinimum !== null ? money(plaidMinimum) : null}
            onUsePlaid={() => onTerm('minimum', undefined)}
          />
        </div>
      </div>
      {noPlaid && (
        <p className="panel-note">
          {a.noTerms ? NO_TERMS_HINT[a.noTerms] : 'Plaid has no usable figure for this one. Type it from a statement.'}
        </p>
      )}
      {a.kind === 'mortgage' && minimum.source === 'plaid' && (
        <p className="panel-note">
          Plaid&apos;s monthly payment can include escrow (taxes and insurance), which doesn&apos;t pay down the
          loan. If it does here, type just the principal and interest.
        </p>
      )}
      {debt &&
        (coversInterest(debt) ? (
          <div className="payoff-sub">About {money(firstInterestCents(debt))} a month in interest at this balance.</div>
        ) : (
          <div className="stale-note">
            {money(debt.minimumCents)} a month doesn&apos;t cover the interest (about{' '}
            {money(firstInterestCents(debt))} a month), so on its own it never pays this off.
          </div>
        ))}
      <button className="link-btn payoff-leave" onClick={() => onLeftOut(true)}>
        Leave out of the plan
      </button>
    </div>
  );
}

/** Where a term came from: Plaid, typed, or still needed (with a way back to Plaid's). */
function TermSource({
  term,
  fromPlaid,
  plaid,
  onUsePlaid,
}: {
  term: Term;
  /** How a Plaid value is described ("Purchase APR from Plaid"). */
  fromPlaid: string;
  /** Plaid's value, formatted, when it has a usable one. */
  plaid: string | null;
  onUsePlaid: () => void;
}) {
  const restore = plaid && (
    <>
      {' '}
      <button className="link-btn" onClick={onUsePlaid}>
        Use Plaid&apos;s {plaid}
      </button>
    </>
  );
  if (term.error) {
    return (
      <div className="payoff-source invalid">
        {term.error}
        {restore}
      </div>
    );
  }
  if (term.source === 'plaid') return <div className="payoff-source">{fromPlaid}</div>;
  if (term.source === 'typed') {
    return (
      <div className="payoff-source">
        Typed
        {restore}
      </div>
    );
  }
  return (
    <div className="payoff-source needed">
      Needed
      {restore}
    </div>
  );
}

// The chart's frame, in the house style of MonthFlowChart.
const W = 340;
const H = 140;
const PAD_LEFT = 8;
const PAD_RIGHT = 10;
const PAD_TOP = 12;
const PAD_BOTTOM = 20;
const PLAN_COLOR = 'var(--accent)';
// The baseline is context, so it is a gray, but darker than --muted: checked
// against the card surface (over 3:1) and against the accent (far enough apart
// for colour-blind readers too).
const BASELINE_COLOR = '#6b7080';

/**
 * The line through `vals`, cut where it rises past `top` and picked up again
 * where it comes back under, so a balance growing off the chart is seen leaving
 * it. Run flat along the edge instead, it would read as levelling off.
 */
function clippedPath(vals: number[], x: (i: number) => number, y: (v: number) => number, top: number): string {
  const at = (px: number, v: number) => `${px.toFixed(1)},${y(v).toFixed(1)}`;
  let d = '';
  let drawing = false;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    const prev = vals[i - 1];
    if (i > 0 && prev <= top !== v <= top) {
      // Where this segment crosses the top edge.
      const cross = x(i - 1) + ((top - prev) / (v - prev)) * (x(i) - x(i - 1));
      d += `${drawing ? 'L' : 'M'}${at(cross, top)}`;
      drawing = v <= top;
    }
    if (v <= top) {
      d += `${drawing ? 'L' : 'M'}${at(x(i), v)}`;
      drawing = true;
    }
  }
  return d;
}

function niceTicks(max: number): number[] {
  const rough = max / 2.5;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

/**
 * What is owed in total, month by month: the chosen order against paying only
 * the minimums. Scrubbing reads both at a month; at rest it shows the month the
 * plan is done, which is when the gap between them is plainest.
 */
function PayoffChart({
  plan,
  baseline,
  planLabel,
  currency,
  start,
}: {
  plan: Plan;
  baseline: Plan;
  planLabel: string;
  currency: string | null;
  start: string;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const geo = useMemo(() => {
    const done = plan.months ?? 0;
    // The axis runs to whichever plan finishes last. When paying the minimums
    // never finishes, a little past the plan's end: that line has left the
    // chart through the top long before, so more would only be empty floor.
    const span = baseline.months ?? Math.min(HORIZON_MONTHS, Math.max(done + 6, Math.ceil(done * 1.2)));
    const at = (series: number[], i: number) => (i < series.length ? series[i] : series[series.length - 1]) / 100;
    const planVals = Array.from({ length: span + 1 }, (_, i) => at(plan.owedByMonth, i));
    const baseVals = Array.from({ length: span + 1 }, (_, i) => at(baseline.owedByMonth, i));
    const planTop = Math.max(...planVals);
    // A balance that is never paid off can grow without end. The axis stops at
    // half again the plan's peak and that line leaves through the top,
    // rather than flattening the plan against the floor.
    const top = Math.max(planTop, Math.min(Math.max(...baseVals), planTop * 1.5)) * 1.06 || 1;
    const plotW = W - PAD_LEFT - PAD_RIGHT;
    const x = (i: number) => PAD_LEFT + (i / span) * plotW;
    const y = (v: number) => PAD_TOP + (1 - v / top) * (H - PAD_TOP - PAD_BOTTOM);
    return {
      done,
      span,
      planVals,
      baseVals,
      x,
      y,
      top,
      plotW,
      // The plan's own peak sets the axis, so only the baseline can run off it.
      planPath: clippedPath(planVals, x, y, top),
      basePath: clippedPath(baseVals, x, y, top),
      ticks: niceTicks(top),
    };
  }, [plan, baseline]);

  const { done, span, planVals, baseVals, x, y, top, plotW, planPath, basePath, ticks } = geo;
  const i = active ?? done;

  function scrub(clientX: number) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    setActive(Math.max(0, Math.min(span, Math.round(((px - PAD_LEFT) / plotW) * span))));
  }

  const fmt = (v: number) => formatMoney(v, currency);
  const endLabel = monthLabel(addMonths(start, span));
  return (
    <div>
      <div className="chart-legend">
        <span className="chart-legend-item">
          <span className="payoff-key" style={{ background: PLAN_COLOR }} />
          {planLabel}
        </span>
        <span className="chart-legend-item">
          <span className="payoff-key" style={{ background: BASELINE_COLOR }} />
          Minimums only{baseline.months === null ? ', never paid off' : ''}
        </span>
      </div>

      <div className="chart-readout">
        <span className="chart-readout-value">
          <span className="payoff-key" style={{ background: PLAN_COLOR }} />
          {fmt(planVals[i])}
        </span>
        <span className="chart-readout-value">
          <span className="payoff-key" style={{ background: BASELINE_COLOR }} />
          {fmt(baseVals[i])}
        </span>
        <span className="chart-readout-date">{i === 0 ? 'owed now' : `owed in ${monthLabel(addMonths(start, i))}`}</span>
      </div>

      <svg
        ref={svgRef}
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Total owed from now to ${endLabel}. ${planLabel} reaches zero in ${monthLabel(plan.month!)}; paying only the minimums, ${baseline.month ? `in ${monthLabel(baseline.month)}` : 'it never does'}.`}
        onPointerMove={(e) => scrub(e.clientX)}
        onPointerDown={(e) => scrub(e.clientX)}
        onPointerLeave={() => setActive(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={y(t)} y2={y(t)} stroke="#262a33" strokeWidth={1} />
            <text className="chart-tick" x={PAD_LEFT} y={y(t) - 3}>
              {compactMoney(t, currency)}
            </text>
          </g>
        ))}

        <path d={basePath} fill="none" stroke={BASELINE_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <path d={planPath} fill="none" stroke={PLAN_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {active !== null && (
          <line x1={x(i)} x2={x(i)} y1={PAD_TOP} y2={H - PAD_BOTTOM} stroke="#3a4150" strokeWidth={1} />
        )}
        {/* Off the top, the readout above still has its figure. */}
        {baseVals[i] <= top && (
          <circle cx={x(i)} cy={y(baseVals[i])} r={4} fill={BASELINE_COLOR} stroke="var(--card)" strokeWidth={2} />
        )}
        <circle cx={x(i)} cy={y(planVals[i])} r={4} fill={PLAN_COLOR} stroke="var(--card)" strokeWidth={2} />

        <text className="chart-xlabel" x={PAD_LEFT} y={H - 6}>
          Now
        </text>
        <text className="chart-xlabel" x={W - PAD_RIGHT} y={H - 6} textAnchor="end">
          {endLabel}
        </text>
      </svg>
    </div>
  );
}
