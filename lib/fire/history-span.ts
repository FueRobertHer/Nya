// lib/fire/history-span.ts
//
// The span of the market history (lib/fire/history-data.ts) without the
// history itself: its first month and how many months of returns it holds,
// so the page can say what every plan was run on without loading 44 KB of
// data the worker already has. test/plan-compare.test.tsx holds these to the
// data, so they can't drift from it.

import { monthLabel, type Market } from './market';

export const HISTORY_FIRST = '1871-01';
export const HISTORY_COUNT = 1829;

/** The first and last month of returns, YYYY-MM. */
export function historySpan(): { first: string; last: string } {
  return { first: HISTORY_FIRST, last: monthLabel({ firstMonth: HISTORY_FIRST } as Market, HISTORY_COUNT - 1) };
}
