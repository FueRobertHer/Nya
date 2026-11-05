// lib/fire/plan-v2.ts
//
// FirePlan version 2 (the tax plan's D14): `items` (lib/fire/items.ts) in
// place of version 1's `income` and `expenses`, and `partnerAge`, `stopAtFi`
// ("Stop when I reach FI", beside `targetAge`) and `fiNumber` (your own; null
// is worked out). Every other field is version 1's, with its ranges.
//
// WHAT IS STORED STAYS AS IT WAS. The store (an entry's plan in `fire-plans`,
// lib/plan-copies.ts) reads either version and its upgrade (upgradeStoredPlan)
// never changes one into the other, since the seam checks a value and its
// upgrade alike on every write and downloads the upgraded value. The page
// works on version 2 in memory (planOf, basePlanOf) and sends back the
// version it read (toStored).
//
// Today's names keep version 1's meaning (lib/fire/plan.ts: FirePlan,
// DEFAULT_PLAN, parsePlan, isFirePlan, repairPlan, upgradePlan), so every
// caller keeps what it does unless it opts in here.
//
// Imports no data and no storage: the route and the browser both use it.

import { DEFAULT_PLAN, LIMITS, isFirePlan, readPlan, repairPlan, upgradePlan, type FirePlan, type Repair } from './plan';
import { ITEM_LIMITS, asExpense, asIncome, expensesOf, incomeOf, isPlanItem, itemFromExpense, itemFromIncome, itemRules, parseItem, type PlanItem } from './items';

export type FirePlanV2 = Omit<FirePlan, 'version' | 'income' | 'expenses'> & {
  version: 2;
  /** 25 at most, in the order they were added (sorted by age only where the
   *  Timeline is drawn). */
  items: PlanItem[];
  /** The partner's age today, for items timed by it; null without one. */
  partnerAge: number | null;
  /** "Stop when I reach FI": the stop is searched for (lib/fire/steady.ts),
   *  and `targetAge` is kept for when it goes back to an age. */
  stopAtFi: boolean;
  /** Your own FI number; null works it out from spending. */
  fiNumber: number | null;
};

/** A plan as either version stores it. */
export type StoredPlan = FirePlan | FirePlanV2;

/** Version 1 in memory as version 2: its incomes, then its one-offs, in
 *  stored order (the currency record compares the lists by position), with
 *  no partner, the stop at its age and the FI number worked out. */
export function planOf(stored: StoredPlan): FirePlanV2 {
  if (stored.version === 2) return stored;
  const { version: _version, income, expenses, planFunding, ...rest } = stored;
  return {
    version: 2,
    ...rest,
    items: [...income.map(itemFromIncome), ...expenses.map(itemFromExpense)],
    planFunding,
    partnerAge: null,
    stopAtFi: false,
    fiNumber: null,
  };
}

/** The start a new plan takes behind `plan-tax`, never the default every older
 *  reader's plan rests on (`DEFAULT_PLAN.start`). */
export const NEW_PLAN_START = 'at-stop' as const;

/** What a plan that was never saved is, as version 2. */
export const DEFAULT_PLAN_V2: FirePlanV2 = planOf(DEFAULT_PLAN);

const V2_KEYS = Object.keys(DEFAULT_PLAN_V2) as (keyof FirePlanV2)[];
const SHARED = V2_KEYS.filter((k) => k !== 'version' && k !== 'items' && k !== 'partnerAge' && k !== 'stopAtFi' && k !== 'fiNumber');

/** The plan to send back in the version it was read as: version 2 as it is;
 *  version 1 only when every item is one of its incomes or one-offs, within
 *  its counts, with no partner, the stop at an age and the FI number worked
 *  out. Each list keeps its items' order. */
export function toStored(plan: FirePlanV2, version: 1): { plan: FirePlan } | { error: string };
export function toStored(plan: FirePlanV2, version: 2): { plan: FirePlanV2 };
export function toStored(plan: FirePlanV2, version: 1 | 2): { plan: StoredPlan } | { error: string };
export function toStored(plan: FirePlanV2, version: 1 | 2): { plan: StoredPlan } | { error: string } {
  if (version === 2) return { plan };
  if (plan.items.some((x) => asIncome(x) === null && asExpense(x) === null)) return { error: 'This plan holds items only a newer version of Nya can save.' };
  if (plan.partnerAge !== null || plan.stopAtFi || plan.fiNumber !== null) return { error: 'This plan holds settings only a newer version of Nya can save.' };
  const income = incomeOf(plan);
  const expenses = expensesOf(plan);
  if (income.length > LIMITS.incomes) return { error: `A plan takes ${LIMITS.incomes} incomes at most.` };
  if (expenses.length > LIMITS.expenses) return { error: `A plan takes ${LIMITS.expenses} one-off expenses at most.` };
  const { version: _version, items: _items, partnerAge: _partner, stopAtFi: _stop, fiNumber: _fi, planFunding, ...rest } = plan;
  return { plan: { version: 1, ...rest, income, expenses, planFunding } };
}

/** A clean copy of a version 2 plan, or why it is not one: the fields it
 *  shares with version 1 by version 1's own reader (lib/fire/plan.ts), then
 *  its own. `input` as there. */
function readPlanV2(raw: unknown, input: boolean): { plan: FirePlanV2 } | { error: string; field: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'plan must be an object', field: 'plan' };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(V2_KEYS as string[]).includes(k)) return { error: `plan has an unknown field "${k.slice(0, 40)}"`, field: 'plan' };
  for (const k of V2_KEYS) if (!(k in o)) return { error: `plan is missing "${k}"`, field: 'plan' };
  if (o.version !== 2) return { error: 'version must be 2', field: 'version' };
  if (typeof o.stopAtFi !== 'boolean') return { error: 'stopAtFi must be true or false', field: 'stopAtFi' };
  // Stopping at FI keeps the age typed before, which may since have passed.
  const probe: Record<string, unknown> = { version: 1, income: [], expenses: [] };
  for (const k of SHARED) probe[k] = o[k];
  if (o.stopAtFi) probe.targetAge = null;
  const shared = readPlan(probe, input);
  if ('error' in shared) return shared;
  let targetAge = shared.plan.targetAge;
  if (o.stopAtFi && o.targetAge !== null) {
    const t = o.targetAge;
    const [min, max] = LIMITS.age;
    if (typeof t !== 'number' || !Number.isFinite(t) || (input && !(Number.isInteger(t) && t >= min && t <= max))) return { error: `targetAge must be a whole number from ${min} to ${max}`, field: 'targetAge' };
    targetAge = t;
  }
  const partnerAge = o.partnerAge;
  if (partnerAge !== null) {
    const [min, max] = LIMITS.age;
    if (typeof partnerAge !== 'number' || !Number.isFinite(partnerAge) || (input && !(Number.isInteger(partnerAge) && partnerAge >= min && partnerAge <= max))) {
      return { error: `partnerAge must be a whole number from ${min} to ${max}`, field: 'partnerAge' };
    }
  }
  const fi = o.fiNumber;
  if (fi !== null && (typeof fi !== 'number' || !Number.isFinite(fi) || (input && !(fi > 0 && fi <= LIMITS.balance)))) return { error: `fiNumber must be an amount above 0, up to ${LIMITS.balance}`, field: 'fiNumber' };
  if (!Array.isArray(o.items) || (input && o.items.length > ITEM_LIMITS.items)) return { error: `items must be a list of at most ${ITEM_LIMITS.items}`, field: 'items' };
  const items: PlanItem[] = [];
  for (const [i, x] of o.items.entries()) {
    if (input) {
      const r = parseItem(x, `items[${i}]`);
      if ('error' in r) return { error: r.error, field: `items[${i}]` };
      items.push(r.ok);
    } else {
      if (!isPlanItem(x)) return { error: `items[${i}] is not an item of a plan`, field: `items[${i}]` };
      items.push(x);
    }
  }
  const { version: _version, income: _income, expenses: _expenses, ...rest } = shared.plan;
  const plan: FirePlanV2 = { ...DEFAULT_PLAN_V2, ...rest, targetAge, version: 2, items, partnerAge: partnerAge as number | null, stopAtFi: o.stopAtFi, fiNumber: fi as number | null };
  if (input) {
    const broken = itemRules(plan);
    if (broken) return broken;
  }
  return { plan };
}

/** A version 2 plan to save, or why it can't be saved. */
export function parsePlanV2(raw: unknown): { plan: FirePlanV2 } | { error: string; field: string } {
  return readPlanV2(raw, true);
}

/** Whether a value is a version 2 plan as stored: the shape and types. */
export function isFirePlanV2(v: unknown): v is FirePlanV2 {
  return 'plan' in readPlanV2(v, false);
}

/** Whether a value is a plan either version stores. */
export function isStoredPlan(v: unknown): v is StoredPlan {
  return isFirePlan(v) || isFirePlanV2(v);
}

/** The store's upgrade (lib/fire/copies.ts upgradePlanEntry), by version, never changing it:
 *  version 1's as today (upgradePlan), version 2's missing fields from
 *  DEFAULT_PLAN_V2. Anything else as it is, for the check to refuse. */
export function upgradeStoredPlan(stored: unknown): unknown {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return stored;
  const o = stored as Record<string, unknown>;
  if (o.version !== 2) return upgradePlan(stored);
  const missing = V2_KEYS.filter((k) => !Object.hasOwn(o, k));
  if (missing.length === 0) return o;
  const filled: Record<string, unknown> = { ...o };
  for (const k of missing) filled[k] = structuredClone(DEFAULT_PLAN_V2[k]);
  return filled;
}

/** What a repair of an item says it was: version 1's list for an income or
 *  one-off, so RepairCard's words hold; "items" for the rest. */
function repairOf(x: unknown): Repair {
  const g = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
  const from = g.from as { anchor?: { at?: unknown; age?: unknown } } | undefined;
  const age = from?.anchor?.at === 'age' && typeof from.anchor.age === 'number' ? from.anchor.age : 0;
  const amount = typeof g.yearly === 'number' ? g.yearly : typeof g.once === 'number' ? g.once : 0;
  const field = g.kind === 'other-income' ? 'income' : g.kind === 'one-off' ? 'expenses' : 'items';
  return { field, item: { label: typeof g.label === 'string' ? g.label : '', amount, age } };
}

/** repairPlan for version 2: each value today's checks refuse set to its
 *  default, an item they refuse left out (named, so it can be typed in
 *  again). */
export function repairPlanV2(plan: FirePlanV2): { plan: FirePlanV2; fixed: Repair[] } {
  let p: FirePlanV2 = plan;
  const fixed: Repair[] = [];
  for (let round = 0; round < 96; round++) {
    const r = parsePlanV2(p);
    if ('plan' in r) return { plan: r.plan, fixed };
    const field = r.field;
    const at = /^items\[(\d+)\]/.exec(field);
    if (at) {
      fixed.push(repairOf(p.items[Number(at[1])]));
      p = { ...p, items: p.items.filter((_, i) => i !== Number(at[1])) };
    } else if (field === 'items') {
      fixed.push({ field });
      p = { ...p, items: (Array.isArray(p.items) ? p.items : []).slice(0, ITEM_LIMITS.items) };
    } else if (/^planFunding\[\d+\]/.test(field) || field === 'planFunding') {
      const n = /^planFunding\[(\d+)\]/.exec(field);
      fixed.push({ field: 'planFunding' });
      p = { ...p, planFunding: n ? p.planFunding.filter((_, i) => i !== Number(n[1])) : p.planFunding.slice(0, LIMITS.planFunding) };
    } else if (field === 'allocation') {
      fixed.push({ field });
      p = { ...p, stocksPct: DEFAULT_PLAN_V2.stocksPct, bondsPct: DEFAULT_PLAN_V2.bondsPct };
    } else if ((V2_KEYS as string[]).includes(field) && field !== 'version') {
      fixed.push({ field });
      p = { ...p, [field]: DEFAULT_PLAN_V2[field as keyof FirePlanV2] };
    } else {
      break;
    }
  }
  return { plan: DEFAULT_PLAN_V2, fixed: [{ field: 'plan' }] };
}

/** The plan the Plan tab and Home work from, and what had to change: a
 *  version 1 plan by today's repair (so a value it takes stays as it is),
 *  then in memory as version 2; a version 2 plan by its own; none, the
 *  default. One function, so Home and Your path can't differ. */
export function basePlanOf(stored: StoredPlan | null): { plan: FirePlanV2; fixed: Repair[] } {
  if (stored === null) return { plan: DEFAULT_PLAN_V2, fixed: [] };
  if (stored.version === 2) return repairPlanV2(stored);
  const r = repairPlan(stored);
  return { plan: planOf(r.plan), fixed: r.fixed };
}
