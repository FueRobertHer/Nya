// lib/allocation/series.ts
//
// Allocation over time, from holdings history (lib/holdings-history.ts): for
// each recorded day, what the recorded positions held by asset class,
// classified by the same rule as today's (lib/allocation/classes.ts, with the
// person's splits as they are now).
//
// Only what was recorded. Plaid keeps no past holdings, so the series starts
// on the first day Nya recorded any and is never drawn before it; a day
// nothing was recorded on is not in it at all. A recorded day can still be
// short: an investment account recorded before and after it may not have
// been recorded that day (its institution couldn't be reached, or answered
// incompletely). Such a day names the accounts missing from it, by the days
// each account was recorded on (from the first to the last, the index's
// spans), so its mix is never taken for the whole.
//
// From positions only: money an account doesn't list as a position (cash,
// often) and accounts listed with none have no value here, so a day's total
// can be less than the balances that day; `empty` counts the accounts listed
// with no position. One currency, as today's allocation: positions priced in
// another are left out and summed by currency.
//
// Pure. The route (app/api/allocation-history) reads the days and runs it.

import { classify, spread, type FundSplits, type Slot, type SecurityLike } from './classes';

/** A recorded position, as readHoldingsHistory gives it (RecordedPosition),
 *  reduced to what this reads. */
export type SeriesPosition = SecurityLike & {
  value: number | null;
  currency: string | null;
  unofficial_currency?: string;
};

export type SeriesDayIn = {
  date: string;
  accounts: { account_id: string; positions: SeriesPosition[] }[];
};

export type SeriesDay = {
  date: string;
  /** Amounts by class, in the series' currency: only the classes held. */
  classes: Partial<Record<Slot, number>>;
  total: number;
  /** Accounts recorded that day. */
  accounts: number;
  /** Of those, accounts listed with no position. */
  empty: number;
  /** Accounts recorded both before and after this day (or on it, by their
   *  spans) that weren't recorded on it, by id, in id order. */
  missing: string[];
  /** Left out for being priced in another currency, by currency. */
  otherCurrencies: Record<string, number>;
  /** Positions with no value. */
  unpriced: number;
};

/** When each account was recorded, first and last UTC day. */
export type AccountSpan = { first: string; last: string };

export function allocationSeries(
  days: readonly SeriesDayIn[],
  spans: ReadonlyMap<string, AccountSpan>,
  splits: FundSplits,
  currency: string | null
): SeriesDay[] {
  const inCurrency = (c: string | null | undefined) => !c || !currency || c === currency;
  return [...days]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((day) => {
      const classes: Partial<Record<Slot, number>> = {};
      const add = (slot: Slot, n: number) => (classes[slot] = (classes[slot] ?? 0) + n);
      const otherCurrencies: Record<string, number> = {};
      let total = 0;
      let empty = 0;
      let unpriced = 0;
      const recorded = new Set<string>();
      for (const account of day.accounts) {
        recorded.add(account.account_id);
        if (account.positions.length === 0) empty++;
        for (const p of account.positions) {
          if (typeof p.value !== 'number' || !Number.isFinite(p.value)) {
            unpriced++;
            continue;
          }
          const c = p.currency ?? p.unofficial_currency ?? null;
          if (!inCurrency(c)) {
            otherCurrencies[c as string] = (otherCurrencies[c as string] ?? 0) + p.value;
            continue;
          }
          total += p.value;
          const k = classify(p, splits);
          if (k.split) for (const [cls, part] of spread(p.value, k.split)) add(cls, part);
          else add('unclassified', p.value);
        }
      }
      const missing = [...spans]
        .filter(([id, s]) => s.first <= day.date && day.date <= s.last && !recorded.has(id))
        .map(([id]) => id)
        .sort();
      return { date: day.date, classes, total, accounts: recorded.size, empty, missing, otherCurrencies, unpriced };
    });
}

/** The currency most recorded positions are priced in, for a series asked
 *  for with none: the one a person's holdings are mostly in. */
export function commonCurrency(days: readonly SeriesDayIn[]): string | null {
  const counts = new Map<string, number>();
  for (const d of days) {
    for (const a of d.accounts) {
      for (const p of a.positions) {
        const c = p.currency ?? p.unofficial_currency ?? null;
        if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
  }
  let best: string | null = null;
  for (const [c, n] of counts) if (best === null || n > (counts.get(best) ?? 0) || (n === counts.get(best) && c < best)) best = c;
  return best;
}
