// lib/fire/compile.ts
//
// Where each of a plan's items counts (lib/fire/items.ts; the tax plan's
// timeline, "Where each kind counts"), at the ages the steady path resolved
// them to (lib/fire/steady.ts): the FI walk from today and the simulation from
// its start age, as lib/fire/events.ts explains for life events, which are
// items here with their own arithmetic unchanged (compileEvents).
//
// What items add to what life events did:
//   - a plan's one-offs and income (version 1's lists) in the simulation as
//     enginePlan placed them (lib/fire/plan.ts), and, with the switch D15
//     turns on (`count.planInWalk`, the flag 'plan-items-in-fi'), in the walk
//     too: a one-off is a cost in its year, income adds to saving every year
//     it covers until FI. One begun before today is in measured saving: the
//     walk leaves it out, and takes it out from its end. Income not kept up
//     with inflation counts at its amount in the walk, as the simulation
//     counts it from the year it first does;
//   - part-time work that says what it replaces, starting before the stop:
//     in the walk, what it pays less what it replaces;
//   - pay up or down: a raise for good, a career break for its years, any
//     change between;
//   - income given before tax at 1 - taxRate, in the walk and the simulation.
//
// One compile for the plan's items and an open scenario's together, so their
// notes say which item by position (`at`), whatever their ids.
//
// Imports nothing that touches storage: the Plan tab runs this in the browser.

import { INCOME_KINDS, fixedEdges, itemFromEvent, type PlanItem } from './items';
import type { CompiledEvents, EventNote, EventPart, LifeEvent } from './events';
import { MAX_YEARS } from './simulate';

/** An item's resolved ages: where it starts, and where it stops (null for
 *  good, or ignored for a kind that happens once); null when it isn't placed
 *  (the resolution says why). */
export type ItemAges = { start: number; end: number | null } | null;

/** What counts where, by the release flags it rests on. */
export type Count = { planInWalk: boolean };

/** Today's age (the walk), the simulation's start age and length, the
 *  resolved stop (part-time work before it is in the walk) and the plan's
 *  tax rate (income given before tax). */
export type CompileAt = { age: number | null; startAge: number | null; stop: number | null; years: number; taxRate: number };

export type ItemNote = EventNote & { at: number };

export type CompiledItems = Omit<CompiledEvents, 'notes'> & {
  notes: ItemNote[];
  /** Whether each item put anything in the walk. */
  inWalk: boolean[];
};

/** The ages a repeat is bought at: its start, then every so many years. */
const repeats = (x: PlanItem, start: number) => Array.from({ length: x.times ?? 1 }, (_, k) => start + k * (x.every ?? 0));

/** Where each item counts, at `ages` (one per item). */
export function compileItems(items: readonly PlanItem[], ages: readonly ItemAges[], at: CompileAt, count: Count): CompiledItems {
  const out: CompiledItems = { walk: { moneyIn: [], costs: [], spans: [] }, lasting: [], later: [], sim: { oneOffs: [], income: [], lowerSpending: [] }, notes: [], inWalk: items.map(() => false) };
  const { age: a, startAge: S, years: Y, stop, taxRate } = at;
  for (const [i, x] of items.entries()) {
    const placed = ages[i];
    if (placed === null) continue;
    const { start, end } = placed;
    const noted = new Set<EventPart>();
    const note = (part: EventPart) => {
      if (noted.has(part)) return;
      noted.add(part);
      out.notes.push({ at: i, id: x.id, part });
    };
    const span = (from: number, to: number | null, delta: number) => {
      out.walk.spans.push({ from, to, delta });
      out.inWalk[i] = true;
    };
    const afterTax = (v: number) => (x.beforeTax ? v * (1 - taxRate) : v);

    // A plan's one-offs and income: the simulation as enginePlan placed
    // them, and the walk behind D15's switch.
    if (x.kind === 'one-off') {
      const amount = x.once ?? 0;
      for (const age of repeats(x, start)) {
        const y = S === null ? -1 : age - S;
        if (S === null) note('no-age');
        else if (y < 0) note('before-start');
        else {
          out.sim.oneOffs.push({ amount, year: y });
          if (y >= Y) note('after-end');
        }
        if (count.planInWalk && a !== null && age >= a && amount > 0) {
          out.walk.costs.push({ year: age - a, amount });
          out.inWalk[i] = true;
        }
      }
      continue;
    }
    if (INCOME_KINDS.includes(x.kind) && x.kind !== 'part-time') {
      const amount = afterTax(x.yearly ?? 0);
      if (S === null) note('no-age');
      else {
        const fromYear = Math.max(0, start - S);
        if (end === null) out.sim.income.push({ amount, fromYear, inflationAdjusted: x.inflationAdjusted });
        else if (end - S > fromYear) out.sim.income.push({ amount, fromYear, toYear: end - S, inflationAdjusted: x.inflationAdjusted });
      }
      if (count.planInWalk && a !== null && amount > 0) {
        if (start >= a) {
          if (end === null || end > start) span(start - a, end === null ? null : end - a, amount);
        } else if (end !== null && end > a) {
          span(end - a, null, -amount);
        }
      }
      continue;
    }

    // Life event kinds, as compileEvents counted them.
    if (a === null && S === null) {
      note('no-age');
      continue;
    }
    const forGood = end === null;
    // A change that happens once, before today, is in today's figures.
    const once = x.kind === 'car' ? Math.max(...repeats(x, start)) : (x.kind === 'pay' && forGood) || x.kind === 'windfall' || x.kind === 'loan-end' ? start : null;
    if (a !== null && once !== null && once < a) {
      note('already');
      continue;
    }
    // Without your age, pay for good (only ever in the walk), or money in or
    // cars all before the start age (which the simulation doesn't reach),
    // count nowhere.
    const walkOnly = (x.kind === 'pay' && forGood) || (S !== null && once !== null && once < S);
    if (a === null) note(walkOnly ? 'no-today-walk' : 'no-today');

    /** A cost paid once, at age t. */
    const cost = (t: number, amount: number) => {
      if (a !== null) {
        if (t >= a) {
          out.walk.costs.push({ year: t - a, amount });
          out.inWalk[i] = true;
        } else note('past');
      }
      if (S !== null && t >= S) {
        out.sim.oneOffs.push({ amount, year: t - S });
        if (t - S >= Y) note('after-end');
      }
    };
    /** Money in once, at age t: in the walk before that year's costs; in the
     *  simulation as income for that one year, which the engine invests when
     *  the year doesn't need it (never a lower cost). */
    const moneyIn = (t: number, amount: number) => {
      if (a !== null) {
        if (t >= a) {
          out.walk.moneyIn.push({ year: t - a, amount });
          out.inWalk[i] = true;
        } else note('past');
      }
      if (S !== null && t >= S) {
        const y = t - S;
        if (y >= Y) note('after-end');
        if (y < MAX_YEARS) out.sim.income.push({ amount, fromYear: y, toYear: y + 1, inflationAdjusted: true });
      }
    };
    /** A change in yearly spending over ages [t0, t1), t1 null for good. */
    const change = (t0: number, t1: number | null, d: number) => {
      if (a !== null) {
        if (t0 < a) note('past');
        const from = Math.max(t0, a) - a;
        const to = t1 === null ? null : t1 - a;
        if (to === null || to > from) span(from, to, -d);
      }
      if (S === null) return;
      if (t1 === null) {
        if (t0 <= S) {
          out.lasting.push({ id: x.id, amount: d });
          return;
        }
        // To the longest plan the engine runs, so a longer grid column
        // counts it as the plan's own length does.
        const y0 = t0 - S;
        if (y0 >= Y) note('after-end');
        out.later.push({ id: x.id, amount: d, fromAge: t0 });
        if (d > 0) for (let y = y0; y < MAX_YEARS; y++) out.sim.oneOffs.push({ amount: d, year: y });
        else if (y0 < MAX_YEARS) out.sim.lowerSpending.push({ amount: -d, fromYear: y0 });
        return;
      }
      const y0 = Math.max(t0, S) - S;
      const y1 = Math.min(t1 - S, MAX_YEARS);
      if (y1 <= y0) return;
      if (y1 > Y) note('after-end');
      if (d > 0) for (let y = y0; y < y1; y++) out.sim.oneOffs.push({ amount: d, year: y });
      else out.sim.lowerSpending.push({ amount: -d, fromYear: y0, toYear: y1 });
    };

    const yearly = x.yearly ?? 0;
    switch (x.kind) {
      case 'home':
        if ((x.once ?? 0) > 0) cost(start, x.once as number);
        if (yearly !== 0) change(start, end, yearly);
        break;
      case 'child':
      case 'spending':
        change(start, end, yearly);
        break;
      case 'pay':
        // Take-home, more or less, in the walk only: the job ends when you
        // stop. For good, from its age (a raise); for some years, from today
        // to its end (a career break), changing nothing after the start age.
        if (end === null) {
          if (a !== null) span(start - a, null, yearly);
          break;
        }
        if (a !== null) {
          if (start < a) note('past');
          const from = Math.max(start, a) - a;
          if (end - a > from) span(from, end - a, yearly);
        }
        if (S !== null && end > S) note('retired');
        break;
      case 'part-time': {
        const pays = afterTax(yearly);
        // In the walk only when it says what it replaces and starts before
        // the stop; begun before today, in measured saving, so from its end
        // the walk adds back what it replaced less what it paid.
        if (x.replaces !== null && a !== null && stop !== null && start < stop) {
          if (start >= a) span(start - a, end === null ? null : end - a, pays - x.replaces);
          else if (end !== null && end > a) span(end - a, null, x.replaces - pays);
        }
        if (S === null) break;
        if (start < S) note('before-start');
        const y0 = Math.max(start, S) - S;
        const y1 = Math.min((end ?? S + MAX_YEARS) - S, MAX_YEARS);
        if (y1 > y0) {
          out.sim.income.push({ amount: pays, fromYear: y0, toYear: y1, inflationAdjusted: x.inflationAdjusted });
          if (y1 > Y) note('after-end');
        }
        break;
      }
      case 'car':
        for (const t of repeats(x, start)) cost(t, x.once ?? 0);
        break;
      case 'windfall':
        moneyIn(start, x.once ?? 0);
        break;
      case 'loan-end':
        change(start, null, -yearly);
        break;
    }
  }
  return out;
}

/** The ages of items timed by ages alone (a scenario's life events, version
 *  1's lists): their own, an end for good null. */
export function fixedAges(items: readonly PlanItem[]): ItemAges[] {
  const edges = fixedEdges({ items: [...items], age: null, partnerAge: null, targetAge: null, stopAtFi: false });
  return items.map((_, i) => {
    const start = edges.get(`${i}:start`);
    return start === undefined ? null : { start, end: edges.get(`${i}:end`) ?? null };
  });
}

/**
 * Where each life event counts: in the FI walk from today (`age`), in the
 * simulation from its start age (`startAge`) for `years`. Either age may be
 * unknown; then that part is left out, and noted.
 */
export function compileEvents(events: readonly LifeEvent[], at: { age: number | null; startAge: number | null; years: number }): CompiledEvents {
  const items = events.map(itemFromEvent);
  const { notes, inWalk: _inWalk, ...rest } = compileItems(items, fixedAges(items), { ...at, stop: null, taxRate: 0 }, { planInWalk: false });
  return { ...rest, notes: notes.map(({ id, part }) => ({ id, part })) };
}
