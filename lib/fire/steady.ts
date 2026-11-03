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
//     today's to PLAN_TO_AGE, the edges on them placed at k (one that would
//     come before today, today), and k passes when the walk reaches its
//     target at an age that rounds to k or earlier, as the answer is said
//     (components/plan-text.ts fiHeadline). The first k that passes is the
//     answer; none, and what waits on it isn't placed.
//
// The path itself is the caller's (lib/fire/plan-figures.ts), so this holds
// only the order things are placed in. Imports nothing that touches storage.

import type { ItemAges } from './compile';
import { ONCE_KINDS, type PlanItem, type When } from './items';
import { PLAN_TO_AGE, stopOf } from './plan';

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

type Plan = { items: readonly PlanItem[]; age: number | null; partnerAge: number | null; targetAge: number | null; stopAtFi: boolean };

type Edge = { value: number } | { why: Exclude<Unplaced, 'no-years'> | 'never' };

/** The ages of every edge, given the stop, FI and the balance milestones
 *  fired so far (by node, `${index}:${side}`). */
function place(plan: Plan, stop: number | null, fi: number | null, fired: ReadonlyMap<string, number>): { ages: ItemAges[]; why: (Unplaced | null)[]; onFi: Set<number> } {
  const items = plan.items;
  const index = new Map(items.map((x, i) => [x.id, i]));
  const shift = plan.age !== null && plan.partnerAge !== null ? plan.age - plan.partnerAge : null;
  const today = plan.age;
  const memo = new Map<string, Edge>();
  const fromFi = new Set<string>();
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
        const t = fired.get(node);
        return t === undefined ? { why: 'not-reached' } : { value: t + w.offset };
      }
      case 'item': {
        const j = index.get(a.id);
        if (j === undefined) return { why: 'never' };
        const other = `${j}:${a.edge}`;
        const e = edge(other);
        if (fromFi.has(other)) fromFi.add(node);
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
      e = 'value' in s ? { value: s.value + x.until.years } : s;
    } else e = at(x.until, node, x.owner);
    busy.delete(node);
    memo.set(node, e);
    return e;
  }
  const ages: ItemAges[] = [];
  const why: (Unplaced | null)[] = [];
  const onFi = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    const s = edge(`${i}:start`);
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
  return { ages, why, onFi };
}

const anchoredOn = (plan: Plan, at: 'fi' | 'balance') =>
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
  if (pending.length === 0 || plan.age === null) return placed;
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
  return placed;
}

/** Each item's ages on the steady path, the stop, and FI where it was
 *  searched for. */
export function resolveItems(plan: Plan, world: SteadyWorld): Resolution {
  const fixedStop = stopOf(plan);
  const onFi = anchoredOn(plan, 'fi');
  if (!plan.stopAtFi && !onFi) {
    const r = settle(plan, world, fixedStop, null);
    return { ages: r.ages, why: r.why, stop: fixedStop, fi: null, searched: 'none' };
  }
  const today = plan.age;
  const searched = plan.stopAtFi ? 'stop' : 'fi';
  if (today !== null) {
    for (let k = Math.ceil(today); k <= PLAN_TO_AGE; k++) {
      const stop = plan.stopAtFi ? k : fixedStop;
      const r = settle(plan, world, stop, k);
      // What starts on FI after k comes after FI: left out of the walk that
      // dates it, so a cost after FI can't leave it with no answer.
      const skip = new Set([...r.onFi].filter((i) => (r.ages[i] as { start: number }).start > k));
      const fiAge = world.fiAge(r.ages, stop, { through: plan.stopAtFi ? k : null, skip });
      if (fiAge !== null && Math.round(fiAge) <= k) return { ages: r.ages, why: r.why, stop, fi: k, searched };
    }
  }
  const r = settle(plan, world, fixedStop, null);
  return { ages: r.ages, why: r.why, stop: fixedStop, fi: null, searched };
}
