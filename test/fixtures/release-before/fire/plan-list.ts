// lib/fire/plan-list.ts
//
// What a person's list of plans shares: how many copies it holds beside your
// plan (lib/fire/copies.ts), how long a plan's name can be and that no two
// share one, and the settings two plans are told apart by, in the order they
// are said (components/plan-diff.ts). This is what is left of the Plan's
// scenarios, which copies replaced, and its constants keep the old word.
//
// Imports nothing: the routes and the browser both use it.

/** The settings said one by one when two plans differ, in this order. `mix`
 *  is stocksPct and bondsPct together. */
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

/** How many copies a person can have beside their plan. */
export const MAX_PLAN_SCENARIOS = 10;
/** How long a plan's name can be, in characters. */
export const SCENARIO_NAME_MAX = 40;

/** Whether a name is another plan's already, in any case. */
export function nameTaken(names: readonly { id: string; name: string }[], name: string, exceptId: string | null = null): boolean {
  const n = name.trim().toLowerCase();
  return names.some((s) => s.id !== exceptId && s.name.trim().toLowerCase() === n);
}
