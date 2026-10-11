// lib/goal-save.ts
//
// What a save of the goal list decides before anything is written (#42),
// between the route's strict read (lib/goal-plans.ts readGoalRecords) and its
// writes (writeGoalRecords): each goal's plan as the save leaves it, with what
// the server works out for it, and the checks that need what Nya knows of the
// accounts. Every check here is the server's own: the editor makes the same
// ones first, on the balances it shows, but a save is only ever taken on the
// balances the server last measured.
//
// THE CHECKS, beyond the fields' own (lib/goal-model.ts parseGoals):
//   - allocations never above the balance (lib/goal-allocation.ts
//     allocationRefusals): a save may not raise an account's allocations
//     above the newest balance Nya measured for it, nor raise them at all on
//     an account whose balance it doesn't know; allocations a balance that
//     fell no longer covers are kept, and shown scaled to fit;
//   - an allocation is in the account's currency, no finer than its smallest
//     unit, and so is a monthly target;
//   - a goal can't start tracking a credit card or a loan, nor take an
//     allocation from one: their balances are owed, not saved. One that
//     tracked one before is kept as it is (it shows no progress);
//   - nor an account that ended (lib/lifecycle.ts: closed, no longer the
//     person's, or no longer followed), which counts in nothing from its day:
//     nothing more can be set aside from it. A goal on one keeps its plan,
//     its allocation included, for if it is reopened;
//   - a target date set or changed is not in the past (a day of slack, for a
//     person whose day is behind the server's UTC one). One that passed since
//     it was set is kept.
//
// WHAT THE SERVER WORKS OUT. When a target date is first set, or the goal
// moves to another account, the day, what the goal holds then and the account
// it holds it on (`plan_start`): where "where you should be by now" starts.
// The day is the person's own (`today`, which the route takes from the page
// when it is within a day of the server's), not the server's UTC one. When it is
// archived, the day and what it held just before (`archived`), and its
// allocation is released. Each amount is null when the balance isn't known.
//
// A goal sent without a plan (a client from before plans) keeps its stored
// plan exactly, and is checked like any other only for what it changes.

import { allocationRefusals, type AllocGoal } from './goal-allocation';
import { goalViews, type GoalAccount } from './goal-view';
import { resolveId, type Link } from './link-core';
import { isOwedType } from './balance';
import { addDays, amountUnitsError } from './manual-txn-input';
import { formatMoney } from './format';
import { dayLabel, endedWhy } from './goal-text';
import type { Goal, GoalInput } from './goal-model';
import type { GoalCore, GoalRecord, NextGoal, StoredPlan } from './goal-plans';

/** An account as the server knows it: the newest balance it measured (the
 *  read-only API's, lib/api-read.ts readAccounts), and the day of it. */
export type KnownAccount = GoalAccount & { as_of: string | null };

type Draft = {
  core: GoalCore;
  plan: StoredPlan;
  was: GoalRecord | undefined;
  /** Its account now, followed through links, and before the save. */
  account: string | null;
  wasAccount: string | null;
  /** Its plan_start, or archived, needs what it holds: filled in below. */
  needsStart: boolean;
  needsArchivedAmount: boolean;
  /** Whether its allocation or monthly target is new or changed. */
  amountsChanged: boolean;
};

/** A save's plan for every goal, or the first reason it is refused (400). */
export async function planGoalSave(
  input: readonly GoalInput[],
  read: readonly GoalRecord[],
  opts: { today: string; links: ReadonlyMap<string, Link>; accounts: () => Promise<Map<string, KnownAccount> | null> }
): Promise<{ next: NextGoal[] } | { refused: string }> {
  const links = opts.links as Map<string, Link>;
  const resolve = (id: string | null) => (id === null ? null : resolveId(id, links));
  const byId = new Map(read.map((r) => [r.core.id, r]));
  const drafts: Draft[] = [];

  for (const g of input) {
    const was = byId.get(g.id);
    const core: GoalCore = { id: g.id, name: g.name, target: g.target, account_id: g.account_id };
    const account = resolve(core.account_id);
    const wasAccount = resolve(was?.core.account_id ?? null);
    if (g.plan === null) {
      drafts.push({ core, plan: was?.stored ?? {}, was, account, wasAccount, needsStart: false, needsArchivedAmount: false, amountsChanged: false });
      continue;
    }
    const p = g.plan;
    const moved = account !== wasAccount;
    const plan: StoredPlan = {};
    const archived = p.archived ? (was?.plan.archived ?? { on: opts.today, amount: null }) : undefined;
    // Archiving releases the allocation: an archived goal claims nothing.
    if (p.allocation !== undefined && !archived) plan.allocation = { amount: p.allocation, account_id: core.account_id! };
    if (p.monthly_target !== undefined) plan.monthly_target = p.monthly_target;
    let needsStart = false;
    if (p.target_date !== undefined) {
      if (p.target_date !== was?.plan.target_date && p.target_date < addDays(opts.today, -1)) {
        return { refused: 'A target date can’t be in the past: pick today or a day after it.' };
      }
      plan.target_date = p.target_date;
      // Kept while the goal stays on the account the line started on: the
      // read leaves out a start on another account (lib/goal-plans.ts
      // recordOf), however the goal got there.
      const start = was?.plan.target_date !== undefined && !moved ? was.plan.plan_start : undefined;
      if (start) plan.plan_start = start;
      else {
        plan.plan_start = { date: opts.today, amount: null, account_id: core.account_id };
        needsStart = true;
      }
    }
    if (archived) plan.archived = archived;
    const amountsChanged = plan.allocation?.amount !== was?.plan.allocation?.amount || (!!plan.allocation && moved) || plan.monthly_target !== was?.plan.monthly_target;
    drafts.push({ core, plan, was, account, wasAccount, needsStart, needsArchivedAmount: !!archived && !was?.plan.archived, amountsChanged });
  }

  const newlyTracked = drafts.filter((d) => d.account !== null && d.account !== d.wasAccount);
  const needAccounts = drafts.some((d) => d.amountsChanged || d.needsStart || d.needsArchivedAmount) || newlyTracked.length > 0;
  const known = needAccounts ? await opts.accounts() : null;
  const accountOf = (id: string | null) => (id === null ? undefined : known?.get(id));
  const nameOf = (id: string) => known?.get(id)?.name ?? 'that account';

  // A credit card or a loan: owed, not saved. An account that ended: from
  // its day it counts in nothing.
  for (const d of drafts) {
    const a = accountOf(d.account);
    if (a?.ended && newlyTracked.includes(d)) return { refused: `A goal can’t track ${a.name}: ${endedWhy(a.ended)}.` };
    if (!a?.type || !isOwedType(a.type)) continue;
    if (newlyTracked.includes(d)) {
      return { refused: `A goal can’t track ${a.name}: a credit card’s or a loan’s balance is money owed, not saved. Choose a savings account, or plan a payoff with the debt payoff planner.` };
    }
    if (d.plan.allocation && d.amountsChanged) return { refused: `Nothing can be allocated from ${a.name}: its balance is money owed, not saved.` };
  }

  // Amounts no finer than the account's currency allows.
  for (const d of drafts) {
    if (!d.amountsChanged) continue;
    const currency = accountOf(d.account)?.currency || 'USD';
    for (const amount of [d.plan.allocation?.amount, d.plan.monthly_target]) {
      const why = amount === undefined ? null : amountUnitsError(amount, currency);
      if (why) return { refused: `${why}.` };
    }
  }

  // Allocations against the balances, by the account each goal tracks now.
  // An allocation counts only on the account it was set on (one kept for a
  // goal a client from before plans moved is not a claim on the new one).
  const bound = (account: string | null, plan: StoredPlan) =>
    plan.allocation && account !== null && resolve(plan.allocation.account_id) === account ? plan.allocation.amount : undefined;
  const allocs = (goals: { id: string; account: string | null; plan: StoredPlan }[]): AllocGoal[] =>
    goals.map((g) => ({ id: g.id, account_id: g.account, allocation: bound(g.account, g.plan), archived: !!g.plan.archived }));
  const nextAllocs = allocs(drafts.map((d) => ({ id: d.core.id, account: d.account, plan: d.plan })));
  const storedAllocs = allocs(read.map((r) => ({ id: r.core.id, account: resolve(r.core.account_id), plan: r.plan })));
  // An account that ended has no balance to set aside from: allocations on it
  // may be kept or lowered, never raised.
  const balances = new Map([...(known ?? new Map<string, KnownAccount>())].map(([id, a]) => [id, { balance: a.ended ? null : a.balance, currency: a.currency }]));
  const refusal = allocationRefusals(nextAllocs, storedAllocs, balances)[0];
  if (refusal) {
    const money = (n: number) => formatMoney(n, refusal.currency);
    const name = nameOf(refusal.account_id);
    if (refusal.reason === 'no_balance') {
      const ended = accountOf(refusal.account_id)?.ended;
      return {
        refused: ended
          ? `Nothing more can be set aside from ${name}: ${endedWhy(ended)}.`
          : known
            ? `Nya has no balance for ${name} yet, so nothing more can be allocated from it.`
            : 'Your balances couldn’t be read just now, so a new allocation can’t be checked. Try again in a moment.',
      };
    }
    const asOf = accountOf(refusal.account_id)?.as_of;
    return {
      refused: `Allocations on ${name} would come to ${money(refusal.total)}, more than its balance of ${money(refusal.balance!)}${asOf ? ` as of ${dayLabel(asOf)}` : ''}. Lower them, or refresh your balances and try again.`,
    };
  }

  // What each goal holds, for the plan_start and archived amounts.
  if (drafts.some((d) => d.needsStart || d.needsArchivedAmount)) {
    const accounts = [...(known?.values() ?? [])];
    const asGoal = (id: string, account: string | null, plan: StoredPlan): Goal => ({
      id,
      name: id,
      target: 1,
      account_id: account,
      plan: { ...(bound(account, plan) !== undefined ? { allocation: bound(account, plan) } : {}), ...(plan.archived ? { archived: true as const } : {}) },
    });
    const holds = (goals: Goal[]) => new Map(goalViews(goals, accounts, null, opts.today).views.map((v) => [v.goal.id, v.saved]));
    const after = holds(drafts.map((d) => asGoal(d.core.id, d.account, d.plan)));
    const beforeSave = holds(read.map((r) => asGoal(r.core.id, resolve(r.core.account_id), r.plan)));
    for (const d of drafts) {
      if (d.needsStart) d.plan.plan_start = { date: opts.today, amount: known ? (after.get(d.core.id) ?? null) : null, account_id: d.core.account_id };
      if (d.needsArchivedAmount) d.plan.archived = { on: opts.today, amount: known ? (beforeSave.get(d.core.id) ?? null) : null };
    }
  }
  return { next: drafts.map((d) => ({ core: d.core, plan: d.plan })) };
}
