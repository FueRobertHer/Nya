// lib/fire/steady.ts
//
// Where each of a plan's items falls on the steady path (the tax plan's
// timeline, "Fixed and state anchors", "Finding FI", "Stop when I reach FI"):
// one age for each edge, used by every view, the FI walk, Whole path, the
// simulation and Progress alike.
//
//   - FIXED edges are known before anything runs: an age (yours, or the
//     partner's as yours), the stop while it is an age, an edge on one.
//   - A BALANCE milestone fires on the steady path's balance at the start of a
//     year (the close of the one before), before that year's money in and
//     costs, and stays fired: a cost it starts can't switch it off. Placing
//     one changes nothing before its year, so firing the earliest crossing,
//     then building the path again, is exact.
//   - FI and "stop when I reach FI" are searched for: whole ages k from
//     today's to PLAN_TO_AGE (today's alone past it), the edges on them
//     placed at k (one that would
//     come before today, today), and k passes when the walk reaches its
//     target at an age that rounds to k or earlier, as the answer is said
//     (components/plan-text.ts fiHeadline). The first k that passes is the
//     answer; none, and what waits on it isn't placed.
//
// With D11's start (Will it last? from what you'd have at your stop age), a
// balance milestone not fired by then fires per run instead, and an edge on one
// follows it there (`perRun`, compiled by lib/fire/compile.ts conditionalFlows);
// every other start, and an edge on FI, takes the steady path's year in every run.
//
// The path itself is the caller's (lib/fire/plan-figures.ts), so this holds
// only the order things are placed in. Imports nothing that touches storage.

import type { ItemAges } from './compile';
import { ONCE_KINDS, type PlanItem, type When } from './items';
import { PLAN_TO_AGE, stopOf, type StartChoice } from './plan';

/** Why an item isn't placed, or why it runs no years. */
export type Unplaced = 'not-reached' | 'waits-on-stop' | 'waits-on-fi' | 'no-age' | 'no-years';

export type Resolution = {
  ages: ItemAges[];
  /** Per item: why it isn't placed (or, 'no-years', why it runs none). */
  why: (Unplaced | null)[];
  /** The stop: the age typed, or the search's answer (null: none). */
  stop: number | null;
  /** FI as a search found it, when one ran; null otherwise. */
  fi: number | null;
  /** Which search ran. */
  searched: 'none' | 'fi' | 'stop';
  /** What waits on a run's own balance: only with D11's start, and only when
   *  something does. */
  perRun?: PerRun;
};

/** An edge that waits on a run's own balance: so many years after a trigger. */
export type RunEdge = { trigger: number; offset: number };

/** The balances each run checks, and per item (null: as the steady path has it)
 *  each edge that waits on one, or the age of one that doesn't. */
export type PerRun = {
  triggers: number[];
  edges: ({ start: RunEdge | number; end: RunEdge | number | null } | null)[];
};

/** What the resolution reads of the steady path, built by the caller from the
 *  ages placed so far and a stop. */
export type SteadyWorld = {
  /** Balances at the start of each year from today (index 0 is today's
   *  age), to the plan's end or where it can't go on; null with nothing to
   *  build it from. */
  path(ages: ItemAges[], stop: number | null): number[] | null;
  /** FI's age on the walk with these ages, counting the walk's changes
   *  through the year that starts at `through` (an age) or in full, and
   *  leaving out the items in `skip`; null when it isn't reached or worked
   *  out. */
  fiAge(ages: ItemAges[], stop: number | null, opts: { through: number | null; skip: ReadonlySet<number> }): number | null;
};

type Plan = { items: readonly PlanItem[]; age: number | null; partnerAge: number | null; targetAge: number | null; stopAtFi: boolean; start: StartChoice };

/** An edge on a balance milestone, by so many years. */
type Follows = { node: string; offset: number };
/** Each edge placed, what it follows, and an end's age where it has one. */
type Placed = { ages: ItemAges[]; why: (Unplaced | null)[]; onFi: Set<number>; follows: Map<string, Follows>; ends: (number | null)[] };

type Edge = { value: number } | { why: Exclude<Unplaced, 'no-years'> | 'never' };

/** The ages of every edge, given the stop, FI and the balance milestones
 *  fired so far (by node, `${index}:${side}`). */
function place(plan: Plan, stop: number | null, fi: number | null, fired: ReadonlyMap<string, number>): Placed {
  const items = plan.items;
  const index = new Map(items.map((x, i) => [x.id, i]));
  const shift = plan.age !== null && plan.partnerAge !== null ? plan.age - plan.partnerAge : null;
  const today = plan.age;
  const memo = new Map<string, Edge>();
  const fromFi = new Set<string>();
  const follows = new Map<string, Follows>();
  const busy = new Set<string>();
  const at = (w: When, node: string, owner: PlanItem['owner']): Edge => {
    const a = w.anchor;
    switch (a.at) {
      case 'age':
        if (owner === 'partner') return shift === null ? { why: 'no-age' } : { value: a.age + shift + w.offset };
        return { value: a.age + w.offset };
      case 'stop':
        if (stop === null) return { why: 'waits-on-stop' };
        if (plan.stopAtFi) fromFi.add(node);
        // Under the stop at FI, as for FI: never before today.
        return { value: plan.stopAtFi && today !== null ? Math.max(today, stop + w.offset) : stop + w.offset };
      case 'fi':
        if (fi === null) return { why: 'waits-on-fi' };
        fromFi.add(node);
        return { value: today !== null ? Math.max(today, fi + w.offset) : fi + w.offset };
      case 'balance': {
        follows.set(node, { node, offset: w.offset });
        const t = fired.get(node);
        return t === undefined ? { why: 'not-reached' } : { value: t + w.offset };
      }
      case 'item': {
        const j = index.get(a.id);
        if (j === undefined) return { why: 'never' };
        const other = `${j}:${a.edge}`;
        const e = edge(other);
        if (fromFi.has(other)) fromFi.add(node);
        const on = follows.get(other);
        if (on) follows.set(node, { node: on.node, offset: on.offset + w.offset });
        return 'value' in e ? { value: e.value + w.offset } : e;
      }
    }
  };
  function edge(node: string): Edge {
    const known = memo.get(node);
    if (known) return known;
    if (busy.has(node)) return { why: 'never' };
    busy.add(node);
    const [i, side] = node.split(':');
    const x = items[Number(i)];
    let e: Edge;
    if (side === 'start') e = at(x.from, node, x.owner);
    else if (ONCE_KINDS.includes(x.kind) || x.until === null) e = { why: 'never' };
    else if ('years' in x.until) {
      const s = edge(`${i}:start`);
      if (fromFi.has(`${i}:start`)) fromFi.add(node);
      const on = follows.get(`${i}:start`);
      if (on) follows.set(node, { node: on.node, offset: on.offset + x.until.years });
      e = 'value' in s ? { value: s.value + x.until.years } : s;
    } else e = at(x.until, node, x.owner);
    busy.delete(node);
    memo.set(node, e);
    return e;
  }
  const ages: ItemAges[] = [];
  const why: (Unplaced | null)[] = [];
  const onFi = new Set<number>();
  const ends: (number | null)[] = [];
  for (let i = 0; i < items.length; i++) {
    const s = edge(`${i}:start`);
    const atEnd = edge(`${i}:end`);
    ends.push('value' in atEnd ? atEnd.value : null);
    if (!('value' in s)) {
      ages.push(null);
      why.push(s.why === 'never' ? 'not-reached' : s.why);
      continue;
    }
    if (fromFi.has(`${i}:start`)) onFi.add(i);
    const e = edge(`${i}:end`);
    // An end never reached (a balance it never gets to, or none at all)
    // means it doesn't stop; one before its start, no years at all.
    const end = 'value' in e ? e.value : null;
    if (end !== null && end < s.value) {
      ages.push({ start: s.value, end: s.value });
      why.push('no-years');
    } else {
      ages.push({ start: s.value, end });
      why.push(null);
    }
  }
  return { ages, why, onFi, follows, ends };
}

export const anchoredOn = (plan: Pick<Plan, 'items'>, at: 'fi' | 'balance') =>
  plan.items.some((x) => x.from.anchor.at === at || (x.until !== null && !('years' in x.until) && x.until.anchor.at === at));

/** The balance milestones by node, with what they wait for. */
function milestones(plan: Plan): { node: string; amount: number; offset: number }[] {
  const out: { node: string; amount: number; offset: number }[] = [];
  plan.items.forEach((x, i) => {
    if (x.from.anchor.at === 'balance') out.push({ node: `${i}:start`, amount: x.from.anchor.amount, offset: x.from.offset });
    if (x.until !== null && !('years' in x.until) && x.until.anchor.at === 'balance') out.push({ node: `${i}:end`, amount: x.until.anchor.amount, offset: x.until.offset });
  });
  return out;
}

/** Every edge at a stop and FI, the balance milestones fired one crossing at
 *  a time on the path the ages so far make. */
function settle(plan: Plan, world: SteadyWorld, stop: number | null, fi: number | null) {
  const pending = milestones(plan);
  const fired = new Map<string, number>();
  let placed = place(plan, stop, fi, fired);
  if (pending.length === 0 || plan.age === null) return { ...placed, fired };
  const today = plan.age;
  for (let pass = 0; pass < pending.length; pass++) {
    const balances = world.path(placed.ages, stop);
    if (!balances) break;
    let first: number | null = null;
    for (const m of pending) {
      if (fired.has(m.node)) continue;
      const k = balances.findIndex((b) => b >= m.amount);
      if (k >= 0 && (first === null || k < first)) first = k;
    }
    if (first === null) break;
    // Ties fire together.
    for (const m of pending) {
      if (fired.has(m.node)) continue;
      const k = balances.findIndex((b) => b >= m.amount);
      if (k === first) fired.set(m.node, today + k);
    }
    placed = place(plan, stop, fi, fired);
  }
  return { ...placed, fired };
}

/** With D11's start, the edges that wait on a run's own balance: on a balance
 *  milestone the steady path hasn't fired by the time Will it last? starts. A
 *  run's first balance is the steady path's there, so none of these fires before
 *  its second year. Nothing for any other start. */
function perRunOf(plan: Plan, r: ReturnType<typeof settle>, stop: number | null): Pick<Resolution, 'perRun'> {
  if (plan.start !== 'at-stop' || stop === null || plan.age === null) return {};
  const by = Math.max(stop, plan.age);
  const amounts = new Map(milestones(plan).map((m) => [m.node, m.amount]));
  const triggers: number[] = [];
  const index = new Map<string, number>();
  const waiting = (node: string): RunEdge | null => {
    const on = r.follows.get(node);
    if (!on) return null;
    const t = r.fired.get(on.node);
    if (t !== undefined && t <= by) return null;
    let trigger = index.get(on.node);
    if (trigger === undefined) {
      trigger = triggers.length;
      index.set(on.node, trigger);
      triggers.push(amounts.get(on.node) as number);
    }
    return { trigger, offset: on.offset };
  };
  const edges = plan.items.map((_, i) => {
    const start = waiting(`${i}:start`);
    const end = waiting(`${i}:end`);
    if (!start && !end) return null;
    const placed = r.ages[i];
    if (!start && placed === null) return null;
    return { start: start ?? (placed as { start: number }).start, end: end ?? r.ends[i] };
  });
  return triggers.length > 0 ? { perRun: { triggers, edges } } : {};
}

/** Each item's ages on the steady path, the stop, and FI where it was
 *  searched for. */
export function resolveItems(plan: Plan, world: SteadyWorld): Resolution {
  const fixedStop = stopOf(plan);
  const onFi = anchoredOn(plan, 'fi');
  if (!plan.stopAtFi && !onFi) {
    const r = settle(plan, world, fixedStop, null);
    return { ages: r.ages, why: r.why, stop: fixedStop, fi: null, searched: 'none', ...perRunOf(plan, r, fixedStop) };
  }
  const today = plan.age;
  const searched = plan.stopAtFi ? 'stop' : 'fi';
  if (today !== null) {
    for (let k = Math.ceil(today); k <= Math.max(PLAN_TO_AGE, Math.ceil(today)); k++) {
      const stop = plan.stopAtFi ? k : fixedStop;
      const r = settle(plan, world, stop, k);
      // What starts on FI after k comes after FI: left out of the walk that
      // dates it, so a cost after FI can't leave it with no answer.
      const skip = new Set([...r.onFi].filter((i) => (r.ages[i] as { start: number }).start > k));
      const fiAge = world.fiAge(r.ages, stop, { through: plan.stopAtFi ? k : null, skip });
      if (fiAge !== null && Math.round(fiAge) <= k) return { ages: r.ages, why: r.why, stop, fi: k, searched, ...perRunOf(plan, r, stop) };
    }
  }
  const r = settle(plan, world, fixedStop, null);
  return { ages: r.ages, why: r.why, stop: fixedStop, fi: null, searched, ...perRunOf(plan, r, fixedStop) };
}
