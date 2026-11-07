// lib/fire/tax/piece.ts
//
// Arithmetic on quantities that are affine in the year's withdrawal x near the
// point being evaluated. Federal and health (lib/fire/tax/federal.ts,
// lib/fire/tax/health.ts) are written only with these helpers, so one
// evaluation of a year gives three things at once: each quantity's value, its
// slope in x, and how far x can move before any comparison or "smaller of"
// changes its answer (the room). The year's solver (lib/fire/tax/year.ts)
// walks those pieces to the least withdrawal that pays.
//
// Shared conventions:
//   - A boundary belongs to the side the law gives it: "not over", "at or
//     under" (a bracket's top, the 400% cliff, a Medicaid line) belongs below;
//     "at least" (100% of the poverty line, a percent cell's edge, the work
//     rule's income) belongs above. Values within LINE_EPS of a boundary are at
//     it, so floating error never flips a cliff.
//   - Two evaluation modes. "At x" applies each boundary on the law's side.
//     "Just right of x" is the limit from above: a quantity at a boundary with
//     a slope above 0 is past it upward, below 0 past it downward, and 0
//     leaves it at the boundary, on the law's side.
//   - Two rooms. `room` ends at every kink; `federalRoom` at every kink but an
//     ACA percent cell's edge (health's cells are scanned arithmetically).
//   - Nothing here allocates: results go into Lin objects the caller made once.
//
// Imports nothing that touches storage: the Plan tab runs this in the browser.

import type { Bracket } from './law/types';

/** A quantity's value, and its slope in the year's withdrawal x. */
export type Lin = { v: number; s: number };

/** Dollars within which a value counts as at a boundary. */
export const LINE_EPS = 1e-6;

export function lin(v = 0, s = 0): Lin {
  return { v, s };
}

/** The evaluation in progress: its mode, the rooms found so far, and whether it sits
 *  on a line where "at" can differ from just right of here. */
export const track = { right: false, room: Infinity, federalRoom: Infinity, onLine: false };

/** Starts an evaluation: "just right of x" when `right`, else "at x". */
export function begin(right: boolean): void {
  track.right = right;
  track.room = Infinity;
  track.federalRoom = Infinity;
  track.onLine = false;
}

/** Ends both rooms at `d` (if nearer). A cell's edge ends only `room`. */
export function limit(d: number, cell = false): void {
  if (!(d > 0)) return;
  if (d < track.room) track.room = d;
  if (!cell && d < track.federalRoom) track.federalRoom = d;
}

/** The room until `a` reaches `t`, in either direction. */
export function reaching(a: Lin, t: number, cell = false): void {
  if (a.s === 0) return;
  if (Math.abs(t - a.v) <= LINE_EPS) {
    track.onLine = true;
    return;
  }
  limit((t - a.v) / a.s, cell);
}

/** Whether a is at or under t, t itself counting as under. */
export function atOrUnder(a: Lin, t: number, cell = false): boolean {
  reaching(a, t, cell);
  const d = a.v - t;
  if (d > LINE_EPS) return false;
  if (d < -LINE_EPS) return true;
  return !(track.right && a.s > 0);
}

/** Whether a is at least t, t itself counting as above. */
export function atLeast(a: Lin, t: number, cell = false): boolean {
  reaching(a, t, cell);
  const d = a.v - t;
  if (d > LINE_EPS) return true;
  if (d < -LINE_EPS) return false;
  return !(track.right && a.s < 0);
}

export function set(out: Lin, v: number, s = 0): Lin {
  out.v = v;
  out.s = s;
  return out;
}

export function copy(out: Lin, a: Lin): Lin {
  out.v = a.v;
  out.s = a.s;
  return out;
}

/** out = a + k * b. */
export function addScaled(out: Lin, a: Lin, b: Lin, k = 1): Lin {
  const v = a.v + k * b.v;
  const s = a.s + k * b.s;
  out.v = v;
  out.s = s;
  return out;
}

/** out = k * a. */
export function scale(out: Lin, a: Lin, k: number): Lin {
  out.v = k * a.v;
  out.s = k * a.s;
  return out;
}

/** out = a + c, c a constant. */
export function plus(out: Lin, a: Lin, c: number): Lin {
  out.v = a.v + c;
  out.s = a.s;
  return out;
}

/** The smaller of a and b. At a tie, going right, the one with the smaller slope. */
export function smaller(out: Lin, a: Lin, b: Lin): Lin {
  const gap = b.v - a.v;
  const ds = a.s - b.s;
  if (ds !== 0) {
    if (Math.abs(gap) > LINE_EPS) limit(gap / ds);
    else track.onLine = true;
  }
  const pickA = gap > LINE_EPS ? true : gap < -LINE_EPS ? false : !track.right || a.s <= b.s;
  return pickA ? copy(out, a) : copy(out, b);
}

/** The larger of a and b. At a tie, going right, the one with the larger slope. */
export function larger(out: Lin, a: Lin, b: Lin): Lin {
  const gap = b.v - a.v;
  const ds = a.s - b.s;
  if (ds !== 0) {
    if (Math.abs(gap) > LINE_EPS) limit(gap / ds);
    else track.onLine = true;
  }
  const pickA = gap < -LINE_EPS ? true : gap > LINE_EPS ? false : !track.right || a.s >= b.s;
  return pickA ? copy(out, a) : copy(out, b);
}

/** The smaller of a and a constant c. */
export function atMost(out: Lin, a: Lin, c: number): Lin {
  reaching(a, c);
  const d = a.v - c;
  const keepA = d < -LINE_EPS ? true : d > LINE_EPS ? false : !track.right || a.s <= 0;
  return keepA ? copy(out, a) : set(out, c, 0);
}

/** The larger of a and a constant c. */
export function atLeastOf(out: Lin, a: Lin, c: number): Lin {
  reaching(a, c);
  const d = a.v - c;
  const keepA = d > LINE_EPS ? true : d < -LINE_EPS ? false : !track.right || a.s >= 0;
  return keepA ? copy(out, a) : set(out, c, 0);
}

/** The tax on `a` by ascending brackets (each "not over" its top). */
export function bracketTax(out: Lin, a: Lin, brackets: readonly Bracket[]): Lin {
  let tax = 0;
  let lower = 0;
  let rate = brackets[0].rate;
  for (let i = 0; i < brackets.length; i++) {
    const b = brackets[i];
    rate = b.rate;
    if (b.upTo === Infinity) {
      tax += (a.v - lower) * b.rate;
      break;
    }
    reaching(a, b.upTo);
    const over = a.v - b.upTo;
    const past = over > LINE_EPS || (Math.abs(over) <= LINE_EPS && track.right && a.s > 0);
    if (!past) {
      tax += (a.v - lower) * b.rate;
      break;
    }
    tax += (b.upTo - lower) * b.rate;
    lower = b.upTo;
  }
  out.v = a.v <= 0 ? 0 : tax;
  out.s = a.v <= 0 && !(track.right && a.s > 0 && a.v > -LINE_EPS) ? 0 : rate * a.s;
  return out;
}
