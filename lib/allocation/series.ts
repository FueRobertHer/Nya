// lib/allocation/series.ts
//
// Allocation over time: for each day holdings history recorded
// (lib/holdings-history.ts), what the investment accounts held by asset
// class, worked out by today's allocation itself (allocate, in
// lib/allocation/allocation.ts) from what was recorded that day. So a day is
// counted by exactly the rules the current view counts today by:
//   - positions are classified with the person's splits as they are now;
//   - each account's balance that day (the balances measured beside the
//     positions, lib/history.ts readMeasuredBalances) is set against its
//     positions: money no position explains is unclassified, or split by the
//     person's split for the account, and an account with no position (one
//     tracked by hand, or one whose positions didn't come that day) is
//     unclassified whole, or split;
//   - one currency: an account in another is left out whole, positions and
//     all, a position priced in another is left out, and a position with no
//     currency takes its account's.
// The accounts are the ones today's allocation shows, as the Plan tab lists
// them with each one's currency, so the days and the view above them are of
// the same accounts. An account recorded before that the dashboard no longer
// shows (its connection removed, the account closed) is counted on the days
// it was recorded from its positions alone: its currency isn't known, so its
// balance can't be set against them, and a position of its with no currency
// is left out and counted, never taken to be in the display currency.
//
// Only what was recorded. Plaid keeps no past holdings, so the series starts
// on the first day Nya recorded any and is never drawn before it; a day
// nothing was recorded on is not in it. A recorded day can still be short: an
// account with neither positions nor a balance recorded that day (its
// institution couldn't be reached) is MISSING from it, and named, so the
// day's mix is never taken for the whole. An account today's allocation shows
// is expected on every day from the first it was recorded on, and from the
// first day the account directory knew it (lib/links.ts), so an institution
// that stops answering, or was failing when recording began, leaves its days
// marked rather than drawn complete. One it no longer shows is expected only
// between the first and last days it was recorded: after that it was gone.
//
// Pure. The route (app/api/allocation-history) reads the days a month at a
// time and adds them here oldest first, so a year of positions is never held
// at once.

import { allocate, isMoney, type AllocHolding, type AllocInstitution } from './allocation';
import { SLOTS, type SecurityLike, type Slot } from './classes';
import type { AllocationSettings } from './settings';

/** A recorded position, as readHoldingsHistory gives it (RecordedPosition),
 *  reduced to what this reads. */
export type SeriesPosition = SecurityLike & {
  value: number | null;
  currency: string | null;
  unofficial_currency?: string;
};

/** A recorded day, its accounts under the ids they are known by now. */
export type SeriesDayIn = {
  date: string;
  accounts: { account_id: string; positions: SeriesPosition[] }[];
};

/** An investment account today's allocation shows, as the Plan tab lists it
 *  for the series. */
export type SeriesAccount = {
  account_id: string;
  /** Its currency, as the dashboard has it: null when Plaid gives none, taken
   *  to be the display currency, as today's allocation takes it. */
  currency: string | null;
  /** Tracked by hand. */
  manual: boolean;
};

export type SeriesDay = {
  date: string;
  /** Amounts by class, in the series' currency: only the classes held. */
  classes: Partial<Record<Slot, number>>;
  /** What they add up to. */
  total: number;
  /** Of the unclassified money, how much no position explains: accounts with
   *  none, and balances beyond their positions. */
  unlisted: number;
  /** Accounts expected that day and not recorded on it, by id, in id order. */
  missing: string[];
  /** Left out for being in another currency, by currency: accounts in another
   *  currency whole, and positions priced in another. */
  otherCurrencies: Record<string, number>;
  /** Positions with no currency in accounts the dashboard no longer shows,
   *  whose currency isn't known: left out. */
  noCurrency: number;
  /** Positions with no value. */
  unpriced: number;
};

/** When an account was recorded, positions or a balance. */
export type SeriesAccountSpan = {
  account_id: string;
  /** In today's allocation. One that isn't is counted from its positions
   *  alone, on the days it was recorded. */
  shown: boolean;
  /** The first and last day it was recorded, from all that is known (the
   *  holdings index, and the balances of the days read); null if never. */
  first: string | null;
  last: string | null;
  /** On some day added, money in it no position explained was counted as
   *  unclassified (`unlisted`): kept by hand, a balance beyond its
   *  positions, or a day its positions didn't come. */
  unlisted: boolean;
};

/** "Known since before anything": for an account whose directory entry
 *  can't be read, so no day can be said to come before it existed. */
export const KNOWN_ALWAYS = '0000-01-01';

/** A recorded position, as today's allocation takes a position. */
function holdingOf(account_id: string, p: SeriesPosition): AllocHolding {
  return {
    account_id,
    name: p.name ?? null,
    ticker: p.ticker ?? null,
    security_type: p.security_type ?? null,
    is_cash_equivalent: p.is_cash_equivalent ?? null,
    value: p.value,
    currency: p.currency ?? p.unofficial_currency ?? null,
  };
}

/** One account as an institution of its own: on a past day nothing about its
 *  institution's health is known but what was recorded. */
function institutionOf(account_id: string, manual: boolean, balance: number | null, currency: string | null): AllocInstitution {
  return {
    name: '',
    item_id: manual ? null : 'recorded',
    error: false,
    staleAsOf: null,
    missing: 0,
    accounts: [{ account_id, name: account_id, type: 'investment', subtype: null, balance, currency }],
  };
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export type SeriesInput = {
  shown: readonly SeriesAccount[];
  /** The first day each account is known to have existed (the account
   *  directory, links followed), by id; KNOWN_ALWAYS when it can't be read. */
  knownFrom: ReadonlyMap<string, string>;
  /** Every account holdings history recorded, first and last day, by the id
   *  it is known by now (the index), hidden ones left out. */
  recorded: ReadonlyMap<string, { first: string; last: string }>;
  settings: AllocationSettings | null;
  currency: string | null;
};

/**
 * Builds the series a day at a time: `add` each recorded day oldest first,
 * with the balances measured that day by the id each account is known by
 * now, then read `days` and `accounts()`.
 */
export function seriesBuilder(input: SeriesInput) {
  const shown = new Map(input.shown.map((a) => [a.account_id, a]));
  const days: SeriesDay[] = [];
  // First and last day each account was recorded, positions or a balance:
  // from the index, then from each day added.
  const spans = new Map<string, { first: string; last: string }>();
  for (const [id, s] of input.recorded) spans.set(id, { first: s.first, last: s.last });
  const noteRecorded = (id: string, date: string) => {
    const s = spans.get(id);
    if (!s) spans.set(id, { first: date, last: date });
    else {
      if (date < s.first) s.first = date;
      if (date > s.last) s.last = date;
    }
  };
  // The accounts no longer shown that were recorded, or expected, on a day
  // added: the only ones worth naming.
  const earlier = new Set<string>();
  // The accounts whose unlisted money was counted as unclassified.
  const unlistedIn = new Set<string>();
  let previous: string | null = null;

  function add(day: SeriesDayIn, balances: ReadonlyMap<string, number>): void {
    if (previous !== null && day.date <= previous) throw new Error('allocation series: add each day once, oldest first');
    previous = day.date;
    const held = new Map(day.accounts.map((a) => [a.account_id, a.positions]));
    const institutions: AllocInstitution[] = [];
    const holdings: AllocHolding[] = [];
    const missing: string[] = [];
    let noCurrency = 0;

    // Today's accounts: positions and the balance, by today's rules.
    for (const a of shown.values()) {
      const positions = held.get(a.account_id);
      const balance = balances.get(a.account_id);
      if (positions === undefined && balance === undefined) {
        // Expected once it is known to have existed, or once it was first
        // recorded: the spans hold the days added before this one, and the
        // index's first day, which may be before the range.
        const known = input.knownFrom.get(a.account_id);
        const first = spans.get(a.account_id)?.first;
        if ((known !== undefined && known <= day.date) || (first !== undefined && first <= day.date)) missing.push(a.account_id);
        continue;
      }
      institutions.push(institutionOf(a.account_id, a.manual, balance ?? null, a.currency));
      for (const p of positions ?? []) holdings.push(holdingOf(a.account_id, p));
    }

    // Accounts no longer shown: their positions alone, each in its own
    // currency, or left out with none.
    for (const [id, positions] of held) {
      if (shown.has(id)) continue;
      earlier.add(id);
      institutions.push(institutionOf(id, false, null, null));
      for (const p of positions) {
        const own = p.currency ?? p.unofficial_currency ?? null;
        if (own === null && finite(p.value)) {
          noCurrency += p.value;
          continue;
        }
        holdings.push(holdingOf(id, p));
      }
    }
    for (const [id, s] of input.recorded) {
      if (shown.has(id) || held.has(id)) continue;
      if (s.first <= day.date && day.date <= s.last) {
        missing.push(id);
        earlier.add(id);
      }
    }

    for (const inst of institutions) noteRecorded(inst.accounts[0].account_id, day.date);
    const alloc = allocate({ institutions, holdings, settings: input.settings, currency: input.currency });
    const unlisted = alloc.gaps.filter((g) => g.split === null && isMoney(g.amount));
    for (const g of unlisted) unlistedIn.add(g.account_id);
    const classes: Partial<Record<Slot, number>> = {};
    for (const s of SLOTS) if (isMoney(alloc.classes[s])) classes[s] = alloc.classes[s];
    const otherCurrencies: Record<string, number> = {};
    for (const o of alloc.otherCurrencies) otherCurrencies[o.currency] = o.amount;
    days.push({
      date: day.date,
      classes,
      total: alloc.total,
      unlisted: unlisted.reduce((sum, g) => sum + g.amount, 0),
      missing: missing.sort(),
      otherCurrencies,
      noCurrency,
      unpriced: alloc.unpriced,
    });
  }

  return {
    add,
    days,
    /** Today's accounts, and the earlier ones the days added name, each with
     *  when it was recorded, in id order. */
    accounts(): SeriesAccountSpan[] {
      return [...new Set([...shown.keys(), ...earlier])].sort().map((account_id) => ({
        account_id,
        shown: shown.has(account_id),
        first: spans.get(account_id)?.first ?? null,
        last: spans.get(account_id)?.last ?? null,
        unlisted: unlistedIn.has(account_id),
      }));
    },
  };
}

/** The whole series at once, for a caller holding every day (a test, a short
 *  range): days in any order, each with the balances measured on it. */
export function allocationSeries(
  days: readonly { day: SeriesDayIn; balances?: ReadonlyMap<string, number> }[],
  input: SeriesInput
): { days: SeriesDay[]; accounts: SeriesAccountSpan[] } {
  const b = seriesBuilder(input);
  const ordered = [...days].sort((x, y) => (x.day.date < y.day.date ? -1 : x.day.date > y.day.date ? 1 : 0));
  for (const d of ordered) b.add(d.day, d.balances ?? new Map());
  return { days: b.days, accounts: b.accounts() };
}

/** The currency most of today's accounts are in, for a series asked for with
 *  none: ties go to the code first in order, and none known is null. */
export function commonCurrency(accounts: readonly SeriesAccount[]): string | null {
  const counts = new Map<string, number>();
  for (const a of accounts) if (a.currency) counts.set(a.currency, (counts.get(a.currency) ?? 0) + 1);
  let best: string | null = null;
  for (const [c, n] of counts) if (best === null || n > (counts.get(best) ?? 0) || (n === counts.get(best) && c < best)) best = c;
  return best;
}
