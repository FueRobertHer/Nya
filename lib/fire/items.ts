// lib/fire/items.ts
//
// A plan's items (the tax plan's D14): its income, its one-offs and what a
// scenario's life events were, as one kind of thing, each timed by an anchor
// (an age, the stop, another item's start or end, a balance invested assets
// reach, or FI) and an offset in whole years. FirePlan version 2 holds them
// (lib/fire/plan-v2.ts); version 1's income and one-offs and a scenario's
// life events upgrade to them in memory, keeping their ids and figures.
//
// ONE SHAPE: every item has every field. A field that doesn't apply to its
// kind is null, `owner` null, `beforeTax` false and `inflationAdjusted` true
// (FIELDS, below), so a stored item is checked by one closed shape, as a life
// event is by its kind's keys (lib/fire/events.ts).
//
// Two checks, as for a plan: isPlanItem is what a stored item must be to read
// back (the shape and types), parseItem what a save must meet (ranges per
// kind). One-offs and the three kinds of income take version 1's ranges (an
// amount from 0), so every version 1 plan's items parse; the life event kinds
// take parseLifeEvent's. itemRules holds the rules between items.
//
// What still reads version 1's lists (the simulation's From Your path, a
// copy's diff, the release before's readers) goes through the views here
// (incomeOf, expensesOf, ...), so a plan read as version 1 saves back as
// version 1 (lib/fire/plan-v2.ts toStored) and its currency record, which
// compares the lists position by position, still holds.
//
// Imports no data and no storage: the Plan tab runs this in the browser.

import { LIMITS, stopOf, type PlanExpense, type PlanIncome } from './plan';
import { EVENT_LIMITS, type LifeEvent } from './events';
import { MAX_YEARS } from './simulate';
import type { FirePlanV2 } from './plan-v2';

export type Anchor =
  /** The owner's age: yours, or the partner's for a partner's item. */
  | { at: 'age'; age: number }
  /** The plan's stop (lib/fire/plan.ts stopOf). */
  | { at: 'stop' }
  /** Another item's start or end. */
  | { at: 'item'; id: string; edge: 'start' | 'end' }
  /** Invested assets reach it, in today's dollars, on the steady path. */
  | { at: 'balance'; amount: number }
  /** When you reach FI: the walk's FI, by its search (lib/fire/steady.ts). */
  | { at: 'fi' };

/** Whole years after the anchor; below zero on any anchor but a balance, or
 *  an edge that follows one. */
export type When = { anchor: Anchor; offset: number };

export type ItemKind =
  | 'social-security'
  | 'pension'
  | 'part-time'
  | 'other-income'
  | 'home'
  | 'child'
  | 'car'
  | 'spending'
  | 'loan-end'
  | 'pay'
  | 'windfall'
  | 'one-off';

export const ITEM_KINDS: readonly ItemKind[] = ['social-security', 'pension', 'part-time', 'other-income', 'home', 'child', 'car', 'spending', 'loan-end', 'pay', 'windfall', 'one-off'];

export type PlanItem = {
  id: string;
  label: string;
  /** Sets its direction, its words, where it counts and its tax. */
  kind: ItemKind;
  from: When;
  /** When it stops: an anchor, a number of years, or null for good (ignored
   *  for a kind that happens once). */
  until: When | { years: number } | null;
  /** Paid or received at `from`: a home's price, a car, a windfall, a one-off. */
  once: number | null;
  /** Each year it runs; for `pay` the change in take-home, below zero for
   *  less; for `loan-end` how much less is spent. */
  yearly: number | null;
  /** Part-time work: the take-home it replaces a year, after tax (0: none,
   *  work on the side; null: not said). */
  replaces: number | null;
  /** A repeat: every so many years, so many times in all. */
  every: number | null;
  times: number | null;
  /** Income only; costs are in today's dollars. */
  inflationAdjusted: boolean;
  /** Income and pay: whose (null: yours). */
  owner: 'you' | 'partner' | null;
  /** Income: the amount is before tax. */
  beforeTax: boolean;
};

export const ITEM_LIMITS = {
  items: 25,
  /** Years either side of an anchor. */
  offset: [-60, 90],
  /** A span in years. */
  years: [1, MAX_YEARS],
} as const;

/** Money in, a year. */
export const INCOME_KINDS: readonly ItemKind[] = ['social-security', 'pension', 'part-time', 'other-income'];
/** Kinds that happen at `from` (a repeat aside): they have no end to anchor on. */
export const ONCE_KINDS: readonly ItemKind[] = ['car', 'windfall', 'one-off'];
/** A plan's one-offs and income: what D15 adds to the walk (the flag
 *  'plan-items-in-fi'); no life event upgrades to one of them. */
export const MONEY_KINDS: readonly ItemKind[] = ['one-off', 'other-income', 'social-security', 'pension'];

type Field = 'until' | 'once' | 'yearly' | 'replaces' | 'every' | 'times' | 'inflationAdjusted' | 'owner' | 'beforeTax';

/** The fields each kind takes beyond id, label, kind and from. */
const FIELDS: Record<ItemKind, readonly Field[]> = {
  'social-security': ['until', 'yearly', 'inflationAdjusted', 'owner', 'beforeTax'],
  pension: ['until', 'yearly', 'inflationAdjusted', 'owner', 'beforeTax'],
  'other-income': ['until', 'yearly', 'inflationAdjusted', 'owner', 'beforeTax'],
  'part-time': ['until', 'yearly', 'replaces', 'inflationAdjusted', 'owner', 'beforeTax'],
  home: ['until', 'once', 'yearly'],
  child: ['until', 'yearly'],
  car: ['once', 'every', 'times'],
  spending: ['until', 'yearly'],
  'loan-end': ['yearly'],
  pay: ['until', 'yearly', 'owner'],
  windfall: ['once'],
  'one-off': ['once', 'every', 'times'],
};

const KEYS = ['id', 'label', 'kind', 'from', 'until', 'once', 'yearly', 'replaces', 'every', 'times', 'inflationAdjusted', 'owner', 'beforeTax'] as const;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numberOrNull = (v: unknown) => v === null || finite(v);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

function isAnchor(v: unknown): v is Anchor {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const a = v as Record<string, unknown>;
  switch (a.at) {
    case 'age':
      return exact(a, ['at', 'age']) && finite(a.age);
    case 'stop':
    case 'fi':
      return exact(a, ['at']);
    case 'item':
      return exact(a, ['at', 'id', 'edge']) && typeof a.id === 'string' && (a.edge === 'start' || a.edge === 'end');
    case 'balance':
      return exact(a, ['at', 'amount']) && finite(a.amount);
    default:
      return false;
  }
}

function isWhen(v: unknown): v is When {
  return exact(v, ['anchor', 'offset']) && isAnchor(v.anchor) && finite(v.offset);
}

const isYears = (v: unknown): v is { years: number } => exact(v, ['years']) && finite(v.years);

/** Whether a value is an item as stored: the one shape, of its types,
 *  whatever ranges applied when it was saved. */
export function isPlanItem(v: unknown): v is PlanItem {
  if (!exact(v, KEYS)) return false;
  if (typeof v.id !== 'string' || typeof v.label !== 'string') return false;
  if (typeof v.kind !== 'string' || !(ITEM_KINDS as readonly string[]).includes(v.kind)) return false;
  if (!isWhen(v.from)) return false;
  if (!(v.until === null || isWhen(v.until) || isYears(v.until))) return false;
  if (!['once', 'yearly', 'replaces', 'every', 'times'].every((k) => numberOrNull(v[k]))) return false;
  if (typeof v.inflationAdjusted !== 'boolean' || typeof v.beforeTax !== 'boolean') return false;
  return v.owner === null || v.owner === 'you' || v.owner === 'partner';
}

/** An item as a save sends it, checked against today's ranges, or why it
 *  can't be saved. `at` names it in the error ("items[2]"). */
export function parseItem(raw: unknown, at: string): { ok: PlanItem } | { error: string } {
  if (!isPlanItem(raw)) return { error: `${at} is not an item of a plan` };
  const e = raw;
  if (!ID.test(e.id)) return { error: `${at}.id must be a short id` };
  const label = e.label.trim();
  const legacy = e.kind === 'one-off' || e.kind === 'other-income' || e.kind === 'social-security' || e.kind === 'pension';
  // Version 1's own check for what it held; a life event's for the rest.
  if (!label || label.length > LIMITS.label || (!legacy && CONTROL.test(label))) return { error: `${at} needs a name of 1 to ${LIMITS.label} characters, on one line` };
  const takes = FIELDS[e.kind];
  for (const f of ['until', 'once', 'yearly', 'replaces', 'every', 'times', 'owner'] as const) {
    if (!takes.includes(f) && e[f] !== null) return { error: `${at}: a ${e.kind} item has no ${f}` };
  }
  if (!takes.includes('inflationAdjusted') && !e.inflationAdjusted) return { error: `${at}: only income can lose value with inflation` };
  if (!takes.includes('beforeTax') && e.beforeTax) return { error: `${at}: only income can be before tax` };
  const when = (w: When, what: string): string | null => {
    const [omin, omax] = ITEM_LIMITS.offset;
    if (!Number.isInteger(w.offset) || w.offset < omin || w.offset > omax) return `${at}: ${what} is a whole number of years from ${omin} to ${omax} from its anchor`;
    const a = w.anchor;
    if (a.at === 'age' && !(Number.isInteger(a.age) && a.age >= LIMITS.eventAge[0] && a.age <= LIMITS.eventAge[1])) return `${at}: ${what} is an age from ${LIMITS.eventAge[0]} to ${LIMITS.eventAge[1]}`;
    if (a.at === 'balance') {
      if (!(a.amount > 0 && a.amount <= LIMITS.balance)) return `${at}: ${what} is a balance above 0, up to ${LIMITS.balance}`;
      if (w.offset < 0) return `${at}: ${what} can’t come before a balance is reached`;
    }
    if (a.at === 'item' && !ID.test(a.id)) return `${at}: ${what} names an item by its id`;
    return null;
  };
  const yearly = (min: number, max: number, what: string, zero = true) =>
    e.yearly !== null && e.yearly >= min && e.yearly <= max && (zero || e.yearly !== 0) ? null : `${at}: ${what} is an amount from ${min} to ${max}${zero ? '' : ', not 0'}`;
  const positive = (v: number | null, max: number, what: string) => (v !== null && v > 0 && v <= max ? null : `${at}: ${what} is an amount above 0, up to ${max}`);
  const repeat = () => {
    if (e.every === null) return e.times === null || e.times === 1 ? null : `${at}: something bought once is 1 in all`;
    const [emin, emax] = EVENT_LIMITS.carEvery;
    const [tmin, tmax] = EVENT_LIMITS.carTimes;
    if (!(Number.isInteger(e.every) && e.every >= emin && e.every <= emax)) return `${at}: the time between is a whole number of years from ${emin} to ${emax}`;
    return e.times !== null && Number.isInteger(e.times) && e.times >= tmin && e.times <= tmax ? null : `${at}: a repeat is ${tmin} to ${tmax} in all`;
  };
  let error = when(e.from, 'when it starts');
  if (!error && e.until !== null && takes.includes('until')) {
    if ('years' in e.until) {
      const [ymin, ymax] = ITEM_LIMITS.years;
      if (!(Number.isInteger(e.until.years) && e.until.years >= ymin && e.until.years <= ymax)) error = `${at}: how long it lasts is a whole number of years from ${ymin} to ${ymax}`;
    } else {
      error = when(e.until, 'when it stops');
    }
  }
  if (!error) {
    switch (e.kind) {
      case 'other-income':
      case 'social-security':
      case 'pension':
        error = yearly(0, LIMITS.money, 'the income a year');
        break;
      case 'part-time':
        error =
          positive(e.yearly, EVENT_LIMITS.yearly, 'the income a year') ??
          (e.replaces === null || (e.replaces >= 0 && e.replaces <= LIMITS.money) ? null : `${at}: the take-home it replaces is an amount from 0 to ${LIMITS.money}`) ??
          (e.until === null ? `${at}: part-time work needs when it stops` : null);
        break;
      case 'home':
        error =
          (e.once !== null && e.once >= 0 && e.once <= EVENT_LIMITS.cost ? null : `${at}: what is paid from investments is an amount from 0 to ${EVENT_LIMITS.cost}`) ??
          yearly(-EVENT_LIMITS.yearly, EVENT_LIMITS.yearly, 'the change in yearly spending') ??
          (e.once === 0 && e.yearly === 0 ? `${at}: a home needs what it costs from investments, or a change in yearly spending` : null);
        break;
      case 'child':
        error = positive(e.yearly, EVENT_LIMITS.yearly, 'the extra spending a year') ?? (e.until === null ? `${at}: a child’s costs need how long they last` : null);
        break;
      case 'spending':
        error = yearly(-EVENT_LIMITS.yearly, EVENT_LIMITS.yearly, 'the change a year', false);
        break;
      case 'pay':
        error = yearly(-EVENT_LIMITS.yearly, EVENT_LIMITS.yearly, 'the change in take-home a year', false);
        break;
      case 'loan-end':
        error = positive(e.yearly, EVENT_LIMITS.yearly, 'how much less is spent a year');
        break;
      case 'car':
        error = positive(e.once, EVENT_LIMITS.cost, 'what each car takes from investments') ?? repeat();
        break;
      case 'windfall':
        error = positive(e.once, EVENT_LIMITS.cost, 'the amount');
        break;
      case 'one-off':
        error = (e.once !== null && e.once >= 0 && e.once <= LIMITS.money * 10 ? null : `${at}: the amount is from 0 to ${LIMITS.money * 10}`) ?? repeat();
        break;
    }
  }
  if (error) return { error };
  return { ok: { ...e, label } };
}

const ageWhen = (age: number): When => ({ anchor: { at: 'age', age }, offset: 0 });

/** An item with only its kind's own fields set, the rest as FIELDS says. */
function item(id: string, label: string, kind: ItemKind, from: When, set: Partial<Pick<PlanItem, Field>>): PlanItem {
  return { id, label, kind, from, until: null, once: null, yearly: null, replaces: null, every: null, times: null, inflationAdjusted: true, owner: null, beforeTax: false, ...set };
}

/** Version 1's income: other income after tax, from its age for good. */
export function itemFromIncome(x: PlanIncome): PlanItem {
  return item(x.id, x.label, 'other-income', ageWhen(x.fromAge), { yearly: x.amount, inflationAdjusted: x.inflationAdjusted });
}

/** Version 1's one-off: a one-off at its age. */
export function itemFromExpense(x: PlanExpense): PlanItem {
  return item(x.id, x.label, 'one-off', ageWhen(x.atAge), { once: x.amount });
}

/** A scenario's life event, as an item with the same figures and id, its ages
 *  as age anchors: a raise is pay up for good, a career break pay down by
 *  what it costs in saving for its years, part-time work with what it
 *  replaces not said (so it stays out of the walk, as it was). */
export function itemFromEvent(e: LifeEvent): PlanItem {
  switch (e.kind) {
    case 'house':
      return item(e.id, e.label, 'home', ageWhen(e.atAge), { until: e.years === null ? null : { years: e.years }, once: e.cost, yearly: e.yearly });
    case 'child':
      return item(e.id, e.label, 'child', ageWhen(e.fromAge), { until: { years: e.years }, yearly: e.yearly });
    case 'sabbatical':
      return item(e.id, e.label, 'pay', ageWhen(e.fromAge), { until: { years: e.years }, yearly: -e.savingsLost });
    case 'part-time':
      return item(e.id, e.label, 'part-time', ageWhen(e.fromAge), { until: ageWhen(e.toAge), yearly: e.yearly });
    case 'spending':
      return item(e.id, e.label, 'spending', ageWhen(e.fromAge), { until: e.years === null ? null : { years: e.years }, yearly: e.yearly });
    case 'car':
      return item(e.id, e.label, 'car', ageWhen(e.atAge), { once: e.cost, every: e.every, times: e.times });
    case 'raise':
      return item(e.id, e.label, 'pay', ageWhen(e.fromAge), { yearly: e.yearly });
    case 'windfall':
      return item(e.id, e.label, 'windfall', ageWhen(e.atAge), { once: e.amount });
    case 'loan-end':
      return item(e.id, e.label, 'loan-end', ageWhen(e.atAge), { yearly: e.yearly });
  }
}

const plainAge = (w: When): number | null => (w.anchor.at === 'age' && w.offset === 0 ? w.anchor.age : null);
const plain = (x: PlanItem) => x.owner === null && !x.beforeTax && x.replaces === null && x.every === null && x.times === null;

/** The item as version 1's income, or null unless it is exactly what an
 *  upgrade of one makes. */
export function asIncome(x: PlanItem): PlanIncome | null {
  const fromAge = plainAge(x.from);
  if (x.kind !== 'other-income' || fromAge === null || x.until !== null || x.once !== null || x.yearly === null || !plain(x)) return null;
  return { id: x.id, label: x.label, amount: x.yearly, fromAge, inflationAdjusted: x.inflationAdjusted };
}

/** The item as version 1's one-off, or null unless it is exactly what an
 *  upgrade of one makes. */
export function asExpense(x: PlanItem): PlanExpense | null {
  const atAge = plainAge(x.from);
  if (x.kind !== 'one-off' || atAge === null || x.until !== null || x.yearly !== null || x.once === null || !x.inflationAdjusted || !plain(x)) return null;
  return { id: x.id, label: x.label, amount: x.once, atAge };
}

type Items = Pick<FirePlanV2, 'items'>;

/** The plan's items that are version 1's income, in item order. */
export const incomeOf = (plan: Items): PlanIncome[] => plan.items.map(asIncome).filter((x): x is PlanIncome => x !== null);
/** The plan's items that are version 1's one-offs, in item order. */
export const expensesOf = (plan: Items): PlanExpense[] => plan.items.map(asExpense).filter((x): x is PlanExpense => x !== null);

const yearsOf = (until: PlanItem['until']): number | null | undefined => (until === null ? null : 'years' in until ? until.years : undefined);

/** The item as a life event, or null unless it is exactly what itemFromEvent
 *  makes of one: what a copy's diff and the release before's readers call a
 *  life event. */
export function asEvent(x: PlanItem): LifeEvent | null {
  const age = plainAge(x.from);
  if (age === null || x.owner !== null || x.beforeTax || x.replaces !== null || !x.inflationAdjusted) return null;
  const years = yearsOf(x.until);
  const once = x.every === null && x.times === null;
  const { id, label } = x;
  switch (x.kind) {
    case 'home':
      return once && years !== undefined && x.once !== null && x.yearly !== null ? { id, kind: 'house', label, atAge: age, cost: x.once, yearly: x.yearly, years } : null;
    case 'child':
      return once && typeof years === 'number' && x.once === null && x.yearly !== null ? { id, kind: 'child', label, fromAge: age, yearly: x.yearly, years } : null;
    case 'pay':
      if (!once || x.once !== null || x.yearly === null) return null;
      if (typeof years === 'number' && x.yearly <= 0) return { id, kind: 'sabbatical', label, fromAge: age, years, savingsLost: 0 - x.yearly };
      return years === null ? { id, kind: 'raise', label, fromAge: age, yearly: x.yearly } : null;
    case 'part-time': {
      const toAge = x.until !== null && 'anchor' in x.until ? plainAge(x.until) : null;
      return once && toAge !== null && x.once === null && x.yearly !== null ? { id, kind: 'part-time', label, fromAge: age, toAge, yearly: x.yearly } : null;
    }
    case 'spending':
      return once && years !== undefined && x.once === null && x.yearly !== null ? { id, kind: 'spending', label, fromAge: age, yearly: x.yearly, years } : null;
    case 'car':
      return x.until === null && x.once !== null && x.yearly === null && x.times !== null ? { id, kind: 'car', label, atAge: age, cost: x.once, every: x.every, times: x.times } : null;
    case 'windfall':
      return once && x.until === null && x.once !== null && x.yearly === null ? { id, kind: 'windfall', label, atAge: age, amount: x.once } : null;
    case 'loan-end':
      return once && x.until === null && x.once === null && x.yearly !== null ? { id, kind: 'loan-end', label, atAge: age, yearly: x.yearly } : null;
    default:
      return null;
  }
}

/** The plan with `x` in place of the item with its id, or added at the end
 *  (the Timeline's item sheet). */
export const withItem = <P extends Items>(plan: P, x: PlanItem): P => ({
  ...plan,
  items: plan.items.some((y) => y.id === x.id) ? plan.items.map((y) => (y.id === x.id ? x : y)) : [...plan.items, x],
});

/** The plan without the item with this id. */
export const withoutItem = <P extends Items>(plan: P, id: string): P => ({ ...plan, items: plan.items.filter((y) => y.id !== id) });

/** The ages of the items' edges known before anything runs (an age, yours or
 *  the partner's as yours; the stop while it is an age; an edge anchored on
 *  one of those), by `${index}:start` and `${index}:end`. An end for good, or
 *  of a kind that happens once, is never fixed. */
export function fixedEdges(plan: Pick<FirePlanV2, 'items' | 'age' | 'partnerAge' | 'targetAge' | 'stopAtFi'>): Map<string, number> {
  const index = new Map(plan.items.map((x, i) => [x.id, i]));
  const out = new Map<string, number>();
  const busy = new Set<string>();
  const stop = stopOf(plan);
  const shift = plan.age !== null && plan.partnerAge !== null ? plan.age - plan.partnerAge : null;
  const whenAge = (w: When, owner: PlanItem['owner']): number | null => {
    const a = w.anchor;
    let base: number | null = null;
    if (a.at === 'age') base = owner === 'partner' ? (shift === null ? null : a.age + shift) : a.age;
    else if (a.at === 'stop') base = stop;
    else if (a.at === 'item') {
      const j = index.get(a.id);
      base = j === undefined ? null : edge(`${j}:${a.edge}`);
    }
    return base === null ? null : base + w.offset;
  };
  function edge(node: string): number | null {
    if (out.has(node)) return out.get(node) as number;
    if (busy.has(node)) return null; // a loop: itemRules refuses it
    busy.add(node);
    const [i, side] = node.split(':');
    const x = plan.items[Number(i)];
    let v: number | null = null;
    if (side === 'start') v = whenAge(x.from, x.owner);
    else if (!ONCE_KINDS.includes(x.kind) && x.until !== null) {
      if ('years' in x.until) {
        const s = edge(`${i}:start`);
        v = s === null ? null : s + x.until.years;
      } else v = whenAge(x.until, x.owner);
    }
    busy.delete(node);
    if (v !== null) out.set(node, v);
    return v;
  }
  plan.items.forEach((_, i) => {
    edge(`${i}:start`);
    edge(`${i}:end`);
  });
  return out;
}

/** The rules between a plan's items (the item sheet's refusals), or the first
 *  one broken, naming its item ("items[2]"): never the list, since a repair
 *  resets a field it is named by. */
export function itemRules(plan: Pick<FirePlanV2, 'items' | 'age' | 'partnerAge' | 'targetAge' | 'stopAtFi'>): { error: string; field: string } | null {
  const items = plan.items;
  const index = new Map<string, number>();
  for (const [i, x] of items.entries()) {
    if (index.has(x.id)) return { field: `items[${i}]`, error: 'item ids must be unique' };
    index.set(x.id, i);
  }
  const anchors = (x: PlanItem): When[] => (x.until !== null && !('years' in x.until) && !ONCE_KINDS.includes(x.kind) ? [x.from, x.until] : [x.from]);
  for (const [i, x] of items.entries()) {
    for (const w of anchors(x)) {
      const a = w.anchor;
      if (a.at === 'age' && x.owner === 'partner' && plan.partnerAge === null) return { field: `items[${i}]`, error: `items[${i}] is timed by your partner’s age, which isn’t set` };
      if (a.at !== 'item') continue;
      const j = index.get(a.id);
      if (j === undefined) return { field: `items[${i}]`, error: `items[${i}] is timed by an item the plan doesn’t have` };
      const y = items[j];
      if (a.edge === 'end' && (ONCE_KINDS.includes(y.kind) || y.until === null)) return { field: `items[${i}]`, error: `items[${i}] is timed by the end of items[${j}], which has none` };
    }
  }
  // The graph's nodes are edges (each item's start and end), so "until B
  // starts; B starts 2 years after it starts" is allowed and "A starts when
  // B ends; B ends when A starts" isn't.
  const after = (node: string): string[] => {
    const [i, side] = node.split(':');
    const x = items[Number(i)];
    if (side === 'end') {
      if (ONCE_KINDS.includes(x.kind) || x.until === null) return [];
      if ('years' in x.until) return [`${i}:start`];
    }
    const w = side === 'start' ? x.from : (x.until as When);
    return w.anchor.at === 'item' ? [`${index.get(w.anchor.id)}:${w.anchor.edge}`] : [];
  };
  const state = new Map<string, 'busy' | 'done'>();
  const visit = (node: string, trail: string[]): string[] | null => {
    if (state.get(node) === 'done') return null;
    if (state.get(node) === 'busy') return trail.slice(trail.indexOf(node));
    state.set(node, 'busy');
    for (const next of after(node)) {
      const loop = visit(next, [...trail, node]);
      if (loop) return loop;
    }
    state.set(node, 'done');
    return null;
  };
  for (let i = 0; i < items.length; i++) {
    for (const side of ['start', 'end']) {
      const loop = visit(`${i}:${side}`, []);
      if (loop) {
        const named = [...new Set(loop.map((n) => Number(n.split(':')[0])))];
        const others = named.filter((j) => j !== named[0]);
        return { field: `items[${named[0]}]`, error: others.length > 0 ? `items[${named[0]}] and items[${others[0]}] wait on each other` : `items[${named[0]}] waits on itself` };
      }
    }
  }
  // Nothing reacts to the future: no edge before a balance is reached.
  const onBalance = (node: string, seen = new Set<string>()): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    const [i, side] = node.split(':');
    const x = items[Number(i)];
    const w = side === 'start' ? x.from : x.until !== null && !('years' in x.until) ? x.until : null;
    if (side === 'end' && x.until !== null && 'years' in x.until) return onBalance(`${i}:start`, seen);
    if (!w) return false;
    if (w.anchor.at === 'balance') return true;
    return w.anchor.at === 'item' && onBalance(`${index.get(w.anchor.id)}:${w.anchor.edge}`, seen);
  };
  for (const [i, x] of items.entries()) {
    for (const w of anchors(x)) {
      if (w.offset < 0 && w.anchor.at === 'item' && onBalance(`${index.get(w.anchor.id)}:${w.anchor.edge}`)) {
        return { field: `items[${i}]`, error: `items[${i}] can’t come before what follows a balance being reached` };
      }
    }
  }
  const fixed = fixedEdges(plan);
  for (let i = 0; i < items.length; i++) {
    const s = fixed.get(`${i}:start`);
    const e = fixed.get(`${i}:end`);
    if (s !== undefined && e !== undefined && e <= s) return { field: `items[${i}]`, error: `items[${i}] stops before it starts` };
  }
  // Two part-time jobs for one person can't overlap (refused where both are
  // fixed; the sheet says so otherwise).
  for (let i = 0; i < items.length; i++) {
    for (let j = 0; j < i; j++) {
      const [x, y] = [items[i], items[j]];
      if (x.kind !== 'part-time' || y.kind !== 'part-time' || (x.owner === 'partner') !== (y.owner === 'partner')) continue;
      const [xs, xe, ys, ye] = [fixed.get(`${i}:start`), fixed.get(`${i}:end`), fixed.get(`${j}:start`), fixed.get(`${j}:end`)];
      if (xs === undefined || xe === undefined || ys === undefined || ye === undefined) continue;
      if (xs < ye && ys < xe) return { field: `items[${i}]`, error: `items[${i}] and items[${j}] are part-time work for one person at the same time` };
    }
  }
  return null;
}
