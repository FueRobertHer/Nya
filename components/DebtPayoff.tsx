'use client';

// The debt payoff planner (lib/payoff.ts), opened from "Payoff plan" on the
// Accounts tab. Lists each credit card and loan that isn't hidden with the terms
// Plaid supplies and where each came from, takes what is missing (or a
// correction) from the person, and shows when everything is paid off and the
// interest that costs: avalanche or snowball, beside paying only the minimums.
//
// Nothing is saved. What the person types (rates, payments, the extra amount,
// the order, what is left in or out) is state in this component, which the
// Dashboard mounts once outside the tabs: it lasts while the app is open,
// through closing the drawer and switching tabs, and a reload starts again from
// Plaid's terms. Keeping it in browser storage would be one more place for
// financial details to outlive a sign-out, to save retyping a rate.

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { compactMoney, formatMoney } from '@/lib/format';
import { instantDay, localMonth } from '@/lib/local-date';
import {
  HORIZON_MONTHS,
  MAX_APR,
  MAX_CENTS,
  addMonths,
  blindSpots,
  byCurrency,
  comparePlans,
  debtAccounts,
  durationLabel,
  firstInterestCents,
  parseCents,
  planRows,
  type BlindSpot,
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
  /** true leaves a debt out; false puts in one that starts out (a card paid in
   *  full). Absent is the default. */
  leftOut: Record<string, boolean>;
  /** Student loans planned without their accrued interest. */
  withoutAccrued: Record<string, boolean>;
  /** The extra each month as typed, per currency: an amount means nothing in
   *  another currency, so switching currency doesn't carry it over. */
  extra: Record<string, string>;
  strategy: Strategy;
  /** The currency being planned when the debts are in several; null is the first. */
  currency: string | null;
};

export const NO_INPUTS: PayoffInputs = {
  typed: {},
  leftOut: {},
  withoutAccrued: {},
  extra: {},
  strategy: 'avalanche',
  currency: null,
};

const STRATEGY_LABEL: Record<Strategy, string> = { avalanche: 'Avalanche', snowball: 'Snowball' };

const HORIZON_YEARS = HORIZON_MONTHS / 12;

/** The key a currency is kept under in PayoffInputs (a null currency is ''). */
const currencyKey = (c: string | null) => c ?? '';

/** "Mar 2029" from a YYYY-MM, on the local calendar. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/**
 * Cents as money in the plan's currency. With no currency code (Plaid reports
 * an unofficial currency without one) there is no symbol: formatMoney's
 * fallback would print "$" for what may not be dollars.
 */
function moneyIn(currency: string | null): (cents: number) => string {
  return (cents) =>
    currency
      ? formatMoney(cents / 100, currency)
      : (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function compactIn(currency: string | null, amount: number): string {
  return currency
    ? compactMoney(amount, currency)
    : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(amount);
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

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function accountName(a: DebtAccount): string {
  return a.mask ? `${a.name} ••${a.mask}` : a.name;
}

/** What the plan can't see, as one sentence each (lib/payoff.ts blindSpots). */
function spotText(s: BlindSpot): string {
  switch (s.kind) {
    case 'unloaded':
      return `${s.institution} couldn't be loaded, so any cards or loans there aren't in this plan.`;
    case 'too-old':
      return `${s.institution} couldn't be loaded and its last balances, from ${staleDay(s.date, s.at)}, are too old to use, so any cards or loans there aren't in this plan.`;
    case 'missing':
      return `${s.count} ${plural(s.count, 'account', 'accounts')} at ${s.institution} couldn't be recovered, so ${plural(s.count, "it isn't", "they aren't")} in this plan.`;
    case 'vanished':
      return `${s.count} ${plural(s.count, 'account', 'accounts')} ${s.institution} used to report ${plural(s.count, "isn't", "aren't")} in its latest answer, so ${plural(s.count, "it isn't", "they aren't")} in this plan.`;
    case 'dated':
      return `${s.institution} couldn't be reached: its balances here are from ${staleDay(s.date, s.at)}.`;
  }
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
  const spots = useMemo(() => blindSpots(institutions), [institutions]);
  const group = groups.find((g) => currencyKey(g.currency) === inputs.currency) ?? groups[0];
  const currency = group?.currency ?? null;
  const key = currencyKey(currency);

  const { rows, debts, waiting } = useMemo(
    () =>
      planRows(group?.accounts ?? [], {
        typed: inputs.typed,
        leftOut: inputs.leftOut,
        withoutAccrued: inputs.withoutAccrued,
      }),
    [group, inputs.typed, inputs.leftOut, inputs.withoutAccrued]
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

  const spotNote = spots.length > 0 && (
    <div className="stale-note payoff-notes">
      {spots.map((s, i) => (
        <p key={i}>{spotText(s)}</p>
      ))}
    </div>
  );
  if (!group) {
    return (
      <>
        {spotNote}
        <p className="empty-note">No cards or loans to plan.</p>
      </>
    );
  }

  const money = moneyIn(currency);
  const nameOf = (id: string) => accountName(rows.find((r) => r.account.id === id)!.account);
  const setTerm = (id: string, field: keyof TypedTerms, value: string | undefined) =>
    onChange((prev) => ({ ...prev, typed: { ...prev.typed, [id]: { ...prev.typed[id], [field]: value } } }));
  // Undefined goes back to the default (a card paid in full starts out).
  const setLeftOut = (id: string, out: boolean | undefined) =>
    onChange((prev) => {
      const leftOut = { ...prev.leftOut };
      if (out === undefined) delete leftOut[id];
      else leftOut[id] = out;
      return { ...prev, leftOut };
    });
  const setWithoutAccrued = (id: string, without: boolean) =>
    onChange((prev) => ({ ...prev, withoutAccrued: { ...prev.withoutAccrued, [id]: without } }));

  const owing = rows.filter((r) => r.status !== 'nothing-owed' && r.status !== 'no-balance');
  const noBalance = rows.filter((r) => r.status === 'no-balance').length;
  const paidInFull = rows.filter((r) => r.status === 'paid-in-full').length;
  const outside = rows.filter((r) => r.status === 'left-out' || r.status === 'paid-in-full').length;

  let summary: ReactNode;
  if (owing.length === 0) {
    summary = (
      <p className="empty-note">
        {noBalance === 0
          ? 'Nothing is owed on these cards and loans.'
          : noBalance === rows.length
            ? "No balance was reported for these cards and loans, so there's nothing to plan."
            : `${noBalance} of these reported no balance and the rest owe nothing, so there's nothing to plan.`}
      </p>
    );
  } else if (waiting > 0) {
    summary = <Waiting rows={rows} waiting={waiting} money={money} />;
  } else if (debts.length === 0) {
    summary = (
      <p className="empty-note">
        {paidInFull === owing.length
          ? `${plural(paidInFull, 'This card is', 'These cards are')} paid in full each month, so no balance is carried to pay off. Include one below to plan it as a balance you carry.`
          : 'Every debt is left out of the plan. Include one below to plan it.'}
      </p>
    );
  } else if (!comparison) {
    summary = <div className="stale-note">Enter an extra amount of 0 or more to see the plan.</div>;
  } else {
    // "Debt-free" only when nothing owed is outside this plan: left out, in
    // another currency, or at an institution the plan can't see.
    const complete = outside === 0 && groups.length === 1 && !spots.some((s) => s.kind !== 'dated');
    summary = (
      <PlanSummary
        comparison={comparison}
        strategy={inputs.strategy}
        money={money}
        nameOf={nameOf}
        complete={complete}
        outside={outside}
        only={groups.length > 1 ? currency ?? 'Other' : null}
        extraCents={typeof extra === 'number' ? extra : 0}
        interestNowCents={debts.reduce((sum, d) => sum + firstInterestCents(d), 0)}
      />
    );
  }

  // One payment Plaid shows on several loans, split here: said near the headline
  // too, since it changes the plan's monthly total.
  const shared = new Map<string, { institution: string; totalCents: number; loans: number }>();
  for (const r of rows) {
    const s = r.account.sharedMinimum;
    if (!s || r.minimum.source !== 'plaid' || (r.status !== 'ready' && r.status !== 'needs-terms')) continue;
    shared.set(`${r.account.institution}:${s.totalCents}`, { institution: r.account.institution, ...s });
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

      <section className="panel-section">
        {spotNote}
        {currency === null && (
          <p className="panel-note">
            These report no standard currency code, so amounts are shown without a symbol, and they may not
            all be in the same currency.
          </p>
        )}
        {summary}
        {[...shared.values()].map((s) => (
          <p className="panel-note" key={`${s.institution}:${s.totalCents}`}>
            Plaid shows one {money(s.totalCents)} payment on {s.loans} student loans at {s.institution}, so
            it&apos;s split across them by balance.
          </p>
        ))}
      </section>

      <section className="panel-section">
        <label className="field">
          Extra each month{groups.length > 1 ? ` (${currency ?? 'Other'})` : ''}
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
            onAccrued={(without) => setWithoutAccrued(row.account.id, without)}
          />
        ))}
      </section>

      <p className="panel-note">
        Interest is worked out monthly, at the APR / 12, rounded to the cent. Card issuers charge it daily, so
        real interest on a card runs a little higher. Payments stay at today&apos;s amounts, nothing new is
        charged, fees aren&apos;t included, and a promotional rate is taken as lasting, since when it ends
        isn&apos;t known. Nothing typed here is saved: it lasts until the app is reloaded.
      </p>
    </>
  );
}

/** Why a debt's payment is held, said near the headline as on its row. */
function holdReason(a: DebtAccount, money: (cents: number) => string): string | null {
  const plaid = a.plaidMinimumCents;
  if (plaid === null) return null;
  switch (a.minimumHold) {
    case 'escrow':
      return `Plaid's ${money(plaid)} payment includes escrow, which doesn't pay down the loan, so its principal and interest are needed.`;
    case 'escrow-unknown':
      return `Plaid's ${money(plaid)} is the whole monthly payment and may include escrow, so its principal and interest are needed.`;
    case 'zero':
      return `Plaid shows a ${money(0)} minimum, which usually isn't a real payment.`;
    default:
      return null;
  }
}

/** The plan is waiting on terms: how many, and the debts held for a reason. */
function Waiting({ rows, waiting, money }: { rows: PlanRow[]; waiting: number; money: (cents: number) => string }) {
  const held = rows.filter(
    (r) => r.status === 'needs-terms' && r.minimum.value === null && !r.minimum.error && r.account.minimumHold
  );
  return (
    <div className="stale-note payoff-notes">
      <p>
        Add the missing rate or payment for {waiting === 1 ? '1 debt' : `${waiting} debts`} below, or leave{' '}
        {plural(waiting, 'it', 'them')} out, to see the plan.
      </p>
      {held.map((r) => (
        <p key={r.account.id}>
          {accountName(r.account)}: {holdReason(r.account, money)}
        </p>
      ))}
    </div>
  );
}

/** "$1,234.56 in interest and 1 year 2 months", leaving out whichever is zero. */
function savingText(interestCents: number, months: number, money: (cents: number) => string): string {
  return [interestCents > 0 ? `${money(interestCents)} in interest` : null, months > 0 ? durationLabel(months) : null]
    .filter(Boolean)
    .join(' and ');
}

/** The headline: when the chosen order clears everything, what it costs, and what it saves. */
function PlanSummary({
  comparison,
  strategy,
  money,
  nameOf,
  complete,
  outside,
  only,
  extraCents,
  interestNowCents,
}: {
  comparison: Comparison;
  strategy: Strategy;
  money: (cents: number) => string;
  nameOf: (id: string) => string;
  /** Nothing owed is outside this plan, so it can say "Debt-free". */
  complete: boolean;
  /** Debts left out of the plan (by the person, or paid in full). */
  outside: number;
  /** The currency planned, when the debts are in several. */
  only: string | null;
  extraCents: number;
  /** The first month's interest across the plan, to tell "too slow" from "never". */
  interestNowCents: number;
}) {
  const plan = comparison[strategy];
  if (plan.months === null) {
    // Past 50 years is not the same as never: a payment a little over the
    // interest pays off eventually, just not within the horizon.
    return (
      <div className="stale-note">
        At {money(plan.monthlyCents)} a month these debts aren&apos;t paid off within {HORIZON_YEARS} years
        {plan.monthlyCents <= interestNowCents ? ": the payments don't cover the interest" : ''}. Add more each
        month.
      </div>
    );
  }

  const lines: string[] = [];
  if (extraCents > 0 && plan.extraSaved) {
    const { interestCents, months } = plan.extraSaved;
    lines.push(
      interestCents === null || months === null
        ? `Without the extra ${money(extraCents)} a month, these debts aren't paid off within ${HORIZON_YEARS} years.`
        : `The extra ${money(extraCents)} a month saves ${savingText(interestCents, months, money) || 'nothing here'}.`
    );
  }
  const neverOnMinimums = comparison.minimums.debts.filter((d) => d.months === null).map((d) => nameOf(d.id));
  if (neverOnMinimums.length > 0) {
    lines.push(
      `Against paying only the minimums: this clears ${listNames(neverOnMinimums)}, which minimums alone don't within ${HORIZON_YEARS} years.`
    );
  } else {
    const { interestCents, months } = plan.saved;
    const saving = savingText(interestCents!, months!, money);
    lines.push(
      saving
        ? `Against paying only the minimums, this saves ${saving}.`
        : 'The same as paying only the minimums. An extra amount each month pays it off sooner.'
    );
  }

  const notes = [outside > 0 ? `${outside} left out` : null, only ? `${only} only` : null].filter(Boolean);
  return (
    <>
      <div className="summary-row">
        <div>
          <div className="total-label">{complete ? 'Debt-free' : 'Paid off'}</div>
          <div className="summary-value">{monthLabel(plan.month!)}</div>
          <div className="as-of">
            in {durationLabel(plan.months)}
            {notes.length > 0 ? `, ${notes.join(', ')}` : ''}
          </div>
        </div>
        <div>
          <div className="total-label">Interest</div>
          <div className="summary-value">{money(plan.interestCents!)}</div>
          <div className="as-of">{STRATEGY_LABEL[strategy].toLowerCase()} order</div>
        </div>
      </div>
      {lines.map((l) => (
        <div className="status-note" key={l}>
          {l}
        </div>
      ))}
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
        {p.month ? monthLabel(p.month) : 'Not by 50 years'}
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
              <th>Paid off</th>
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
            money={money}
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
                <span className="payoff-step-when">{d.month ? monthLabel(d.month) : 'Not by 50 years'}</span>
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
  'not-reported': 'Plaid has no terms for this account right now. Type them from a statement.',
};

const APR_KIND: Record<string, string> = {
  purchase_apr: 'purchases',
  cash_apr: 'cash advances',
  balance_transfer_apr: 'balance transfers',
  special: 'a special rate',
};

/** One card or loan: its balance, its two terms, and where each came from. */
function DebtRow({
  row,
  typed,
  money,
  onTerm,
  onLeftOut,
  onAccrued,
}: {
  row: PlanRow;
  /** What was typed for it, as typed (undefined fields are untouched). */
  typed: TypedTerms;
  money: (cents: number) => string;
  onTerm: (field: keyof TypedTerms, value: string | undefined) => void;
  /** true leaves it out, false puts it in, undefined goes back to the default. */
  onLeftOut: (out: boolean | undefined) => void;
  onAccrued: (without: boolean) => void;
}) {
  const { account: a, apr, minimum, status } = row;
  const card = a.type === 'credit';
  const updated = a.updatedAt ? instantDay(a.updatedAt) : null;
  const balanceNote = a.staleAsOf
    ? ` · balance from ${staleDay(a.staleAsOf, a.staleAsOfAt)}`
    : updated
      ? ` · updated ${updated}`
      : '';
  const owed = status === 'nothing-owed' ? 'Nothing owed' : status === 'no-balance' ? '--' : money(row.owedCents!);
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
  // Plaid reports a student loan's accrued interest apart from its balance;
  // it is owed, so it is planned unless the person leaves it out.
  const accrued = a.accruedInterestCents !== null && status !== 'nothing-owed' && status !== 'no-balance' && (
    <div className="payoff-sub">
      {row.accruedIncluded
        ? `Includes ${money(a.accruedInterestCents)} of accrued interest. `
        : `${money(a.accruedInterestCents)} of accrued interest left out. `}
      <button className="link-btn" onClick={() => onAccrued(row.accruedIncluded)}>
        {row.accruedIncluded ? 'Leave it out' : 'Include it'}
      </button>
    </div>
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
  if (status === 'paid-in-full' || status === 'left-out') {
    return (
      <div className="payoff-debt">
        {head}
        {accrued}
        <p className="panel-note">
          {status === 'paid-in-full'
            ? "Paid in full at its last statement: no interest is charged while that continues, so it's left out. "
            : 'Left out of the plan. '}
          <button className="link-btn" onClick={() => onLeftOut(false)}>
            Include it
          </button>
        </p>
      </div>
    );
  }

  // The figures that fill the fields until something is typed over them. One
  // out of range is left out of the field, as it is out of the plan
  // (resolveApr, resolveMinimum).
  const plaidApr = a.plaidApr !== null && a.plaidApr >= 0 && a.plaidApr <= MAX_APR ? a.plaidApr : null;
  const fallback =
    a.defaultMinimumCents !== null && a.defaultMinimumCents >= 0 && a.defaultMinimumCents <= MAX_CENTS
      ? a.defaultMinimumCents
      : null;
  const plaidPayment =
    a.plaidMinimumCents !== null && a.plaidMinimumCents > 0 && a.plaidMinimumCents <= MAX_CENTS ? a.plaidMinimumCents : null;
  const cents = (c: number) => (c / 100).toFixed(2);
  const aprText = typed.apr ?? (plaidApr !== null ? String(plaidApr) : '');
  const minimumText = typed.minimum ?? (fallback !== null ? cents(fallback) : '');
  const minimumNeeded = minimum.value === null && !minimum.error;
  // Why a term is needed, said only where Plaid has nothing usable for it. A
  // field the person cleared shows "Needed" with Plaid's figure a tap away
  // instead (TermSource), and a held payment says why below.
  const noPlaid =
    (apr.value === null && !apr.error && plaidApr === null) ||
    (minimumNeeded && fallback === null && !a.minimumHold);
  const debt: Debt | null =
    status === 'ready' ? { id: a.id, balanceCents: row.owedCents!, apr: apr.value!, minimumCents: minimum.value! } : null;

  let interestLine: ReactNode = null;
  if (debt) {
    const interest = firstInterestCents(debt);
    const pay = debt.minimumCents;
    interestLine =
      pay > interest ? (
        <div className="payoff-sub">About {money(interest)} a month in interest at this balance.</div>
      ) : (
        <div className="stale-note">
          {pay === 0
            ? interest === 0
              ? 'With no payment, it never pays off on its own.'
              : `With no payment, it never pays off on its own, and it grows by about ${money(interest)} a month in interest.`
            : pay === interest
              ? `${money(pay)} a month only covers the interest, so on its own the balance never falls.`
              : `${money(pay)} a month doesn't cover the interest (about ${money(interest)} a month), so on its own it never pays this off.`}
        </div>
      );
  }

  return (
    <div className="payoff-debt">
      {head}
      {accrued}
      {a.paidInFull && (
        <p className="panel-note">Paid in full at its last statement. It&apos;s planned here as a balance carried, with interest.</p>
      )}
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
            fromDefault={`${a.plaidAprLabel ?? 'APR'} from Plaid`}
            restore={plaidApr !== null ? `Use Plaid's ${plaidApr}%` : null}
            onRestore={() => onTerm('apr', undefined)}
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
            fromDefault={
              a.sharedMinimum
                ? `Share of one ${money(a.sharedMinimum.totalCents)} payment on ${a.sharedMinimum.loans} loans`
                : a.minimumHold === 'escrow-unknown'
                  ? 'Monthly payment from Plaid, with no escrow'
                  : 'Minimum from Plaid'
            }
            restore={fallback !== null ? `Use ${a.sharedMinimum ? 'the shared split' : "Plaid's"} ${money(fallback)}` : null}
            onRestore={() => onTerm('minimum', undefined)}
          />
        </div>
      </div>

      {apr.source === 'plaid' && a.aprParts && (
        <p className="panel-note">
          Blended from the card&apos;s rates by what each applied to at its last statement:{' '}
          {a.aprParts
            .map((p) => `${p.rate}% on ${money(Math.round(p.balance * 100))}${p.type && APR_KIND[p.type] ? ` (${APR_KIND[p.type]})` : ''}`)
            .join(', ')}
          .
        </p>
      )}

      {noPlaid && (
        <p className="panel-note">
          {a.noTerms ? NO_TERMS_HINT[a.noTerms] : 'Plaid has no usable figure for this one. Type it from a statement.'}
        </p>
      )}

      {minimumNeeded && (a.minimumHold === 'escrow' || a.minimumHold === 'escrow-unknown') && plaidPayment !== null && (
        <div className="payoff-hold">
          <p className="panel-note">
            {a.minimumHold === 'escrow'
              ? `Plaid's ${money(plaidPayment)} includes escrow (taxes and insurance${a.escrowCents !== null ? `; the escrow account holds ${money(a.escrowCents)}` : ''}), which doesn't pay down the loan. Type the principal and interest from a statement.`
              : `Plaid's ${money(plaidPayment)} is the whole monthly payment, which can include escrow (taxes and insurance) that doesn't pay down the loan. Type the principal and interest from a statement.`}
          </p>
          {a.workedOut && (
            <button className="link-btn" onClick={() => onTerm('minimum', cents(a.workedOut!.cents))}>
              Use {money(a.workedOut.cents)}, worked out from the original {money(Math.round(a.workedOut.principal * 100))}{' '}
              over {durationLabel(a.workedOut.months)} at {a.workedOut.apr}%
            </button>
          )}
          {a.minimumHold === 'escrow-unknown' && (
            <button className="link-btn" onClick={() => onTerm('minimum', cents(plaidPayment))}>
              No escrow? Use Plaid&apos;s {money(plaidPayment)}
            </button>
          )}
        </div>
      )}

      {minimumNeeded && a.minimumHold === 'zero' && (
        <p className="panel-note">
          Plaid shows a {money(0)} minimum. That&apos;s usually autopay at some servicers, nothing due this
          cycle, or a deferment rather than a payment. Type what you pay each month.
        </p>
      )}

      {a.sharedMinimum && minimum.source === 'plaid' && (
        <div className="payoff-hold">
          <p className="panel-note">
            Plaid shows the same {money(a.sharedMinimum.totalCents)} minimum on {a.sharedMinimum.loans} loans
            here. Some servicers bill one payment across all of an account&apos;s loans, so it&apos;s split by
            balance.
          </p>
          <button className="link-btn" onClick={() => onTerm('minimum', cents(a.sharedMinimum!.totalCents))}>
            Billed separately? Use {money(a.sharedMinimum.totalCents)} for this loan
          </button>
        </div>
      )}

      {interestLine}

      {/* A card paid in full goes back to starting out; anything else is left out. */}
      <button className="link-btn payoff-leave" onClick={() => onLeftOut(a.paidInFull ? undefined : true)}>
        Leave out of the plan
      </button>
    </div>
  );
}

/** Where a term came from: Plaid, worked out, typed, or still needed, with a way back to the default. */
function TermSource({
  term,
  fromDefault,
  restore,
  onRestore,
}: {
  term: Term;
  /** How the default value is described ("Purchase APR from Plaid"). */
  fromDefault: string;
  /** The link back to the default, when there is one. */
  restore: string | null;
  onRestore: () => void;
}) {
  const back = restore && (
    <>
      {' '}
      <button className="link-btn" onClick={onRestore}>
        {restore}
      </button>
    </>
  );
  if (term.error) {
    return (
      <div className="payoff-source invalid">
        {term.error}
        {back}
      </div>
    );
  }
  if (term.source === 'plaid') return <div className="payoff-source">{fromDefault}</div>;
  if (term.source === 'worked-out') {
    return (
      <div className="payoff-source">
        Worked out from the original loan
        {back}
      </div>
    );
  }
  if (term.source === 'typed') {
    return (
      <div className="payoff-source">
        Typed
        {back}
      </div>
    );
  }
  return (
    <div className="payoff-source needed">
      Needed
      {back}
    </div>
  );
}

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
 * What is owed in total, month by month: the chosen order against paying only
 * the minimums. Scrubbing reads both at a month; at rest it shows the month the
 * plan is done, which is when the gap between them is plainest.
 */
function PayoffChart({
  plan,
  baseline,
  planLabel,
  currency,
  money,
  start,
}: {
  plan: Plan;
  baseline: Plan;
  planLabel: string;
  currency: string | null;
  money: (cents: number) => string;
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
  // Clamped: a pointer left resting on the chart keeps its index while a larger
  // extra shortens the plan under it.
  const i = Math.min(active ?? done, span);

  function scrub(clientX: number) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    setActive(Math.max(0, Math.min(span, Math.round(((px - PAD_LEFT) / plotW) * span))));
  }

  const fmt = (v: number) => money(Math.round(v * 100));
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
          Minimums only{baseline.months === null ? `, not paid off by ${HORIZON_YEARS} years` : ''}
        </span>
      </div>

      {/* Two figures on one line and the date on its own, so a long figure
          can't wrap and move the chart under the finger while scrubbing. */}
      <div className="chart-readout chart-readout-stable">
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
        aria-label={`Total owed from now to ${endLabel}. ${planLabel} reaches zero in ${monthLabel(plan.month!)}; paying only the minimums, ${baseline.month ? `in ${monthLabel(baseline.month)}` : `not within ${HORIZON_YEARS} years`}.`}
        onPointerMove={(e) => scrub(e.clientX)}
        onPointerDown={(e) => scrub(e.clientX)}
        onPointerLeave={() => setActive(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_LEFT} x2={W - PAD_RIGHT} y1={y(t)} y2={y(t)} stroke="#262a33" strokeWidth={1} />
            <text className="chart-tick" x={PAD_LEFT} y={y(t) - 3}>
              {compactIn(currency, t)}
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
