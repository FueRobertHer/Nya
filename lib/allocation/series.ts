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
//     person's split for the account; an account that lists no positions (one
//     tracked by hand, or at a connection that never gives any) is
//     unclassified whole, or split;
//   - an account whose positions didn't come that day (its institution
//     answers for it on other days, but holdings history has no answer for it
//     on this one, while its balance was measured) is unclassified whole and
//     never split, as today's view counts an account whose holdings call
//     failed: its split is for money beyond its positions, and what it holds
//     that day isn't known;
//   - one currency: an account in another is left out whole, positions and
//     all, a position priced in another is left out, and a position with no
//     currency takes its account's.
//
// THE ACCOUNTS. The Plan tab lists the investment accounts the dashboard
// knows: those today's allocation shows, and those whose institution it
// can't show (no balance could be recovered: an outage past the recovery
// limit, or an account missing from the last snapshot), each with its
// currency. Both are counted the same way on the days they were recorded. Of
// the other accounts holdings history recorded, the route says which are
// still linked (remembered for a connection still stored, or missing from an
// answer pending confirmation): those are counted from their positions alone,
// since their currency isn't known here, a position of theirs with no
// currency left out and counted, never taken to be in the display currency.
// Every other recorded account is GONE: its connection was removed, or the
// account closed.
//
// Only what was recorded. Plaid keeps no past holdings, so the series starts
// on the first day Nya recorded any and is never drawn before it; a day
// nothing was recorded on is not in it. A recorded day can still be short: an
// account with neither positions nor a balance recorded that day (its
// institution couldn't be reached) is MISSING from it, and named, so the
// day's mix is never taken for the whole. An account still linked is
// expected on every day from the first it was recorded on, and from the first
// day the account directory knew it (lib/links.ts), so an institution that
// stops answering, however long for, or was failing when recording began,
// leaves its days marked rather than drawn complete. A gone one is expected
// only between the first and last days it was recorded: after that it was
// gone.
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

/** An investment account the Plan tab lists for the series. */
export type SeriesAccount = {
  account_id: string;
  /** Its currency, as the dashboard has it: null when Plaid gives none, taken
   *  to be the display currency, as today's allocation takes it. */
  currency: string | null;
  /** Tracked by hand. */
  manual: boolean;
  /** In today's allocation; false for one its institution can't show. */
  shown: boolean;
};

export type SeriesDay = {
  date: string;
  /** Amounts by class, in the series' currency: only the classes held. */
  classes: Partial<Record<Slot, number>>;
  /** What they add up to. */
  total: number;
  /** Of the unclassified money, how much no position explains: accounts with
   *  none, balances beyond their positions, and accounts whose positions
   *  didn't come. */
  unlisted: number;
  /** Accounts expected that day and not recorded on it, by id, in id order. */
  missing: string[];
  /** Left out for being in another currency, by currency: accounts in another
   *  currency whole, and positions priced in another. */
  otherCurrencies: Record<string, number>;
  /** Positions with no currency in accounts the Plan doesn't list, whose
   *  currency isn't known: left out. */
  noCurrency: number;
  /** Positions with no value. */
  unpriced: number;
};

/** Where an account stands now: in today's allocation ("shown"), still linked
 *  but not shown ("unshown": its institution can't be shown, or it is missing
 *  pending confirmation), or "gone" (its connection removed, or the account
 *  closed). */
export type AccountState = 'shown' | 'unshown' | 'gone';

/** When an account was recorded, positions or a balance. */
export type SeriesAccountSpan = {
  account_id: string;
  state: AccountState;
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
function institutionOf(account_id: string, manual: boolean, balance: number | null, currency: string | null, positionsFailed: boolean): AllocInstitution {
  return {
    name: '',
    item_id: manual ? null : 'recorded',
    error: false,
    staleAsOf: null,
    missing: 0,
    accounts: [{ account_id, name: account_id, type: 'investment', subtype: null, balance, currency, positionsFailed }],
  };
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export type SeriesInput = {
  /** The accounts the Plan tab lists: shown, and those it can't show. */
  accounts: readonly SeriesAccount[];
  /** The first day each account is known to have existed (the account
   *  directory, links followed), by id; KNOWN_ALWAYS when it can't be read. */
  knownFrom: ReadonlyMap<string, string>;
  /** Every account holdings history recorded, first and last day, by the id
   *  it is known by now (the index), hidden ones left out. */
  recorded: ReadonlyMap<string, { first: string; last: string }>;
  /** Of the recorded accounts the Plan doesn't list, whether one is still
   *  linked (expected as a listed one is) rather than gone. */
  linked: (account_id: string) => boolean;
  settings: AllocationSettings | null;
  currency: string | null;
};

/**
 * Builds the series a day at a time: `add` each recorded day oldest first,
 * with the balances measured that day by the id each account is known by
 * now, then read `days` and `accounts()`.
 */
export function seriesBuilder(input: SeriesInput) {
  const listed = new Map(input.accounts.map((a) => [a.account_id, a]));
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
  /** Expected on a day: known to have existed by then, or recorded by then
   *  (the spans hold the days added before it, and the index's first day,
   *  which may be before the range). */
  const expectedFrom = (id: string, date: string) => {
    const known = input.knownFrom.get(id);
    const first = spans.get(id)?.first;
    return (known !== undefined && known <= date) || (first !== undefined && first <= date);
  };
  // The accounts the Plan doesn't list that were recorded, or expected, on a
  // day added: the only ones worth naming.
  const unlisted = new Set<string>();
  // The accounts whose unlisted money was counted as unclassified.
  const unlistedMoneyIn = new Set<string>();
  let previous: string | null = null;

  function add(day: SeriesDayIn, balances: ReadonlyMap<string, number>): void {
    if (previous !== null && day.date <= previous) throw new Error('allocation series: add each day once, oldest first');
    previous = day.date;
    const held = new Map(day.accounts.map((a) => [a.account_id, a.positions]));
    const institutions: AllocInstitution[] = [];
    const holdings: AllocHolding[] = [];
    const missing: string[] = [];
    let noCurrency = 0;

    // The accounts the Plan lists: positions and the balance, by today's
    // rules.
    for (const a of listed.values()) {
      const positions = held.get(a.account_id);
      const balance = balances.get(a.account_id);
      if (positions === undefined && balance === undefined) {
        if (expectedFrom(a.account_id, day.date)) missing.push(a.account_id);
        continue;
      }
      // A balance with no answer for it, at an institution that answers for
      // it on other days: its positions didn't come.
      const positionsFailed = positions === undefined && !a.manual && input.recorded.has(a.account_id);
      institutions.push(institutionOf(a.account_id, a.manual, balance ?? null, a.currency, positionsFailed));
      for (const p of positions ?? []) holdings.push(holdingOf(a.account_id, p));
    }

    // The others: their positions alone, each in its own currency, or left
    // out with none.
    for (const [id, positions] of held) {
      if (listed.has(id)) continue;
      unlisted.add(id);
      institutions.push(institutionOf(id, false, null, null, false));
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
      if (listed.has(id) || held.has(id)) continue;
      // Still linked: expected from its first day, with no end. Gone: only
      // between its first and last days.
      const expected = input.linked(id) ? expectedFrom(id, day.date) : s.first <= day.date && day.date <= s.last;
      if (expected) {
        missing.push(id);
        unlisted.add(id);
      }
    }

    for (const inst of institutions) noteRecorded(inst.accounts[0].account_id, day.date);
    const alloc = allocate({ institutions, holdings, settings: input.settings, currency: input.currency });
    const unexplained = alloc.gaps.filter((g) => g.split === null && isMoney(g.amount));
    for (const g of unexplained) unlistedMoneyIn.add(g.account_id);
    const classes: Partial<Record<Slot, number>> = {};
    for (const s of SLOTS) if (isMoney(alloc.classes[s])) classes[s] = alloc.classes[s];
    const otherCurrencies: Record<string, number> = {};
    for (const o of alloc.otherCurrencies) otherCurrencies[o.currency] = o.amount;
    days.push({
      date: day.date,
      classes,
      total: alloc.total,
      unlisted: unexplained.reduce((sum, g) => sum + g.amount, 0),
      missing: missing.sort(),
      otherCurrencies,
      noCurrency,
      unpriced: alloc.unpriced,
    });
  }

  const stateOf = (id: string): AccountState => {
    const a = listed.get(id);
    if (a) return a.shown ? 'shown' : 'unshown';
    return input.linked(id) ? 'unshown' : 'gone';
  };

  return {
    add,
    days,
    /** The listed accounts, and the others the days added name, each with
     *  where it stands and when it was recorded, in id order. */
    accounts(): SeriesAccountSpan[] {
      return [...new Set([...listed.keys(), ...unlisted])].sort().map((account_id) => ({
        account_id,
        state: stateOf(account_id),
        first: spans.get(account_id)?.first ?? null,
        last: spans.get(account_id)?.last ?? null,
        unlisted: unlistedMoneyIn.has(account_id),
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

/** The currency most of the listed accounts are in, for a series asked for
 *  with none: ties go to the code first in order, and none known is null. */
export function commonCurrency(accounts: readonly SeriesAccount[]): string | null {
  const counts = new Map<string, number>();
  for (const a of accounts) if (a.currency) counts.set(a.currency, (counts.get(a.currency) ?? 0) + 1);
  let best: string | null = null;
  for (const [c, n] of counts) if (best === null || n > (counts.get(best) ?? 0) || (n === counts.get(best) && c < best)) best = c;
  return best;
}
