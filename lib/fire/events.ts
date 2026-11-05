// lib/fire/events.ts
//
// Life events: buying a home, a child, a sabbatical, part-time work, a change
// in spending, a car (once or every few years), a raise, a windfall and a loan
// paid off, each with the person's own figures, never a default. Their shape,
// where each counts, and the FI walk that dates financial independence with
// them.
//
// TWO MODELS OF THE SAME YEARS, as the Plan already has two:
//
//   - THE FI WALK keeps saving until the FI number is reached, however long
//     that takes, as fiView does (lib/fire/plan.ts). So an event counts in
//     every year from today it covers, whatever the retirement age: money in
//     (a windfall) arrives at the start of its year, a cost paid from
//     investments (a home, each car) then leaves it, and a change in yearly
//     spending, a sabbatical's lost savings or a raise's added savings
//     changes that year's savings, which arrive at its end (the Plan's
//     convention). A loan paid off is spending lower for good, so savings
//     higher. Part-time work is not in it: the walk assumes full-time work
//     until FI.
//   - THE SIMULATION retires at the start age (lib/fire/plan.ts startAge) and
//     counts each event's years from then on: a cost as a one-off, a higher
//     cost as a one-off in each of its years, a lower one as lowerSpending
//     (never money coming in, lib/fire/simulate.ts), part-time work as income
//     for its years (toYear), and a windfall as income for its one year,
//     which the engine invests when the year doesn't need it. A sabbatical or
//     a raise after the start changes nothing: a raise is what is saved,
//     never spending in retirement.
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
// A plan holds these as items (lib/fire/items.ts), and where each counts is
// worked out with them (lib/fire/compile.ts compileItems).
//
// Imports nothing that touches storage: the Plan tab runs this in the browser.

import { LIMITS } from './plan';
import { yearsToTarget } from './fi';
import type { LowerSpending, OneOffExpense, OtherIncome } from './simulate';

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
  | { id: string; kind: 'spending'; label: string; fromAge: number; yearly: number; years: number | null }
  /** What each car takes from investments when it is bought: once (`every`
   *  null, `times` 1), or `times` cars `every` so many years from atAge. A
   *  car loan's payments are in measured spending, never here. */
  | { id: string; kind: 'car'; label: string; atAge: number; cost: number; every: number | null; times: number }
  /** How much more is saved a year from fromAge, until FI. Never a change
   *  to spending in retirement. */
  | { id: string; kind: 'raise'; label: string; fromAge: number; yearly: number }
  /** Money in once, after tax, at an age: added to investments. */
  | { id: string; kind: 'windfall'; label: string; atAge: number; amount: number }
  /** How much less is spent a year, for good, once a loan is paid off at
   *  atAge: its payments, in measured spending until then. */
  | { id: string; kind: 'loan-end'; label: string; atAge: number; yearly: number };

export const EVENT_LIMITS = {
  /** A yearly amount, either way. */
  yearly: LIMITS.money,
  /** A cost paid once, as the Plan's one-off expenses. */
  cost: LIMITS.money * 10,
  /** Years between cars, and how many in all, when there is more than one. */
  carEvery: [2, 30],
  carTimes: [2, 20],
} as const;

/** The ages a car is bought at: atAge, then every so many years. */
export function carAges(e: Extract<LifeEvent, { kind: 'car' }>): number[] {
  return Array.from({ length: e.times }, (_, i) => e.atAge + i * (e.every ?? 0));
}

/** What the walk counts: money in and costs at the start of a year, and
 *  changes to a year's savings, by years from today (0 is the year starting
 *  today). Money in is its own list: a cost is never below zero. */
export type WalkChanges = {
  moneyIn: { year: number; amount: number }[];
  costs: { year: number; amount: number }[];
  /** [from, to) in years from today; `to` null for good. */
  spans: { from: number; to: number | null; delta: number }[];
  /** The tax on what a year before the stop had to sell (lib/fire/tax/mix.ts
   *  taxedMix), paid with that year's costs. Only in the detailed tax model. */
  taxes?: { year: number; amount: number }[];
};

/** Why part of an event isn't counted somewhere, for the words beside it:
 *  - past: some of its years are before today (they count from today;
 *    your measured figures may already count what has begun);
 *  - already: a change that happens once (money in, a car, a raise, a loan
 *    paid off) is before today, so your figures may already count it, and
 *    it is left out: counting a raise or a paid-off loan from today would
 *    count it twice;
 *  - no-today: without your age, its years can't be placed from today, so
 *    the FI date leaves it out (the simulation still places it from the
 *    retirement age);
 *  - no-today-walk: the same for a raise, which is only in the FI date, or
 *    a windfall or cars all before the retirement age, which the simulation
 *    doesn't reach: so it is left out altogether;
 *  - no-age: without either age it can't be placed at all;
 *  - retired: a sabbatical's years from the retirement age change nothing;
 *  - before-start: part-time work before the retirement age is left out;
 *  - after-end: some of it is after the plan ends, which only the grid's
 *    longer columns reach. */
export type EventPart = 'past' | 'already' | 'no-today' | 'no-today-walk' | 'no-age' | 'retired' | 'before-start' | 'after-end';
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
};

export const hasWalk = (w: WalkChanges) => w.moneyIn.length > 0 || w.costs.length > 0 || w.spans.length > 0 || (w.taxes?.length ?? 0) > 0;

/** A year's savings in the walk: the plan's, plus every change covering it. */
export function savingsIn(w: WalkChanges, base: number, year: number): number {
  let c = base;
  for (const s of w.spans) if (year >= s.from && (s.to === null || year < s.to)) c += s.delta;
  return c;
}

/** The last walk year with a change of its own: after it, savings stay as
 *  they are then (lasting changes included), and the walk ends in closed
 *  form. -1 when nothing changes after today's first year. A tax isn't a change
 *  of its own: walkToFi walks on through what is left of them. */
export function lastChange(w: WalkChanges): number {
  let k = -1;
  for (const m of w.moneyIn) k = Math.max(k, m.year);
  for (const c of w.costs) k = Math.max(k, c.year);
  for (const s of w.spans) k = Math.max(k, s.to === null ? s.from - 1 : s.to - 1);
  return k;
}

const inYear = (xs: readonly { year: number; amount: number }[], year: number) => xs.reduce((sum, x) => (x.year === year ? sum + x.amount : sum), 0);

export const costIn = (w: WalkChanges, year: number) => inYear(w.costs, year) + (w.taxes ? inYear(w.taxes, year) : 0);
export const moneyInAt = (w: WalkChanges, year: number) => w.moneyIn.reduce((sum, m) => (m.year === year ? sum + m.amount : sum), 0);

/** Where the walk can't go on: a cost from investments larger than what it
 *  has then, or a year's savings below zero taking it below zero. `year` is
 *  from today; `have` is the balance at its start, with that year's money in
 *  (which arrives before its costs are paid); `need` the cost, or what the
 *  year takes out. Never a negative balance compounding, or a cost paid from
 *  nowhere. */
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
    bal += moneyInAt(w, k);
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
  // There through the last change is there, as it is with no taxes: a tax in a
  // later year, of a saving below zero, doesn't take a date back.
  if (reached !== null) return { years: reached };
  const tail = savingsIn(w, savings, K + 1);
  let end = K;
  for (const x of w.taxes ?? []) end = Math.max(end, x.year);
  for (let k = K + 1; k <= end; k++) {
    const cost = costIn(w, k);
    if (cost > 0 && cost > bal + 1e-9) return { short: { year: k, have: bal, need: cost, kind: 'cost' } };
    bal -= cost;
    if (bal >= target) return { years: k };
    const t = yearsToTarget(bal, tail, realReturn, target);
    if (t <= 1) return { years: k + t };
    const next = bal * (1 + realReturn) + tail;
    if (next < 0) return { short: { year: k, have: bal, need: -tail, kind: 'savings' } };
    bal = next;
  }
  const rest = yearsToTarget(bal, tail, realReturn, target);
  // Never there, with savings below zero after the last change: the balance
  // runs down, and the year it would go below zero is where it stops, as a
  // year inside the changes would (a balance that only holds still, saving
  // below zero exactly what it earns, is never there, and never short).
  if (rest === Infinity && tail < 0) {
    let b = bal;
    for (let k = end + 1; k < end + 1 + 1000; k++) {
      const next = b * (1 + realReturn) + tail;
      if (next < 0) return { short: { year: k, have: b, need: -tail, kind: 'savings' } };
      if (next >= b) break;
      b = next;
    }
  }
  return { years: end + 1 + rest };
}

/** The walk year by year: `balances[k]` is the balance at the start of year
 *  k from today (before that year's money in and cost), for k = 0 to
 *  `years`; or, where it couldn't go on, through the start of that year,
 *  with `short` (so `balances.length` is `short.year + 1`). */
export function walkPath(assets: number, savings: number, realReturn: number, w: WalkChanges, years: number): { balances: number[]; short: Shortfall | null } {
  let bal = assets;
  const balances = [bal];
  for (let k = 0; k < years; k++) {
    bal += moneyInAt(w, k);
    const cost = costIn(w, k);
    if (cost > 0 && cost > bal + 1e-9) return { balances, short: { year: k, have: bal, need: cost, kind: 'cost' } };
    bal -= cost;
    const c = savingsIn(w, savings, k);
    const end = bal * (1 + realReturn) + c;
    if (end < 0) return { balances, short: { year: k, have: bal, need: -c, kind: 'savings' } };
    bal = end;
    balances.push(bal);
  }
  return { balances, short: null };
}

/** The walk's balance at the start of `year` (before that year's money in
 *  and cost, which a simulation starting then takes itself), or where it
 *  couldn't go on before then. */
export function walkBalanceAt(assets: number, savings: number, realReturn: number, w: WalkChanges, year: number): { balance: number } | { short: Shortfall } {
  const p = walkPath(assets, savings, realReturn, w, year);
  return p.short ? { short: p.short } : { balance: p.balances[p.balances.length - 1] };
}
