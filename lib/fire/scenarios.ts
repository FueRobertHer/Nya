// lib/fire/scenarios.ts
//
// A Plan scenario: a named set of changes from the person's Plan, never a
// copy of it. Stored on the seam (lib/plan-scenarios.ts, app/api/plan-
// scenarios); shown on the Plan tab beside the Plan, and opened there
// (components/PlanScenarios.tsx).
//
// A scenario holds:
//   - `set`: the Plan's own settings it sets, as absolute values ("retire at
//     50", never "5 years earlier", which would compound unseen with every
//     edit of the Plan). A value set stays set, even when it equals the
//     Plan's at the time; "Use your plan's" unsets it (unsetChange);
//   - for the Plan's other income and one-off expenses: the ids it leaves
//     out, and items it adds in the Plan's own shapes. An added item with the
//     id of a Plan item REPLACES it, in its place; one whose Plan item is gone
//     replaced something the Plan no longer has, so it is left out and said
//     (an orphan), never read as an addition;
//   - its life events (lib/fire/events.ts).
// Everything it doesn't set follows the Plan as it is when it is shown, so a
// correction to the Plan reaches every scenario, and the gap between a
// scenario and the Plan is the scenario's own changes.
//
// WHAT A SCENARIO CAN'T CHANGE (LOCKED): your age, which places everything;
// whether cash counts as invested and how each workplace plan is paid into,
// which are how the figures are MEASURED, the same for every plan; the
// method, so plans compare on one; and the part-time income, which feeds only
// Barista FI. A save that would change one is refused, never dropped.
//
// Two checks, as lib/fire/plan.ts has: parseScenarioDraft is what a save
// must meet (today's ranges, by running the Plan's own parsePlan over the
// values), isPlanScenario is what a stored one must be to read back (shape,
// types and choices only), so a range narrowed later never makes a saved
// scenario unreadable, while a choice a later release adds reads as a later
// version's entry. Resolving runs parsePlan again on the result: a scenario
// the Plan's rules refuse today (it retires at 50, and your age is now 52) is
// not run, and says why.
//
// Imports nothing that touches storage: the route and the browser both use it.

import { knownCurrency } from '../manual-txn-input';
import { DEFAULT_PLAN, LIMITS, asText, isFirePlan, parsePlan, pctText, type FirePlan, type PlanExpense, type PlanIncome } from './plan';
import { EVENT_LIMITS, isLifeEvent, parseLifeEvent, type LifeEvent } from './events';

export type { LifeEvent } from './events';

/** The settings a scenario can set, in the order they are listed. `mix` is
 *  stocksPct and bondsPct together: their rule (at most 100) holds only when
 *  both come from the same place. */
export const SET_FIELDS = [
  'targetAge',
  'spending',
  'savings',
  'assets',
  'withdrawalRate',
  'realReturn',
  'taxRate',
  'rule',
  'floor',
  'ceiling',
  'start',
  'startBalance',
  'horizon',
  'mix',
  'rebalance',
  'fee',
] as const;
export type SetField = (typeof SET_FIELDS)[number];

export type ScenarioSet = {
  /** Never null: a scenario that retires "at no age" means nothing. */
  targetAge?: number;
  /** A typed figure, or null for Nya's measured one, as in the Plan. */
  spending?: number | null;
  savings?: number | null;
  assets?: number | null;
  withdrawalRate?: number;
  realReturn?: number;
  taxRate?: number;
  rule?: FirePlan['rule'];
  floor?: number;
  ceiling?: number;
  start?: FirePlan['start'];
  /** Never null; set whenever `start` is set to 'custom'. */
  startBalance?: number;
  horizon?: number | null;
  mix?: { stocksPct: number; bondsPct: number };
  rebalance?: FirePlan['rebalance'];
  fee?: number;
};

export type ListChanges<T> = { leaveOut: string[]; add: T[] };

/** What a scenario changes, without its name and bookkeeping. */
export type ScenarioChanges = {
  set: ScenarioSet;
  income: ListChanges<PlanIncome>;
  expenses: ListChanges<PlanExpense>;
  events: LifeEvent[];
};

/** What the page sends to save one. */
export type ScenarioDraft = ScenarioChanges & {
  name: string;
  /** The Plan's currency when its amounts were typed (see currencyFor). */
  currency: string | null;
};

/** One as stored. The server sets the last three. */
export type PlanScenario = ScenarioDraft & {
  version: 1;
  /** When it was made: the order scenarios are listed in. */
  createdAt: string;
  /** When it was last saved, for the person. */
  savedAt: string;
  /** Random, new on every save: the version an edit names (PUT based_on). */
  rev: string;
};

export const MAX_PLAN_SCENARIOS = 10;
export const SCENARIO_NAME_MAX = 40;
export const MAX_LEAVE_OUT = 20;

export const NO_CHANGES: ScenarioChanges = { set: {}, income: { leaveOut: [], add: [] }, expenses: { leaveOut: [], add: [] }, events: [] };

const STORED_KEYS = ['version', 'name', 'currency', 'createdAt', 'savedAt', 'rev', 'set', 'income', 'expenses', 'events'];
const DRAFT_KEYS = ['name', 'currency', 'set', 'income', 'expenses', 'events'];
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MONEY_FIELDS = ['spending', 'savings', 'assets', 'startBalance'] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const closed = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/** The Plan's fields a scenario's settings give. */
export function setFields(set: ScenarioSet): Partial<FirePlan> {
  const { mix, ...rest } = set;
  const out: Partial<FirePlan> = { ...rest };
  if (mix) {
    out.stocksPct = mix.stocksPct;
    out.bondsPct = mix.bondsPct;
  }
  return out;
}

function isSet(v: unknown): v is ScenarioSet {
  if (!isObject(v)) return false;
  if (!Object.keys(v).every((k) => (SET_FIELDS as readonly string[]).includes(k))) return false;
  if (Object.hasOwn(v, 'targetAge') && typeof v.targetAge !== 'number') return false;
  if (Object.hasOwn(v, 'startBalance') && typeof v.startBalance !== 'number') return false;
  if (Object.hasOwn(v, 'mix')) {
    const m = v.mix;
    if (!isObject(m) || !closed(m, ['stocksPct', 'bondsPct']) || typeof m.stocksPct !== 'number' || typeof m.bondsPct !== 'number') return false;
  }
  // Types and choices by the Plan's own reader (no ranges).
  return isFirePlan({ ...DEFAULT_PLAN, ...setFields(v as ScenarioSet) });
}

function isLists(v: unknown, income: boolean): boolean {
  if (!isObject(v) || !closed(v, ['leaveOut', 'add'])) return false;
  if (!Array.isArray(v.leaveOut) || !v.leaveOut.every((id) => typeof id === 'string') || !Array.isArray(v.add)) return false;
  return isFirePlan({ ...DEFAULT_PLAN, [income ? 'income' : 'expenses']: v.add });
}

/** Whether a value is a scenario as stored (the store's read check): the
 *  current shape, its types and choices, whatever ranges applied when it was
 *  saved. A choice this code doesn't know (a later release's rule) fails it,
 *  so the store reports the entry as not understood, never as damaged. */
export function isPlanScenario(v: unknown): v is PlanScenario {
  if (!isObject(v) || !closed(v, STORED_KEYS)) return false;
  return (
    v.version === 1 &&
    typeof v.name === 'string' &&
    (v.currency === null || typeof v.currency === 'string') &&
    typeof v.createdAt === 'string' &&
    typeof v.savedAt === 'string' &&
    typeof v.rev === 'string' &&
    isSet(v.set) &&
    isLists(v.income, true) &&
    isLists(v.expenses, false) &&
    Array.isArray(v.events) &&
    v.events.every(isLifeEvent)
  );
}

/** Whether a scenario holds an amount, which is in the Plan's currency: a
 *  typed figure, an added item, or a life event (every kind has one). */
export function hasAmounts(c: ScenarioChanges): boolean {
  return MONEY_FIELDS.some((f) => typeof c.set[f] === 'number') || c.income.add.length > 0 || c.expenses.add.length > 0 || c.events.length > 0;
}

function parseSet(raw: unknown): { ok: ScenarioSet } | { error: string } {
  if (!isObject(raw)) return { error: 'set must be an object' };
  const unknown = Object.keys(raw).find((k) => !(SET_FIELDS as readonly string[]).includes(k));
  if (unknown) return { error: `set.${unknown.slice(0, 40)} isn’t a setting a scenario can change` };
  if (Object.hasOwn(raw, 'targetAge') && typeof raw.targetAge !== 'number') return { error: 'set.targetAge must be an age' };
  if (Object.hasOwn(raw, 'startBalance') && typeof raw.startBalance !== 'number') return { error: 'set.startBalance must be an amount' };
  if (Object.hasOwn(raw, 'mix')) {
    const m = raw.mix;
    if (!isObject(m) || !closed(m, ['stocksPct', 'bondsPct'])) return { error: 'set.mix must hold stocksPct and bondsPct' };
  }
  if (raw.start === 'custom' && !Object.hasOwn(raw, 'startBalance')) return { error: 'set.start custom needs set.startBalance' };
  // The Plan's own ranges and rules, over the defaults.
  const r = parsePlan({ ...DEFAULT_PLAN, ...setFields(raw as ScenarioSet) });
  if ('error' in r) return { error: `set: ${r.error}` };
  const out: ScenarioSet = {};
  for (const k of SET_FIELDS) {
    if (!Object.hasOwn(raw, k)) continue;
    if (k === 'mix') out.mix = { stocksPct: r.plan.stocksPct, bondsPct: r.plan.bondsPct };
    else (out as Record<string, unknown>)[k] = r.plan[k];
  }
  return { ok: out };
}

function parseLeaveOut(raw: unknown, at: string): { ok: string[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length > MAX_LEAVE_OUT) return { error: `${at}.leaveOut must be a list of at most ${MAX_LEAVE_OUT} ids` };
  if (!raw.every((id) => typeof id === 'string' && ID.test(id))) return { error: `${at}.leaveOut must be a list of ids` };
  if (new Set(raw).size !== raw.length) return { error: `${at}.leaveOut names an id twice` };
  return { ok: raw as string[] };
}

/**
 * A scenario as a save sends it, checked field by field, or why it can't be
 * saved: a one-line name of 1 to SCENARIO_NAME_MAX characters, the currency
 * its amounts are in (a known code; refused as null when it has any), the
 * settings it sets in the Plan's ranges, at most MAX_LEAVE_OUT ids left out
 * per list, items added within the Plan's limits (5 incomes, 10 one-offs,
 * ids unique), and at most 10 life events. Nothing else is taken.
 */
export function parseScenarioDraft(raw: unknown): { ok: ScenarioDraft } | { error: string } {
  if (!isObject(raw)) return { error: 'Send the scenario, as JSON' };
  const extra = Object.keys(raw).find((k) => !DRAFT_KEYS.includes(k));
  if (extra) return { error: `${extra.slice(0, 40)} isn’t part of a scenario` };
  const missing = DRAFT_KEYS.find((k) => !Object.hasOwn(raw, k));
  if (missing) return { error: `A scenario needs ${missing}` };
  if (typeof raw.name !== 'string') return { error: 'A scenario needs a name' };
  const name = raw.name.trim();
  if (!name || name.length > SCENARIO_NAME_MAX || CONTROL.test(name)) return { error: `A name is 1 to ${SCENARIO_NAME_MAX} characters, on one line` };
  if (raw.currency !== null && (typeof raw.currency !== 'string' || !knownCurrency(raw.currency))) return { error: 'Enter a currency as its three-letter code, like USD' };
  const set = parseSet(raw.set);
  if ('error' in set) return set;
  const lists: Record<'income' | 'expenses', { leaveOut: string[]; add: unknown[] }> = { income: { leaveOut: [], add: [] }, expenses: { leaveOut: [], add: [] } };
  for (const list of ['income', 'expenses'] as const) {
    const v = raw[list];
    if (!isObject(v) || !closed(v, ['leaveOut', 'add'])) return { error: `${list} must hold leaveOut and add` };
    const left = parseLeaveOut(v.leaveOut, list);
    if ('error' in left) return left;
    if (!Array.isArray(v.add)) return { error: `${list}.add must be a list` };
    lists[list] = { leaveOut: left.ok, add: v.add };
  }
  // Items in the Plan's own shapes and limits, ids unique across both lists.
  const items = parsePlan({ ...DEFAULT_PLAN, income: lists.income.add, expenses: lists.expenses.add });
  if ('error' in items) return { error: `Added items: ${items.error}` };
  if (!Array.isArray(raw.events) || raw.events.length > EVENT_LIMITS.events) return { error: `events must be a list of at most ${EVENT_LIMITS.events}` };
  const events: LifeEvent[] = [];
  for (let i = 0; i < raw.events.length; i++) {
    const e = parseLifeEvent(raw.events[i], `events[${i}]`);
    if ('error' in e) return e;
    if (events.some((x) => x.id === e.ok.id)) return { error: `events[${i}].id is used twice` };
    events.push(e.ok);
  }
  const draft: ScenarioDraft = {
    name,
    currency: raw.currency as string | null,
    set: set.ok,
    income: { leaveOut: lists.income.leaveOut, add: items.plan.income },
    expenses: { leaveOut: lists.expenses.leaveOut, add: items.plan.expenses },
    events,
  };
  // As the runway's: an amount is never kept without the currency it is in.
  if (draft.currency === null && hasAmounts(draft)) return { error: 'A scenario with amounts needs the currency they are in' };
  return { ok: draft };
}

/** Just the changes of a scenario or a draft. */
export function changesOf(s: ScenarioChanges): ScenarioChanges {
  return { set: s.set, income: s.income, expenses: s.expenses, events: s.events };
}

type Item = { id: string };

function applyList<T extends Item>(base: readonly T[], ch: ListChanges<T>): { items: T[]; orphans: T[]; moot: string[] } {
  const adds = new Map(ch.add.map((x) => [x.id, x]));
  const left = new Set(ch.leaveOut);
  const baseIds = new Set(base.map((x) => x.id));
  const items: T[] = [];
  for (const b of base) {
    const replacement = adds.get(b.id);
    if (replacement) items.push(replacement);
    else if (!left.has(b.id)) items.push(b);
  }
  const orphans: T[] = [];
  for (const x of ch.add) {
    if (baseIds.has(x.id)) continue; // placed as a replacement above
    if (left.has(x.id)) orphans.push(x);
    else items.push(x);
  }
  const moot = ch.leaveOut.filter((id) => !baseIds.has(id) && !adds.has(id));
  return { items, orphans, moot };
}

export type Applied = {
  plan: FirePlan;
  /** Replacements of Plan items the Plan no longer has: left out, said. */
  orphans: { income: PlanIncome[]; expenses: PlanExpense[] };
  /** Leave-outs of Plan items that are gone: nothing to leave out. */
  moot: { income: string[]; expenses: string[] };
};

/** The Plan with a scenario's changes, unchecked. */
export function applyScenario(plan: FirePlan, s: ScenarioChanges): Applied {
  const income = applyList(plan.income, s.income);
  const expenses = applyList(plan.expenses, s.expenses);
  return {
    plan: { ...plan, ...setFields(s.set), income: income.items, expenses: expenses.items },
    orphans: { income: income.orphans, expenses: expenses.orphans },
    moot: { income: income.moot, expenses: expenses.moot },
  };
}

/** The Plan with a scenario's changes, as today's rules take it, or the
 *  rule it breaks now (field as parsePlan names it). Not repaired: a
 *  scenario that doesn't fit the Plan any more is shown, not run. */
export function resolveScenario(plan: FirePlan, s: ScenarioChanges): ({ ok: true } & Applied) | { ok: false; error: string; field: string } {
  const applied = applyScenario(plan, s);
  const r = parsePlan(applied.plan);
  if ('error' in r) return { ok: false, error: r.error, field: r.field };
  return { ok: true, ...applied, plan: r.plan };
}

/** The fields a scenario never changes, with what to call them. */
export const LOCKED: readonly { field: keyof FirePlan; name: string }[] = [
  { field: 'age', name: 'Your age' },
  { field: 'includeCash', name: 'Whether checking and savings count as invested' },
  { field: 'planFunding', name: 'How each workplace plan is paid into' },
  { field: 'method', name: 'The simulation method' },
  { field: 'partTimeIncome', name: 'The part-time income for Barista FI' },
];

const PERCENT: ReadonlySet<string> = new Set(['withdrawalRate', 'realReturn', 'taxRate', 'fee', 'floor', 'ceiling']);

/** Whether two values of a field are the same as the Plan's forms hold them
 *  (lib/fire/plan.ts asText, pctText), so a value a form only wrote back,
 *  rounded to its grid, is never taken for a change. */
export function sameAsForms(field: string, a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return PERCENT.has(field) ? pctText(a) === pctText(b) : asText(a) === asText(b);
  if (Array.isArray(a) || Array.isArray(b) || isObject(a) || isObject(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function sameItem(a: PlanIncome | PlanExpense, b: PlanIncome | PlanExpense): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => sameAsForms(k, (a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function recordList<T extends PlanIncome | PlanExpense>(base: readonly T[], current: ListChanges<T>, next: readonly T[]): ListChanges<T> {
  const baseById = new Map(base.map((x) => [x.id, x]));
  const nextIds = new Set(next.map((x) => x.id));
  const leaveOut: string[] = [];
  const add: T[] = [];
  for (const x of next) {
    const b = baseById.get(x.id);
    if (!b) add.push(x);
    else if (!sameItem(b, x)) {
      leaveOut.push(x.id);
      add.push(x);
    }
  }
  for (const b of base) if (!nextIds.has(b.id)) leaveOut.push(b.id);
  // A replacement whose Plan item is gone isn't on screen to be saved again:
  // it is kept until the person removes it. A leave-out of an item that is
  // gone, with nothing replacing it, is dropped: there is nothing to leave out.
  for (const x of current.add) {
    if (!baseById.has(x.id) && current.leaveOut.includes(x.id) && !nextIds.has(x.id)) {
      leaveOut.push(x.id);
      add.push(x);
    }
  }
  return { leaveOut: [...new Set(leaveOut)], add };
}

/**
 * What a form's save means for a scenario that is open: the Plan's forms
 * save a whole plan, `next`, made from the scenario's resolved one; this
 * records what changed in it, as the scenario's own changes, and nothing
 * else. Compared at the forms' precision (sameAsForms). Either share of the
 * mix changing records both; a start becoming a typed balance records the
 * balance too. A change to what a scenario can't hold (LOCKED) refuses the
 * save, in words. Never drops anything without a word.
 */
export function recordSave(base: FirePlan, s: ScenarioChanges, next: FirePlan): { ok: ScenarioChanges } | { error: string } {
  const shown = applyScenario(base, s).plan;
  for (const { field, name } of LOCKED) {
    if (!sameAsForms(field, shown[field], next[field])) return { error: `${name} is the same in every plan: change it with your plan open.` };
  }
  const set: ScenarioSet = { ...s.set };
  const assign = (k: SetField, v: unknown) => ((set as Record<string, unknown>)[k] = v);
  for (const k of SET_FIELDS) {
    if (k === 'mix' || k === 'startBalance') continue;
    if (sameAsForms(k, shown[k], next[k])) continue;
    if (k === 'targetAge' && next.targetAge === null) return { error: 'A scenario keeps a retirement age. To follow your plan’s, choose Use your plan’s beside it.' };
    assign(k, next[k]);
  }
  if (!sameAsForms('stocksPct', shown.stocksPct, next.stocksPct) || !sameAsForms('bondsPct', shown.bondsPct, next.bondsPct)) {
    set.mix = { stocksPct: next.stocksPct, bondsPct: next.bondsPct };
  }
  if (next.startBalance !== null && (!sameAsForms('startBalance', shown.startBalance, next.startBalance) || (set.start === 'custom' && set.startBalance === undefined))) {
    set.startBalance = next.startBalance;
  }
  const income = recordList(base.income, s.income, next.income);
  const expenses = recordList(base.expenses, s.expenses, next.expenses);
  for (const [list, ch, max] of [['income', income, LIMITS.incomes], ['one-offs', expenses, LIMITS.expenses]] as const) {
    if (ch.add.length > max) return { error: `A scenario adds at most ${max} ${list === 'income' ? 'incomes' : 'one-offs'}.` };
    if (ch.leaveOut.length > MAX_LEAVE_OUT) return { error: `A scenario leaves out at most ${MAX_LEAVE_OUT} of your plan’s ${list}.` };
  }
  return { ok: { set, income, expenses, events: s.events } };
}

/** The changes without leave-outs of Plan items the Plan no longer has
 *  (nothing to leave out), unless a replacement still names one: they would
 *  otherwise pile up toward the limit. Every save does this. */
export function pruneMoot(base: FirePlan, s: ScenarioChanges): ScenarioChanges {
  const prune = <T extends Item>(items: readonly Item[], ch: ListChanges<T>): ListChanges<T> => {
    const ids = new Set(items.map((x) => x.id));
    const adds = new Set(ch.add.map((x) => x.id));
    return { leaveOut: ch.leaveOut.filter((id) => ids.has(id) || adds.has(id)), add: ch.add };
  };
  return { ...s, income: prune(base.income, s.income), expenses: prune(base.expenses, s.expenses) };
}

/** The scenario without one of its settings: that one follows the Plan. */
export function unsetChange(s: ScenarioChanges, field: SetField): ScenarioChanges {
  const set = { ...s.set };
  delete set[field];
  return { ...s, set };
}

const LIST_LIMIT = { income: LIMITS.incomes, expenses: LIMITS.expenses } as const;

/** The scenario with one of the Plan's items as the Plan has it again (no
 *  longer left out or replaced), or why not: the list would then be longer
 *  than a plan takes. */
export function restoreItem(base: FirePlan, s: ScenarioChanges, list: 'income' | 'expenses', id: string): { ok: ScenarioChanges } | { error: string } {
  const ch = s[list] as ListChanges<PlanIncome | PlanExpense>;
  const nextList = { leaveOut: ch.leaveOut.filter((x) => x !== id), add: ch.add.filter((x) => x.id !== id) };
  const next = { ...s, [list]: nextList } as ScenarioChanges;
  const count = applyScenario(base, next).plan[list].length;
  if (count > LIST_LIMIT[list]) {
    return { error: `That would give this scenario ${count} ${list === 'income' ? 'incomes' : 'one-offs'}, more than a plan takes (${LIST_LIMIT[list]}): leave one out first.` };
  }
  return { ok: next };
}

/** The scenario without an item it added, or a replacement whose Plan item
 *  is gone (its leave-out goes with it, as there is nothing left to leave
 *  out). */
export function removeAdded(base: FirePlan, s: ScenarioChanges, list: 'income' | 'expenses', id: string): ScenarioChanges {
  const ch = s[list] as ListChanges<PlanIncome | PlanExpense>;
  const inPlan = base[list].some((x) => x.id === id);
  const nextList = { leaveOut: inPlan ? ch.leaveOut : ch.leaveOut.filter((x) => x !== id), add: ch.add.filter((x) => x.id !== id) };
  return { ...s, [list]: nextList } as ScenarioChanges;
}

/** One change of a scenario, for the words that list it. */
export type ScenarioChange =
  | { kind: 'set'; field: SetField }
  | { kind: 'left-out'; list: 'income' | 'expenses'; item: PlanIncome | PlanExpense }
  | { kind: 'replaced'; list: 'income' | 'expenses'; item: PlanIncome | PlanExpense; was: PlanIncome | PlanExpense }
  | { kind: 'added'; list: 'income' | 'expenses'; item: PlanIncome | PlanExpense }
  | { kind: 'orphan'; list: 'income' | 'expenses'; item: PlanIncome | PlanExpense }
  | { kind: 'moot'; list: 'income' | 'expenses'; id: string };

/** Every change a scenario makes to the Plan, in order: its settings, then
 *  each list's items. Life events are listed apart. */
export function scenarioChanges(base: FirePlan, s: ScenarioChanges): ScenarioChange[] {
  const out: ScenarioChange[] = [];
  for (const field of SET_FIELDS) if (Object.hasOwn(s.set, field)) out.push({ kind: 'set', field });
  for (const list of ['income', 'expenses'] as const) {
    const ch = s[list] as ListChanges<PlanIncome | PlanExpense>;
    const baseById = new Map<string, PlanIncome | PlanExpense>(base[list].map((x) => [x.id, x]));
    const adds = new Map(ch.add.map((x) => [x.id, x]));
    for (const id of ch.leaveOut) {
      const b = baseById.get(id);
      if (!b) {
        if (!adds.has(id)) out.push({ kind: 'moot', list, id });
      } else if (!adds.has(id)) out.push({ kind: 'left-out', list, item: b });
    }
    for (const x of ch.add) {
      const b = baseById.get(x.id);
      if (b) out.push({ kind: 'replaced', list, item: x, was: b });
      else if (ch.leaveOut.includes(x.id)) out.push({ kind: 'orphan', list, item: x });
      else out.push({ kind: 'added', list, item: x });
    }
  }
  return out;
}

/** The value a setting has in a plan, as a scenario sets it. */
export function settingOf(plan: FirePlan, field: SetField): unknown {
  return field === 'mix' ? { stocksPct: plan.stocksPct, bondsPct: plan.bondsPct } : plan[field];
}

/** Whether a name is another scenario's already, in any case. */
export function nameTaken(names: readonly { id: string; name: string }[], name: string, exceptId: string | null = null): boolean {
  const n = name.trim().toLowerCase();
  return names.some((s) => s.id !== exceptId && s.name.trim().toLowerCase() === n);
}

/** The currency to save a scenario with: the Plan's now when it holds no
 *  amount, or when this save gives it its first; otherwise the one its
 *  amounts were typed in, which only "They're in" a new one changes, so
 *  nothing is relabelled without a word. */
export function currencyFor(stored: (ScenarioChanges & { currency: string | null }) | null, next: ScenarioChanges, planCurrency: string | null): string | null {
  if (!stored || !hasAmounts(next) || !hasAmounts(stored)) return planCurrency;
  return stored.currency;
}

/** The currency a scenario's amounts were typed in, when it isn't the
 *  Plan's now: then it isn't run. Null on either side (no accounts yet) is
 *  taken as the Plan's, as the runway does. */
export function otherCurrency(s: ScenarioChanges & { currency: string | null }, planCurrency: string | null): string | null {
  return hasAmounts(s) && s.currency !== null && planCurrency !== null && s.currency !== planCurrency ? s.currency : null;
}
