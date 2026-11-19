// lib/fire/steady.ts
//
// Where each of a plan's items falls on the steady path (the tax plan's
// timeline, "Fixed and state anchors", "Finding FI", "Stop when I reach FI"):
// one age for each edge, used by every view, the FI walk, Whole path, the
// simulation and Progress alike.
//
//   - FIXED edges are known before anything runs: an age (yours, or the
//     partner's as yours), the stop while it is an age, an edge on one.
//   - A BALANCE anchor fires on the steady path's balance at the start of a
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
//   - With D9 (a plan's `lastsIn`), FI is the earliest stop that lasts, found by
//     simulation (lib/fire/earliest.ts), and placed here as given (resolveAt):
//     the edges on FI at it, and under the stop at FI the stop too.
//   - A MILESTONE (an item with no money) on a balance fires as any balance
//     anchor does. One that nothing is timed on moves nothing, so the passes
//     and the searches leave it out (D9's candidates too: withoutIdle), and
//     one path at the answer places it: that path is the same up to its
//     crossing whenever it fired.
//   - A milestone on a SHARE of the FI number, or at COAST FI, is checked year
//     by year in order: in year y it is reached when the balance at the start of
//     y reaches its threshold, worked out from the FI number of the plan as it
//     stands then (everything placed by what fired before y, nothing that waits
//     on what hasn't). So each pass searches them only from the year after the
//     last one something with an item on it fired in: a later pass never fires
//     one in a year whose threshold already counted that year's followers.
//     Coast FI's threshold is what grows to the FI number by the stop at the
//     plan's growth (lib/fire/fi.ts coastFiNumber), checked only until the stop.
//     One that nothing is timed on rides the passes while anything is
//     pending, since what they place moves its threshold, and costs no path of
//     its own; once nothing is pending the number never moves again, and one
//     path at the answer places what is left, from the year after the last that
//     moved a figure, as it places a balance.
//
// With D11's start (the stress test from what you'd have at your stop age), a
// balance anchor not fired by then fires per run instead (a share at its
// threshold, as reached or as the FI number last stood; Coast FI never, since
// runs start at the stop), and an edge on one follows it there (`perRun`,
// compiled by lib/fire/compile.ts conditionalFlows);
// every other start, and an edge on FI, takes the steady path's year in every run.
//
// The path itself is the caller's (lib/fire/plan-figures.ts), so this holds
// only the order things are placed in. Imports nothing that touches storage.

import type { ItemAges } from './compile';
import { coastFiNumber } from './fi';
import { ONCE_KINDS, onPath, type Anchor, type PlanItem, type When } from './items';
import { PLAN_TO_AGE, stopOf, type StartChoice } from './plan';

/** Why an item isn't placed, or why it runs no years ('no-fi-number': a share
 *  of the FI number, or Coast FI, with no FI number worked out). */
export type Unplaced = 'not-reached' | 'waits-on-stop' | 'waits-on-fi' | 'no-fi-number' | 'no-age' | 'no-years';

export type Resolution = {
  ages: ItemAges[];
  /** Per item: why it isn't placed (or, 'no-years', why it runs none). */
  why: (Unplaced | null)[];
  /** The stop: the age typed, or the search's answer (null: none). */
  stop: number | null;
  /** FI as a search found it, when one ran; null otherwise. */
  fi: number | null;
  /** Which search ran: 'lasts', FI given as the earliest stop that lasts (D9). */
  searched: 'none' | 'fi' | 'stop' | 'lasts';
  /** What waits on a run's own balance: only with D11's start, and only when
   *  something does. */
  perRun?: PerRun;
  /** Per item: the threshold a share or Coast FI milestone was reached at, in
   *  today's dollars; there only when one was. */
  reachedAt?: (number | null)[];
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
   *  age), to the plan's end or where it can't go on, with the FI number the
   *  same build works out (null: none) and the growth its Coast FI compounds
   *  at (lib/fire/plan.ts fiView); null with nothing to build it from. */
  path(ages: ItemAges[], stop: number | null): SteadyPath | null;
  /** FI's age on the walk with these ages, counting the walk's changes
   *  through the year that starts at `through` (an age) or in full, and
   *  leaving out the items in `skip`; null when it isn't reached or worked
   *  out. */
  fiAge(ages: ItemAges[], stop: number | null, opts: { through: number | null; skip: ReadonlySet<number> }): number | null;
};

export type SteadyPath = { balances: number[]; fiNumber: number | null; growth: number };

type Plan = { items: readonly PlanItem[]; age: number | null; partnerAge: number | null; targetAge: number | null; stopAtFi: boolean; start: StartChoice };

/** An edge on a balance anchor, by so many years. */
type Follows = { node: string; offset: number };
/** Each edge placed, what it follows, and an end's age where it has one. */
type Placed = { ages: ItemAges[]; why: (Unplaced | null)[]; onFi: Set<number>; follows: Map<string, Follows>; ends: (number | null)[] };

type Edge = { value: number } | { why: Exclude<Unplaced, 'no-years'> | 'never' };

/** The ages of every edge, given the stop, FI and the balance anchors
 *  fired so far (by node, `${index}:${side}`); `held`, why one that can't be
 *  checked isn't. */
function place(plan: Plan, stop: number | null, fi: number | null, fired: ReadonlyMap<string, number>, held: ReadonlyMap<string, Unplaced> = new Map()): Placed {
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
      case 'balance':
      case 'share':
      case 'coast': {
        follows.set(node, { node, offset: w.offset });
        const t = fired.get(node);
        return t === undefined ? { why: (held.get(node) as Exclude<Unplaced, 'no-years'> | undefined) ?? 'not-reached' } : { value: t + w.offset };
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

type OnPath = Extract<Anchor, { at: 'balance' | 'share' | 'coast' }>;
/** An edge on the steady path's balance, by node, and what it waits for. */
type Watch = { node: string; on: OnPath };

/** The edges that wait on the steady path's balance: an amount, a share of the
 *  FI number or Coast FI. */
function watches(plan: Plan): Watch[] {
  const out: Watch[] = [];
  plan.items.forEach((x, i) => {
    if (onPath(x.from.anchor)) out.push({ node: `${i}:start`, on: x.from.anchor });
    if (x.until !== null && !('years' in x.until) && onPath(x.until.anchor)) out.push({ node: `${i}:end`, on: x.until.anchor });
  });
  return out;
}

/** The start of each milestone on the steady path's balance (an amount, a
 *  share or Coast FI) that nothing is timed on, by node. */
function unwatched(plan: Plan): Set<string> {
  const timed = new Set<string>();
  for (const x of plan.items) {
    for (const w of x.until !== null && !('years' in x.until) ? [x.from, x.until] : [x.from]) if (w.anchor.at === 'item') timed.add(w.anchor.id);
  }
  const out = new Set<string>();
  plan.items.forEach((x, i) => {
    if (x.kind === 'milestone' && onPath(x.from.anchor) && !timed.has(x.id)) out.add(`${i}:start`);
  });
  return out;
}

/** The plan's items without the milestones on the steady path's balance that
 *  nothing is timed on: what D9's search runs each candidate with
 *  (lib/fire/earliest.ts), since they move no run, so no candidate builds a
 *  path to place one. */
export function withoutIdle(plan: Plan): PlanItem[] {
  const idle = unwatched(plan);
  return plan.items.filter((_, i) => !idle.has(`${i}:start`));
}

/** Where what one waits for first comes on this path, with the threshold it
 *  crossed (a share or Coast FI, at index `from` or later; an amount from the
 *  start, exact as it is); or why it can't be checked. */
function crossing(on: OnPath, w: SteadyPath, from: number, today: number, stop: number | null): { k: number; at: number | null } | { why: Unplaced } | null {
  const b = w.balances;
  if (on.at === 'balance') {
    const k = b.findIndex((x) => x >= on.amount);
    return k >= 0 ? { k, at: null } : null;
  }
  if (w.fiNumber === null) return { why: 'no-fi-number' };
  if (on.at === 'share') {
    const at = (on.percent / 100) * w.fiNumber;
    for (let k = Math.max(0, from); k < b.length; k++) if (b[k] >= at) return { k, at };
    return null;
  }
  if (stop === null) return { why: 'waits-on-stop' };
  for (let k = Math.max(0, from); k < b.length && today + k <= stop; k++) {
    const at = coastFiNumber(w.fiNumber, w.growth, stop - (today + k));
    if (b[k] >= at) return { k, at };
  }
  return null;
}

type Settled = Placed & {
  fired: Map<string, number>;
  /** The threshold each share or Coast FI fired at, by node. */
  reached: Map<string, number>;
  held: Map<string, Unplaced>;
  /** The FI number on the last path built, for a share left to the runs. */
  fiNumber: number | null;
  /** The last year something with an item on it fired in (-1 for none): a
   *  share or Coast FI left to finish is searched from the year after. */
  after: number;
};

/** Every edge at a stop and FI, what waits on the steady path's balance
 *  fired one crossing at a time on the path the ages so far make; a milestone
 *  on a balance nothing is timed on only with `final`, from one path at the
 *  end, and a share or Coast FI nothing is timed on there too when nothing
 *  else waits. */
function settle(plan: Plan, world: SteadyWorld, stop: number | null, fi: number | null, final: boolean): Settled {
  const idle = unwatched(plan);
  const all = watches(plan);
  const pending = all.filter((m) => !idle.has(m.node));
  const fired = new Map<string, number>();
  const reached = new Map<string, number>();
  // Coast FI with no stop waits on one, path or none.
  const waits = new Map<string, Unplaced>(stop === null ? all.filter((m) => m.on.at === 'coast').map((m) => [m.node, 'waits-on-stop']) : []);
  const held = new Map(waits);
  let placed = place(plan, stop, fi, fired, held);
  const empty: Settled = { ...placed, fired, reached, held, fiNumber: null, after: -1 };
  if (pending.length === 0 || plan.age === null) return final ? finish(plan, world, empty, stop, fi) : empty;
  const today = plan.age;
  // A share or Coast FI nothing is timed on reads the FI number as the passes
  // leave it, so it rides them; firing one moves nothing, so its path is kept.
  const watching = [...pending, ...all.filter((m) => idle.has(m.node) && m.on.at !== 'balance')];
  let path = world.path(placed.ages, stop);
  let fiNumber: number | null = path?.fiNumber ?? null;
  // The last year something with an item on it fired in.
  let after = -1;
  while (path) {
    const hits = new Map<string, { k: number; at: number | null }>();
    held.clear();
    for (const [node, why] of waits) held.set(node, why);
    let first: number | null = null;
    for (const m of watching) {
      if (fired.has(m.node)) continue;
      const c = crossing(m.on, path, after + 1, today, stop);
      if (c === null) continue;
      if ('why' in c) {
        held.set(m.node, c.why);
        continue;
      }
      hits.set(m.node, c);
      if (first === null || c.k < first) first = c.k;
    }
    if (first === null) break;
    // Ties fire together.
    let moved = false;
    for (const [node, c] of hits) {
      if (c.k !== first) continue;
      fired.set(node, today + c.k);
      if (c.at !== null) reached.set(node, c.at);
      if (!idle.has(node)) moved = true;
    }
    if (!moved) continue;
    after = Math.max(after, first);
    // With nothing left that has an item on it, nothing moves again: what
    // still rides is placed from one path at the answer (finish).
    if (pending.every((m) => fired.has(m.node))) break;
    placed = place(plan, stop, fi, fired, held);
    path = world.path(placed.ages, stop);
    if (path) fiNumber = path.fiNumber;
  }
  placed = place(plan, stop, fi, fired, held);
  const r: Settled = { ...placed, fired, reached, held, fiNumber, after };
  return final ? finish(plan, world, r, stop, fi) : r;
}

/** The milestones nothing is timed on that the passes left, placed on one path
 *  at the answer: they move nothing, so the path is the one every other edge
 *  settled on. An amount is searched from the start; a share or Coast FI from
 *  the year after the last that moved a figure, where the passes would have
 *  gone on, since from there the FI number is one number throughout. */
function finish(plan: Plan, world: SteadyWorld, r: Settled, stop: number | null, fi: number | null): Settled {
  const idle = unwatched(plan);
  if (idle.size === 0 || plan.age === null) return r;
  const left = watches(plan).filter((m) => idle.has(m.node) && !r.fired.has(m.node));
  if (left.length === 0) return r;
  const path = world.path(r.ages, stop);
  if (!path) return r;
  const fired = new Map(r.fired);
  const reached = new Map(r.reached);
  const held = new Map(r.held);
  for (const m of left) {
    held.delete(m.node);
    const c = crossing(m.on, path, m.on.at === 'balance' ? 0 : r.after + 1, plan.age, stop);
    if (c === null) continue;
    if ('why' in c) held.set(m.node, c.why);
    else {
      fired.set(m.node, plan.age + c.k);
      if (c.at !== null) reached.set(m.node, c.at);
    }
  }
  return { ...place(plan, stop, fi, fired, held), fired, reached, held, fiNumber: path.fiNumber, after: r.after };
}

/** The resolution's own fields from a settled one. */
function resolved(plan: Plan, r: Settled): Pick<Resolution, 'ages' | 'why' | 'reachedAt'> {
  if (r.reached.size === 0) return { ages: r.ages, why: r.why };
  return { ages: r.ages, why: r.why, reachedAt: plan.items.map((_, i) => r.reached.get(`${i}:start`) ?? null) };
}

/** With D11's start, the edges that wait on a run's own balance: on a balance
 *  anchor the steady path hasn't fired by the time the stress test starts. A
 *  run's first balance is the steady path's there, so none of these fires before
 *  its second year. Nothing for any other start. */
function perRunOf(plan: Plan, r: Settled, stop: number | null): Pick<Resolution, 'perRun'> {
  if (plan.start !== 'at-stop' || stop === null || plan.age === null) return {};
  const by = Math.max(stop, plan.age);
  const on = new Map(watches(plan).map((m) => [m.node, m.on]));
  // What a run's balance is checked against: an amount as it is; a share at
  // the threshold it was reached at, or the FI number as it last stood; Coast
  // FI never (it is checked only until the stop, where runs start).
  const amountOf = (node: string): number | null => {
    const a = on.get(node);
    if (a === undefined || a.at === 'coast') return null;
    if (a.at === 'balance') return a.amount;
    const t = r.reached.get(node);
    if (t !== undefined) return t;
    return r.fiNumber === null ? null : (a.percent / 100) * r.fiNumber;
  };
  const triggers: number[] = [];
  const index = new Map<string, number>();
  const waiting = (node: string): RunEdge | null => {
    const follows = r.follows.get(node);
    if (!follows) return null;
    const t = r.fired.get(follows.node);
    if (t !== undefined && t <= by) return null;
    let trigger = index.get(follows.node);
    if (trigger === undefined) {
      const amount = amountOf(follows.node);
      if (amount === null) return null;
      trigger = triggers.length;
      index.set(follows.node, trigger);
      triggers.push(amount);
    }
    return { trigger, offset: follows.offset };
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

/** Each item's ages with FI at `k`, the earliest stop that lasts (D9,
 *  lib/fire/earliest.ts): the stop at `k` too under the stop at FI, the age typed
 *  otherwise. Null `k`: none lasts, so what waits on FI, or on a stop at FI, isn't
 *  placed. Nothing is searched for. */
export function resolveAt(plan: Plan, world: SteadyWorld, k: number | null): Resolution {
  const stop = plan.stopAtFi ? k : stopOf(plan);
  const r = settle(plan, world, stop, k, true);
  return { ...resolved(plan, r), stop, fi: k, searched: 'lasts', ...perRunOf(plan, r, stop) };
}

/** Each item's ages on the steady path, the stop, and FI where it was
 *  searched for. */
export function resolveItems(plan: Plan, world: SteadyWorld): Resolution {
  const fixedStop = stopOf(plan);
  const onFi = anchoredOn(plan, 'fi');
  if (!plan.stopAtFi && !onFi) {
    const r = settle(plan, world, fixedStop, null, true);
    return { ...resolved(plan, r), stop: fixedStop, fi: null, searched: 'none', ...perRunOf(plan, r, fixedStop) };
  }
  const today = plan.age;
  const searched = plan.stopAtFi ? 'stop' : 'fi';
  if (today !== null) {
    for (let k = Math.ceil(today); k <= Math.max(PLAN_TO_AGE, Math.ceil(today)); k++) {
      const stop = plan.stopAtFi ? k : fixedStop;
      const r = settle(plan, world, stop, k, false);
      // What starts on FI after k comes after FI: left out of the walk that
      // dates it, so a cost after FI can't leave it with no answer.
      const skip = new Set([...r.onFi].filter((i) => (r.ages[i] as { start: number }).start > k));
      const fiAge = world.fiAge(r.ages, stop, { through: plan.stopAtFi ? k : null, skip });
      if (fiAge !== null && Math.round(fiAge) <= k) {
        const done = finish(plan, world, r, stop, k);
        return { ...resolved(plan, done), stop, fi: k, searched, ...perRunOf(plan, done, stop) };
      }
    }
  }
  const r = settle(plan, world, fixedStop, null, true);
  return { ...resolved(plan, r), stop: fixedStop, fi: null, searched, ...perRunOf(plan, r, fixedStop) };
}
