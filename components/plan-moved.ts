// What D15 moved, in the words of the line that says so while it is new
// (the tax plan's screens.md): with the switch on (the flag
// 'plan-items-in-fi'), a plan's one-offs and income count in the walk to its
// FI date, and Your path and Progress each say once what that moved, until
// the person taps Got it (kept for the session by components/Dashboard.tsx)
// or the change is no longer new (lib/flag-read.ts newUntil). Only the date
// is named: D15 never moves the FI number.

import type { ItemAges } from '@/lib/fire/compile';
import { MONEY_KINDS, type PlanItem } from '@/lib/fire/items';
import type { PlanFigures } from '@/lib/fire/plan-figures';
import { yearsBetween, type SavedItems } from '@/lib/fire/saved-plan';

/** Whether the change is still new on `today` (YYYY-MM-DD): through
 *  `newUntil`, the last day it is, inclusive. */
export const stillNew = (newUntil: string | null | undefined, today: string): boolean => !!newUntil && today <= newUntil;

/** The age an item moves the walk at: a one-off's year, an income's first
 *  year, or, for one begun before today, its last (where the walk takes it
 *  out). Null where it doesn't. */
export function movesAt(item: PlanItem, ages: ItemAges, age: number): number | null {
  if (!ages) return null;
  if (item.kind === 'one-off' || ages.start >= age) return ages.start;
  return ages.end;
}

/** "Roof at 45", "Pension from 60", an income begun before today "Rent to 50". */
export function itemName(item: PlanItem, ages: ItemAges, age: number): string {
  if (!ages) return item.label;
  if (item.kind === 'one-off') return `${item.label} at ${ages.start}`;
  if (ages.start >= age) return `${item.label} from ${ages.start}`;
  return ages.end !== null ? `${item.label} to ${ages.end}` : item.label;
}

/** Two named, then how many more: "Roof at 45", "Roof at 45 and Car at 50",
 *  "Roof at 45, Car at 50 and 2 more". */
export function namesText(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** The plan's one-offs and income the walk counts, in item order, moving it
 *  before `by` (an age; null for any). */
export function countedNames(f: PlanFigures, by: number | null): string[] {
  const age = f.plan.age;
  if (age === null) return [];
  const out: string[] = [];
  for (const [i, item] of f.plan.items.entries()) {
    if (!f.inWalk[i] || !MONEY_KINDS.includes(item.kind)) continue;
    const at = movesAt(item, f.resolution.ages[i], age);
    if (at === null || (by !== null && at >= by)) continue;
    out.push(itemName(item, f.resolution.ages[i], age));
  }
  return out;
}

/**
 * Your path's line: the plan's FI date with the switch off and on, and what
 * moved it. Null when the rounded answers are the same, or there is nothing
 * to name.
 *   - "Your FI date moved from 53 to 54: Roof at 45 now counts in it."
 *   - "Your FI date was around 53 before Roof at 45 counted in it." (none now)
 *   - "Your FI date is around 60 now that Pension from 55 counts in it." (none before)
 */
export function fiMovedText(off: PlanFigures, on: PlanFigures): string | null {
  const a = off.view.fiAge === null ? null : Math.round(off.view.fiAge);
  const b = on.view.fiAge === null ? null : Math.round(on.view.fiAge);
  if (a === b) return null;
  // What moved the date is what the walk counts before the later of the two.
  const names = countedNames(on, a !== null && b !== null ? Math.max(a, b) : null);
  if (names.length === 0) return null;
  const list = namesText(names);
  const counts = names.length === 1 ? 'counts' : 'count';
  if (a !== null && b !== null) return `Your FI date moved from ${a} to ${b}: ${list} now ${counts} in it.`;
  if (a !== null) return `Your FI date was around ${a} before ${list} counted in it.`;
  return `Your FI date is around ${b} now that ${list} ${counts} in it.`;
}

/** The saved plan's one-offs and income its line counts from the `start`
 *  day through `day`, in item order. */
export function savedNames(items: SavedItems, start: string, day: string): string[] {
  const from = items.age + yearsBetween(items.from, start);
  const to = items.age + yearsBetween(items.from, day);
  const out: string[] = [];
  for (const { item, ages } of items.counted) {
    const at = movesAt(item, ages, items.age);
    if (at !== null && at >= from && at <= to) out.push(itemName(item, ages, items.age));
  }
  return out;
}

/** Progress's line, naming what its line now counts. */
export function progressMovedText(names: readonly string[]): string {
  return `Your saved plan’s line now counts ${namesText(names)}.`;
}
