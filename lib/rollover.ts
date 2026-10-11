// lib/rollover.ts
//
// Budget rollover and income carryover (#37), as pure functions, safe to
// import from client code: the shapes of the two stores that hold them
// (lib/budget-months-store.ts keeps both on the storage seam), how a change
// is recorded in them, and the money math: what a budget had in a past
// month, what it carries into a month, and what an income pool holds. The
// Budgets tab, the read-only API and MCP, and the data download all compute
// through these, so they agree (lib/budget-month.ts gathers what they read).
//
// BESIDE THE BUDGET SET, NEVER IN IT. Budgets stay in the `budget-set` store
// (lib/budget-set.ts), whose closed shape this release never changes, so the
// release before reads them exactly as before after a rollback. Everything
// rollover adds is kept beside it, keyed by the same category and group ids:
// what each budget was in past months, and the months it rolled over
// (BudgetMonths), and whether income carryover is on (IncomeCarryover).
//
// A PAST MONTH'S BUDGET IS WHAT IT WAS THEN. A budget's amount now is the
// budget set's. When it changes (a save here, or anything else that wrote the
// budget set, such as the release before after a rollback), the amount it
// had is recorded for the months before the month of the change (`amounts`,
// each `until` a month: that amount for the months before it, back to the
// entry before). So changing this month's amount never rewrites an earlier
// month's carry. A budget the record hasn't seen before (one added since) had
// none before the month it was first seen. Each target's `seen` is the amount
// the record last saw in the budget set: anything else there now is a change,
// recorded as of the month it is noticed (noteBudgets). The record began in
// `since`; for a month before it, Nya never knew the amount, so the earliest
// recorded one is used and said to be assumed. A change made twice in a month
// records the amount the month began with, once.
//
// THE CARRY, DERIVED, NEVER STORED. Rollover is a list of periods per budget,
// each from the month it was turned on (or reset) to the month it was turned
// off, the last one open while it is on. For a month M inside a period:
//   carry(M) = 0 at the month the carry counts from, then
//   carry(m + 1) = carry(m) + amount(m) - spent(m)
// where spent is the month's spending by the shared rule (lib/totals.ts
// spendingByCategory: one currency, not transfers, not what was excluded), so
// a recategorization, a merge, an exclusion or a rename changes every carry
// it touches at once. Available is amount + carry. A negative carry is kept:
// overspending digs a hole the next months climb out of. The carry counts
// from the period's first month, moved forward to the first month with any
// transactions (the clamp: before it nothing is known, and a budget would
// otherwise roll over in full), and to the first month with a budget after a
// month without one (no budget, nothing to roll over; the carry starts again
// from zero). A month whose transactions may be incomplete makes every carry
// counted across it uncertain, and says which months (coverage below).
//
// TURNING IT OFF AND ON. Off ends the open period at this month: this month's
// carry is zero at once, and earlier months still show theirs. On again starts
// a new period from the month chosen (this month by default), with a fresh
// carry: an earlier carry never comes back on its own. Choosing an earlier
// month replaces the periods from it on, so choosing the month it first
// started brings that carry back exactly, worked out again from the
// transactions. A reset ends the open period at this month and starts a new
// one from it, marked as a reset. Removing a budget ends its rollover too.
//
// GROUPS. A group's own budget can roll over like a category's: what is left
// of its own amount after everything spent in the group (its own budget caps
// all of it). The reconcile rule (lib/budget-set.ts) then works on what is
// available: a category's amount plus its carry, the group's own amount plus
// its own carry. So a group's meter shows min(its own available, its
// categories' available added up), its categories binding only when every
// one has a budget, and a group without an amount of its own rolls up its
// categories' available. The month's total is each group's limit once, as
// before: a carry counts in the total only through the one limit its group
// shows, never twice.
//
// MERGES AND DELETES. A merged category's record moves onto the one it went
// into, as its budget does (monthsAfterMerge, beside budgetsAfterMerge): past
// amounts are added month by month, since past spending is now counted
// together, and the rollover is the one it went into's, else its own. Until
// it moves (a merge the release before made), reads follow the merge and add
// the two up all the same (placeMonths). A deleted category or group's record
// is dropped. Archived categories roll over as any other: their budgets still
// count (lib/budget-set.ts).
//
// INCOME CARRYOVER, off by default. When on, from its start month:
//   pool(start) = 0, pool(m + 1) = pool(m) + income(m) - spending(m)
// where income is the month's money in and spending its money out, as the
// Activity tab totals a month (lib/totals.ts summarize): every inflow that
// counts, refunds and returns included, is money in, never taken off
// spending (a budget's meter doesn't go down when a refund arrives either),
// and transfers between the person's own accounts, cash and loan payments
// count as neither. Available to allocate is pool(M) + income(M) - spending(M):
// last month's leftover, plus this month's income so far, less this month's
// spending. pool(M) is exactly the months' net flows added up. It changes
// nothing about the budgets: off, nothing here is read.

import { categoriesIn, categoryById, type CategoryIndex } from './categories';
import { budgetMeters, isBudgetAmount, placeBudgets, type Budgets, type GroupMeter } from './budget-set';
import { monthGaps, type Incomplete, type Stopped } from './month-coverage';
import { tidy } from './totals';

// ---- Months ----

/** A month, YYYY-MM, from the year 1000 on (as the API takes one). */
const MONTH = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/;
export const isMonth = (v: unknown): v is string => typeof v === 'string' && MONTH.test(v);

/** The month `n` months after `month` (before, for negative `n`). */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Every month from `from` to `to`, both in, in order: none when `from` is later. */
export function monthsFrom(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** The month a day (YYYY-MM-DD) is in. */
export const monthOf = (day: string): string => day.slice(0, 7);

/** The months it can be anywhere at `now`: the UTC month, and the one before
 *  or after while some time zone is still or already in it (UTC-12 to
 *  UTC+14). A month a page says is "this month" is one of these. */
export function currentMonths(now: number = Date.now()): string[] {
  const at = (ms: number) => new Date(ms).toISOString().slice(0, 7);
  return [...new Set([at(now - 12 * 3600_000), at(now), at(now + 14 * 3600_000)])];
}

/** The month a page says it is, when it is one of currentMonths, else the
 *  UTC month: a stale or forged month never records a change elsewhere. */
export function thisMonth(asked: unknown, now: number = Date.now()): string {
  return isMonth(asked) && currentMonths(now).includes(asked) ? asked : new Date(now).toISOString().slice(0, 7);
}

// ---- The stored shapes ----

export const BUDGET_MONTHS_VERSION = 1;

/** An amount a budget had for the months before `until` (null: none). */
export type AmountUntil = { until: string; amount: number | null };

/** Months a budget rolled over: from `from` to the month before `to` (open:
 *  still on). `reset`: it began with the carry set to zero, ending the period
 *  before it. */
export type RolloverPeriod = { from: string; to?: string; reset?: true };

/** What is recorded of one budget, a category's or a group's own. */
export type TargetMonths = {
  /** The amount the record last saw in the budget set (null: none). */
  seen: number | null;
  /** Past amounts, oldest first (see A PAST MONTH'S BUDGET in the header). */
  amounts?: AmountUntil[];
  /** The months it rolled over, oldest first, never overlapping. */
  rollover?: RolloverPeriod[];
};

/** The `budget-months` store. */
export type BudgetMonths = {
  version: typeof BUDGET_MONTHS_VERSION;
  /** The month the record began: amounts before it are assumed. */
  since: string;
  categories: Record<string, TargetMonths>;
  groups: Record<string, TargetMonths>;
};

export const INCOME_CARRYOVER_VERSION = 1;

/** The `income-carryover` store: whether it is on, and the month its pool
 *  starts in (kept when it is turned off). */
export type IncomeCarryover = { version: typeof INCOME_CARRYOVER_VERSION; enabled: boolean; start: string };

/** Changes kept per budget: past this, the oldest goes, and the months before
 *  it take the next one's amount. Years of monthly changes. */
export const MAX_AMOUNT_CHANGES = 240;
/** Rollover periods kept per budget: past this, the oldest goes, which only
 *  changes what months long past show (a period's carry never depends on an
 *  earlier one). */
export const MAX_PERIODS = 24;
/** How far back a rollover or an income pool can start: ten years. */
export const MAX_MONTHS_BACK = 120;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A category's or group's id, as the budget set keeps one. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const only = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every((k) => allowed.includes(k));
const isAmountOrNone = (v: unknown): v is number | null => v === null || isBudgetAmount(v);

function isAmounts(v: unknown): v is AmountUntil[] {
  if (!Array.isArray(v) || v.length > MAX_AMOUNT_CHANGES) return false;
  return v.every(
    (a, i) => isRecord(a) && only(a, ['until', 'amount']) && isMonth(a.until) && isAmountOrNone(a.amount) && (i === 0 || (v[i - 1] as AmountUntil).until < a.until)
  );
}

function isPeriods(v: unknown): v is RolloverPeriod[] {
  if (!Array.isArray(v) || v.length > MAX_PERIODS) return false;
  return v.every((p, i) => {
    if (!isRecord(p) || !only(p, ['from', 'to', 'reset']) || !isMonth(p.from)) return false;
    if (p.to !== undefined && (!isMonth(p.to) || p.to <= p.from)) return false;
    if (p.reset !== undefined && p.reset !== true) return false;
    // Only the last may be open, and none starts before the one before ends.
    if (i < v.length - 1 && p.to === undefined) return false;
    const before = i > 0 ? (v[i - 1] as RolloverPeriod) : null;
    return !before || (before.to !== undefined && before.to <= p.from);
  });
}

function isTargetMonths(v: unknown): v is TargetMonths {
  return (
    isRecord(v) &&
    only(v, ['seen', 'amounts', 'rollover']) &&
    isAmountOrNone(v.seen) &&
    (v.amounts === undefined || isAmounts(v.amounts)) &&
    (v.rollover === undefined || isPeriods(v.rollover))
  );
}

function isTargets(v: unknown): v is Record<string, TargetMonths> {
  if (!isRecord(v)) return false;
  const entries = Object.entries(v);
  return entries.length <= 1000 && entries.every(([id, t]) => ID.test(id) && isTargetMonths(t));
}

/**
 * The `budget-months` shape, closed, as lib/budget-set.ts closes the budget
 * set: a field this release doesn't know (one a later release added) makes
 * the record unrecognised, so this release never saves over it and drops
 * what that release kept there (lib/repo.ts refuses to).
 */
export function isBudgetMonths(v: unknown): v is BudgetMonths {
  return (
    isRecord(v) &&
    only(v, ['version', 'since', 'categories', 'groups']) &&
    v.version === BUDGET_MONTHS_VERSION &&
    isMonth(v.since) &&
    isTargets(v.categories) &&
    isTargets(v.groups)
  );
}

/** The `income-carryover` shape, closed. */
export function isIncomeCarryover(v: unknown): v is IncomeCarryover {
  return (
    isRecord(v) &&
    only(v, ['version', 'enabled', 'start']) &&
    Object.keys(v).length === 3 &&
    v.version === INCOME_CARRYOVER_VERSION &&
    typeof v.enabled === 'boolean' &&
    isMonth(v.start)
  );
}

/** A change to rollover refused, with what to say to the person and the
 *  status a route answers with. */
export class RolloverError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400
  ) {
    super(message);
    this.name = 'RolloverError';
  }
}

// ---- Recording changes ----

export type TargetKind = 'categories' | 'groups';
const KINDS: readonly TargetKind[] = ['categories', 'groups'];

/** A new record, from the budgets as they are, begun in `month`: each
 *  budget's amount seen, nothing in the past known. */
export function startMonths(budgets: Budgets, month: string): BudgetMonths {
  const seen = (m: Record<string, { amount: number }>) => Object.fromEntries(Object.entries(m).map(([id, b]) => [id, { seen: b.amount }]));
  return { version: BUDGET_MONTHS_VERSION, since: month, categories: seen(budgets.categories), groups: seen(budgets.groups) };
}

/** The entries with neighbours of the same amount joined (the later `until`
 *  covers both), and only the newest MAX_AMOUNT_CHANGES. */
function compacted(amounts: AmountUntil[]): AmountUntil[] {
  const out: AmountUntil[] = [];
  for (const a of amounts) {
    const last = out[out.length - 1];
    if (last && last.amount === a.amount) out[out.length - 1] = { until: a.until, amount: a.amount };
    else out.push(a);
  }
  return out.slice(-MAX_AMOUNT_CHANGES);
}

/** A target's record without empty lists. */
function tidied(t: TargetMonths): TargetMonths {
  return {
    seen: t.seen,
    ...(t.amounts && t.amounts.length > 0 ? { amounts: t.amounts } : {}),
    ...(t.rollover && t.rollover.length > 0 ? { rollover: t.rollover } : {}),
  };
}

/** The periods with the open one ended at `month`: gone when it began then or
 *  later, so it never covered a month. */
export function endRollover(periods: readonly RolloverPeriod[], month: string): RolloverPeriod[] {
  const open = periods[periods.length - 1];
  if (!open || open.to !== undefined) return [...periods];
  const rest = periods.slice(0, -1);
  return open.from >= month ? rest : [...rest, { ...open, to: month }];
}

/** The periods with a new one open from `from` (a reset when `reset`): the
 *  periods from that month on replaced, one running into it ended there. */
export function startRollover(periods: readonly RolloverPeriod[], from: string, reset = false): RolloverPeriod[] {
  const kept = periods.filter((p) => p.from < from).map((p) => (p.to === undefined || p.to > from ? { ...p, to: from } : p));
  return [...kept, { from, ...(reset ? { reset: true as const } : {}) }].slice(-MAX_PERIODS);
}

/** A target's record after the budget set was seen holding `now` in `month`. */
function noted(t: TargetMonths, now: number | null, month: string): TargetMonths {
  const amounts = t.amounts ?? [];
  const last = amounts[amounts.length - 1];
  // The months before this one keep what they had: recorded once a month,
  // so a second change this month leaves the amount the month began with.
  const next = last && last.until >= month ? amounts : compacted([...amounts, { until: month, amount: t.seen }]);
  // No budget, nothing to roll over: removing a budget ends its rollover.
  const rollover = now === null && t.rollover ? endRollover(t.rollover, month) : t.rollover;
  return tidied({ seen: now, amounts: next, rollover });
}

/**
 * The record after reading the budget set in `month`: each budget whose
 * amount differs from what the record last saw has the amount it had kept
 * for the months before this one, and one first seen now had none before.
 * With `ix`, the record of a category or group the set no longer has, and
 * no budget, is dropped (it was deleted, here or by another release). The
 * record itself, unchanged, when nothing differs: a store's update then
 * writes nothing.
 */
export function noteBudgets(cur: BudgetMonths, budgets: Budgets, month: string, ix?: CategoryIndex): BudgetMonths {
  let changed = false;
  const next: BudgetMonths = { ...cur, categories: { ...cur.categories }, groups: { ...cur.groups } };
  for (const kind of KINDS) {
    const ids = new Set([...Object.keys(cur[kind]), ...Object.keys(budgets[kind])]);
    for (const id of ids) {
      const now = budgets[kind][id]?.amount ?? null;
      const t = cur[kind][id];
      if (!t) {
        if (now === null) continue;
        next[kind][id] = { seen: now, amounts: [{ until: month, amount: null }] };
        changed = true;
        continue;
      }
      const known = !ix || (kind === 'categories' ? categoryById(ix, id) !== null : ix.groupById.has(id));
      if (now === null && !known) {
        delete next[kind][id];
        changed = true;
        continue;
      }
      if (t.seen === now) continue;
      next[kind][id] = noted(t, now, month);
      changed = true;
    }
  }
  return changed ? next : cur;
}

/** A target's record, or a refusal when it has no budget now. */
function budgeted(cur: BudgetMonths, kind: TargetKind, id: string): TargetMonths {
  const t = cur[kind][id];
  if (!t || t.seen === null) throw new RolloverError('That budget no longer exists. Reload to see your budgets as they are.', 409);
  return t;
}

/** The earliest month a rollover or pool started in `month` can begin in. */
export const earliestStart = (month: string): string => addMonths(month, -MAX_MONTHS_BACK);

function checkStart(from: string, month: string): void {
  if (from > month) throw new RolloverError('Rollover can’t start after this month.');
  if (from < earliestStart(month)) throw new RolloverError(`Rollover can start at most ${MAX_MONTHS_BACK / 12} years back.`);
}

/**
 * Turns a budget's rollover on from `from` (or moves the start of one on),
 * or off from `month` (see TURNING IT OFF AND ON in the header). Refused
 * (RolloverError) for a budget that no longer exists, or a start after this
 * month or too far back.
 */
export function setRollover(cur: BudgetMonths, kind: TargetKind, id: string, change: { on: true; from: string } | { on: false }, month: string): BudgetMonths {
  const t = budgeted(cur, kind, id);
  let rollover: RolloverPeriod[];
  if (change.on) {
    checkStart(change.from, month);
    rollover = startRollover(t.rollover ?? [], change.from);
  } else {
    rollover = endRollover(t.rollover ?? [], month);
  }
  return { ...cur, [kind]: { ...cur[kind], [id]: tidied({ ...t, rollover }) } };
}

/** The carry set to zero from `month`: the open period ends there and a new
 *  one begins, marked as a reset. Refused unless the budget rolls over now. */
export function resetCarry(cur: BudgetMonths, kind: TargetKind, id: string, month: string): BudgetMonths {
  const t = budgeted(cur, kind, id);
  const open = t.rollover?.[t.rollover.length - 1];
  if (!open || open.to !== undefined) throw new RolloverError('That budget doesn’t roll over, so it has no carry to reset.', 409);
  if (open.from >= month) return cur;
  return { ...cur, [kind]: { ...cur[kind], [id]: tidied({ ...t, rollover: startRollover(t.rollover!, month, true) }) } };
}

/** The amount a budget's record says it had in `month`, with `current` its
 *  amount now (the budget set's). */
export function amountIn(t: TargetMonths | undefined, current: number | null, month: string): number | null {
  for (const a of t?.amounts ?? []) if (month < a.until) return a.amount;
  return current;
}

/** Two records' amounts added up month by month: a merged category's onto
 *  the one it went into. */
function addedAmounts(a: TargetMonths, b: TargetMonths): { amounts: AmountUntil[]; seen: number | null } {
  const plus = (x: number | null, y: number | null) => (x === null ? y : y === null ? x : Math.round((x + y) * 100) / 100);
  const untils = [...new Set([...(a.amounts ?? []), ...(b.amounts ?? [])].map((e) => e.until))].sort();
  const amounts = untils.map((until) => {
    const before = addMonths(until, -1);
    return { until, amount: plus(amountIn(a, a.seen, before), amountIn(b, b.seen, before)) };
  });
  return { amounts: compacted(amounts), seen: plus(a.seen, b.seen) };
}

/**
 * The record with each merged category's moved onto the one it went into
 * (lib/categories.ts categoryById follows a merge), as budgetsAfterMerge
 * moves its budget: amounts added month by month, and the rollover of the one
 * it went into, else its own. A record on a category no longer there is left
 * as it is (noteBudgets drops it). The record itself when nothing moves.
 */
export function monthsAfterMerge(cur: BudgetMonths, ix: CategoryIndex): BudgetMonths {
  const moving = Object.keys(cur.categories)
    .filter((id) => {
      const to = categoryById(ix, id);
      return to !== null && to.id !== id;
    })
    .sort();
  if (moving.length === 0) return cur;
  const categories = { ...cur.categories };
  for (const id of moving) {
    const to = categoryById(ix, id)!.id;
    const from = categories[id];
    const into = categories[to];
    delete categories[id];
    if (!into) {
      categories[to] = from;
      continue;
    }
    const { amounts, seen } = addedAmounts(into, from);
    categories[to] = tidied({ seen, amounts, rollover: into.rollover?.length ? into.rollover : from.rollover });
  }
  return { ...cur, categories };
}

/** The record without a deleted category's or group's. */
export function monthsWithout(cur: BudgetMonths, kind: TargetKind, id: string): BudgetMonths {
  if (!cur[kind][id]) return cur;
  const rest = { ...cur[kind] };
  delete rest[id];
  return { ...cur, [kind]: rest };
}

/** The income setting turned on from `start`, or off (its start kept). */
export function setIncome(cur: IncomeCarryover | null, change: { enabled: true; start: string } | { enabled: false }, month: string): IncomeCarryover | null {
  if (!change.enabled) return cur && { ...cur, enabled: false };
  if (change.start > month) throw new RolloverError('Income carryover can’t start after this month.');
  if (change.start < earliestStart(month)) throw new RolloverError(`Income carryover can start at most ${MAX_MONTHS_BACK / 12} years back.`);
  return { version: INCOME_CARRYOVER_VERSION, enabled: true, start: change.start };
}

// ---- Reading a month ----

/** One budget as placed for reading: the records under it (a merged
 *  category's beside the one it went into) and the periods it rolls over. */
type Placed = { parts: { t: TargetMonths | undefined; current: number | null }[]; rollover: readonly RolloverPeriod[] };

/**
 * Every budget, recorded or set now, by the category or group it counts on
 * now: a merged category's added to where it went, one on a category or
 * group no longer there left out (an orphan, lib/budget-set.ts placeBudgets).
 * The rollover is the record's own on that id, else a merged one's.
 */
export function placeMonths(budgets: Budgets, months: BudgetMonths | null, ix: CategoryIndex): { categories: Map<string, Placed>; groups: Map<string, Placed> } {
  const place = (kind: TargetKind, final: (id: string) => string | null) => {
    const out = new Map<string, Placed & { own: boolean }>();
    const ids = [...new Set([...Object.keys(budgets[kind]), ...Object.keys(months?.[kind] ?? {})])].sort();
    for (const id of ids) {
      const to = final(id);
      if (to === null) continue;
      const t = months?.[kind][id];
      const part = { t, current: budgets[kind][id]?.amount ?? null };
      const p = out.get(to) ?? { parts: [], rollover: [], own: false };
      p.parts.push(part);
      // Its own id's periods win over one merged into it.
      if (t?.rollover?.length && (id === to || (!p.own && p.rollover.length === 0))) {
        p.rollover = t.rollover;
        p.own = id === to;
      }
      out.set(to, p);
    }
    return new Map([...out].map(([id, { parts, rollover }]) => [id, { parts, rollover }]));
  };
  return {
    categories: place('categories', (id) => categoryById(ix, id)?.id ?? null),
    groups: place('groups', (id) => (ix.groupById.has(id) ? id : null)),
  };
}

/** A placed budget's amount in a month: its parts added up, null with none. */
function placedAmount(p: Placed, month: string): number | null {
  let total: number | null = null;
  for (const { t, current } of p.parts) {
    const a = amountIn(t, current, month);
    if (a !== null) total = tidy((total ?? 0) + a);
  }
  return total;
}

/** The period covering a month, or null. */
export function periodIn(periods: readonly RolloverPeriod[] | undefined, month: string): RolloverPeriod | null {
  return (periods ?? []).find((p) => p.from <= month && (p.to === undefined || month < p.to)) ?? null;
}

/** Why the carry counts from the month it does: the month rollover was turned
 *  on from (`start`), a reset (`reset`), the first month with transactions
 *  (`data`: the clamp), the first month with this budget after one without
 *  (`budget`), or no transactions in or before the month at all (`none`: the
 *  carry is zero). */
export type CarryFrom = 'start' | 'reset' | 'data' | 'budget' | 'none';

/** A budget's carry into a month. */
export type Carry = {
  carry: number;
  /** The month the carry counts from, and why it is that month. */
  from: string;
  why: CarryFrom;
  /** The month its rollover period began (as turned on or reset). */
  start: string;
  /** The months it counts whose transactions may be incomplete. */
  uncertain: string[];
};

/** Each budget rolling over in a month, by category or group id. */
export type Carries = { categories: Record<string, Carry>; groups: Record<string, Carry> };

/** What a carry is worked out from. */
export type CarryInput = {
  /** The first month with any transactions, or null with none at all. */
  earliest: string | null;
  /** Whether a month's transactions may be incomplete. */
  uncertain: (month: string) => boolean;
};

/**
 * A budget's carry into `month` (see THE CARRY in the header), or null when
 * it doesn't roll over then or has no amount that month. `amount` and
 * `spent` give each earlier month's.
 */
export function carryInto(
  periods: readonly RolloverPeriod[] | undefined,
  month: string,
  amount: (m: string) => number | null,
  spent: (m: string) => number,
  input: CarryInput
): Carry | null {
  const p = periodIn(periods, month);
  if (!p || amount(month) === null) return null;
  let from = p.from;
  let why: CarryFrom = p.reset ? 'reset' : 'start';
  // Nothing known before the first month with transactions: counted from it
  // (the clamp), and from the month itself when none comes before it.
  if (input.earliest === null || input.earliest > month) {
    from = month;
    why = 'none';
  } else if (input.earliest > from) {
    from = input.earliest;
    why = 'data';
  }
  let carry = 0;
  for (let m = from; m < month; m = addMonths(m, 1)) {
    const a = amount(m);
    if (a === null) {
      // No budget that month: the carry starts again after it.
      carry = 0;
      from = addMonths(m, 1);
      why = 'budget';
      continue;
    }
    carry = tidy(carry + a - spent(m));
  }
  return { carry, from, why, start: p.from, uncertain: monthsFrom(from, addMonths(month, -1)).filter(input.uncertain) };
}

/** What a month's budgets are read from. */
export type MonthInput = CarryInput & {
  ix: CategoryIndex;
  /** The budget set now. */
  budgets: Budgets;
  /** The record, already noted against the budget set (noteBudgets); null
   *  when nothing has been recorded yet. */
  months: BudgetMonths | null;
  /** The month shown, and this month (when a record not begun yet would). */
  month: string;
  today: string;
  /** Each month's spending by category id (lib/totals.ts spendingByCategory). */
  spending: (month: string) => ReadonlyMap<string, number>;
};

/** A month's budgets: each one's amount that month (a merged category's on
 *  the one it went into), which of them are assumed, and what rolls over. */
export type MonthBudgets = {
  month: string;
  budgets: Budgets;
  /** Ids whose amount that month was never recorded (before the record began,
   *  `recorded_since`): the earliest recorded amount stands in for it. */
  assumed: { categories: string[]; groups: string[] };
  recorded_since: string;
  carries: Carries;
};

/** Every budget in a month, and its carry into it (see the header). */
export function budgetsInMonth(input: MonthInput): MonthBudgets {
  const { ix, month } = input;
  const placed = placeMonths(input.budgets, input.months, ix);
  const since = input.months?.since ?? input.today;
  // Each month's spending, once.
  const memo = new Map<string, ReadonlyMap<string, number>>();
  const spending = (m: string) => {
    let s = memo.get(m);
    if (!s) memo.set(m, (s = input.spending(m)));
    return s;
  };
  const groupSpent = (gid: string) => (m: string) => {
    let total = 0;
    for (const c of categoriesIn(ix.taxonomy, gid)) total += spending(m).get(c.id) ?? 0;
    return total;
  };
  const out: MonthBudgets = { month, budgets: { categories: {}, groups: {} }, assumed: { categories: [], groups: [] }, recorded_since: since, carries: { categories: {}, groups: {} } };
  for (const kind of KINDS) {
    for (const [id, p] of placed[kind]) {
      const amount = placedAmount(p, month);
      if (amount === null) continue;
      out.budgets[kind][id] = { amount };
      if (month < since) out.assumed[kind].push(id);
      const spent = kind === 'categories' ? (m: string) => spending(m).get(id) ?? 0 : groupSpent(id);
      const carry = carryInto(p.rollover, month, (m) => placedAmount(p, m), spent, input);
      if (carry) out.carries[kind][id] = carry;
    }
  }
  return out;
}

/** Placed budgets (lib/budget-set.ts placeBudgets) with each one's carry
 *  added: what is available, for the reconcile rule to work on. */
export function withCarry(placed: ReturnType<typeof placeBudgets>, carries: Carries | null | undefined): ReturnType<typeof placeBudgets> {
  if (!carries) return placed;
  const add = (m: Map<string, number>, c: Record<string, Carry>) => new Map([...m].map(([id, a]) => [id, tidy(a + (c[id]?.carry ?? 0))]));
  return { categories: add(placed.categories, carries.categories), groups: add(placed.groups, carries.groups), orphans: placed.orphans };
}

/** The month's meters on what is available (see GROUPS in the header): each
 *  group's limit by the reconcile rule over amounts with their carries. */
export function availableMeters(ix: CategoryIndex, budgets: Budgets, carries: Carries | null | undefined, spent: ReadonlyMap<string, number>): { groups: GroupMeter[]; total: { budget: number; spent: number } } {
  return budgetMeters(ix, withCarry(placeBudgets(budgets, ix), carries), spent);
}

// ---- The income pool ----

/** One month of the pool: what it held coming in, the month's money in and
 *  out, and what it holds going out (next month's coming in). */
export type PoolMonth = { month: string; carried_in: number; income: number; spending: number; carried_out: number; uncertain: boolean };

export type IncomePool = {
  /** The month chosen, and the month the pool counts from: moved to the
   *  first month with transactions when earlier (clamped). */
  start: string;
  from: string;
  clamped: boolean;
  /** Last month's leftover, this month's income so far and spending, and
   *  what is available to allocate: the three together. */
  carried_in: number;
  income: number;
  spending: number;
  available: number;
  /** Months counted whose transactions may be incomplete. */
  uncertain: string[];
  /** Each month from `from` to the one shown, oldest first. */
  months: PoolMonth[];
};

/**
 * The income pool as of `month` (see INCOME CARRYOVER in the header), or null
 * when income carryover is off. `flows` gives a month's money in and out as
 * the Activity tab totals it (lib/totals.ts summarize).
 */
export function incomePool(
  setting: IncomeCarryover | null,
  month: string,
  flows: (m: string) => { money_in: number; money_out: number },
  input: CarryInput
): IncomePool | null {
  if (!setting?.enabled) return null;
  const data = input.earliest ?? addMonths(month, 1);
  const from = data > setting.start ? data : setting.start;
  const months: PoolMonth[] = [];
  let carried = 0;
  for (const m of monthsFrom(from, month)) {
    const f = flows(m);
    const out = tidy(carried + f.money_in - f.money_out);
    months.push({ month: m, carried_in: carried, income: tidy(f.money_in), spending: tidy(f.money_out), carried_out: out, uncertain: input.uncertain(m) });
    carried = out;
  }
  const last = months[months.length - 1];
  return {
    start: setting.start,
    from,
    clamped: from !== setting.start,
    carried_in: last?.carried_in ?? 0,
    income: last?.income ?? 0,
    spending: last?.spending ?? 0,
    available: last?.carried_out ?? 0,
    uncertain: months.filter((m) => m.uncertain).map((m) => m.month),
    months,
  };
}

// ---- Coverage: which months may be incomplete ----

/** One reason a month's transactions may be incomplete. */
export type MonthGap =
  /** An institution's transactions couldn't be loaded, or none are stored yet. */
  | { kind: 'missing'; institution: string }
  /** Its older transactions are still arriving. */
  | { kind: 'importing'; institution: string }
  /** Its connection is broken, and last synced (an instant) before the month
   *  ended, or never. */
  | { kind: 'stopped'; institution: string; since: string | null }
  /** Its stored transactions begin (a day) after the month began. */
  | { kind: 'begins'; institution: string; first: string }
  /** A bank account or card there whose transactions Plaid doesn't provide
   *  (`refused`), or the person didn't allow (`no_consent`). */
  | { kind: 'without'; institution: string; reason: 'refused' | 'no_consent' }
  /** Something the read couldn't read, in words ("your own categories"). */
  | { kind: 'unread'; what: string }
  /** Transactions that month whose exclusion couldn't be read: counted. */
  | { kind: 'exclusions'; count: number };

/** What says whether a month's transactions may be incomplete, gathered by
 *  lib/budget-month.ts from the read. */
export type CoverageFacts = {
  /** Institutions whose transactions aren't all in the read (lib/month-coverage.ts). */
  incomplete: Incomplete[];
  /** Connections whose transactions stopped arriving, and when each last synced. */
  stopped: Stopped[];
  /** Each linked institution's first stored day. */
  first: { institution: string; day: string }[];
  without: { institution: string; reason: 'refused' | 'no_consent' }[];
  /** What couldn't be read, in words: every month may be short of it. */
  unread: string[];
  /** Transactions whose exclusion couldn't be read, by month. */
  exclusionUnknown: ReadonlyMap<string, number>;
};

export const NO_COVERAGE_GAPS: CoverageFacts = { incomplete: [], stopped: [], first: [], without: [], unread: [], exclusionUnknown: new Map() };

/** Why a month's transactions may be incomplete: none when nothing says so. */
export function monthGapsOf(month: string, facts: CoverageFacts): MonthGap[] {
  const g = monthGaps(month, facts.incomplete, facts.stopped);
  const out: MonthGap[] = [
    ...g.missing.map((institution): MonthGap => ({ kind: 'missing', institution })),
    ...g.importing.map((institution): MonthGap => ({ kind: 'importing', institution })),
    ...g.stopped.map((s): MonthGap => ({ kind: 'stopped', institution: s.institution_name, since: s.last_ok_at })),
    ...facts.without.map((w): MonthGap => ({ kind: 'without', institution: w.institution, reason: w.reason })),
    ...facts.unread.map((what): MonthGap => ({ kind: 'unread', what })),
  ];
  // An institution missing or still importing is said so already.
  const said = new Set([...g.missing, ...g.importing]);
  for (const f of facts.first) if (!said.has(f.institution) && `${month}-01` < f.day) out.push({ kind: 'begins', institution: f.institution, first: f.day });
  const unknown = facts.exclusionUnknown.get(month) ?? 0;
  if (unknown > 0) out.push({ kind: 'exclusions', count: unknown });
  return out;
}

/** A reason in words, for a note. `day` names a day or an instant's day
 *  ("Mar 5"), on the reader's calendar where it has one. */
export function gapText(g: MonthGap, day: (isoOrDay: string) => string): string {
  switch (g.kind) {
    case 'missing':
      return `${g.institution}’s transactions couldn’t be loaded`;
    case 'importing':
      return `${g.institution} is still importing older transactions`;
    case 'stopped':
      return g.since ? `${g.institution} hasn’t synced since ${day(g.since)}` : `${g.institution} isn’t syncing`;
    case 'begins':
      return `${g.institution}’s stored transactions begin on ${day(g.first)}`;
    case 'without':
      return g.reason === 'refused'
        ? `Plaid doesn’t provide transactions for the bank or card accounts at ${g.institution}`
        : `you didn’t allow Nya to see transactions from the bank or card accounts at ${g.institution}`;
    case 'unread':
      return `${g.what} couldn’t be read`;
    case 'exclusions':
      return `whether you excluded ${g.count} transaction${g.count === 1 ? '' : 's'} couldn’t be read`;
  }
}

// ---- Words ----

/** "March", or "March 2025" when not in the year of `year`'s month. */
export function monthName(month: string, inYearOf?: string): string {
  const [y, m] = month.split('-').map(Number);
  const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  return inYearOf && inYearOf.slice(0, 4) === month.slice(0, 4) ? name : `${name} ${y}`;
}

/** "March", "March and April", or "3 months from March": months that may be
 *  incomplete, for "may be off: ... incomplete". */
export function monthsText(months: readonly string[], inYearOf?: string): string {
  if (months.length === 1) return monthName(months[0], inYearOf);
  if (months.length === 2) return `${monthName(months[0], inYearOf)} and ${monthName(months[1], inYearOf)}`;
  return `${months.length} months from ${monthName(months[0], inYearOf)}`;
}

/** What a carry says beneath its meter: "+$120 rolled over", "$45 overspent,
 *  carried over", and, when it counts a month that may be incomplete, that it
 *  may be off and which. `money` formats an amount. */
export function carryText(c: Carry, money: (n: number) => string, month: string): string {
  const what =
    c.carry > 0 ? `+${money(c.carry)} rolled over` : c.carry < 0 ? `${money(-c.carry)} overspent, carried over` : c.from === month ? 'Nothing to carry over yet' : 'Nothing carried over';
  if (c.uncertain.length === 0) return what;
  const one = c.uncertain.length === 1;
  return `${what} (may be off: ${monthsText(c.uncertain, month)} ${one ? 'is' : 'are'} incomplete)`;
}

/** Since when it rolls over, and why from then: "Rolling over since March",
 *  "Carryover reset in August", "Rolling over since June 2024, the first
 *  month with transactions". */
export function sinceText(c: Carry, month: string): string {
  const at = monthName(c.from, month);
  switch (c.why) {
    case 'start':
      return `Rolling over since ${at}`;
    case 'reset':
      return `Carryover reset in ${at}`;
    case 'data':
      return `Rolling over since ${at}, the first month with transactions`;
    case 'budget':
      return `Rolling over since ${at}, the first month with this budget since rollover began`;
    case 'none':
      return 'Rolling over, with no transactions to count yet';
  }
}

/** Months to choose a start from, newest first: this month back to the first
 *  month with transactions (or MAX_MONTHS_BACK, if sooner), at least a year. */
export function startChoices(today: string, earliest: string | null): string[] {
  const floor = earliestStart(today);
  const first = earliest && earliest > floor ? earliest : floor;
  const from = first < addMonths(today, -11) ? first : addMonths(today, -11);
  return monthsFrom(from, today).reverse();
}
