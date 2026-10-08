'use client';

// The Plan tab's forms, each shown in the drawer (components/Sheet.tsx). A
// form holds what is typed as strings (so "4." or "-" survive typing), checks
// each field with a message a person can act on, and saves the WHOLE plan
// through onSave, closing only once the server has it.

import { useState } from 'react';
import { allocationOf, LIMITS, parsePlan, type FirePlan, type PlanExpense, type PlanIncome } from '@/lib/fire/plan';
import { vpwExpectedReturn, type RuleKind } from '@/lib/fire/rules';
import { DATA_BONDS, DATA_STOCKS, METHOD_NAMES, RULE_NAMES, ruleText, pct, wholeMoney } from './plan-text';

type SaveProps = {
  plan: FirePlan;
  /** Resolves true once the server has the plan. */
  onSave: (next: FirePlan) => Promise<boolean>;
  onDone: () => void;
  /** False while the saved plan is loading or unreadable: nothing is saved. */
  editable: boolean;
};

class FieldError extends Error {}

/** A number typed in a field: null when empty, an error when not a number in range. */
function readNumber(text: string, what: string, min: number, max: number, opts: { integer?: boolean; optional?: boolean; scale?: number } = {}): number | null {
  const t = text.trim();
  if (t === '') {
    if (opts.optional) return null;
    throw new FieldError(`${what} is needed.`);
  }
  const n = Number(t);
  const scale = opts.scale ?? 1;
  if (!Number.isFinite(n) || n * scale < min - 1e-12 || n * scale > max + 1e-12) {
    const show = (v: number) => (scale === 1 ? v.toLocaleString() : `${Number((v / scale).toFixed(2))}%`);
    throw new FieldError(`${what} must be from ${show(min)} to ${show(max)}.`);
  }
  if (opts.integer && !Number.isInteger(n)) throw new FieldError(`${what} must be a whole number.`);
  return scale === 1 ? n : Number((n * scale).toFixed(6));
}

const asText = (v: number | null) => (v === null ? '' : String(v));
const pctText = (v: number) => String(Number((v * 100).toFixed(4)));

/** Saves `build()` when it checks out, keeping the message otherwise. */
function useSave({ onSave, onDone, editable }: SaveProps) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function save(build: () => FirePlan) {
    let next: FirePlan;
    try {
      next = build();
    } catch (err) {
      if (err instanceof FieldError) {
        setError(err.message);
        return;
      }
      throw err;
    }
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
    if (ok) onDone();
    else setError('It was not saved. Try again in a moment.');
  }
  return { error, saving, save, disabled: saving || !editable };
}

function Buttons({ onDone, disabled, saving, onSave, extra }: { onDone: () => void; disabled: boolean; saving: boolean; onSave: () => void; extra?: React.ReactNode }) {
  return (
    <>
      {extra}
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

/** Choices in a row, the chosen one marked (the chart range style). */
export function Choice<T extends string>({ value, options, onChange, label, disabled = false }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div className="chart-ranges plan-choice" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className="chart-range" aria-pressed={v === value} disabled={disabled} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** Both ages, refusing a target already passed: it would have Coast FI grow
 *  money backwards and the simulation retire before today. */
function ages(age: number | null, targetAge: number | null): { age: number | null; targetAge: number | null } {
  if (age !== null && targetAge !== null && targetAge < age) {
    throw new FieldError("Your target age can't be before your age. If you've already stopped working, use your age.");
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
        Your age places Social Security, pensions and one-off expenses in the plan. Your target age is when you would like
        to be financially independent; Coast FI counts the years to it.
      </p>
      <div className="sheet-form">
        <label className="field">
          Your age
          <input type="number" inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value)} placeholder="Not set" disabled={s.saving} />
        </label>
        <label className="field">
          Target age
          <input type="number" inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Not set" disabled={s.saving} />
        </label>
      </div>
      {s.error && <div className="error">{s.error}</div>}
      <Buttons
        onDone={props.onDone}
        disabled={s.disabled}
        saving={s.saving}
        onSave={() =>
          s.save(() => ({
            ...plan,
            ...ages(readNumber(age, 'Your age', min, max, { integer: true, optional: true }), readNumber(target, 'Target age', min, max, { integer: true, optional: true })),
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
    note: "Nya adds up a year of money out, leaving out transfers between your own accounts and card payments (they settle purchases already counted). Unlike the Activity tab it counts loan payments, whose principal is spending until the loan ends, and cash withdrawals, and takes refunds off. Type your own if you expect to spend differently once you stop working, after a mortgage ends, say.",
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

type CountedAccount = { account_id: string; name: string; institution: string; balance: number };

export function FigureForm(
  props: SaveProps & {
    kind: FigureKind;
    measured: number | null;
    measuredText: string;
    currency: string | null;
    /** Invested assets with or without cash, so the total follows the box as it is ticked. */
    assetsFor?: (includeCash: boolean) => { total: number | null; accounts: CountedAccount[] };
  }
) {
  const { plan, kind } = props;
  const typedNow = plan[kind];
  const [mode, setMode] = useState<'measured' | 'typed'>(typedNow === null && props.measured !== null ? 'measured' : 'typed');
  const [text, setText] = useState(asText(typedNow ?? (props.measured === null ? null : Math.round(props.measured))));
  const [includeCash, setIncludeCash] = useState(plan.includeCash);
  const s = useSave(props);
  const t = FIGURE_TEXT[kind];
  const live = kind === 'assets' && props.assetsFor ? props.assetsFor(includeCash) : null;
  const measured = live ? live.total : props.measured;
  const measuredText = live ? `from ${live.accounts.length} account${live.accounts.length === 1 ? '' : 's'}` : props.measuredText;
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
        <p className="panel-note">
          {measured === null ? (
            'Nya has nothing to measure this from yet, so the plan leaves it out until you type your own.'
          ) : (
            <>
              <strong>{wholeMoney(measured, props.currency)}</strong> {measuredText}
            </>
          )}
        </p>
      ) : (
        <div className="sheet-form">
          <label className="field">
            {t.field}
            <input type="number" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} disabled={s.saving} />
          </label>
        </div>
      )}
      {kind === 'assets' && (
        <>
          <label className="plan-check">
            <input type="checkbox" checked={includeCash} onChange={(e) => setIncludeCash(e.target.checked)} disabled={s.saving} />
            Count checking and savings accounts too
          </label>
          {live && live.accounts.length > 0 && mode === 'measured' && (
            <ul className="plan-accounts">
              {live.accounts.map((a) => (
                <li key={a.account_id}>
                  <span>
                    {a.name} <span className="plan-muted">· {a.institution}</span>
                  </span>
                  <span className="num">{wholeMoney(a.balance, props.currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {s.error && <div className="error">{s.error}</div>}
      <Buttons
        onDone={props.onDone}
        disabled={s.disabled}
        saving={s.saving}
        onSave={() =>
          s.save(() => ({
            ...plan,
            [kind]: mode === 'measured' ? null : readNumber(text, t.field, range[0], range[1]),
            includeCash: kind === 'assets' ? includeCash : plan.includeCash,
          }))
        }
      />
    </>
  );
}

export function AssumptionsForm(props: SaveProps) {
  const { plan } = props;
  const [rate, setRate] = useState(pctText(plan.withdrawalRate));
  const [ret, setRet] = useState(pctText(plan.realReturn));
  const [tax, setTax] = useState(pctText(plan.taxRate));
  const [partTime, setPartTime] = useState(plan.partTimeIncome ? String(plan.partTimeIncome) : '');
  const s = useSave(props);
  return (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        The withdrawal rate sets the FI number (spending divided by it) and the rate the simulation tests. The real
        return, after inflation, is only for the years until FI. The tax rate is a flat share of every withdrawal.
      </p>
      <div className="sheet-form">
        <label className="field">
          Withdrawal rate (% a year)
          <input type="number" inputMode="decimal" step="0.1" value={rate} onChange={(e) => setRate(e.target.value)} disabled={s.saving} />
        </label>
        <label className="field">
          Real return until FI (% a year, after inflation)
          <input type="number" inputMode="decimal" step="0.5" value={ret} onChange={(e) => setRet(e.target.value)} disabled={s.saving} />
        </label>
        <label className="field">
          Tax on withdrawals (% of each withdrawal)
          <input type="number" inputMode="decimal" step="1" value={tax} onChange={(e) => setTax(e.target.value)} disabled={s.saving} />
        </label>
        <label className="field">
          Part-time income for Barista FI (a year, after tax)
          <input type="number" inputMode="decimal" value={partTime} onChange={(e) => setPartTime(e.target.value)} placeholder="None" disabled={s.saving} />
        </label>
      </div>
      {s.error && <div className="error">{s.error}</div>}
      <Buttons
        onDone={props.onDone}
        disabled={s.disabled}
        saving={s.saving}
        onSave={() =>
          s.save(() => ({
            ...plan,
            withdrawalRate: readNumber(rate, 'The withdrawal rate', ...LIMITS.withdrawalRate, { scale: 0.01 }) as number,
            realReturn: readNumber(ret, 'The real return', ...LIMITS.realReturn, { scale: 0.01 }) as number,
            taxRate: readNumber(tax, 'The tax rate', ...LIMITS.taxRate, { scale: 0.01 }) as number,
            partTimeIncome: readNumber(partTime, 'Part-time income', 0, LIMITS.money, { optional: true }) ?? 0,
          }))
        }
      />
    </>
  );
}

const RULE_ORDER: RuleKind[] = ['constant', 'guardrails', 'floor-ceiling', 'percent', 'vpw'];

/** What a start choice means for the plan: when it retires, and what the first
 *  year withdraws. Starting with the FI number withdraws the plan's rate of it
 *  (your spending, by construction); starting from anything else withdraws
 *  your spending, at whatever rate that is of the balance (lib/fire/plan.ts). */
function startConsequence(
  start: FirePlan['start'],
  plan: FirePlan,
  props: { fiNumber: number | null; assets: number | null; spending: number | null; currency: string | null },
  typed: number
): string {
  const money = (n: number) => wholeMoney(n, props.currency);
  const spend = props.spending !== null ? `your spending of ${money(props.spending)} a year` : 'your spending';
  if (start === 'fi-number') {
    return `Retires at your target age${plan.targetAge !== null ? ` (${plan.targetAge})` : ''} with your FI number, withdrawing ${pct(plan.withdrawalRate)} of it: ${spend}.`;
  }
  const balance = start === 'assets' ? props.assets : Number.isFinite(typed) && typed > 0 ? typed : null;
  const rate = props.spending !== null && balance ? props.spending / (1 - plan.taxRate) / balance : null;
  const when = start === 'assets' ? `today${plan.age !== null ? `, at ${plan.age},` : ''} with what you have now` : `at your target age with the balance you type`;
  return `Retires ${when}, spending ${spend}${rate !== null ? `: a ${pct(rate, 1)} withdrawal rate${rate > plan.withdrawalRate * 1.001 ? `, above the ${pct(plan.withdrawalRate)} your FI number assumes` : ''}` : ''}. Answers whether what you spend now would have lasted.`;
}

export function SimulationForm(props: SaveProps & { fiNumber: number | null; assets: number | null; spending: number | null; currency: string | null }) {
  const { plan } = props;
  const [method, setMethod] = useState(plan.method);
  const [rule, setRule] = useState<RuleKind>(plan.rule);
  const [start, setStart] = useState(plan.start);
  const [balance, setBalance] = useState(asText(plan.startBalance));
  const [horizon, setHorizon] = useState(asText(plan.horizon));
  const [stocks, setStocks] = useState(String(plan.stocksPct));
  const [bonds, setBonds] = useState(String(plan.bondsPct));
  const [rebalance, setRebalance] = useState(plan.rebalance);
  const [fee, setFee] = useState(pctText(plan.fee));
  const [floor, setFloor] = useState(pctText(plan.floor));
  const [ceiling, setCeiling] = useState(pctText(plan.ceiling));
  const s = useSave(props);
  const cash = 100 - (Number(stocks) || 0) - (Number(bonds) || 0);
  const mix = { ...plan, stocksPct: Number(stocks) || 0, bondsPct: Number(bonds) || 0 };
  const expected = cash >= 0 ? vpwExpectedReturn(allocationOf(mix)) : 0;

  function build(): FirePlan {
    const stocksPct = readNumber(stocks, 'Stocks', 0, 100, { integer: true }) as number;
    const bondsPct = readNumber(bonds, 'Bonds', 0, 100, { integer: true }) as number;
    if (stocksPct + bondsPct > 100) throw new FieldError('Stocks and bonds add up to more than 100%.');
    return {
      ...plan,
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
    <>
      <div className="sheet-form" style={{ marginTop: 0 }}>
        <label className="field">
          Method
          <select value={method} onChange={(e) => setMethod(e.target.value as FirePlan['method'])} disabled={s.saving}>
            <option value="historical">{METHOD_NAMES.historical}</option>
            <option value="monte-carlo">{METHOD_NAMES['monte-carlo']}</option>
          </select>
        </label>
        <p className="panel-note" style={{ marginTop: -4, marginBottom: 12 }}>
          {method === 'historical'
            ? 'Starts the plan in every month since 1871 that leaves all of it inside the data, and lives through what followed.'
            : '5,000 runs, each built from 5-year blocks of months drawn at random from the same history: more sequences than history holds, spread wider.'}
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
        <p className="panel-note" style={{ marginTop: -4, marginBottom: 12 }}>
          {ruleText(rule, { rate: plan.withdrawalRate, floor: Number(floor) / 100 || plan.floor, ceiling: Number(ceiling) / 100 || plan.ceiling, expectedReturn: expected })}
          {rule !== 'vpw' && ` The rate (${pct(plan.withdrawalRate)}) is set with the FI assumptions.`}
        </p>
        {rule === 'floor-ceiling' && (
          <div className="plan-pair">
            <label className="field">
              Floor (% of the first year)
              <input type="number" inputMode="decimal" value={floor} onChange={(e) => setFloor(e.target.value)} disabled={s.saving} />
            </label>
            <label className="field">
              Ceiling (% of the first year)
              <input type="number" inputMode="decimal" value={ceiling} onChange={(e) => setCeiling(e.target.value)} disabled={s.saving} />
            </label>
          </div>
        )}
        <label className="field">
          Start with
          <select value={start} onChange={(e) => setStart(e.target.value as FirePlan['start'])} disabled={s.saving}>
            <option value="fi-number">FI number{props.fiNumber !== null ? ` (${wholeMoney(props.fiNumber, props.currency)})` : ''}</option>
            <option value="assets">Invested assets{props.assets !== null ? ` (${wholeMoney(props.assets, props.currency)})` : ''}</option>
            <option value="custom">A balance I type</option>
          </select>
        </label>
        <p className="panel-note" style={{ marginTop: -4, marginBottom: 12 }}>
          {startConsequence(start, plan, props, Number(balance))}
        </p>
        {start === 'custom' && (
          <label className="field">
            Starting balance
            <input type="number" inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} disabled={s.saving} />
          </label>
        )}
        <label className="field">
          Length in years (empty: to age 95, or 30 years without an age)
          <input type="number" inputMode="numeric" value={horizon} onChange={(e) => setHorizon(e.target.value)} placeholder="To age 95" disabled={s.saving} />
        </label>
        <div className="plan-pair">
          <label className="field">
            Stocks %
            <input type="number" inputMode="numeric" value={stocks} onChange={(e) => setStocks(e.target.value)} disabled={s.saving} />
          </label>
          <label className="field">
            Bonds %
            <input type="number" inputMode="numeric" value={bonds} onChange={(e) => setBonds(e.target.value)} disabled={s.saving} />
          </label>
        </div>
        <p className="panel-note" style={{ marginTop: -4, marginBottom: 12 }}>
          {cash >= 0 ? `Cash: ${cash}%, which keeps up with inflation and earns nothing more.` : 'Stocks and bonds add up to more than 100%.'} Stocks are{' '}
          {DATA_STOCKS}, bonds {DATA_BONDS}. Nya doesn&apos;t look inside your funds yet, so set the mix you hold.
        </p>
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
          <input type="number" inputMode="decimal" step="0.01" value={fee} onChange={(e) => setFee(e.target.value)} disabled={s.saving} />
        </label>
      </div>
      {s.error && <div className="error">{s.error}</div>}
      <Buttons onDone={props.onDone} disabled={s.disabled} saving={s.saving} onSave={() => s.save(build)} />
    </>
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
    if (!label.trim()) throw new FieldError('Give it a name.');
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
      <div className="sheet-form">
        <label className="field">
          Name
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={LIMITS.label} disabled={s.saving} />
        </label>
        <label className="field">
          A year, after tax
          <input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={s.saving} />
        </label>
        <label className="field">
          From age
          <input type="number" inputMode="numeric" value={fromAge} onChange={(e) => setFromAge(e.target.value)} disabled={s.saving} />
        </label>
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
      {s.error && <div className="error">{s.error}</div>}
      <Buttons
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
    if (!label.trim()) throw new FieldError('Give it a name.');
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
      <div className="sheet-form">
        <label className="field">
          Name
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={LIMITS.label} placeholder="e.g. New roof" disabled={s.saving} />
        </label>
        <label className="field">
          Amount
          <input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={s.saving} />
        </label>
        <label className="field">
          At age
          <input type="number" inputMode="numeric" value={atAge} onChange={(e) => setAtAge(e.target.value)} disabled={s.saving} />
        </label>
      </div>
      {s.error && <div className="error">{s.error}</div>}
      <Buttons
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
