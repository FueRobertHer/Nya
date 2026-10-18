// lib/fx/rates.ts
//
// Exchange rates as a reader holds them, and the rules that turn them into a
// conversion: which day's rate an amount takes, whether there is one at all,
// and how the person's own rate wins. Pure, and safe to import from client
// code. Read once per request (lib/fx/read.ts); never fetched by a reader.
//
// THE SOURCE: the European Central Bank's euro foreign exchange reference
// rates (lib/fx/ecb-store.ts keeps them): for each day it publishes, how many
// units of each of about 30 currencies one euro is worth. Reference rates, for
// information, not what a bank charged.
//
// A DAY WITHOUT A RATE (docs/architecture.md, "Exchange rates"):
//   - a day takes the ECB's newest publication on or before it. The ECB's own
//     calendar leaves at most 4 days without one (Easter's Thursday to Tuesday,
//     some Christmases: the longest gap between publications from 1999 to
//     2026 is 5 days), so a weekend or a holiday takes the last working
//     day's;
//   - the currency must be in that publication: one the ECB published that
//     day without (stopped or suspended, as the rouble from 2 March 2022) has
//     no rate, and is never carried forward from an earlier day;
//   - a day after the newest publication Nya has takes that one (today before
//     the ECB publishes, or while the fetch fails), and the figures say how
//     old it is once it is stale (isStale);
//   - a year Nya has no calendar for (a first fill that stopped) has no rate,
//     said as rates Nya doesn't have yet, never as rates the ECB lacks.
//
// THE PERSON'S OWN RATE: "1 BTC = 61,000 USD" from a day (or every day). On
// the days it applies it is the rate for that currency, in both directions,
// through the ECB's rate for its quote that day (the euro's is 1). One hop:
// the quote's rate is always the ECB's, never another own rate.

import { div, mul, parseDecimal, roundTo, tidyTo, type Frac } from './decimal';
import { isCurrencyCode, knownCurrency, minorDigits } from '../manual-txn-input';

/** One currency's ECB rates in one year: day -> units per euro, as published. */
export type EcbSeries = Record<string, string>;
/** The newest ECB publication, whole: its day and every rate in it. */
export type EcbLatest = { date: string; rates: Record<string, string> };
/** What the last fetch of the ECB's file did (lib/fx/ecb-fetch.ts). */
export type EcbFetch = {
  /** When this run ended, an ISO time. */
  at: string;
  ok: boolean;
  /** Why it failed, in words for an operator; absent when it worked. */
  reason?: string;
  /** The newest publication day the file held, when it was read. */
  newest: string | null;
  /** When a run last worked, an ISO time (this one's, when ok). */
  last_ok: string | null;
};

/** A rate the person set (lib/fx/settings.ts). */
export type OwnRate = {
  /** The currency it prices: an ISO code, or Plaid's unofficial one (BTC). */
  currency: string;
  /** What one unit of it is worth in `quote`, as typed: a positive decimal. */
  rate: string;
  /** EUR, or a currency the ECB publishes; never `currency` itself. */
  quote: string;
  /** The first day it applies (YYYY-MM-DD), or null for every day. */
  from: string | null;
  /** When it was set, an ISO time. */
  set_at: string;
};

/**
 * What a reader converts with. The ECB's part holds only what this reader
 * needs: the calendars and series of the years its days fall in, for the
 * currencies it converts, and the newest publication.
 */
export type FxTable = {
  /** The home currency the person chose, or null: then nothing converts. */
  home: string | null;
  own: readonly OwnRate[];
  latest: EcbLatest | null;
  /** The ECB's publication days, by year ("2026"), for the years read. */
  days: Readonly<Record<string, readonly string[]>>;
  /** The ECB's rates, by "<currency>:<year>", for the series read. */
  series: Readonly<Record<string, EcbSeries>>;
  /** Years read that Nya has no calendar for, or whose calendar can't be
   *  used (damaged): no rate on their days. */
  missing_years: readonly string[];
  fetch: EcbFetch | null;
};

/** A table with nothing in it: no home currency, so nothing converts. */
export const NO_FX: FxTable = { home: null, own: [], latest: null, days: {}, series: {}, missing_years: [], fetch: null };

/** The most days a publication covers after it: the ECB's longest gap between
 *  two publications is 5 days, so at most 4 days go without one. */
export const CARRY_DAYS = 4;

/** Why there is no rate for a currency on a day. */
export type NoRate =
  /** The ECB didn't publish the currency on the publication that day takes. */
  | 'not-published'
  /** Nya doesn't have the ECB's rates for that day (a year not fetched yet,
   *  or no rates fetched at all). */
  | 'not-fetched'
  /** Before the ECB's first publication of anything (1999-01-04). */
  | 'before'
  /** An own rate whose quote has no ECB rate that day. */
  | 'quote';

export type RateOn =
  | { ok: true; /** Units of the currency per euro. */ per_eur: Frac; /** The day the rate is from. */ day: string; source: 'ecb' | 'own' | 'euro' }
  | { ok: false; why: NoRate };

const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
const yearOf = (day: string) => day.slice(0, 4);

/** The newest publication day on or before `day`, from the calendars read, or
 *  why there is none. Looks in the year before when `day` comes before its
 *  year's first publication (1 January always does). */
function publicationOn(fx: FxTable, day: string): { day: string } | { why: NoRate } {
  const year = yearOf(day);
  for (const y of [year, String(Number(year) - 1)]) {
    const days = fx.days[y];
    if (!days) {
      // A year read but missing is rates Nya lacks. A year not read at all is
      // a reader that asked for too little: the same answer, never a guess.
      return { why: y < '1999' ? 'before' : 'not-fetched' };
    }
    for (let i = days.length - 1; i >= 0; i--) {
      if (days[i] <= day) {
        const p = days[i];
        // Past the ECB's own calendar: a year Nya hasn't fetched in between.
        return dayNumber(day) - dayNumber(p) <= CARRY_DAYS ? { day: p } : { why: 'not-fetched' };
      }
    }
    if (y < '1999') return { why: 'before' };
  }
  return { why: 'not-fetched' };
}

/** The ECB's rate for a currency on a day (units per euro), or why there is
 *  none. The euro's is 1. */
export function ecbRate(fx: FxTable, currency: string, day: string): RateOn {
  if (currency === 'EUR') return { ok: true, per_eur: { n: 1n, d: 1n }, day, source: 'euro' };
  if (day < '1999-01-04') return { ok: false, why: 'before' };
  const latest = fx.latest;
  if (latest && day >= latest.date) {
    const r = latest.rates[currency];
    const f = r === undefined ? null : parseDecimal(r);
    return f && f.n > 0n ? { ok: true, per_eur: f, day: latest.date, source: 'ecb' } : { ok: false, why: 'not-published' };
  }
  const p = publicationOn(fx, day);
  if ('why' in p) return { ok: false, why: p.why };
  const series = fx.series[`${currency}:${yearOf(p.day)}`];
  const r = series?.[p.day];
  const f = r === undefined ? null : parseDecimal(r);
  return f && f.n > 0n ? { ok: true, per_eur: f, day: p.day, source: 'ecb' } : { ok: false, why: 'not-published' };
}

/** The own rate that applies to a currency on a day, if any. */
export function ownRateOn(fx: FxTable, currency: string, day: string): OwnRate | null {
  return fx.own.find((o) => o.currency === currency && (o.from === null || day >= o.from)) ?? null;
}

/** A currency's rate on a day, units per euro: the person's own where it
 *  applies (through the ECB's rate for its quote), else the ECB's. */
export function rateOn(fx: FxTable, currency: string, day: string): RateOn {
  const own = ownRateOn(fx, currency, day);
  if (!own) return ecbRate(fx, currency, day);
  const value = parseDecimal(own.rate);
  if (!value || value.n <= 0n) return ecbRate(fx, currency, day);
  const quote = ecbRate(fx, own.quote, day);
  if (!quote.ok) return { ok: false, why: 'quote' };
  // 1 currency = rate quote, and 1 euro = per_eur(quote) quote, so one euro
  // is per_eur(quote) / rate of the currency.
  return { ok: true, per_eur: div(quote.per_eur, value), day: quote.source === 'euro' ? day : quote.day, source: 'own' };
}

/** How many decimal places an amount in the currency is kept to: its minor
 *  unit for an ISO code Intl knows, else 8 (Plaid's unofficial codes, crypto),
 *  as splits count them (lib/split-rows.ts unitScale). */
export function precisionOf(currency: string): number {
  return isCurrencyCode(currency) && knownCurrency(currency) ? minorDigits(currency) : 8;
}

export type Converted =
  | { ok: true; amount: number; from: RateOn & { ok: true }; to: RateOn & { ok: true } }
  | { ok: false; why: NoRate; currency: string };

/**
 * An amount in `from` on `day`, in `to`, rounded once, half away from zero, to
 * `to`'s precision: amount × rate(to) / rate(from), exactly. The amount is
 * taken as the decimal of its shortest text, or, with `tidy`, first rounded to
 * `from`'s precision (a float sum of amounts, so client and server convert the
 * same subtotal). In its own currency it is itself, unrounded.
 */
export function convert(fx: FxTable, amount: number, from: string, to: string, day: string, opts: { tidy?: boolean } = {}): Converted {
  if (from === to) {
    const same: RateOn & { ok: true } = { ok: true, per_eur: { n: 1n, d: 1n }, day, source: 'euro' };
    return { ok: true, amount, from: same, to: same };
  }
  const a = rateOn(fx, from, day);
  if (!a.ok) return { ok: false, why: a.why, currency: from };
  const b = rateOn(fx, to, day);
  if (!b.ok) return { ok: false, why: b.why, currency: to };
  const exact = opts.tidy ? tidyTo(amount, precisionOf(from)) : parseDecimal(amount);
  if (!exact) throw new RangeError('Not a finite amount');
  return { ok: true, amount: roundTo(div(mul(exact, b.per_eur), a.per_eur), precisionOf(to)), from: a, to: b };
}

/** What one unit of `from` is worth in `to` on a day, for showing ("1 USD =
 *  0.86573 EUR", lib/format.ts formatRate): never used to convert. `day` is
 *  the ECB day it is from (the day itself for an own rate quoted in euros). */
export function displayRate(fx: FxTable, from: string, to: string, day: string): { value: number; day: string; source: 'ecb' | 'own' } | null {
  if (from === to) return null;
  const a = rateOn(fx, from, day);
  const b = rateOn(fx, to, day);
  if (!a.ok || !b.ok) return null;
  const value = roundTo(div(b.per_eur, a.per_eur), 12);
  const source = a.source === 'own' || b.source === 'own' ? 'own' : 'ecb';
  const ecbDay = [a, b].find((r) => r.source !== 'euro')?.day ?? day;
  return { value, day: ecbDay, source };
}

/** More than this since the last fetch that worked, and the rates are stale. */
export const STALE_FETCH_MS = 30 * 3_600_000;
/** More than this many days between the newest publication and today, and the
 *  rates are stale whatever the fetch says: past the ECB's own calendar. */
export const STALE_DAYS = 5;

/** Whether the newest rates Nya has are older than they should be: the last
 *  fetch that worked was over 30 hours ago, or the newest publication is over
 *  5 days old. Not on the fifth day of an Easter gap, when the fetch is
 *  working and the ECB published nothing newer. */
export function isStale(fx: Pick<FxTable, 'latest' | 'fetch'>, now: number): boolean {
  if (!fx.latest) return true;
  const today = new Date(now).toISOString().slice(0, 10);
  if (dayNumber(today) - dayNumber(fx.latest.date) > STALE_DAYS) return true;
  const lastOk = fx.fetch?.last_ok ? Date.parse(fx.fetch.last_ok) : NaN;
  return !Number.isFinite(lastOk) || now - lastOk > STALE_FETCH_MS;
}
