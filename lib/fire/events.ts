// lib/fire/events.ts
//
// A scenario's life events (lib/fire/scenarios.ts): buying a home, a child, a
// sabbatical, part-time work and a change in spending, each with the
// person's own figures, never a default. Their shape and checks, where each
// counts, and the FI walk that dates financial independence with them.
//
// TWO MODELS OF THE SAME YEARS, as the Plan already has two:
//
//   - THE FI WALK keeps saving until the FI number is reached, however long
//     that takes, as fiView does (lib/fire/plan.ts). So an event counts in
//     every year from today it covers, whatever the retirement age: a cost
//     paid from investments leaves the balance at the start of its year, and
//     a change in yearly spending (or a sabbatical's lost savings) changes
//     that year's savings, which arrive at its end (the Plan's convention).
//     Part-time work is not in it: the walk assumes full-time work until FI.
//   - THE SIMULATION retires at the start age (lib/fire/plan.ts startAge) and
//     counts each event's years from then on: a cost as a one-off, a higher
//     cost as a one-off in each of its years, a lower one as lowerSpending
//     (never money coming in, lib/fire/simulate.ts), part-time work as income
//     for its years (toYear). A sabbatical after the start changes nothing.
//
// An event that covers years before and after the start is in both, which
// is not counting it twice: the walk and the simulation answer different
// questions about the same years.
//
// A LASTING CHANGE ("for good") already in effect when the simulation starts
// is retirement spending: it is added to the spending the FI number, the
// rule and the start balance are worked out from (lib/fire/plan-figures.ts),
// and is not also a one-off. One that starts later stays in the simulation,
// to the longest plan the engine runs, so the grid's longer columns count it.
//
// Imports nothing that touches storage: the Plan tab runs this in the browser.

import { LIMITS } from './plan';
import { yearsToTarget } from './fi';
import { MAX_YEARS, type LowerSpending, type OneOffExpense, type OtherIncome } from './simulate';

export type LifeEvent =
  /** A cost paid from investments when it is bought (0 when the down payment
   *  comes from cash the plan doesn't count), and a change in yearly spending
   *  from then (the mortgage, taxes and upkeep, less the rent no longer paid),
   *  for some years or for good (null). */
  | { id: string; kind: 'house'; label: string; atAge: number; cost: number; yearly: number; years: number | null }
  | { id: string; kind: 'child'; label: string; fromAge: number; yearly: number; years: number }
  /** How much less is saved each year of it: what would have been saved, plus
   *  anything spent from savings. */
  | { id: string; kind: 'sabbatical'; label: string; fromAge: number; years: number; savingsLost: number }
  /** Income a year, after tax, from fromAge to the age it stops at. */
  | { id: string; kind: 'part-time'; label: string; fromAge: number; toAge: number; yearly: number }
  /** More (or, below zero, less) spent a year, for some years or for good. */
  | { id: string; kind: 'spending'; label: string; fromAge: number; yearly: number; years: number | null };

export type LifeEventKind = LifeEvent['kind'];
export const EVENT_KINDS: readonly LifeEventKind[] = ['house', 'child', 'sabbatical', 'part-time', 'spending'];

export const EVENT_LIMITS = {
  events: 10,
  /** A yearly amount, either way. */
  yearly: LIMITS.money,
  /** A cost paid once, as the Plan's one-off expenses. */
  cost: LIMITS.money * 10,
  childYears: [1, 40],
  sabbaticalYears: [1, 10],
  spanYears: [1, MAX_YEARS],
} as const;

const KEYS: Record<LifeEventKind, readonly string[]> = {
  house: ['id', 'kind', 'label', 'atAge', 'cost', 'yearly', 'years'],
  child: ['id', 'kind', 'label', 'fromAge', 'yearly', 'years'],
  sabbatical: ['id', 'kind', 'label', 'fromAge', 'years', 'savingsLost'],
  'part-time': ['id', 'kind', 'label', 'fromAge', 'toAge', 'yearly'],
  spending: ['id', 'kind', 'label', 'fromAge', 'yearly', 'years'],
};

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Whether a value is a life event as stored: its kind's exact fields, of
 *  their types, whatever ranges applied when it was saved. */
export function isLifeEvent(v: unknown): v is LifeEvent {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  if (typeof e.kind !== 'string' || !(EVENT_KINDS as readonly string[]).includes(e.kind)) return false;
  const keys = KEYS[e.kind as LifeEventKind];
  if (Object.keys(e).length !== keys.length || !keys.every((k) => Object.hasOwn(e, k))) return false;
  if (typeof e.id !== 'string' || typeof e.label !== 'string') return false;
  for (const k of keys) {
    if (k === 'id' || k === 'kind' || k === 'label') continue;
    if (k === 'years' && e.years === null && (e.kind === 'house' || e.kind === 'spending')) continue;
    if (!finite(e[k])) return false;
  }
  return true;
}

/** A life event as a save sends it, checked against today's ranges, or why
 *  it can't be saved. */
export function parseLifeEvent(raw: unknown, at: string): { ok: LifeEvent } | { error: string } {
  if (!isLifeEvent(raw)) {
    const kind = typeof raw === 'object' && raw !== null ? (raw as { kind?: unknown }).kind : undefined;
    return { error: typeof kind === 'string' && (EVENT_KINDS as readonly string[]).includes(kind) ? `${at} has fields its kind doesn’t take, or misses one` : `${at} is not a kind of life event` };
  }
  const e = raw;
  if (!ID.test(e.id)) return { error: `${at}.id must be a short id` };
  const label = e.label.trim();
  if (!label || label.length > LIMITS.label || CONTROL.test(label)) return { error: `${at} needs a name of 1 to ${LIMITS.label} characters, on one line` };
  const [ageMin, ageMax] = LIMITS.eventAge;
  const age = (v: number, what: string) => (Number.isInteger(v) && v >= ageMin && v <= ageMax ? null : `${at}: ${what} is a whole number from ${ageMin} to ${ageMax}`);
  const whole = (v: number, [min, max]: readonly [number, number], what: string) => (Number.isInteger(v) && v >= min && v <= max ? null : `${at}: ${what} is a whole number of years from ${min} to ${max}`);
  const amount = (v: number, min: number, max: number, what: string) => (v >= min && v <= max ? null : `${at}: ${what} is an amount from ${min} to ${max}`);
  const positive = (v: number, what: string) => (v > 0 && v <= EVENT_LIMITS.yearly ? null : `${at}: ${what} is an amount above 0, up to ${EVENT_LIMITS.yearly}`);
  let error: string | null = null;
  switch (e.kind) {
    case 'house':
      error =
        age(e.atAge, 'the age') ??
        amount(e.cost, 0, EVENT_LIMITS.cost, 'what is paid from investments') ??
        amount(e.yearly, -EVENT_LIMITS.yearly, EVENT_LIMITS.yearly, 'the change in yearly spending') ??
        (e.years === null ? null : whole(e.years, EVENT_LIMITS.spanYears, 'how long the change lasts')) ??
        (e.cost === 0 && e.yearly === 0 ? `${at}: a home needs what it costs from investments, or a change in yearly spending` : null);
      break;
    case 'child':
      error = age(e.fromAge, 'the age') ?? positive(e.yearly, 'the extra spending a year') ?? whole(e.years, EVENT_LIMITS.childYears, 'how long it lasts');
      break;
    case 'sabbatical':
      error = age(e.fromAge, 'the age') ?? whole(e.years, EVENT_LIMITS.sabbaticalYears, 'how long it lasts') ?? positive(e.savingsLost, 'how much less is saved a year');
      break;
    case 'part-time':
      error =
        age(e.fromAge, 'the age it starts') ??
        age(e.toAge, 'the age it stops') ??
        (e.toAge > e.fromAge ? null : `${at}: part-time work stops after it starts`) ??
        positive(e.yearly, 'the income a year');
      break;
    case 'spending':
      error =
        age(e.fromAge, 'the age') ??
        (e.yearly !== 0 && Math.abs(e.yearly) <= EVENT_LIMITS.yearly ? null : `${at}: the change a year is an amount other than 0, up to ${EVENT_LIMITS.yearly} either way`) ??
        (e.years === null ? null : whole(e.years, EVENT_LIMITS.spanYears, 'how long the change lasts'));
      break;
  }
  if (error) return { error };
  return { ok: { ...e, label } };
}

/** The ages an event covers, [from, to): `to` null for good. */
export function eventSpan(e: LifeEvent): { from: number; to: number | null } {
  switch (e.kind) {
    case 'house':
      return { from: e.atAge, to: e.years === null ? null : e.atAge + e.years };
    case 'child':
    case 'sabbatical':
      return { from: e.fromAge, to: e.fromAge + e.years };
    case 'part-time':
      return { from: e.fromAge, to: e.toAge };
    case 'spending':
      return { from: e.fromAge, to: e.years === null ? null : e.fromAge + e.years };
  }
}

/** What the walk counts: costs at the start of a year, and changes to a
 *  year's savings, by years from today (0 is the year starting today). */
export type WalkChanges = {
  costs: { year: number; amount: number }[];
  /** [from, to) in years from today; `to` null for good. */
  spans: { from: number; to: number | null; delta: number }[];
};

/** Why part of an event isn't counted somewhere, for the words beside it:
 *  - past: some of its years are before today (they count from today;
 *    your measured figures may already count what has begun);
 *  - no-today: without your age, its years can't be placed from today, so
 *    the FI date leaves it out (the simulation still places it from the
 *    retirement age);
 *  - no-age: without either age it can't be placed at all;
 *  - retired: a sabbatical's years from the retirement age change nothing;
 *  - before-start: part-time work before the retirement age is left out;
 *  - after-end: some of it is after the plan ends, which only the grid's
 *    longer columns reach. */
export type EventPart = 'past' | 'no-today' | 'no-age' | 'retired' | 'before-start' | 'after-end';
export type EventNote = { id: string; part: EventPart };

export type CompiledEvents = {
  walk: WalkChanges;
  /** Lasting changes in effect when the simulation starts: part of
   *  retirement spending, by event. */
  lasting: { id: string; amount: number }[];
  /** Lasting changes that start after it: in the simulation, and left out of
   *  the FI number, which says so. */
  later: { id: string; amount: number; fromAge: number }[];
  sim: { oneOffs: OneOffExpense[]; income: OtherIncome[]; lowerSpending: LowerSpending[] };
  notes: EventNote[];
};

/**
 * Where each event counts: in the FI walk from today (`age`), in the
 * simulation from its start age (`startAge`) for `years`. Either age may be
 * unknown; then that part is left out, and noted.
 */
export function compileEvents(events: readonly LifeEvent[], at: { age: number | null; startAge: number | null; years: number }): CompiledEvents {
  const out: CompiledEvents = { walk: { costs: [], spans: [] }, lasting: [], later: [], sim: { oneOffs: [], income: [], lowerSpending: [] }, notes: [] };
  const { age: a, startAge: S, years: Y } = at;
  for (const e of events) {
    const noted = new Set<EventPart>();
    const note = (part: EventPart) => {
      if (noted.has(part)) return;
      noted.add(part);
      out.notes.push({ id: e.id, part });
    };
    if (a === null && S === null) {
      note('no-age');
      continue;
    }
    if (a === null) note('no-today');

    /** A cost paid once, at age x. */
    const cost = (x: number, amount: number) => {
      if (a !== null) {
        if (x >= a) out.walk.costs.push({ year: x - a, amount });
        else note('past');
      }
      if (S !== null && x >= S) {
        out.sim.oneOffs.push({ amount, year: x - S });
        if (x - S >= Y) note('after-end');
      }
    };
    /** A change in yearly spending over ages [x0, x1), x1 null for good. */
    const change = (x0: number, x1: number | null, d: number) => {
      if (a !== null) {
        if (x0 < a) note('past');
        const from = Math.max(x0, a) - a;
        const to = x1 === null ? null : x1 - a;
        if (to === null || to > from) out.walk.spans.push({ from, to, delta: -d });
      }
      if (S === null) return;
      if (x1 === null) {
        if (x0 <= S) {
          out.lasting.push({ id: e.id, amount: d });
          return;
        }
        // To the longest plan the engine runs, so a longer grid column
        // counts it as the plan's own length does.
        const y0 = x0 - S;
        if (y0 >= Y) note('after-end');
        out.later.push({ id: e.id, amount: d, fromAge: x0 });
        if (d > 0) for (let y = y0; y < MAX_YEARS; y++) out.sim.oneOffs.push({ amount: d, year: y });
        else if (y0 < MAX_YEARS) out.sim.lowerSpending.push({ amount: -d, fromYear: y0 });
        return;
      }
      const y0 = Math.max(x0, S) - S;
      const y1 = Math.min(x1 - S, MAX_YEARS);
      if (y1 <= y0) return;
      if (y1 > Y) note('after-end');
      if (d > 0) for (let y = y0; y < y1; y++) out.sim.oneOffs.push({ amount: d, year: y });
      else out.sim.lowerSpending.push({ amount: -d, fromYear: y0, toYear: y1 });
    };

    switch (e.kind) {
      case 'house':
        if (e.cost > 0) cost(e.atAge, e.cost);
        if (e.yearly !== 0) change(e.atAge, e.years === null ? null : e.atAge + e.years, e.yearly);
        break;
      case 'child':
        change(e.fromAge, e.fromAge + e.years, e.yearly);
        break;
      case 'spending':
        change(e.fromAge, e.years === null ? null : e.fromAge + e.years, e.yearly);
        break;
      case 'sabbatical': {
        const x1 = e.fromAge + e.years;
        if (a !== null) {
          if (e.fromAge < a) note('past');
          const from = Math.max(e.fromAge, a) - a;
          if (x1 - a > from) out.walk.spans.push({ from, to: x1 - a, delta: -e.savingsLost });
        }
        if (S !== null && x1 > S) note('retired');
        break;
      }
      case 'part-time': {
        if (S === null) break;
        if (e.fromAge < S) note('before-start');
        const y0 = Math.max(e.fromAge, S) - S;
        const y1 = Math.min(e.toAge - S, MAX_YEARS);
        if (y1 > y0) {
          out.sim.income.push({ amount: e.yearly, fromYear: y0, toYear: y1, inflationAdjusted: true });
          if (y1 > Y) note('after-end');
        }
        break;
      }
    }
  }
  return out;
}

export const hasWalk = (w: WalkChanges) => w.costs.length > 0 || w.spans.length > 0;

/** A year's savings in the walk: the plan's, plus every change covering it. */
export function savingsIn(w: WalkChanges, base: number, year: number): number {
  let c = base;
  for (const s of w.spans) if (year >= s.from && (s.to === null || year < s.to)) c += s.delta;
  return c;
}

/** The last walk year with a change of its own: after it, savings stay as
 *  they are then (lasting changes included), and the walk ends in closed
 *  form. -1 when nothing changes after today's first year. */
export function lastChange(w: WalkChanges): number {
  let k = -1;
  for (const c of w.costs) k = Math.max(k, c.year);
  for (const s of w.spans) k = Math.max(k, s.to === null ? s.from - 1 : s.to - 1);
  return k;
}

const costIn = (w: WalkChanges, year: number) => w.costs.reduce((sum, c) => (c.year === year ? sum + c.amount : sum), 0);

/** Where the walk can't go on: a cost from investments larger than what it
 *  has then, or a year's savings below zero taking it below zero. `year` is
 *  from today; `have` is the balance at its start; `need` the cost, or what
 *  the year takes out. Never a negative balance compounding, or a cost paid
 *  from nowhere. */
export type Shortfall = { year: number; have: number; need: number; kind: 'cost' | 'savings' };

/**
 * Years until invested assets reach `target` and stay there through the
 * last change, with the walk's costs and savings changes; or where it can't
 * go on. Exactly yearsToTarget when nothing changes. See the top of this
 * file; the within-year estimate is yearsToTarget's own, from the balance at
 * the start of the year with that year's savings, which is exact at whole
 * years and the rest of the closed-form answer when savings stay the same.
 */
export function walkToFi(assets: number, savings: number, realReturn: number, target: number, w: WalkChanges): { years: number } | { short: Shortfall } {
  const K = lastChange(w);
  let bal = assets;
  let reached: number | null = null;
  for (let k = 0; k <= K; k++) {
    const cost = costIn(w, k);
    if (cost > 0 && cost > bal + 1e-9) return { short: { year: k, have: bal, need: cost, kind: 'cost' } };
    bal -= cost;
    const c = savingsIn(w, savings, k);
    if (bal >= target) {
      if (reached === null) reached = k;
    } else {
      reached = null;
      const t = yearsToTarget(bal, c, realReturn, target);
      if (t <= 1) reached = k + t;
    }
    const end = bal * (1 + realReturn) + c;
    if (end < 0) return { short: { year: k, have: bal, need: -c, kind: 'savings' } };
    bal = end;
    if (reached !== null && bal < target) reached = null;
  }
  if (reached !== null) return { years: reached };
  const tail = savingsIn(w, savings, K + 1);
  const rest = yearsToTarget(bal, tail, realReturn, target);
  // Never there, with savings below zero after the last change: the balance
  // runs down, and the year it would go below zero is where it stops, as a
  // year inside the changes would (a balance that only holds still, saving
  // below zero exactly what it earns, is never there, and never short).
  if (rest === Infinity && tail < 0) {
    let b = bal;
    for (let k = K + 1; k < K + 1 + 1000; k++) {
      const end = b * (1 + realReturn) + tail;
      if (end < 0) return { short: { year: k, have: b, need: -tail, kind: 'savings' } };
      if (end >= b) break;
      b = end;
    }
  }
  return { years: K + 1 + rest };
}

/** The walk's balance at the start of `year` (before that year's cost,
 *  which a simulation starting then takes itself), or where it couldn't go
 *  on before then. */
export function walkBalanceAt(assets: number, savings: number, realReturn: number, w: WalkChanges, year: number): { balance: number } | { short: Shortfall } {
  let bal = assets;
  for (let k = 0; k < year; k++) {
    const cost = costIn(w, k);
    if (cost > 0 && cost > bal + 1e-9) return { short: { year: k, have: bal, need: cost, kind: 'cost' } };
    bal -= cost;
    const c = savingsIn(w, savings, k);
    const end = bal * (1 + realReturn) + c;
    if (end < 0) return { short: { year: k, have: bal, need: -c, kind: 'savings' } };
    bal = end;
  }
  return { balance: bal };
}
