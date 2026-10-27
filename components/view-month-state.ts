'use client';

// The month Activity and Budgets show, shared between them for the session
// (look and feel step 2b2), as their segments are kept: step back to August
// on Activity, and Budgets opens on August too. Dashboard holds it; neither
// the address nor storage does.
//
// NULL IS EACH TAB'S OWN DEFAULT: Activity's month it opens on (this month,
// or the latest with transactions while this one has none), Budgets' this
// month. A tab writes null when it lands on its default, so a stored month is
// always one chosen away from it, and none goes stale on the 1st.
//
// WRITTEN ONLY BY NAVIGATION: the stepper's arrows and list, its return
// button (null) and Activity's trend taps. A tab that can't show the month
// asked for shows its nearest (activityMonth, budgetsShown) without writing
// it back, and Activity's cash-flow pick holds its month locally. Home's links
// into either tab reset it (resetsMonth).

import { useCallback, useState } from 'react';
import type { Go } from './attention';
import { addMonths, monthsFrom, MAX_MONTHS_BACK } from '@/lib/rollover';

/** YYYY-MM, or null for each tab's own default. */
export type ViewMonth = string | null;

/** The month as a tab writes it: null when it is the tab's default. */
export const writeMonth = (m: string, own: string | null): ViewMonth => (m === own ? null : m);

export function useViewMonth(): { month: ViewMonth; set: (m: ViewMonth) => void; reset: () => void } {
  const [month, setMonth] = useState<ViewMonth>(null);
  const set = useCallback((m: ViewMonth) => setMonth(m), []);
  const reset = useCallback(() => setMonth(null), []);
  return { month, set, reset };
}

/** Which of Home's links reset the month: the budget alerts are this month's,
 *  and the review count counts every month while the list shows one. A new
 *  kind of link is a type error here until it is decided. */
export const resetsMonth: Record<Go['to'], boolean> = {
  budgets: true,
  review: true,
  card: false,
  accounts: false,
  connections: false,
  account: false,
  restore: false,
  currency: false,
};

/** Where Activity opens: the latest month listed not after this one (a row
 *  dated tomorrow, on a month's last day, doesn't open the next), else the
 *  newest. `months` newest first. */
export function activityOpensOn(months: readonly string[], thisMonth: string): string | null {
  return months.find((m) => m <= thisMonth) ?? months[0] ?? null;
}

/** The month Activity shows for one asked for: it when listed, else the
 *  latest listed before it (never a later one, which could be its default
 *  while another month is asked for), else the oldest listed. */
export function activityMonth(want: ViewMonth, months: readonly string[], thisMonth: string): string | null {
  if (want === null || months.length === 0) return activityOpensOn(months, thisMonth);
  if (months.includes(want)) return want;
  return months.find((m) => m < want) ?? months[months.length - 1];
}

/** The month Budgets shows: this month for the default or a later one, else
 *  the month asked for, at most MAX_MONTHS_BACK back. Never moved to the first
 *  month with transactions: a bank's stored rows that couldn't be read make
 *  that later than months Activity lists. */
export function budgetsShown(want: ViewMonth, thisMonth: string): string {
  if (want === null || want >= thisMonth) return thisMonth;
  const floor = addMonths(thisMonth, -MAX_MONTHS_BACK);
  return want < floor ? floor : want;
}

/** Budgets' months to step through, newest first: back to the first with
 *  transactions (ten years at most), or to the month shown when that is
 *  earlier or not known yet, so the month shown is always among them. */
export function budgetsRange(shown: string, thisMonth: string, earliest: string | null): string[] {
  const floor = addMonths(thisMonth, -MAX_MONTHS_BACK);
  const first = earliest && earliest < thisMonth ? (earliest > floor ? earliest : floor) : thisMonth;
  return monthsFrom(shown < first ? shown : first, thisMonth).reverse();
}
