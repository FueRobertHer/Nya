// lib/fire/plan.ts
//
// The person's plan assumptions, as stored (lib/fire-plan.ts, one encrypted
// value per container) and as the Plan tab edits them, and how they turn into
// the deterministic FI view and an engine plan.
//
// The stored value holds only what the person chose or typed. Anything Nya
// measures (spending, savings, invested assets) is stored only as an
// OVERRIDE: null means "use what Nya measures", so a plan saved in March
// follows the spending of April instead of freezing March's figure.
//
// Two checks, on purpose. parsePlan is what a save must meet: the API route
// runs every PUT through it, and the forms run every edit through it. Every
// field must be present, of its type and in today's range, the rules between
// fields must hold, and nothing else may be there. isFirePlan is what a
// stored plan must be to read back (lib/fire-plan.ts): the same shape and
// types, but none of the ranges or rules, which a later release may change; a
// plan saved under one release must never become unreadable under the next.
// upgradePlan fills in a field added since a plan was saved. Imports no data
// and no storage, so the route and the browser can both use it.

import { baristaFiNumber, coastFiNumber, fiNumber, projectBalance, yearsToTarget } from './fi';
import { vpwExpectedReturn, type RuleKind, type RuleSpec } from './rules';
import { CASH_REAL_RETURN, MAX_YEARS, type Method, type Rebalance, type SimPlan } from './simulate';

export type StartChoice = 'fi-number' | 'assets' | 'custom';

export type PlanIncome = {
  id: string;
  label: string;
  /** A year, after tax, in today's dollars. */
  amount: number;
  fromAge: number;
  /** Social Security keeps up with inflation; many pensions do not. */
  inflationAdjusted: boolean;
};

export type PlanExpense = {
  id: string;
  label: string;
  /** In today's dollars, after tax. */
  amount: number;
  atAge: number;
};

export type FirePlan = {
  version: 1;
  /** Typed by the person. */
  age: number | null;
  targetAge: number | null;
  /** Overrides of what Nya measures; null uses the measurement. */
  spending: number | null;
  savings: number | null;
  assets: number | null;
  /** Count checking and savings balances as invested assets too. */
  includeCash: boolean;
  /** Fractions: 0.04 is 4%. */
  withdrawalRate: number;
  realReturn: number;
  taxRate: number;
  /** Barista FI: part-time income a year, after tax. 0 leaves it out. */
  partTimeIncome: number;
  method: Method;
  rule: RuleKind;
  /** What the simulated retirement starts with. */
  start: StartChoice;
  /** The balance for start 'custom'. */
  startBalance: number | null;
  /** Years; null runs to PLAN_TO_AGE when the starting age is known. */
  horizon: number | null;
  /** Whole percents; cash is the rest. */
  stocksPct: number;
  bondsPct: number;
  rebalance: Rebalance;
  fee: number;
  /** Floor-and-ceiling rule bounds, as multiples of the first year's withdrawal. */
  floor: number;
  ceiling: number;
  income: PlanIncome[];
  expenses: PlanExpense[];
  /** Workplace plans (account ids) the person pays into from a bank account,
   *  with "Paid through payroll" turned off: their contributions are already
   *  counted as saved by income minus spending, so they aren't added again.
   *  Every other workplace plan is taken as paid through payroll. */
  bankFunded: string[];
};

export const DEFAULT_PLAN: FirePlan = {
  version: 1,
  age: null,
  targetAge: null,
  spending: null,
  savings: null,
  assets: null,
  includeCash: false,
  withdrawalRate: 0.04,
  realReturn: 0.05,
  taxRate: 0,
  partTimeIncome: 0,
  method: 'historical',
  rule: 'constant',
  start: 'fi-number',
  startBalance: null,
  horizon: null,
  stocksPct: 75,
  bondsPct: 25,
  rebalance: 'annual',
  fee: 0.001,
  floor: 0.9,
  ceiling: 1.25,
  income: [],
  expenses: [],
  bankFunded: [],
};

/** A plan with no age runs this long. */
export const DEFAULT_YEARS = 30;
/** With an age, a plan runs to this age (within 10 to MAX_YEARS years). */
export const PLAN_TO_AGE = 95;

export const LIMITS = {
  age: [16, 100],
  money: 10_000_000,
  balance: 1_000_000_000,
  withdrawalRate: [0.005, 0.15],
  realReturn: [-0.05, 0.15],
  taxRate: [0, 0.6],
  horizon: [5, MAX_YEARS],
  fee: [0, 0.03],
  floor: [0.5, 1],
  ceiling: [1, 3],
  eventAge: [16, 110],
  incomes: 5,
  expenses: 10,
  label: 60,
  id: 40,
  bankFunded: 20,
} as const;

const METHODS: readonly Method[] = ['historical', 'monte-carlo'];
const RULES: readonly RuleKind[] = ['constant', 'percent', 'guardrails', 'vpw', 'floor-ceiling'];
const STARTS: readonly StartChoice[] = ['fi-number', 'assets', 'custom'];
const REBALANCES: readonly Rebalance[] = ['annual', 'monthly', 'none'];
const KEYS = Object.keys(DEFAULT_PLAN) as (keyof FirePlan)[];

class Invalid extends Error {}

function num(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Invalid(`${field} must be a number from ${min} to ${max}`);
  return v;
}
function int(v: unknown, field: string, min: number, max: number): number {
  const n = num(v, field, min, max);
  if (!Number.isInteger(n)) throw new Invalid(`${field} must be a whole number`);
  return n;
}
function orNull<T>(v: unknown, read: (v: unknown) => T): T | null {
  return v === null ? null : read(v);
}
function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new Invalid(`${field} must be true or false`);
  return v;
}
function oneOf<T extends string>(v: unknown, field: string, options: readonly T[]): T {
  if (typeof v !== 'string' || !(options as readonly string[]).includes(v)) throw new Invalid(`${field} must be one of ${options.join(', ')}`);
  return v as T;
}
function id(v: unknown, field: string): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(v)) throw new Invalid(`${field} must be a short id`);
  return v;
}
function label(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new Invalid(`${field} must be text`);
  const t = v.trim();
  if (!t || t.length > LIMITS.label) throw new Invalid(`${field} must be 1 to ${LIMITS.label} characters`);
  return t;
}
function exactKeys(v: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Invalid(`${field} must be an object`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Invalid(`${field} has an unknown field "${k.slice(0, 40)}"`);
  for (const k of keys) if (!(k in o)) throw new Invalid(`${field} is missing "${k}"`);
  return o;
}

/** A clean copy of a plan, or why it is not one. `input` checks everything a
 *  save must meet; otherwise only the shape and types, as a stored plan is
 *  checked (see the top of this file). */
function readPlan(raw: unknown, input: boolean): { plan: FirePlan } | { error: string } {
  // Ranges and rules between fields apply to input only.
  const n = (v: unknown, field: string, min: number, max: number) => num(v, field, input ? min : -Infinity, input ? max : Infinity);
  const whole = (v: unknown, field: string, min: number, max: number) => int(v, field, input ? min : -Infinity, input ? max : Infinity);
  const text = (v: unknown, field: string) => {
    if (input) return label(v, field);
    if (typeof v !== 'string') throw new Invalid(`${field} must be text`);
    return v;
  };
  const key = (v: unknown, field: string) => {
    if (input) return id(v, field);
    if (typeof v !== 'string') throw new Invalid(`${field} must be an id`);
    return v;
  };
  const list = (v: unknown, field: string, max: number): unknown[] => {
    if (!Array.isArray(v) || (input && v.length > max)) throw new Invalid(`${field} must be a list of at most ${max}`);
    return v;
  };
  try {
    const o = exactKeys(raw, KEYS, 'plan');
    if (o.version !== 1) throw new Invalid('version must be 1');
    const [ageMin, ageMax] = LIMITS.age;
    const stocksPct = whole(o.stocksPct, 'stocksPct', 0, 100);
    const bondsPct = whole(o.bondsPct, 'bondsPct', 0, 100);
    if (input && stocksPct + bondsPct > 100) throw new Invalid('stocksPct and bondsPct add up to more than 100');
    const floor = n(o.floor, 'floor', ...LIMITS.floor);
    const ceiling = n(o.ceiling, 'ceiling', ...LIMITS.ceiling);
    const income = list(o.income, 'income', LIMITS.incomes).map((x, i): PlanIncome => {
      const e = exactKeys(x, ['id', 'label', 'amount', 'fromAge', 'inflationAdjusted'], `income[${i}]`);
      return {
        id: key(e.id, `income[${i}].id`),
        label: text(e.label, `income[${i}].label`),
        amount: n(e.amount, `income[${i}].amount`, 0, LIMITS.money),
        fromAge: whole(e.fromAge, `income[${i}].fromAge`, ...LIMITS.eventAge),
        inflationAdjusted: bool(e.inflationAdjusted, `income[${i}].inflationAdjusted`),
      };
    });
    const expenses = list(o.expenses, 'expenses', LIMITS.expenses).map((x, i): PlanExpense => {
      const e = exactKeys(x, ['id', 'label', 'amount', 'atAge'], `expenses[${i}]`);
      return {
        id: key(e.id, `expenses[${i}].id`),
        label: text(e.label, `expenses[${i}].label`),
        amount: n(e.amount, `expenses[${i}].amount`, 0, LIMITS.money * 10),
        atAge: whole(e.atAge, `expenses[${i}].atAge`, ...LIMITS.eventAge),
      };
    });
    const ids = [...income, ...expenses].map((x) => x.id);
    if (input && new Set(ids).size !== ids.length) throw new Invalid('income and expense ids must be unique');
    // Account ids, as Plaid and manual accounts make them; repeats dropped.
    const bankFunded = [
      ...new Set(
        list(o.bankFunded, 'bankFunded', LIMITS.bankFunded).map((v, i) => {
          if (typeof v !== 'string' || (input && !/^[A-Za-z0-9_.:-]{1,100}$/.test(v))) throw new Invalid(`bankFunded[${i}] must be an account id`);
          return v;
        })
      ),
    ];
    const plan: FirePlan = {
      version: 1,
      age: orNull(o.age, (v) => whole(v, 'age', ageMin, ageMax)),
      targetAge: orNull(o.targetAge, (v) => whole(v, 'targetAge', ageMin, ageMax)),
      spending: orNull(o.spending, (v) => n(v, 'spending', 0, LIMITS.money)),
      savings: orNull(o.savings, (v) => n(v, 'savings', -LIMITS.money, LIMITS.money)),
      assets: orNull(o.assets, (v) => n(v, 'assets', 0, LIMITS.balance)),
      includeCash: bool(o.includeCash, 'includeCash'),
      withdrawalRate: n(o.withdrawalRate, 'withdrawalRate', ...LIMITS.withdrawalRate),
      realReturn: n(o.realReturn, 'realReturn', ...LIMITS.realReturn),
      taxRate: n(o.taxRate, 'taxRate', ...LIMITS.taxRate),
      partTimeIncome: n(o.partTimeIncome, 'partTimeIncome', 0, LIMITS.money),
      method: oneOf(o.method, 'method', METHODS),
      rule: oneOf(o.rule, 'rule', RULES),
      start: oneOf(o.start, 'start', STARTS),
      startBalance: orNull(o.startBalance, (v) => n(v, 'startBalance', 0, LIMITS.balance)),
      horizon: orNull(o.horizon, (v) => whole(v, 'horizon', ...LIMITS.horizon)),
      stocksPct,
      bondsPct,
      rebalance: oneOf(o.rebalance, 'rebalance', REBALANCES),
      fee: n(o.fee, 'fee', ...LIMITS.fee),
      floor,
      ceiling,
      income,
      expenses,
      bankFunded,
    };
    if (input) {
      if (plan.start === 'custom' && plan.startBalance === null) throw new Invalid('a custom start needs startBalance');
      // A target in the past would have Coast FI grow money backwards in time
      // and the simulation retire before today.
      if (plan.age !== null && plan.targetAge !== null && plan.targetAge < plan.age) throw new Invalid('targetAge must not be before age');
    }
    return { plan };
  } catch (err) {
    if (err instanceof Invalid) return { error: err.message };
    throw err;
  }
}

/** A clean copy of a plan to save, or why it can't be saved: every field in
 *  today's range, and the rules between fields. */
export function parsePlan(raw: unknown): { plan: FirePlan } | { error: string } {
  return readPlan(raw, true);
}

/** Whether a value is a plan as stored: the current shape and types (after
 *  upgradePlan), whatever ranges and rules applied when it was saved. A value
 *  this fails is one this code doesn't understand: a later release's, say. */
export function isFirePlan(v: unknown): v is FirePlan {
  return 'plan' in readPlan(v, false);
}

/**
 * A stored plan in the current shape, for the store's reads (lib/fire-plan.ts).
 * Fills in any field the plan was saved without, from DEFAULT_PLAN: a field
 * added since it was saved. Anything else, a later version's plan among them
 * (a release rolled back reading what a newer one saved), is returned as it
 * is, for isFirePlan to reject, so the store reports it as not understood,
 * never as damaged. Never throws.
 *
 * Adding a field: give it a DEFAULT_PLAN value that keeps an older plan
 * meaning what it meant (or fill it in here); a field added to an income or
 * expense item needs its default here too. Changing what a field means bumps
 * the version, and this turns each older version into the current one.
 */
export function upgradePlan(stored: unknown): unknown {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return stored;
  const o = stored as Record<string, unknown>;
  if (o.version !== 1) return stored;
  const missing = KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(o, k));
  if (missing.length === 0) return stored;
  const filled: Record<string, unknown> = { ...o };
  for (const k of missing) filled[k] = structuredClone(DEFAULT_PLAN[k]);
  return filled;
}

/** What Nya measured, for the inputs a plan can override. Null when there is
 *  nothing to measure from (no transactions, no investment accounts). */
export type Measured = {
  spending: number | null;
  savings: number | null;
  assets: number | null;
};

/** Where an input came from, for the label beside it. */
export type Source = 'measured' | 'typed' | 'none';

export type Input = { value: number | null; source: Source };

function input(typed: number | null, measured: number | null): Input {
  if (typed !== null) return { value: typed, source: 'typed' };
  if (measured !== null) return { value: measured, source: 'measured' };
  return { value: null, source: 'none' };
}

export type FiView = {
  spending: Input;
  savings: Input;
  assets: Input;
  /** Null without spending to base it on. */
  fiNumber: number | null;
  /** Invested assets as a share of the FI number. */
  progress: number | null;
  /** Years until the FI number, at the plan's real return: 0 when already
   *  there, Infinity when never, null without the inputs. */
  yearsToFi: number | null;
  /** The age then, when the age is known and it ever happens. */
  fiAge: number | null;
  /** Coast FI, when both ages are known. */
  coast: { number: number; years: number; reached: boolean } | null;
  /** Barista FI, when part-time income is set. */
  barista: { number: number; yearsTo: number | null } | null;
  /** The balance projected at the target age, when both ages are known. */
  atTargetAge: number | null;
};

/** The deterministic FI view of a plan, from what was typed and what Nya measured. */
export function fiView(plan: FirePlan, measured: Measured): FiView {
  const spending = input(plan.spending, measured.spending);
  const savings = input(plan.savings, measured.savings);
  const assets = input(plan.assets, measured.assets);
  const fi = spending.value === null ? null : fiNumber(spending.value, plan.withdrawalRate, plan.taxRate);
  const a = assets.value ?? 0;
  const c = savings.value ?? 0;
  const yearsToFi = fi === null || (assets.value === null && savings.value === null) ? null : yearsToTarget(a, c, plan.realReturn, fi);
  const fiAge = yearsToFi !== null && Number.isFinite(yearsToFi) && plan.age !== null ? plan.age + yearsToFi : null;
  const span = plan.age !== null && plan.targetAge !== null ? plan.targetAge - plan.age : null;
  const coastNumber = fi !== null && span !== null ? coastFiNumber(fi, plan.realReturn, span) : null;
  let barista: FiView['barista'] = null;
  if (plan.partTimeIncome > 0 && spending.value !== null) {
    const number = baristaFiNumber(spending.value, plan.partTimeIncome, plan.withdrawalRate, plan.taxRate);
    barista = { number, yearsTo: assets.value === null && savings.value === null ? null : yearsToTarget(a, c, plan.realReturn, number) };
  }
  return {
    spending,
    savings,
    assets,
    fiNumber: fi,
    progress: fi !== null && fi > 0 && assets.value !== null ? assets.value / fi : null,
    yearsToFi,
    fiAge,
    coast: coastNumber === null || span === null ? null : { number: coastNumber, years: Math.max(0, span), reached: a >= coastNumber },
    barista,
    atTargetAge: span !== null && (assets.value !== null || savings.value !== null) ? projectBalance(a, c, plan.realReturn, Math.max(0, span)) : null,
  };
}

/** The rule as the engine takes it, starting at `rate` (VPW has none). */
export function ruleSpec(plan: FirePlan, rate: number = plan.withdrawalRate): RuleSpec {
  switch (plan.rule) {
    case 'constant':
    case 'percent':
    case 'guardrails':
      return { kind: plan.rule, rate };
    case 'floor-ceiling':
      return { kind: 'floor-ceiling', rate, floor: plan.floor, ceiling: plan.ceiling };
    case 'vpw':
      return { kind: 'vpw', expectedReturn: vpwExpectedReturn(allocationOf(plan)) };
  }
}

export function allocationOf(plan: FirePlan): SimPlan['allocation'] {
  return { stocks: plan.stocksPct / 100, bonds: plan.bondsPct / 100, cash: (100 - plan.stocksPct - plan.bondsPct) / 100 };
}

/** The age the simulated retirement starts at: today's for a start from
 *  today's assets, the target age otherwise (each falls back to the other). */
export function startAge(plan: FirePlan): number | null {
  return plan.start === 'assets' ? plan.age ?? plan.targetAge : plan.targetAge ?? plan.age;
}

/** How long the simulated retirement runs: the plan's own length, or to
 *  PLAN_TO_AGE from the starting age, or DEFAULT_YEARS without an age. */
export function planYears(plan: FirePlan): number {
  if (plan.horizon !== null) return plan.horizon;
  const age = startAge(plan);
  if (age === null) return DEFAULT_YEARS;
  return Math.min(MAX_YEARS, Math.max(10, PLAN_TO_AGE - age));
}

export type EnginePlan = {
  sim: SimPlan;
  startAge: number | null;
  /** The rate the rule starts at, and where it came from: the plan's own
   *  withdrawal rate (starting with the FI number), or your spending as a
   *  share of what you start with (starting from your invested assets or a
   *  typed balance). VPW sets its own share and ignores it. */
  rate: number;
  rateFrom: 'plan' | 'spending';
  /** Income and expenses that could not be placed: no age to place them by,
   *  or an expense dated before the plan starts. */
  left: { income: PlanIncome[]; expenses: PlanExpense[] };
  /** One-off expenses dated after the plan's own end. They are in the engine
   *  plan like any other, so a longer column of the grid counts them (as it
   *  counts income starting that late); the plan itself never reaches them. */
  beyond: PlanExpense[];
};

export type Missing = 'spending' | 'assets' | 'balance';

/**
 * The plan as the engine runs it, or what it needs first.
 *
 * Starting with the FI number, the first year withdraws the plan's rate of
 * it, which is your spending (grossed up for tax) by construction. Starting
 * from what you have now, or a balance you type, the question is whether
 * what you SPEND would have lasted, so the first year withdraws your
 * spending, grossed up for tax, and the rate is what that is of the balance
 * (a 10% rate is said as 10%, not quietly replaced by the plan's 4%).
 */
export function enginePlan(plan: FirePlan, view: FiView): EnginePlan | { missing: Missing } {
  let startBalance: number | null;
  if (plan.start === 'fi-number') startBalance = view.fiNumber;
  else if (plan.start === 'assets') startBalance = view.assets.value;
  else startBalance = plan.startBalance;
  if (startBalance === null) {
    return { missing: plan.start === 'fi-number' ? 'spending' : plan.start === 'assets' ? 'assets' : 'balance' };
  }
  let rate = plan.withdrawalRate;
  let rateFrom: EnginePlan['rateFrom'] = 'plan';
  if (plan.start !== 'fi-number') {
    const spending = view.spending.value;
    if (spending === null) return { missing: 'spending' };
    if (!(startBalance > 0)) return { missing: plan.start === 'assets' ? 'assets' : 'balance' };
    rate = spending / (1 - plan.taxRate) / startBalance;
    rateFrom = 'spending';
  }
  const years = planYears(plan);
  const age = startAge(plan);
  const left: EnginePlan['left'] = { income: [], expenses: [] };
  const beyond: PlanExpense[] = [];
  const income: SimPlan['income'] = [];
  for (const s of plan.income) {
    if (age === null) left.income.push(s);
    else income.push({ amount: s.amount, fromYear: Math.max(0, s.fromAge - age), inflationAdjusted: s.inflationAdjusted });
  }
  const oneOffs: SimPlan['oneOffs'] = [];
  for (const e of plan.expenses) {
    const year = age === null ? -1 : e.atAge - age;
    if (year < 0) {
      left.expenses.push(e);
      continue;
    }
    oneOffs.push({ amount: e.amount, year });
    if (year >= years) beyond.push(e);
  }
  return {
    sim: {
      startBalance,
      years,
      allocation: allocationOf(plan),
      rebalance: plan.rebalance,
      fee: plan.fee,
      taxRate: plan.taxRate,
      rule: ruleSpec(plan, rate),
      income,
      oneOffs,
      cashRealReturn: CASH_REAL_RETURN,
    },
    startAge: age,
    rate,
    rateFrom,
    beyond,
    left,
  };
}
