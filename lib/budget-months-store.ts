// lib/budget-months-store.ts
//
// Where budget rollover and income carryover are kept (#37, lib/rollover.ts):
// two value stores on the storage seam, beside the budget set and never in it
// (lib/budget-store.ts keeps that, in a closed shape this release doesn't
// change), keyed inside by the same category and group ids.
//
//   budget-months     what each budget had in past months, the months it
//                     rolled over, and when the record began (BudgetMonths)
//   income-carryover  whether income carryover is on, and its start month
//
// WHAT A ROLLBACK SEES. The release before this one reads neither store: it
// shows every budget flat, as before, from the budget set, which this release
// writes exactly as that release does. Nothing that release saves can reach
// these stores, so nothing it saves can corrupt them. What it changes in the
// budget set is noticed here the next time the app reads budgets (noteMonths:
// an amount that differs from what the record last saw is recorded as a
// change made in the month it is noticed, so the months before keep their
// amounts; a budget it removed ends its rollover; one it added had none
// before), and a category it merged or deleted is followed or dropped as one
// merged or deleted here is.
//
// WRITES. The app's reads of a month (app/api/budgets/month) begin the record
// the first time (its `since`), then note the budget set against it; a save of
// budgets notes it before and after writing the budget set (app/api/budgets);
// the rollover and income settings change through app/api/budgets/rollover. A
// merge moves a merged category's record onto the one it went into, and a
// delete drops one (app/api/categories). Every write is a compare-and-set
// (ValueStore.update) over what was just read, since a save, a merge and a
// setting can land together from two devices.
//
// READS ARE STRICT. A record that can't be read is never taken for none: the
// month's budgets answer 409 rather than showing every carry as zero, and a
// save of budgets is refused rather than rewriting the months before it with
// the new amount (app/api/budgets). The read-only API and the download read
// without writing: a change not noticed yet is noted in memory there.

import { defineValueStore } from './repo';
import type { Ctx } from './containers';
import type { Budgets } from './budget-set';
import { indexTaxonomy, type Taxonomy } from './categories';
import {
  isBudgetMonths,
  isIncomeCarryover,
  monthsAfterMerge,
  monthsWithout,
  noteBudgets,
  setIncome,
  startMonths,
  type BudgetMonths,
  type IncomeCarryover,
  type TargetKind,
} from './rollover';

export const budgetMonthsStore = defineValueStore<BudgetMonths>('budget-months', {
  what: 'budgets by month',
  isValid: isBudgetMonths,
  exportable: true, // what the person's budgets were, and which roll over: theirs
});

export const incomeCarryoverStore = defineValueStore<IncomeCarryover>('income-carryover', {
  what: 'income carryover settings',
  isValid: isIncomeCarryover,
  exportable: true, // a setting the person chose
});

/**
 * The record, noted against the budget set as it is now, in `month` (this
 * month, as the page has it): begun when there is none, from `before` (what
 * the budget set held before a save being recorded, else `budgets`), so a
 * first save records what it replaced. Writes only when something differs.
 * Strict.
 */
export async function noteMonths(ctx: Ctx, budgets: Budgets, taxonomy: Taxonomy, month: string, before: Budgets = budgets): Promise<BudgetMonths> {
  const ix = indexTaxonomy(taxonomy);
  return (await budgetMonthsStore.update(ctx, (cur) => noteBudgets(cur ?? startMonths(before, month), budgets, month, ix)))!;
}

/**
 * A change to the record (a rollover turned on or off, a carry reset), made
 * over the record noted against the budget set now, as one compare-and-set:
 * `change` may run more than once and throws RolloverError to refuse.
 */
export async function changeMonths(ctx: Ctx, budgets: Budgets, taxonomy: Taxonomy, month: string, change: (m: BudgetMonths) => BudgetMonths): Promise<BudgetMonths> {
  const ix = indexTaxonomy(taxonomy);
  return (await budgetMonthsStore.update(ctx, (cur) => change(noteBudgets(cur ?? startMonths(budgets, month), budgets, month, ix))))!;
}

/** Income carryover turned on from `start`, or off (its start kept).
 *  Strict; refuses (RolloverError) a start after this month or too far back. */
export async function changeIncome(ctx: Ctx, change: { enabled: true; start: string } | { enabled: false }, month: string): Promise<IncomeCarryover | null> {
  return incomeCarryoverStore.update(ctx, (cur) => setIncome(cur, change, month));
}

/** After a merge: each merged category's record moved onto the one it went
 *  into, as its budget is (lib/budget-store.ts moveMergedBudgets). */
export async function moveMergedMonths(ctx: Ctx, taxonomy: Taxonomy): Promise<void> {
  const ix = indexTaxonomy(taxonomy);
  await budgetMonthsStore.update(ctx, (cur) => cur && monthsAfterMerge(cur, ix));
}

/** After a category or group is deleted: its record dropped. */
export async function dropMonths(ctx: Ctx, kind: TargetKind, id: string): Promise<void> {
  await budgetMonthsStore.update(ctx, (cur) => cur && monthsWithout(cur, kind, id));
}
