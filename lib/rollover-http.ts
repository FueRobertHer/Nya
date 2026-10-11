// lib/rollover-http.ts
//
// What the routes for budget rollover and income carryover (#37) share:
// app/api/budgets/month, which answers a month of budgets, and
// app/api/budgets/rollover, which changes the settings: how a failure is
// answered, by the storage seam's rules (lib/repo.ts IN A ROUTE), and how the
// month a page asks about, and the month it says it is, are checked.

import { NextResponse } from 'next/server';
import { containerUnavailable } from './data-ctx';
import { StoredDataUnreadableError, StoreRefusedError, UnreadableEntriesError, describeUnreadable } from './repo';
import { BudgetError } from './budget-set';
import { addMonths, currentMonths, isMonth, MAX_MONTHS_BACK, RolloverError } from './rollover';

/** What a failure answers: the container (503); stored data that can't be
 *  read (409, flagged, so the page never shows "none" and saves over it,
 *  with the ids of a map store's entries); the seam refusing a write, or a
 *  change refused (their status); anything else a plain 500. */
export function rolloverFailure(err: unknown, what: string): NextResponse {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  if (err instanceof StoredDataUnreadableError) {
    console.error('Stored budgets unreadable:', describeUnreadable(err));
    const ids = err instanceof UnreadableEntriesError ? { unreadable_ids: err.unreadable, unrecognised_ids: err.unrecognised } : {};
    return NextResponse.json({ error: err.message, unreadable: true, ...ids }, { status: 409 });
  }
  if (err instanceof StoreRefusedError || err instanceof BudgetError || err instanceof RolloverError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error(err);
  return NextResponse.json({ error: what }, { status: 500 });
}

/** Whether `v` is a month some time zone is in now: what a page sends as
 *  "this month". */
export const isThisMonth = (v: unknown, now: number = Date.now()): v is string => isMonth(v) && currentMonths(now).includes(v);

const PARAMS = new Set(['month', 'today', 'history']);

/** A month view's query, checked: `today`, this month as the page has it
 *  (the UTC month without one), and `month`, the one shown (today by
 *  default), no later than today and at most MAX_MONTHS_BACK months back;
 *  `history=1` to read the stored history even when nothing in the month
 *  counts it (lib/budget-month.ts ONLY WHAT IS COUNTED IS READ). Nothing else
 *  is taken, and nothing twice. */
export function readMonthParams(params: URLSearchParams, now: number = Date.now()): { month: string; today: string; history: boolean } | { error: string } {
  for (const key of new Set(params.keys())) {
    if (!PARAMS.has(key)) return { error: 'Unknown parameter' };
    if (params.getAll(key).length > 1) return { error: `${key} is given more than once` };
  }
  const todayParam = params.get('today');
  if (todayParam !== null && !isThisMonth(todayParam, now)) return { error: 'today must be this month, YYYY-MM' };
  const today = todayParam ?? new Date(now).toISOString().slice(0, 7);
  const month = params.get('month') ?? today;
  if (!isMonth(month)) return { error: 'month must be a month, YYYY-MM' };
  if (month > today) return { error: 'month can’t be after this month' };
  if (month < addMonths(today, -MAX_MONTHS_BACK)) return { error: `month can be at most ${MAX_MONTHS_BACK / 12} years back` };
  const history = params.get('history');
  if (history !== null && history !== '1') return { error: 'history can only be 1' };
  return { month, today, history: history === '1' };
}
