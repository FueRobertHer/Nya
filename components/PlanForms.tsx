'use client';

// The Plan tab's forms, each shown in the drawer (components/Sheet.tsx). A
// form holds what is typed as strings (so "4." or "-" survive typing), checks
// each field with a message a person can act on, and saves the WHOLE plan
// through onSave, closing only once the server has it. A form opens while
// saving is paused (the Plan's figure rows always open their sheets), and
// then says why above its buttons.
//
// With a scenario open (lib/fire/scenarios.ts), the plan a form holds is the
// scenario's, and onSave records what changed in it as the scenario's own
// (components/plan-savers.ts). What a scenario can't change (your age, how
// figures are measured, the method, the part-time income) is shown, but
// can't be edited there, and the form says where its save goes.

import { useEffect, useId, useRef, useState } from 'react';
import { plainNumber } from '@/lib/format';
import { allocationOf, asText, LIMITS, parsePlan, pctText, type FirePlan, type PlanExpense, type PlanFunding, type PlanIncome } from '@/lib/fire/plan';
import { vpwExpectedReturn, type RuleKind } from '@/lib/fire/rules';
import { fiNumber as fiNumberOf } from '@/lib/fire/fi';
import { METHOD_NAMES, RULE_NAMES, ruleText, pct, wholeMoney } from './plan-text';
import { BLOCK_MONTHS, DEFAULT_RUNS, DEFAULT_SEED } from '@/lib/fire/simulate';
import { mixBasisText, mixLeftOutText, mixText } from './allocation-text';
import { Masked, NO_EXAMPLE, spokenLabel } from './HideAmounts';
import { Why } from './Why';
import { Segmented } from './Segmented';
import FieldError from './FieldError';
import { Notice } from './TotalCaveats';
import type { PlanMix } from '@/lib/allocation/allocation';

type SaveProps = {
  plan: FirePlan;
  /** Resolves true once the server has the plan, false when it didn't take
   *  it, or with why it was refused before it was sent. */
  onSave: (next: FirePlan) => Promise<boolean | string>;
  onDone: () => void;
  /** False while the saved plan is loading or unreadable: nothing is saved. */
  editable: boolean;
  /** The open scenario's name, which the save goes to; null for the Plan. */
  scenario?: string | null;
  /** Why saving is paused for more than a moment (the saved plan couldn't
   *  be read, a repair waits, its currency isn't known), said above the
   *  buttons; null while it isn't, or only for a moment (a save under way). */
  paused?: string | null;
};

/** Said beside an input a scenario can't change. */
const SAME_IN_EVERY_PLAN = 'the same in every scenario: change it with your plan open.';

/** What was typed that can't be saved, and the fields it is about (each by
 *  the name `readNumber` is given): said under the last of them, and named
 *  by each (`useSave`'s `field` and `under`). */
class FieldProblem extends Error {
  constructor(
    message: string,
    readonly fields: readonly string[]
  ) {
    super(message);
  }
}

/** A number typed in a field: null when empty, an error when not a number in range. */
function readNumber(text: string, what: string, min: number, max: number, opts: { integer?: boolean; optional?: boolean; scale?: number } = {}): number | null {
  const t = text.trim();
  if (t === '') {
    if (opts.optional) return null;
    throw new FieldProblem(`${what} is needed.`, [what]);
  }
  const n = Number(t);
  const scale = opts.scale ?? 1;
  if (!Number.isFinite(n) || n * scale < min - 1e-12 || n * scale > max + 1e-12) {
    const show = (v: number) => (scale === 1 ? plainNumber(v) : `${Number((v / scale).toFixed(2))}%`);
    throw new FieldProblem(`${what} must be from ${show(min)} to ${show(max)}.`, [what]);
  }
  if (opts.integer && !Number.isInteger(n)) throw new FieldProblem(`${what} must be a whole number.`, [what]);
  return scale === 1 ? n : Number((n * scale).toFixed(6));
}


/** Saves `build()` when it checks out, keeping the message otherwise: what
 *  was typed wrong under its field, a save that failed as a notice. */
function useSave({ onSave, onDone, editable }: SaveProps) {
  const [error, setError] = useState('');
  const [wrong, setWrong] = useState<FieldProblem | null>(null);
  const [saving, setSaving] = useState(false);
  const errorId = useId();
  async function save(build: () => FirePlan) {
    let next: FirePlan;
    try {
      next = build();
    } catch (err) {
      if (err instanceof FieldProblem) {
        setError('');
        setWrong(err);
        return;
      }
      throw err;
    }
    setWrong(null);
    // The server checks again; this catches anything the fields above missed.
    const parsed = parsePlan(next);
    if ('error' in parsed) {
      setError(`That plan can't be saved: ${parsed.error}.`);
      return;
    }
    setError('');
    setSaving(true);
    const ok = await onSave(parsed.plan);
    setSaving(false);
    if (ok === true) onDone();
    else setError(typeof ok === 'string' ? ok : 'It was not saved. Try again in a moment.');
  }
  /** A field's input: invalid, and described by what is wrong, while it is
   *  one the problem is about. */
  const field = (name: string) => (wrong?.fields.includes(name) ? { 'aria-invalid': true, 'aria-describedby': errorId } : {});
  /** What is wrong, said here when the last field it is about is one of `names`. */
  const under = (...names: string[]) =>
    wrong && names.includes(wrong.fields[wrong.fields.length - 1]) ? <FieldError id={errorId}>{wrong.message}</FieldError> : null;
  return { error, saving, save, field, under, disabled: saving || !editable };
}

function Buttons({
  onDone,
  disabled,
  saving,
  onSave,
  extra,
  scenario = null,
  paused = null,
}: {
  onDone: () => void;
  disabled: boolean;
  saving: boolean;
  onSave: () => void;
  extra?: React.ReactNode;
  scenario?: string | null;
  paused?: string | null;
}) {
  return (
    <>
      {extra}
      {scenario && <p className="panel-note plan-scenario-saves">Saved to the scenario “{scenario}”, not your plan.</p>}
      {paused && <p className="helper plan-paused">{paused}</p>}
      <div className="button-pair" style={{ marginTop: 16 }}>
        <button className="secondary" onClick={onDone} disabled={saving}>
          Cancel
        </button>
        <button onClick={onSave} disabled={disabled}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );
}

/** Choices in a row, the chosen one marked: a radio group setting a value,
 *  or, with `tabs`, a switch between views (components/Segmented.tsx). */
export function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
  tabs,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
  tabs?: { id: (v: T) => string; panel: string };
}) {
  return <Segmented className="plan-choice" label={label} value={value} onChange={onChange} options={options} disabled={disabled} tabs={tabs} />;
}

/** Both ages, refusing a target already passed: it would have Coast FI grow
 *  money backwards and the simulation retire before today. */
function ages(age: number | null, targetAge: number | null): { age: number | null; targetAge: number | null } {
  if (age !== null && targetAge !== null && targetAge < age) {
    throw new FieldProblem("Your stop age can't be before your age. If you've already stopped working, use your age.", ['Your age', 'Stop age']);
  }
  return { age, targetAge };
}

export function AboutForm(props: SaveProps) {
  const { plan } = props;
  const [age, setAge] = useState(asText(plan.age));
  const [target, setTarget] = useState(asText(plan.targetAge));
  const s = useSave(props);
  const [min, max] = LIMITS.age;
  return (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        Your age places Social Security, pensions and one-off expenses in the plan. Your stop age is when you would like to
        stop working: the stress test starts there (unless it starts with what you have today), and Coast FI counts the years
        to it.
      </p>
      <div className="sheet-form">
        <label className="field">
          Your age
          <input
            type="number"
            inputMode="numeric"
            value={age}
            onChange={(e) => setAge(e.target.value)}
            placeholder="Not set"
            {...s.field('Your age')}
            disabled={s.saving || !!props.scenario}
          />
        </label>
        {s.under('Your age')}
        {props.scenario && <p className="panel-note">Your age is {SAME_IN_EVERY_PLAN}</p>}
        <label className="field">
          Stop age
          <input
            type="number"
            inputMode="numeric"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="Not set"
            {...s.field('Stop age')}
            disabled={s.saving}
          />
        </label>
        {s.under('Stop age')}
      </div>
      {s.error && (
        <Notice level="critical" role="alert">
          {s.error}
        </Notice>
      )}
      <Buttons
        scenario={props.scenario}
        paused={props.paused}
        onDone={props.onDone}
        disabled={s.disabled}
        saving={s.saving}
        onSave={() =>
          s.save(() => ({
            ...plan,
            ...ages(readNumber(age, 'Your age', min, max, { integer: true, optional: true }), readNumber(target, 'Stop age', min, max, { integer: true, optional: true })),
          }))
        }
      />
    </>
  );
}

export type FigureKind = 'spending' | 'savings' | 'assets';

const FIGURE_TEXT: Record<FigureKind, { title: string; field: string; note: string }> = {
  spending: {
    title: 'Annual spending',
    field: 'Spending a year',
    note: "Nya adds up a year of money out, leaving out transfers between your own accounts and card payments (they settle purchases already counted). Unlike the Activity tab it counts mortgage, car, student and personal loan payments, whose principal is spending until the loan ends, and cash withdrawals, and takes refunds in spending categories off. Type your own if you expect to spend differently once you stop working, after a mortgage ends, say.",
  },
  savings: {
    title: 'Annual savings',
    field: 'Savings a year',
    note: "An estimate: a year of income minus spending, plus what went into workplace plans Nya can see (a 401(k) and the like, employer's match included). Contributions to a workplace plan Nya can't see never reach a bank account, so add them if you type your own.",
  },
  assets: {
    title: 'Invested assets',
    field: 'Invested assets',
    note: 'Your investment accounts as the Accounts tab shows them, without hidden accounts. Debts are not subtracted.',
  },
};

type CountedAccount = { account_id: string; name: string; institution: string; balance: number; currency?: string | null };

export function FigureForm(
  props: SaveProps & {
    kind: FigureKind;
    measured: number | null;
    measuredText: string;
    /** How the measured figure was worked out (components/plan-figure-notes.ts),
     *  behind Why? under it; null when there is nothing more to say. */
    why?: string | null;
    currency: string | null;
    /** Invested assets with or without cash, so the total follows the box as it is ticked. */
    assetsFor?: (includeCash: boolean) => { total: number | null; accounts: CountedAccount[] };
    /** Savings: the workplace plans whose contributions are measured, each
     *  with how it is paid into. */
    workplacePlans?: { account_id: string; label: string }[];
  }
) {
  const { plan, kind } = props;
  const typedNow = plan[kind];
  const [mode, setMode] = useState<'measured' | 'typed'>(typedNow === null && props.measured !== null ? 'measured' : 'typed');
  const [text, setText] = useState(asText(typedNow ?? (props.measured === null ? null : Math.round(props.measured))));
  const [includeCash, setIncludeCash] = useState(plan.includeCash);
  // How each workplace plan is paid into, by account id; absent is not set.
  const [funding, setFunding] = useState(() => new Map(plan.planFunding.map((f) => [f.account_id, f.paidFrom])));
  const plans = kind === 'savings' ? (props.workplacePlans ?? []) : [];
  // What is set here, plus what was set before for a plan not listed now
  // (hidden, or disconnected for a while), as long as it fits.
  const planFunding = (): PlanFunding[] => {
    const listed = new Set(plans.map((p) => p.account_id));
    const here = plans.flatMap((p) => {
      const paidFrom = funding.get(p.account_id);
      return paidFrom ? [{ account_id: p.account_id, paidFrom }] : [];
    });
    return [...here, ...plan.planFunding.filter((f) => !listed.has(f.account_id))].slice(0, LIMITS.planFunding);
  };
  const s = useSave(props);
  const t = FIGURE_TEXT[kind];
  const live = kind === 'assets' && props.assetsFor ? props.assetsFor(includeCash) : null;
  const measured = live ? live.total : props.measured;
  const measuredText = live ? `from ${live.accounts.length} account${live.accounts.length === 1 ? '' : 's'}` : props.measuredText;
  // Said of the figure as the plan measures it now: for assets, not once the
  // cash box says otherwise.
  const why = props.why && (kind !== 'assets' || includeCash === plan.includeCash) ? props.why : null;
  const range = kind === 'savings' ? [-LIMITS.money, LIMITS.money] : kind === 'assets' ? [0, LIMITS.balance] : [0, LIMITS.money];
  return (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        {t.note}
      </p>
      <Choice
        label={t.title}
        value={mode}
        onChange={setMode}
        options={[
          ['measured', 'Nya’s figure'],
          ['typed', 'My own'],
        ]}
      />
      {mode === 'measured' ? (
        <>
          <p className="panel-note">
            {measured === null ? (
              'Nya has nothing to measure this from yet, so the plan leaves it out until you type your own.'
            ) : (
              <>
                <strong>
                  <Masked>{wholeMoney(measured, props.currency)}</Masked>
                </strong>{' '}
                {measuredText}
              </>
            )}
          </p>
          {measured !== null && why && (
            <Why>
              <Masked>{why}</Masked>
            </Why>
          )}
        </>
      ) : (
        <div className="sheet-form">
          <label className="field">
            {t.field}
            <input
              type="number"
              inputMode="decimal"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={NO_EXAMPLE}
              {...s.field(t.field)}
              disabled={s.saving}
            />
          </label>
          {s.under(t.field)}
        </div>
      )}
      {kind === 'assets' && (
        <>
          <label className="plan-check">
            <input type="checkbox" checked={includeCash} onChange={(e) => setIncludeCash(e.target.checked)} disabled={s.saving || !!props.scenario} />
            Count checking and savings accounts too
          </label>
          {props.scenario && <p className="panel-note">Counting cash is how your figures are measured: {SAME_IN_EVERY_PLAN}</p>}
          {live && live.accounts.length > 0 && mode === 'measured' && (
            <ul className="plan-accounts">
              {live.accounts.map((a) => (
                <li key={a.account_id}>
                  <span>
                    {a.name} <span className="plan-muted">· {a.institution}</span>
                  </span>
                  <span className="num">
                    <Masked>{wholeMoney(a.balance, a.currency ?? props.currency)}</Masked>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {plans.length > 0 && (
        <>
          <p className="panel-note">
            How each workplace plan is paid into. <strong>Payroll</strong>: every contribution is added, since it comes out
            of your pay before it reaches a bank. <strong>My bank</strong>: none is, since the transfers that paid for them
            already count as saved (a Solo 401(k), say). <strong>Not set</strong>: a contribution is added unless a
            transfer from your bank to investment and retirement funds paid for it.
          </p>
          {plans.map((p) => (
            <div key={p.account_id} className="plan-funding">
              <div className="plan-funding-name">{p.label}</div>
              <Choice
                label={`How ${p.label} is paid into`}
                value={funding.get(p.account_id) ?? 'unset'}
                disabled={s.saving || !!props.scenario}
                onChange={(v) =>
                  setFunding((m) => {
                    const next = new Map(m);
                    if (v === 'unset') next.delete(p.account_id);
                    else next.set(p.account_id, v);
                    return next;
                  })
                }
                options={[
                  ['unset', 'Not set'],
                  ['payroll', 'Payroll'],
                  ['bank', 'My bank'],
                ]}
              />
            </div>
          ))}
        </>
      )}
      {s.error && (
        <Notice level="critical" role="alert">
          {s.error}
        </Notice>
      )}
      <Buttons
        scenario={props.scenario}
        paused={props.paused}
        onDone={props.onDone}
        disabled={s.disabled}
        saving={s.saving}
        onSave={() =>
          s.save(() => ({
            ...plan,
            [kind]: mode === 'measured' ? null : readNumber(text, t.field, range[0], range[1]),
            includeCash: kind === 'assets' ? includeCash : plan.includeCash,
            planFunding: kind === 'savings' ? planFunding() : plan.planFunding,
          }))
        }
      />
    </>
  );
}

const RULE_ORDER: RuleKind[] = ['constant', 'guardrails', 'floor-ceiling', 'percent', 'vpw'];

/** A rate typed as a percent, or `saved` while the field doesn't hold one in
 *  range: what the sentences beside the fields read as they are typed. */
function typedRate(text: string, [min, max]: readonly [number, number], saved: number): number {
  const t = text.trim();
  const n = t === '' ? NaN : Number(t) / 100;
  return Number.isFinite(n) && n >= min - 1e-12 && n <= max + 1e-12 ? n : saved;
}

/** The rate the simulation withdraws at when it doesn't start with the FI
 *  number: your spending, grossed up for tax, as a share of the balance it
 *  starts with (lib/fire/plan.ts enginePlan); null when either isn't known. */
function startRate(start: FirePlan['start'], props: { assets: number | null; spending: number | null }, typed: number, tax: number): number | null {
  if (start === 'fi-number') return null;
  const balance = start === 'assets' ? props.assets : Number.isFinite(typed) && typed > 0 ? typed : null;
  return props.spending !== null && balance ? props.spending / (1 - tax) / balance : null;
}

/** What a start choice means for the plan: when it stops working, and what
 *  the first year withdraws. Starting with the FI number withdraws the plan's
 *  rate of it (your spending, by construction); starting from anything else
 *  withdraws your spending, at whatever rate that is of the balance
 *  (lib/fire/plan.ts). `rate` and `tax` are the ones typed. */
function startConsequence(
  start: FirePlan['start'],
  plan: FirePlan,
  props: { assets: number | null; spending: number | null; currency: string | null },
  typed: number,
  rate: number,
  tax: number
): string {
  const money = (n: number) => wholeMoney(n, props.currency);
  const spend = props.spending !== null ? `your spending of ${money(props.spending)} a year` : 'your spending';
  if (start === 'fi-number') {
    return `Stops working at your stop age${plan.targetAge !== null ? ` (${plan.targetAge})` : ''} with your FI number, withdrawing ${pct(rate)} of it: ${spend}.`;
  }
  const actual = startRate(start, props, typed, tax);
  const when = start === 'assets' ? `today${plan.age !== null ? `, at ${plan.age},` : ''} with what you have now` : `at your stop age with the balance you type`;
  return `Stops working ${when}, spending ${spend}${actual !== null ? `: a ${pct(actual, 1)} withdrawal rate${actual > rate * 1.001 ? `, above the ${pct(rate)} your FI number assumes` : ''}` : ''}. Answers whether what you spend now would have lasted.`;
}

/** Which part of the Assumptions sheet to open at: the stress test's
 *  settings, or its mix (filled in from your allocation). */
export type AssumptionsAt = 'stress' | 'mix';

/**
 * Assumptions (rollout phase 6d): every rate and setting the plan uses, in
 * one sheet, each with what it changes under it. The FI number's (the
 * withdrawal rate, growth after inflation, tax, part-time income), then the
 * stress test's (method, rule, where it starts, length, mix, rebalancing,
 * fees). One Save saves the whole plan. Opened at the stress test's part
 * from Stress test's row, and at its mix, filled in from your allocation,
 * from Portfolio's "Use my allocation in the plan": nothing changes until
 * Save.
 */
export function AssumptionsForm(
  props: SaveProps & {
    /** The spending the FI number rests on (in a scenario, its spending in
     *  retirement); null when the plan shown isn't worked out. */
    fiSpending: number | null;
    assets: number | null;
    spending: number | null;
    currency: string | null;
    /** The mix the allocation gives (components/AllocationCard.tsx), offered
     *  to fill in, with what it is of and what it leaves out: nothing changes
     *  until Save. Null when there is none. */
    allocationMix?: (PlanMix & { ok: true }) | null;
    /** The part to open at; null or left out, the top. */
    at?: AssumptionsAt | null;
  }
) {
  const { plan, at = null } = props;
  const offer = props.allocationMix ?? null;
  const fill = at === 'mix' && offer !== null;
  const [rate, setRate] = useState(pctText(plan.withdrawalRate));
  const [ret, setRet] = useState(pctText(plan.realReturn));
  const [tax, setTax] = useState(pctText(plan.taxRate));
  const [partTime, setPartTime] = useState(plan.partTimeIncome ? String(plan.partTimeIncome) : '');
  const [method, setMethod] = useState(plan.method);
  const [rule, setRule] = useState<RuleKind>(plan.rule);
  const [start, setStart] = useState(plan.start);
  const [balance, setBalance] = useState(asText(plan.startBalance));
  const [horizon, setHorizon] = useState(asText(plan.horizon));
  const [stocks, setStocks] = useState(String(fill ? offer.stocksPct : plan.stocksPct));
  const [bonds, setBonds] = useState(String(fill ? offer.bondsPct : plan.bondsPct));
  const [rebalance, setRebalance] = useState(plan.rebalance);
  const [fee, setFee] = useState(pctText(plan.fee));
  const [floor, setFloor] = useState(pctText(plan.floor));
  const [ceiling, setCeiling] = useState(pctText(plan.ceiling));
  const s = useSave(props);
  const cash = 100 - (Number(stocks) || 0) - (Number(bonds) || 0);
  const mix = { ...plan, stocksPct: Number(stocks) || 0, bondsPct: Number(bonds) || 0 };
  const expected = cash >= 0 ? vpwExpectedReturn(allocationOf(mix)) : 0;
  // The rate and tax as typed, for the sentences that read them, and the FI
  // number at them (lib/fire/fi.ts). The rule is said at the rate the
  // simulation withdraws at: the withdrawal rate when it starts with the FI
  // number, else what your spending is of the balance it starts with.
  const rateNow = typedRate(rate, LIMITS.withdrawalRate, plan.withdrawalRate);
  const taxNow = typedRate(tax, LIMITS.taxRate, plan.taxRate);
  const fiNumber = props.fiSpending === null ? null : fiNumberOf(props.fiSpending, rateNow, taxNow);
  const ruleRate = startRate(start, props, Number(balance), taxNow) ?? rateNow;

  // Opened at a part: the sheet's body is scrolled to it. Set on the body
  // alone (never scrollIntoView, which would scroll the page behind too, as
  // the sheet hasn't locked it yet when this runs); the sheet takes focus
  // without scrolling, so this stays.
  const stressRef = useRef<HTMLHeadingElement | null>(null);
  const mixRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = at === 'mix' ? mixRef.current : at === 'stress' ? stressRef.current : null;
    let body: Element | null = el?.parentElement ?? null;
    while (body && !(body.getAttribute('class') ?? '').split(' ').includes('sheet-body')) body = body.parentElement;
    if (el && body) body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top;
    // Only as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function build(): FirePlan {
    const stocksPct = readNumber(stocks, 'Stocks', 0, 100, { integer: true }) as number;
    const bondsPct = readNumber(bonds, 'Bonds', 0, 100, { integer: true }) as number;
    if (stocksPct + bondsPct > 100) throw new FieldProblem('Stocks and bonds add up to more than 100%.', ['Stocks', 'Bonds']);
    return {
      ...plan,
      withdrawalRate: readNumber(rate, 'The withdrawal rate', ...LIMITS.withdrawalRate, { scale: 0.01 }) as number,
      realReturn: readNumber(ret, 'Growth after inflation', ...LIMITS.realReturn, { scale: 0.01 }) as number,
      taxRate: readNumber(tax, 'The tax rate', ...LIMITS.taxRate, { scale: 0.01 }) as number,
      partTimeIncome: readNumber(partTime, 'Part-time income', 0, LIMITS.money, { optional: true }) ?? 0,
      method,
      rule,
      start,
      startBalance: start === 'custom' ? readNumber(balance, 'The starting balance', 0, LIMITS.balance) : plan.startBalance,
      horizon: readNumber(horizon, 'The length', ...LIMITS.horizon, { integer: true, optional: true }),
      stocksPct,
      bondsPct,
      rebalance,
      fee: readNumber(fee, 'The fee', ...LIMITS.fee, { scale: 0.01 }) as number,
      floor: rule === 'floor-ceiling' ? (readNumber(floor, 'The floor', ...LIMITS.floor, { scale: 0.01 }) as number) : plan.floor,
      ceiling: rule === 'floor-ceiling' ? (readNumber(ceiling, 'The ceiling', ...LIMITS.ceiling, { scale: 0.01 }) as number) : plan.ceiling,
    };
  }

  return (
    <div className="plan-assumptions-form">
      <h3 className="plan-heading">FI number</h3>
      <div className="sheet-form">
        <label className="field">
          Withdrawal rate (% a year)
          <input
            type="number"
            inputMode="decimal"
            data-percent
            step="0.1"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            {...s.field('The withdrawal rate')}
            disabled={s.saving}
          />
        </label>
        {s.under('The withdrawal rate')}
        <p className="helper">How much you&apos;d draw each year, as a share of what you have: it sets the FI number (spending divided by it) and the rate the simulation tests.</p>
        <label className="field">
          Growth after inflation until FI (% a year)
          <input
            type="number"
            inputMode="decimal"
            data-percent
            step="0.5"
            value={ret}
            onChange={(e) => setRet(e.target.value)}
            {...s.field('Growth after inflation')}
            disabled={s.saving}
          />
        </label>
        {s.under('Growth after inflation')}
        <p className="helper">Only for the years until FI: years to FI, Coast FI and the balance at your stop age. The simulation uses market history instead.</p>
        <label className="field">
          Tax on withdrawals (% of each withdrawal)
          <input
            type="number"
            inputMode="decimal"
            data-percent
            step="1"
            value={tax}
            onChange={(e) => setTax(e.target.value)}
            {...s.field('The tax rate')}
            disabled={s.saving}
          />
        </label>
        {s.under('The tax rate')}
        <p className="helper">A flat share of every withdrawal: the FI number, and what the simulation withdraws, are larger to pay it.</p>
        <label className="field">
          Part-time income for Barista FI (a year, after tax)
          <input
            type="number"
            inputMode="decimal"
            value={partTime}
            onChange={(e) => setPartTime(e.target.value)}
            placeholder="None"
            {...s.field('Part-time income')}
            disabled={s.saving || !!props.scenario}
          />
        </label>
        {s.under('Part-time income')}
        {props.scenario && <p className="helper">The part-time income for Barista FI is your plan’s: {SAME_IN_EVERY_PLAN} Part-time work in this scenario is a life event.</p>}
      </div>

      <h3 className="plan-heading" ref={stressRef}>
        Stress test
      </h3>
      <div className="sheet-form">
        <label className="field">
          Method
          <select value={method} onChange={(e) => setMethod(e.target.value as FirePlan['method'])} disabled={s.saving || !!props.scenario}>
            <option value="historical">{METHOD_NAMES.historical}</option>
            <option value="monte-carlo">{METHOD_NAMES['monte-carlo']}</option>
          </select>
        </label>
        {props.scenario && <p className="helper">The method is {SAME_IN_EVERY_PLAN}</p>}
        <p className="helper">
          {method === 'historical'
            ? 'Starts the plan in every month since 1871 that leaves all of it inside the data, and lives through what followed.'
            : `${plainNumber(DEFAULT_RUNS)} runs, each built from ${BLOCK_MONTHS / 12}-year blocks of months drawn at random from the same history: more sequences than history holds, spread wider. They are drawn the same way each time (seed ${DEFAULT_SEED}), so the same plan gives the same answer.`}
        </p>
        <label className="field">
          Withdrawal rule
          <select value={rule} onChange={(e) => setRule(e.target.value as RuleKind)} disabled={s.saving}>
            {RULE_ORDER.map((k) => (
              <option key={k} value={k}>
                {RULE_NAMES[k]}
              </option>
            ))}
          </select>
        </label>
        <p className="helper">
          {ruleText(rule, { rate: ruleRate, floor: Number(floor) / 100 || plan.floor, ceiling: Number(ceiling) / 100 || plan.ceiling, expectedReturn: expected })} Withdrawals once a
          year, at the start of the year.
        </p>
        {rule === 'floor-ceiling' && (
          <div className="plan-pair">
            <label className="field">
              Floor (% of the first year)
              <input
                type="number"
                inputMode="decimal"
                data-percent
                value={floor}
                onChange={(e) => setFloor(e.target.value)}
                {...s.field('The floor')}
                disabled={s.saving}
              />
            </label>
            <label className="field">
              Ceiling (% of the first year)
              <input
                type="number"
                inputMode="decimal"
                data-percent
                value={ceiling}
                onChange={(e) => setCeiling(e.target.value)}
                {...s.field('The ceiling')}
                disabled={s.saving}
              />
            </label>
          </div>
        )}
        {s.under('The floor', 'The ceiling')}
        <label className="field">
          Start with
          <select value={start} onChange={(e) => setStart(e.target.value as FirePlan['start'])} disabled={s.saving}>
            {[
              ['fi-number', `FI number${fiNumber !== null ? ` (${wholeMoney(fiNumber, props.currency)})` : ''}`],
              ['assets', `Invested assets${props.assets !== null ? ` (${wholeMoney(props.assets, props.currency)})` : ''}`],
            ].map(([value, text]) => (
              <option key={value} value={value} aria-label={spokenLabel(text)}>
                {text}
              </option>
            ))}
            <option value="custom">A balance I type</option>
          </select>
        </label>
        <p className="helper">
          <Masked>{startConsequence(start, plan, props, Number(balance), rateNow, taxNow)}</Masked>
        </p>
        {start === 'custom' && (
          <label className="field">
            Starting balance
            <input
              type="number"
              inputMode="decimal"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              placeholder={NO_EXAMPLE}
              {...s.field('The starting balance')}
              disabled={s.saving}
            />
          </label>
        )}
        {s.under('The starting balance')}
        <label className="field">
          Length in years (empty: to age 95, or 30 years without an age)
          <input
            type="number"
            inputMode="numeric"
            value={horizon}
            onChange={(e) => setHorizon(e.target.value)}
            placeholder="To age 95"
            {...s.field('The length')}
            disabled={s.saving}
          />
        </label>
        {s.under('The length')}
        <div className="plan-pair" ref={mixRef}>
          <label className="field">
            Stocks %
            <input type="number" inputMode="numeric" value={stocks} onChange={(e) => setStocks(e.target.value)} {...s.field('Stocks')} disabled={s.saving} />
          </label>
          <label className="field">
            Bonds %
            <input type="number" inputMode="numeric" value={bonds} onChange={(e) => setBonds(e.target.value)} {...s.field('Bonds')} disabled={s.saving} />
          </label>
        </div>
        {s.under('Stocks', 'Bonds')}
        <p className="helper">
          {cash >= 0 ? `Cash: ${cash}%, which keeps up with inflation and earns nothing more.` : 'Stocks and bonds add up to more than 100%.'}{' '}
          <Masked>
            {offer ? `${mixBasisText(offer, props.currency)}: ${mixText(offer)}.` : "Nya doesn't look inside funds it doesn't know, so set the mix you hold, or classify them under Allocation."}
          </Masked>
        </p>
        {/* What the mix leaves out, beside the button that fills it in. */}
        {offer && mixLeftOutText(offer, props.currency) && (
          <p className="helper">
            <Masked>{mixLeftOutText(offer, props.currency)}</Masked>
          </p>
        )}
        {(Number(stocks) !== plan.stocksPct || Number(bonds) !== plan.bondsPct) && (
          <p className="helper">Your plan&apos;s simulation uses {mixText({ stocksPct: plan.stocksPct, bondsPct: plan.bondsPct })} until you save.</p>
        )}
        {offer && <p className="helper">The plan keeps this mix until you change it: it doesn&apos;t follow your accounts. Stocks of every region count as stocks.</p>}
        {offer && (offer.stocksPct !== Number(stocks) || offer.bondsPct !== Number(bonds)) && (
          <div className="btn-row">
            <button
              type="button"
              className="btn secondary"
              disabled={s.saving}
              onClick={() => {
                setStocks(String(offer.stocksPct));
                setBonds(String(offer.bondsPct));
              }}
            >
              Fill in my allocation
            </button>
          </div>
        )}
        <label className="field">
          Rebalancing
          <select value={rebalance} onChange={(e) => setRebalance(e.target.value as FirePlan['rebalance'])} disabled={s.saving}>
            <option value="annual">Every year</option>
            <option value="monthly">Every month</option>
            <option value="none">Never (the mix drifts with the markets)</option>
          </select>
        </label>
        <label className="field">
          Fund fees (% a year)
          <input
            type="number"
            inputMode="decimal"
            data-percent
            step="0.01"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            {...s.field('The fee')}
            disabled={s.saving}
          />
        </label>
        {s.under('The fee')}
      </div>
      {s.error && (
        <Notice level="critical" role="alert">
          {s.error}
        </Notice>
      )}
      <Buttons scenario={props.scenario} paused={props.paused} onDone={props.onDone} disabled={s.disabled} saving={s.saving} onSave={() => s.save(build)} />
    </div>
  );
}

export function IncomeForm(props: SaveProps & { item: PlanIncome | null }) {
  const { plan, item } = props;
  const [label, setLabel] = useState(item?.label ?? 'Social Security');
  const [amount, setAmount] = useState(asText(item?.amount ?? null));
  const [fromAge, setFromAge] = useState(asText(item?.fromAge ?? 67));
  const [adjusted, setAdjusted] = useState(item?.inflationAdjusted ?? true);
  const s = useSave(props);
  const build = (): FirePlan => {
    if (!label.trim()) throw new FieldProblem('Give it a name.', ['Name']);
    const entry: PlanIncome = {
      id: item?.id ?? crypto.randomUUID(),
      label: label.trim().slice(0, LIMITS.label),
      amount: readNumber(amount, 'The amount', 0, LIMITS.money) as number,
      fromAge: readNumber(fromAge, 'The starting age', ...LIMITS.eventAge, { integer: true }) as number,
      inflationAdjusted: adjusted,
    };
    return { ...plan, income: item ? plan.income.map((x) => (x.id === item.id ? entry : x)) : [...plan.income, entry] };
  };
  return (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        Income the plan can count on from an age, such as Social Security or a pension, a year and after tax, in
        today&apos;s dollars. It pays part of each year&apos;s spending, so the portfolio withdraws less.
      </p>
      <p className="helper">
        Counts in Will it last?, never in your FI date or FI number. Part-time work is{' '}
        {props.scenario ? "one of this scenario's life events" : 'a life choice in What if…'}, and Barista FI&apos;s
        part-time income is in Assumptions.
      </p>
      <div className="sheet-form">
        <label className="field">
          Name
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={LIMITS.label} {...s.field('Name')} disabled={s.saving} />
        </label>
        {s.under('Name')}
        <label className="field">
          A year, after tax
          <input
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={NO_EXAMPLE}
            {...s.field('The amount')}
            disabled={s.saving}
          />
        </label>
        {s.under('The amount')}
        <label className="field">
          From age
          <input
            type="number"
            inputMode="numeric"
            value={fromAge}
            onChange={(e) => setFromAge(e.target.value)}
            {...s.field('The starting age')}
            disabled={s.saving}
          />
        </label>
        {s.under('The starting age')}
      </div>
      <label className="plan-check">
        <input type="checkbox" checked={adjusted} onChange={(e) => setAdjusted(e.target.checked)} disabled={s.saving} />
        Rises with inflation (Social Security does; many pensions don&apos;t)
      </label>
      {!adjusted && (
        <p className="panel-note">
          Enter what it will pay in today&apos;s dollars. A pension quoted as a future amount is worth less by all the
          inflation until it starts, so scale it down first; from then on the plan takes inflation off it every year.
        </p>
      )}
      {s.error && (
        <Notice level="critical" role="alert">
          {s.error}
        </Notice>
      )}
      <Buttons
        scenario={props.scenario}
        paused={props.paused}
        onDone={props.onDone}
        disabled={s.disabled}
        saving={s.saving}
        onSave={() => s.save(build)}
        extra={
          item && (
            <button className="danger-outline" style={{ marginTop: 12 }} disabled={s.disabled} onClick={() => s.save(() => ({ ...plan, income: plan.income.filter((x) => x.id !== item.id) }))}>
              Remove
            </button>
          )
        }
      />
    </>
  );
}

export function ExpenseForm(props: SaveProps & { item: PlanExpense | null }) {
  const { plan, item } = props;
  const [label, setLabel] = useState(item?.label ?? '');
  const [amount, setAmount] = useState(asText(item?.amount ?? null));
  const [atAge, setAtAge] = useState(asText(item?.atAge ?? null));
  const s = useSave(props);
  const build = (): FirePlan => {
    if (!label.trim()) throw new FieldProblem('Give it a name.', ['Name']);
    const entry: PlanExpense = {
      id: item?.id ?? crypto.randomUUID(),
      label: label.trim().slice(0, LIMITS.label),
      amount: readNumber(amount, 'The amount', 0, LIMITS.money * 10) as number,
      atAge: readNumber(atAge, 'The age', ...LIMITS.eventAge, { integer: true }) as number,
    };
    return { ...plan, expenses: item ? plan.expenses.map((x) => (x.id === item.id ? entry : x)) : [...plan.expenses, entry] };
  };
  return (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        A cost on top of normal spending in one year, such as a roof, a car or a wedding, in today&apos;s dollars and
        after tax.
      </p>
      <p className="helper">
        Counts in Will it last? once that starts, never in your FI date.{' '}
        {props.scenario ? "To move this scenario's FI date with it, add it to its life events." : 'To move your FI date with it, try it in What if… as a life choice.'}
      </p>
      <div className="sheet-form">
        <label className="field">
          Name
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={LIMITS.label}
            placeholder="e.g. New roof"
            {...s.field('Name')}
            disabled={s.saving}
          />
        </label>
        {s.under('Name')}
        <label className="field">
          Amount
          <input
            type="number"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={NO_EXAMPLE}
            {...s.field('The amount')}
            disabled={s.saving}
          />
        </label>
        {s.under('The amount')}
        <label className="field">
          At age
          <input type="number" inputMode="numeric" value={atAge} onChange={(e) => setAtAge(e.target.value)} {...s.field('The age')} disabled={s.saving} />
        </label>
        {s.under('The age')}
      </div>
      {s.error && (
        <Notice level="critical" role="alert">
          {s.error}
        </Notice>
      )}
      <Buttons
        scenario={props.scenario}
        paused={props.paused}
        onDone={props.onDone}
        disabled={s.disabled}
        saving={s.saving}
        onSave={() => s.save(build)}
        extra={
          item && (
            <button className="danger-outline" style={{ marginTop: 12 }} disabled={s.disabled} onClick={() => s.save(() => ({ ...plan, expenses: plan.expenses.filter((x) => x.id !== item.id) }))}>
              Remove
            </button>
          )
        }
      />
    </>
  );
}
