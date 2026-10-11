'use client';

// A month of budgets as the server works it out (#37, app/api/budgets/month,
// lib/budget-month.ts): each budget's amount that month, what rolls over into
// it, the month's spending, the income pool when income carryover is on, and
// which months may be incomplete. The Budgets tab shows it, and Home's budget
// alerts weigh what is available with it, so both agree with the read-only
// API. Loaded again whenever what it is worked out from changes on the page
// (the budgets saved, the transactions loaded, the categories), once each
// change has settled: never while budgets are being saved.
//
// THE STORED HISTORY. This month, when nothing in it counts spending from
// earlier months (no budget rolls over, income carryover off), is answered
// without reading the stored transactions (`history` false): Home needs only
// the carries, and there are none. The Budgets tab asks for the history
// (`history`), for the months to look back on and the months a rollover can
// start from; asked once the answer in hand lacks it.
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
  /** Whether the stored history was read: without it, `earliest` is null
   *  and the month's spending, gaps and currency are left to the page. */
  history: boolean;
  month: string;
  today: string;
  currency: string | null;
  budgets: Budgets;
  assumed: { categories: string[]; groups: string[] };
  recorded_since: string;
  carries: Carries;
  rollover: { categories: Record<string, string>; groups: Record<string, string> };
  starts: { categories: Record<string, string>; groups: Record<string, string> };
  ended: { categories: Record<string, string>; groups: Record<string, string> };
  spent: Record<string, number>;
  income: IncomeCarryover | null;
  pool: IncomePool | null;
  earliest: string | null;
  gaps: { month: string; gaps: MonthGap[] }[];
  left_out_text: string | null;
  counted_left_out_text: string | null;
  notes: string[];
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPair = (v: unknown) => isObject(v) && isObject(v.categories) && isObject(v.groups);

/** The answer's shape, as far as the page relies on it. */
export function isBudgetMonthView(v: unknown): v is BudgetMonthView {
  return (
    isObject(v) &&
    typeof v.history === 'boolean' &&
    typeof v.month === 'string' &&
    typeof v.today === 'string' &&
    isPair(v.budgets) &&
    isPair(v.carries) &&
    isPair(v.rollover) &&
    isPair(v.starts) &&
    isPair(v.ended) &&
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
  'Your budgets by month couldn’t be read, so they were left untouched. Rollover and past months can’t be shown or changed until they can; your budgets still save.';
export const NOT_LOADED = 'Rollover couldn’t be worked out just now, so each budget shows its amount without it.';

/** What the page says of a 409 `unreadable`: the record of budgets by month
 *  or the income setting, else what couldn't be read in the store's own
 *  words (the accounts that ended, say), which rollover waits for too. */
export function unreadableText(data: { what?: unknown; error?: unknown }): string {
  if (data.what === undefined || data.what === 'budgets by month' || data.what === 'income carryover settings') return UNREADABLE_MONTHS;
  const said = typeof data.error === 'string' ? `${data.error} ` : '';
  return `${said}Rollover and past months can’t be shown until they can.`;
}

/** The month view's address, for this month as the page has it (`today`),
 *  asking for the stored history when `history`. */
export const monthUrl = (month: string, today: string, history: boolean): string =>
  `/api/budgets/month?month=${encodeURIComponent(month)}&today=${encodeURIComponent(today)}${history ? '&history=1' : ''}`;

/** Whether the stored history is wanted and the answer in hand lacks it,
 *  having been loaded without asking (one that was asked is never asked
 *  again: the server reads it whenever asked). */
export const lacksHistory = (wanted: boolean, s: { status: BudgetMonthState['status']; view: BudgetMonthView | null; asked: boolean }): boolean =>
  wanted && s.status === 'ready' && s.view !== null && !s.view.history && !s.asked;

/**
 * The month's budgets, loaded for `month` (none while it is null), and again
 * whenever one of `deps` changes, unless `paused` (a save under way): then
 * once it is not. A load that a newer one overtook is dropped. `deps` is a
 * fixed list of the values it is worked out from. With `history`, the stored
 * history is read even when nothing in the month counts it (see THE STORED
 * HISTORY), and an answer in hand without it is loaded again.
 */
export function useBudgetMonth(month: string | null, deps: readonly unknown[], opts: { paused?: boolean; history?: boolean } = {}): BudgetMonthState {
  const [state, setState] = useState<Omit<BudgetMonthState, 'reload'> & { asked: boolean }>({ status: month ? 'loading' : 'idle', view: null, error: null, asked: false });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const paused = !!opts.paused;
  // Read when a load starts, so asking for the history alone never reloads.
  const history = useRef(false);
  history.current = !!opts.history;

  const lacking = lacksHistory(!!opts.history, state);
  useEffect(() => {
    if (lacking) reload();
  }, [lacking, reload]);

  useEffect(() => {
    if (!month) {
      setState({ status: 'idle', view: null, error: null, asked: false });
      return;
    }
    if (paused) return;
    const mine = ++seq.current;
    const asked = history.current;
    setState((s) => ({ status: 'loading', view: s.view?.month === month ? s.view : null, error: null, asked }));
    (async () => {
      try {
        const res = await fetch(monthUrl(month, localMonth(), asked));
        const data = await res.json().catch(() => null);
        if (mine !== seq.current) return;
        if (res.ok && isBudgetMonthView(data)) setState({ status: 'ready', view: data, error: null, asked });
        else setState({ status: 'error', view: null, error: data?.unreadable ? unreadableText(data) : NOT_LOADED, asked });
      } catch {
        if (mine === seq.current) setState({ status: 'error', view: null, error: NOT_LOADED, asked });
      }
    })();
    // The deps are the page's values the month is worked out from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, tick, paused, ...deps]);

  return { status: state.status, view: state.view, error: state.error, reload };
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
    if (data?.unreadable) return unreadableText(data);
    return typeof data?.error === 'string' ? data.error : 'That change couldn’t be saved. Try again.';
  } catch {
    return 'That change couldn’t be saved. Check your connection and try again.';
  }
}
