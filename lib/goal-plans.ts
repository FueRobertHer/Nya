// lib/goal-plans.ts
//
// Where a goal's plan is kept (#42): the `goal-plans` map store on the storage
// seam (lib/repo.ts), one entry per goal id, beside the `goals` blob
// (lib/goals.ts) that keeps each goal's name, target and account as every
// release has. The release before this one reads that blob, and its PUT
// rewrites it with those four fields only, so nothing new is put there: a
// plan in the blob would be gone the first time that release saved.
//
// AN ENTRY holds the plan (lib/goal-model.ts: an allocation, a monthly target,
// a target date, archived, and what the server works out for them), the four
// fields' values as the save that wrote it left them in the blob (`core`, its
// witness), and what the goal read as before that save (`before`), so that a
// read can tell which of these it is looking at:
//   - the blob's goal is the witness: the entry's plan is the goal's plan. The
//     save finished, or it changed only the plan, which leaves the blob's four
//     fields as they were, so it is whole once its entry is written.
//   - the blob's goal is `before`'s witness: the save stopped between its two
//     writes (see THE WRITE ORDER). The goal reads as it did before it, plan
//     and all.
//   - anything else: the release before changed the goal after a rollback
//     (renamed it, or moved it to another account). Its plan still applies,
//     but an allocation only on the account it was set against, following
//     links (lib/links.ts): an allocation on one account is never a claim on
//     another. The goal then reads as it did there, claiming what the
//     allocated goals leave, and says what it had (`earlier_allocation`).
// An entry whose goal isn't in the blob (the release before deleted it, or a
// save adding it stopped before the blob was written) is never read as
// anyone's, and the next save deletes it. Goal ids are random, so no later
// goal can take it over.
//
// THE WRITE ORDER (writeGoalRecords). A save writes the entries whose goal
// changed, all in one HSET; then the blob; then deletes, in one HDEL, the
// entries of goals it removed, the orphans, and the entries it emptied. Read
// at any point between, every goal reads as it did before the save or as the
// save left it, never a mix: an entry already written for a goal whose blob
// write hadn't happened carries the goal as it was in `before`, a goal the
// save adds has no blob entry yet (so its entry is an orphan), and one it
// removes keeps its entry until after the blob says it is gone. Two devices
// saving at the same moment: the last save wins, as with the blob alone.
//
// READS ARE STRICT. An entry that can't be read stops the read
// (UnreadableEntriesError, which the routes answer with 409), never "no
// plan": the next save would write over the goal's plan with nothing. The
// shape is closed: a field a later release adds reads as unrecognised, and
// nothing here saves over it. Version 1 is the first shape, so there is
// nothing to upgrade yet.

import { defineMapStore } from './repo';
import type { Ctx } from './containers';
import { getGoals, setGoals, type Goal as StoredGoal } from './goals';
import { getLinks, effectiveLinks, liveAccountIds, resolveId, type Link } from './links';
import { isCalendarDay } from './manual-txn-input';
import { MAX_GOAL_AMOUNT, type Goal, type GoalPlan } from './goal-model';

/** A goal's four stored fields, without its id: what the blob holds. */
export type Witness = { name: string; target: number; account_id: string | null };

/** A goal's plan as stored. */
export type StoredPlan = {
  /** In the account's currency, bound to the account it was set on. */
  allocation?: { amount: number; account_id: string };
  monthly_target?: number;
  target_date?: string;
  /** Set by the server when the target date is set: the day, and what the
   *  goal held then (null when the balance wasn't known). */
  plan_start?: { date: string; amount: number | null };
  /** Set by the server when it is archived: the day, and what it held then. */
  archived?: { on: string; amount: number | null };
};

export type GoalPlanEntry = {
  v: 1;
  core: Witness;
  plan: StoredPlan;
  /** The goal as it read before the save that wrote this entry; null for a
   *  goal that save added. */
  before: { core: Witness; plan: StoredPlan } | null;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).every((k) => allowed.includes(k));
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const amountOrNull = (n: unknown) => n === null || finite(n);

function isWitness(v: unknown): v is Witness {
  return (
    isObject(v) &&
    onlyKeys(v, ['name', 'target', 'account_id']) &&
    typeof v.name === 'string' &&
    finite(v.target) &&
    (v.account_id === null || typeof v.account_id === 'string')
  );
}

function isStoredPlan(v: unknown): v is StoredPlan {
  if (!isObject(v) || !onlyKeys(v, ['allocation', 'monthly_target', 'target_date', 'plan_start', 'archived'])) return false;
  const { allocation, monthly_target, target_date, plan_start, archived } = v;
  if (
    allocation !== undefined &&
    !(isObject(allocation) && onlyKeys(allocation, ['amount', 'account_id']) && finite(allocation.amount) && allocation.amount >= 0 && allocation.amount <= MAX_GOAL_AMOUNT && typeof allocation.account_id === 'string' && allocation.account_id !== '')
  ) {
    return false;
  }
  if (monthly_target !== undefined && !(finite(monthly_target) && monthly_target > 0 && monthly_target <= MAX_GOAL_AMOUNT)) return false;
  if (target_date !== undefined && !isCalendarDay(target_date)) return false;
  if (plan_start !== undefined && !(isObject(plan_start) && onlyKeys(plan_start, ['date', 'amount']) && isCalendarDay(plan_start.date) && amountOrNull(plan_start.amount))) {
    return false;
  }
  if (archived !== undefined && !(isObject(archived) && onlyKeys(archived, ['on', 'amount']) && isCalendarDay(archived.on) && amountOrNull(archived.amount))) return false;
  return true;
}

/** The current shape, closed: anything else is unrecognised. */
export function isGoalPlanEntry(v: unknown): v is GoalPlanEntry {
  return (
    isObject(v) &&
    onlyKeys(v, ['v', 'core', 'plan', 'before']) &&
    v.v === 1 &&
    isWitness(v.core) &&
    isStoredPlan(v.plan) &&
    (v.before === null || (isObject(v.before) && onlyKeys(v.before, ['core', 'plan']) && isWitness(v.before.core) && isStoredPlan(v.before.plan)))
  );
}

export const goalPlansStore = defineMapStore<GoalPlanEntry>('goal-plans', {
  what: 'goal plans',
  isValid: isGoalPlanEntry,
  exportable: true, // what the person set for each goal
});

/** A goal from the blob, as its four fields: what every release reads, so
 *  whatever an earlier one left there reads as it always did. */
export type GoalCore = { id: string } & Witness;

export function coreOf(g: StoredGoal): GoalCore {
  const raw = g as Partial<Record<keyof StoredGoal, unknown>>;
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    target: Number(raw.target),
    account_id: typeof raw.account_id === 'string' ? raw.account_id : null,
  };
}

export const witnessOf = (g: Witness): Witness => ({ name: g.name, target: g.target, account_id: g.account_id });
const sameWitness = (a: Witness, b: Witness) => a.name === b.name && a.target === b.target && a.account_id === b.account_id;
const emptyStoredPlan = (p: StoredPlan) => Object.keys(p).length === 0;
const samePlan = (a: StoredPlan, b: StoredPlan) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
/** A plan with its fields in one order, for comparing. */
function canonical(p: StoredPlan): StoredPlan {
  return {
    ...(p.allocation ? { allocation: { amount: p.allocation.amount, account_id: p.allocation.account_id } } : {}),
    ...(p.monthly_target !== undefined ? { monthly_target: p.monthly_target } : {}),
    ...(p.target_date !== undefined ? { target_date: p.target_date } : {}),
    ...(p.plan_start ? { plan_start: { date: p.plan_start.date, amount: p.plan_start.amount } } : {}),
    ...(p.archived ? { archived: { on: p.archived.on, amount: p.archived.amount } } : {}),
  };
}

/** A goal as read: its four fields as stored, the plan the entry gives it
 *  (`stored`, by the rule in the header), and that plan as it applies
 *  (`plan`: an allocation set on another account taken off, and kept in
 *  `earlierAllocation`). */
export type GoalRecord = {
  core: GoalCore;
  stored: StoredPlan;
  plan: StoredPlan;
  earlierAllocation: number | null;
};

/** The plan an entry gives the goal (see AN ENTRY in the header). */
export function chosenPlan(core: Witness, entry: GoalPlanEntry | undefined): StoredPlan {
  if (!entry) return {};
  if (sameWitness(core, entry.core)) return entry.plan;
  if (entry.before && sameWitness(core, entry.before.core)) return entry.before.plan;
  return entry.plan;
}

/** Two account ids are the same account once links are followed. */
const sameAccount = (a: string | null, b: string | null, links: ReadonlyMap<string, Link>) =>
  a !== null && b !== null && resolveId(a, links as Map<string, Link>) === resolveId(b, links as Map<string, Link>);

/** The goal as read, from its blob entry and its plan entry. */
export function recordOf(g: GoalCore, entry: GoalPlanEntry | undefined, links: ReadonlyMap<string, Link>): GoalRecord {
  const stored = chosenPlan(g, entry);
  if (stored.allocation && !sameAccount(stored.allocation.account_id, g.account_id, links)) {
    const { allocation, ...rest } = stored;
    return { core: g, stored, plan: rest, earlierAllocation: allocation.amount };
  }
  return { core: g, stored, plan: stored, earlierAllocation: null };
}

export type GoalsRead = { records: GoalRecord[]; entries: Map<string, GoalPlanEntry>; links: Map<string, Link> };

/**
 * Every goal as read, in the blob's order, with the entries as stored and the
 * links followed (goalLinks, read after both stores). Strict: a blob or an
 * entry that can't be read throws (StoredDataUnreadableError), never reads as
 * no goals or no plan. `readOnly` for a reader that must change nothing.
 */
export async function readGoalRecords(ctx: Ctx, opts: { readOnly?: boolean } = {}): Promise<GoalsRead> {
  const goals = await getGoals(ctx);
  const entries = await goalPlansStore.getAll(ctx);
  const links = await goalLinks(ctx, opts);
  return { records: goals.map((g) => recordOf(coreOf(g), entries.get(coreOf(g).id), links)), entries, links };
}

/**
 * The account links that apply, for following a goal's account to the id it
 * has now. Lenient, as the goals route always was: links that can't be read
 * leave every id as stored, which can only leave a goal on an older id (it
 * then reads as disconnected), never move one to an account it doesn't track.
 * `readOnly` changes nothing while reading (lib/links.ts liveAccountIds).
 */
export async function goalLinks(ctx: Ctx, opts: { readOnly?: boolean } = {}): Promise<Map<string, Link>> {
  try {
    return effectiveLinks(await getLinks(ctx), await liveAccountIds(ctx, { readOnly: opts.readOnly }));
  } catch {
    return new Map();
  }
}

/** A goal as the app and the API are given it (lib/goal-model.ts Goal): its
 *  account followed to the id it has now, its plan, and what the server
 *  worked out, read only. */
export function wireGoal(r: GoalRecord, links: ReadonlyMap<string, Link>): Goal {
  const account_id = r.core.account_id ? resolveId(r.core.account_id, links as Map<string, Link>) : null;
  const plan: GoalPlan = {
    ...(r.plan.allocation ? { allocation: r.plan.allocation.amount } : {}),
    ...(r.plan.monthly_target !== undefined ? { monthly_target: r.plan.monthly_target } : {}),
    ...(r.plan.target_date !== undefined ? { target_date: r.plan.target_date } : {}),
    ...(r.plan.archived ? { archived: true as const } : {}),
  };
  return {
    id: r.core.id,
    name: r.core.name,
    target: r.core.target,
    account_id,
    ...(Object.keys(plan).length > 0 ? { plan } : {}),
    ...(r.plan.plan_start ? { plan_start: { date: r.plan.plan_start.date, amount: r.plan.plan_start.amount } } : {}),
    ...(r.plan.archived ? { archived_on: r.plan.archived.on, ...(r.plan.archived.amount !== null ? { archived_amount: r.plan.archived.amount } : {}) } : {}),
    ...(account_id !== r.core.account_id ? { relinked: true as const } : {}),
    ...(r.earlierAllocation !== null ? { earlier_allocation: r.earlierAllocation } : {}),
  };
}

/** A goal as a save leaves it: its four fields, and its plan as stored. */
export type NextGoal = { core: GoalCore; plan: StoredPlan };

/**
 * Saves the goal list, by THE WRITE ORDER in the header: the entries that
 * change, the blob, then the entries no goal needs. `read` is what this save
 * read, strictly, before deciding anything (readGoalRecords): each changed
 * entry carries the goal as it read then as its `before`. Writes nothing for a
 * goal whose four fields and plan are what its entry already holds.
 */
export async function writeGoalRecords(ctx: Ctx, next: readonly NextGoal[], read: { records: readonly GoalRecord[]; entries: ReadonlyMap<string, GoalPlanEntry> }): Promise<void> {
  const before = new Map(read.records.map((r) => [r.core.id, r]));
  const writes: [string, GoalPlanEntry][] = [];
  const emptied: string[] = [];
  for (const n of next) {
    const entry = read.entries.get(n.core.id);
    const was = before.get(n.core.id);
    if (!entry && emptyStoredPlan(n.plan)) continue;
    if (emptyStoredPlan(n.plan)) emptied.push(n.core.id);
    // Already what this save leaves: once the blob holds these four fields
    // the entry reads as it should, and until then its `before` still says
    // what the goal was.
    if (entry && sameWitness(entry.core, n.core) && samePlan(entry.plan, n.plan)) continue;
    writes.push([n.core.id, { v: 1, core: witnessOf(n.core), plan: canonical(n.plan), before: was ? { core: witnessOf(was.core), plan: canonical(was.stored) } : null }]);
  }
  if (writes.length > 0) await goalPlansStore.setMany(ctx, writes);
  await setGoals(ctx, next.map((n) => ({ id: n.core.id, name: n.core.name, target: n.core.target, account_id: n.core.account_id })));
  const kept = new Set(next.map((n) => n.core.id));
  const gone = [...read.entries.keys()].filter((id) => !kept.has(id));
  if (gone.length + emptied.length > 0) await goalPlansStore.remove(ctx, ...gone, ...emptied);
}
