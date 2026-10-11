'use client';

// A month of budgets as the server works it out (#37, app/api/budgets/month,
// lib/budget-month.ts): each budget's amount that month, what rolls over into
// it, the month's spending, the income pool when income carryover is on, and
// which months may be incomplete. The Budgets tab shows it, and Home's budget
// alerts weigh what is available with it, so both agree with the read-only
// API. Loaded again whenever what it is worked out from changes on the page:
// the budgets saved, the transactions loaded, the categories.
//
// Until it has loaded, or when it can't be, the page shows the budgets as it
// always has, from what it holds (each budget's amount, this month's spending),
// and says rollover isn't shown rather than showing a carry it doesn't have.

import { useCallback, useEffect, useRef, useState } from 'react';
import { localMonth } from '@/lib/local-date';
import type { Budgets } from '@/lib/budget-set';
import type { Carries, IncomeCarryover, IncomePool, MonthGap } from '@/lib/rollover';

/** The month view's answer (app/api/budgets/month). */
export type BudgetMonthView = {
  month: string;
  today: string;
  currency: string | null;
  budgets: Budgets;
  assumed: { categories: string[]; groups: string[] };
  recorded_since: string;
  carries: Carries;
  rollover: { categories: Record<string, string>; groups: Record<string, string> };
  starts: { categories: Record<string, string>; groups: Record<string, string> };
  spent: Record<string, number>;
  income: IncomeCarryover | null;
  pool: IncomePool | null;
  earliest: string | null;
  gaps: { month: string; gaps: MonthGap[] }[];
  left_out_text: string | null;
  notes: string[];
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPair = (v: unknown) => isObject(v) && isObject(v.categories) && isObject(v.groups);

/** The answer's shape, as far as the page relies on it. */
export function isBudgetMonthView(v: unknown): v is BudgetMonthView {
  return (
    isObject(v) &&
    typeof v.month === 'string' &&
    typeof v.today === 'string' &&
    isPair(v.budgets) &&
    isPair(v.carries) &&
    isPair(v.rollover) &&
    isPair(v.starts) &&
    isObject(v.assumed) &&
    isObject(v.spent) &&
    Array.isArray(v.gaps) &&
    Array.isArray(v.notes)
  );
}

export type BudgetMonthState = {
  /** `idle` until there is a month to load (budgets not loaded yet). */
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** The month loaded, kept while the same month loads again. */
  view: BudgetMonthView | null;
  /** Why it couldn't be loaded. */
  error: string | null;
  /** Loads it again (after a change to rollover, say). */
  reload: () => void;
};

/** What the page says when the month can't be worked out. */
export const UNREADABLE_MONTHS =
  'Your budgets by month couldn’t be read, so they were left untouched. Rollover and past months can’t be shown, and budgets can’t be changed, until they can.';
const NOT_LOADED = 'Rollover couldn’t be worked out just now, so each budget shows its amount without it.';

/**
 * The month's budgets, loaded for `month` (none while it is null), and again
 * whenever one of `deps` changes. A load that a newer one overtook is
 * dropped. `deps` is a fixed list of the values it is worked out from.
 */
export function useBudgetMonth(month: string | null, deps: readonly unknown[]): BudgetMonthState {
  const [state, setState] = useState<Omit<BudgetMonthState, 'reload'>>({ status: month ? 'loading' : 'idle', view: null, error: null });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!month) {
      setState({ status: 'idle', view: null, error: null });
      return;
    }
    const mine = ++seq.current;
    setState((s) => ({ status: 'loading', view: s.view?.month === month ? s.view : null, error: null }));
    (async () => {
      try {
        const res = await fetch(`/api/budgets/month?month=${encodeURIComponent(month)}&today=${encodeURIComponent(localMonth())}`);
        const data = await res.json().catch(() => null);
        if (mine !== seq.current) return;
        if (res.ok && isBudgetMonthView(data)) setState({ status: 'ready', view: data, error: null });
        else setState({ status: 'error', view: null, error: data?.unreadable ? UNREADABLE_MONTHS : NOT_LOADED });
      } catch {
        if (mine === seq.current) setState({ status: 'error', view: null, error: NOT_LOADED });
      }
    })();
    // The deps are the page's values the month is worked out from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, tick, ...deps]);

  return { ...state, reload };
}

/** A change to rollover or income carryover (app/api/budgets/rollover), in
 *  this month as the page has it: null once saved, else why not. */
export async function changeRollover(body: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await fetch('/api/budgets/rollover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, month: localMonth() }),
    });
    if (res.ok) return null;
    const data = await res.json().catch(() => null);
    if (data?.unreadable) return UNREADABLE_MONTHS;
    return typeof data?.error === 'string' ? data.error : 'That change couldn’t be saved. Try again.';
  } catch {
    return 'That change couldn’t be saved. Check your connection and try again.';
  }
}
