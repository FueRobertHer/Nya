// lib/goal-model.ts
//
// Savings goals as the app, the server and the read-only API exchange them
// (#42): the four fields every release has stored (lib/goals.ts), what this
// release adds as a goal's plan, and what the server works out and sends back
// read only. Pure, safe to import from client code: the stores are
// lib/goals.ts and lib/goal-plans.ts, the arithmetic lib/goal-allocation.ts
// and lib/goal-projection.ts.
//
// THE PLAN. What the person sets beyond a name, a target and an account: an
// allocation (the part of the tracked account's balance this goal claims, in
// that account's currency), a monthly target, a target date, and whether the
// goal is archived. A goal without an allocation claims what the allocated
// goals on its account leave, which is the whole balance when none is
// allocated: exactly what every goal did before plans existed.
//
// SENT WHOLE OR NOT AT ALL. A goal a PUT sends without `plan` keeps the plan
// stored for it: that is a client from before plans (a page cached on a
// phone), which knows nothing to clear. This release's client always sends
// `plan`, `{}` to clear it. So a page from the release before can never wipe
// an allocation it can't see.

import { isCalendarDay } from './manual-txn-input';

/** At most this many goals, archived ones included. The release before
 *  refuses to save more, so after a rollback it can still save the list. */
export const MAX_GOALS = 20;
export const MAX_GOAL_NAME_CHARS = 60;
/** As the release before cut ids and account ids. */
export const MAX_GOAL_ID_CHARS = 40;
export const MAX_ACCOUNT_ID_CHARS = 100;
/** The bound on an allocation or a monthly target, as on a manual balance. */
export const MAX_GOAL_AMOUNT = 1e12;
export const EARLIEST_TARGET_DATE = '2000-01-01';
export const LATEST_TARGET_DATE = '2100-12-31';

/** A goal id that can key a plan: the storage seam's id characters (goal ids
 *  are random UUIDs, so every goal the app made has one). */
const PLAN_ID = /^[A-Za-z0-9_.:-]{1,40}$/;
export const canHavePlan = (id: string) => PLAN_ID.test(id);

/** What the person sets beyond the four fields every release stores. */
export type GoalPlan = {
  /** The part of the tracked account's balance this goal claims, in that
   *  account's currency. Absent: it claims what the allocated goals leave. */
  allocation?: number;
  /** What the person means to put in each month. */
  monthly_target?: number;
  /** YYYY-MM-DD: when it should be reached. */
  target_date?: string;
  /** Kept with its history, out of the list and claiming nothing. */
  archived?: true;
};

/** Where the line to a target date starts: the day the date was set and what
 *  the goal held then (null when that wasn't known). */
export type GoalStart = { date: string; amount: number | null };

/** A goal as GET /api/goals answers it and PUT takes it back. */
export type Goal = {
  id: string;
  name: string;
  target: number;
  /** The account whose balance it counts; null when it tracks none. */
  account_id: string | null;
  /** Absent when nothing is set (and from a client from before plans). */
  plan?: GoalPlan;
  // Read only: worked out by the server from what it stores, ignored by PUT.
  /** Set with the target date: where "where you should be by now" starts. */
  plan_start?: GoalStart;
  /** The day it was archived, and what it held then (absent when unknown). */
  archived_on?: string;
  archived_amount?: number;
  /** Its account was reconnected under a new id, which it now follows. */
  relinked?: true;
  /** An allocation set on the account it tracked before: after a rollback,
   *  the release before moved it to another account. Not applied; the next
   *  save drops it. */
  earlier_allocation?: number;
};

/** A goal as a PUT sent it, checked: `plan` null when it was sent without
 *  one (keep what is stored). */
export type GoalInput = {
  id: string;
  name: string;
  target: number;
  account_id: string | null;
  plan: GoalPlan | null;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An amount the person typed for a plan field: finite, within bounds. */
const amountOk = (n: unknown, min: number, inclusive: boolean): n is number =>
  typeof n === 'number' && Number.isFinite(n) && (inclusive ? n >= min : n > min) && n <= MAX_GOAL_AMOUNT;

/** A plan as sent, checked field by field, or why not. Null fields are not
 *  set. A field it doesn't know is refused, never dropped. */
export function parsePlan(raw: unknown): { plan: GoalPlan } | { error: string } {
  if (!isObject(raw)) return { error: 'A goal’s plan is an object.' };
  const plan: GoalPlan = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    switch (key) {
      case 'allocation':
        if (!amountOk(value, 0, true)) return { error: 'An allocation is an amount from 0 up.' };
        plan.allocation = value;
        break;
      case 'monthly_target':
        if (!amountOk(value, 0, false)) return { error: 'A monthly target is an amount above 0.' };
        plan.monthly_target = value;
        break;
      case 'target_date':
        if (!isCalendarDay(value) || value < EARLIEST_TARGET_DATE || value > LATEST_TARGET_DATE) {
          return { error: 'A target date is a day between 2000 and 2100, YYYY-MM-DD.' };
        }
        plan.target_date = value;
        break;
      case 'archived':
        if (value !== true && value !== false) return { error: 'archived is true or false.' };
        if (value) plan.archived = true;
        break;
      default:
        return { error: `A goal’s plan has no field ${key.slice(0, 40)}.` };
    }
  }
  return { plan };
}

/**
 * The goal list as a PUT sent it, checked: each goal's four stored fields as
 * the release before checked them (so every goal it saved still saves), and
 * its plan field by field. What needs the stored goals or the balances (an
 * allocation against the balance, a new target date in the past, a credit
 * card) is checked in the route, which has them.
 */
export function parseGoals(raw: unknown): { goals: GoalInput[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length > MAX_GOALS) return { error: 'Invalid goals' };
  const goals: GoalInput[] = [];
  const ids = new Set<string>();
  for (const g of raw) {
    if (!isObject(g)) return { error: 'Invalid goal entry' };
    const id = String(g.id ?? '').slice(0, MAX_GOAL_ID_CHARS);
    const name = String(g.name ?? '').trim().slice(0, MAX_GOAL_NAME_CHARS);
    const target = Number(g.target);
    const account_id = g.account_id == null ? null : String(g.account_id).slice(0, MAX_ACCOUNT_ID_CHARS);
    if (!id || !name || !Number.isFinite(target) || target <= 0) return { error: 'Invalid goal entry' };
    if (ids.has(id)) return { error: 'Two goals have the same id.' };
    ids.add(id);
    let plan: GoalPlan | null = null;
    if (g.plan !== undefined) {
      const parsed = parsePlan(g.plan);
      if ('error' in parsed) return parsed;
      plan = parsed.plan;
      if (Object.keys(plan).length > 0 && !canHavePlan(id)) {
        return { error: 'This goal was saved by an early version of Nya and can’t hold a plan: add it again as a new goal.' };
      }
      if (plan.allocation !== undefined && account_id === null) return { error: 'An allocation needs an account to take it from.' };
    }
    goals.push({ id, name, target, account_id, plan });
  }
  return { goals };
}

/** Whether a plan sets nothing. */
export const emptyPlan = (p: GoalPlan | null | undefined) => !p || Object.keys(p).length === 0;
