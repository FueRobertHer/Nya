// lib/fx/api-base.ts
//
// What the read-only API (lib/api-read.ts) adds once the person has chosen a
// home currency (lib/fx/settings.ts): `base_currency` on the answers that
// carry balances, each account's `to_base`, net worth's `base`, and each
// history point's `to_base`. Version 1's own fields keep their meaning (one
// total per currency, nothing converted): conversion arrives only in these
// new ones, each null without a home currency, or without a rate.
//
// THE APP'S RULES (lib/fx/net-worth.ts): balances now at the newest rates,
// each currency's subtotal converted once, so `base.net_worth` is what Home
// shows from the same balances; an account's own `to_base` converts it on its
// own, so the accounts' can add up to a cent per currency away from it. A day
// of net worth's history converts at that day's rates, from its split by
// currency, bridged as the chart is. A currency with no rate is left out and
// named, never guessed. Pure, given what was read once (FxTable).

import { bridgeInteriorEstimates, type HistoryPoint } from '../history';
import { balancesIn, convertHistory, type HistoryGaps, type SplitPoint } from './net-worth';
import { convert, ecbRate, isStale, ownRateOn, type FxTable, type NoRate, type OwnRate } from './rates';
import { homeUnrated, reasonText } from './words';

/** An own rate as the API gives it: 1 `currency` is `rate` `quote`, from
 *  the day `from` on (every day when null). */
export type ApiOwnRate = { currency: string; rate: number; quote: string; from: string | null };

export const apiOwnRates = (own: readonly OwnRate[]): ApiOwnRate[] => own.map((o) => ({ currency: o.currency, rate: Number(o.rate), quote: o.quote, from: o.from }));

/** Why a currency has no rate, in the API's words: the ECB doesn't publish
 *  it (or didn't that day) and the person set none of their own; Nya doesn't
 *  have the ECB's rates for that day yet; the person's own rate is quoted in
 *  a currency with no rate that day; or the home currency itself has none (the
 *  ECB doesn't publish it, with no rate of the person's for it), so nothing
 *  converts into it. Version 1 may add reasons. */
export type ApiNoRate = 'no_rate' | 'not_fetched' | 'rates_unreadable' | 'quote_has_no_rate' | 'base_has_no_rate';

/** `unrated`: whose rate is missing (lib/fx/net-worth.ts). */
export const apiNoRate = (currency: string, why: NoRate, unrated: string, home: string): ApiNoRate =>
  why === 'not-fetched' ? 'not_fetched' : why === 'unread' ? 'rates_unreadable' : homeUnrated(currency, why, unrated, home) ? 'base_has_no_rate' : why === 'quote' ? 'quote_has_no_rate' : 'no_rate';

export type ApiBasePart = {
  currency: string;
  /** The currency's balances added up, in it (assets less debts). */
  net_worth: number;
  /** What it came to in base_currency, or null with no rate. */
  converted: number | null;
  /** One unit of it in base_currency, for showing (never rounded to convert
   *  with), or null for base_currency itself and for one with no rate. */
  rate: number | null;
  /** 'ecb', or 'own' where the person's own rate was used. */
  rate_source: 'ecb' | 'own' | null;
  accounts: number;
};

export type ApiBase = {
  /** Net worth in base_currency: each currency's balances added up, then
   *  converted once, as the app's net worth is. */
  net_worth: number;
  /** The assets and the debts, each converted the same way on its own: so
   *  assets less debts can be a cent per currency away from net_worth. */
  assets: number;
  debts: number;
  /** The accounts counted in it: those with a rate. */
  accounts: number;
  /** Each currency's part: base_currency's first, then those converted, then
   *  those left out, each by most accounts. */
  parts: ApiBasePart[];
  /** The currencies left out for having no rate, with how many accounts and
   *  why. Never guessed. */
  left_out: { currency: string; accounts: number; why: ApiNoRate }[];
  /** The day of the ECB's rates used (their newest publication), or null
   *  when none was. */
  rate_day: string | null;
  /** True when those rates are older than they should be: the nightly fetch
   *  hasn't worked in over 30 hours, or they are over 5 days old. */
  rates_stale: boolean;
  /** The person's own rates used, as me.own_rates gives them. */
  own_rates: ApiOwnRate[];
};

/** An account as net worth counts it: its balance in Plaid's sign (what a
 *  debt owes is positive), its currency (null: the main one). */
export type BaseAccount = { balance: number; currency: string | null; is_debt: boolean };

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/** The ECB publication a currency's rate on `day` is taken from (through the
 *  quote of the person's own rate for it), or null for the euro's and for
 *  none. */
function ecbDayOf(fx: FxTable, currency: string, day: string): string | null {
  const own = ownRateOn(fx, currency, day);
  const c = own ? own.quote : currency;
  if (c === 'EUR') return null;
  const r = ecbRate(fx, c, day);
  return r.ok ? r.day : null;
}

/** Net worth's `base`, from the accounts counted now, at the newest rates. */
export function apiBase(accounts: readonly BaseAccount[], fx: FxTable, main: string | null, now: number): ApiBase {
  const home = fx.home!;
  const day = utcDay(now);
  const of = (list: readonly BaseAccount[], sign: (a: BaseAccount) => number) => balancesIn(list.map((a) => ({ amount: sign(a) * a.balance, currency: a.currency })), fx, home, day, main);
  const net = of(accounts, (a) => (a.is_debt ? -1 : 1));
  const assets = of(accounts.filter((a) => !a.is_debt), () => 1);
  const debts = of(accounts.filter((a) => a.is_debt), () => 1);
  const rated = net.parts.filter((p) => p.currency !== home && p.converted !== null).map((p) => p.currency);
  const days = rated.length > 0 ? [...rated, home].map((c) => ecbDayOf(fx, c, day)).filter((d): d is string => d !== null).sort() : [];
  const rateDay = days[days.length - 1] ?? null;
  const used = fx.own.filter((o) => ownRateOn(fx, o.currency, day) === o && (o.currency === home ? rated.length > 0 : rated.includes(o.currency)));
  return {
    net_worth: net.total,
    assets: assets.total,
    debts: debts.total,
    accounts: net.parts.filter((p) => p.converted !== null).reduce((n, p) => n + p.accounts, 0),
    parts: net.parts.map((p) => ({ currency: p.currency, net_worth: p.amount, converted: p.converted, rate: p.rate?.value ?? null, rate_source: p.rate?.source ?? null, accounts: p.accounts })),
    left_out: net.left_out.map((l) => ({ currency: l.currency, accounts: l.accounts, why: apiNoRate(l.currency, l.why, l.unrated, home) })),
    rate_day: rateDay,
    rates_stale: rateDay !== null && isStale(fx, now),
    own_rates: apiOwnRates(used),
  };
}

/** One balance in base_currency (an account's `to_base`): at the newest
 *  rates, or a day's (a history point). Null with no balance or no rate. */
export function toBase(fx: FxTable, balance: number | null, currency: string | null, day: string): number | null {
  if (balance === null || currency === null || !fx.home) return null;
  const c = convert(fx, balance, currency, fx.home, day, { tidy: true });
  return c.ok ? c.amount : null;
}

/** Net worth's history in base_currency by day: each point from its split
 *  by currency at that day's rates, bridged over the same end days as the
 *  chart (lib/history.ts bridgeInteriorEstimates). A day with no value is a
 *  point that couldn't be converted (its split can't be told, or its main
 *  currency has no rate that day); `gaps` says what couldn't be. */
export function historyInBase(
  split: { points: readonly SplitPoint[]; breaks: readonly string[]; main: string | null },
  fx: FxTable,
  /** The points the answer holds (its range, estimated or not): what `gaps`
   *  counts. Bridging reads them all. */
  answered: (p: SplitPoint) => boolean = () => true
): { byDay: Map<string, number>; gaps: HistoryGaps } {
  const { points } = convertHistory(split.points, split.main, fx, fx.home!);
  const { gaps } = convertHistory(split.points.filter(answered), split.main, fx, fx.home!);
  return { byDay: new Map(bridgeInteriorEstimates(points as HistoryPoint[], split.breaks).map((p) => [p.date, p.value])), gaps };
}

/** What a person should know of a converted history, in words: the points
 *  with no to_base, and the currencies left out of some. */
export function historyNotes(gaps: HistoryGaps, home: string, main: string | null): string[] {
  const notes: string[] = [];
  const points = (n: number) => (n === 1 ? '1 point has' : `${n} points have`);
  const span = (s: { from: string; to: string }) => (s.from === s.to ? `on ${s.from}` : `from ${s.from} to ${s.to}`);
  if (gaps.unsplit > 0) notes.push(`${points(gaps.unsplit)} no to_base: Nya didn’t keep their balances by account, so they can’t be converted`);
  for (const m of gaps.main_unrated) {
    notes.push(`${points(m.days)} no to_base, ${span(m)}: ${reasonText(main ?? home, m.why, m.unrated, home, m.days === 1 ? 'one' : 'many')}`);
  }
  for (const l of gaps.left_out) {
    notes.push(`${l.currency} isn’t in to_base ${span(l)} (${l.days === 1 ? '1 point' : `${l.days} points`}): ${reasonText(l.currency, l.why, l.unrated, home, l.days === 1 ? 'one' : 'many')}`);
  }
  return notes;
}

/** Why an account's points have no to_base, in words, one note a reason,
 *  naming the currency whose rate is missing: "2 points have no to_base:
 *  there is no rate for AED on those days". */
export function pointNotes(fx: FxTable, points: readonly { date: string; value: number; to_base?: number | null }[], currency: string): string[] {
  const home = fx.home;
  if (!home) return [];
  const by = new Map<string, { why: NoRate; unrated: string; n: number }>();
  for (const p of points) {
    if (p.to_base !== null) continue;
    const c = convert(fx, p.value, currency, home, p.date, { tidy: true });
    if (c.ok) continue;
    const k = `${c.why}|${c.currency}`;
    const g = by.get(k) ?? { why: c.why, unrated: c.currency, n: 0 };
    g.n++;
    by.set(k, g);
  }
  return [...by.values()].map((g) => `${g.n === 1 ? '1 point has' : `${g.n} points have`} no to_base: ${reasonText(currency, g.why, g.unrated, home, g.n === 1 ? 'one' : 'many')}`);
}

/** What a person should know of `base`, in words: what it left out and why,
 *  and rates older than they should be. */
export function baseNotes(base: ApiBase, home: string): string[] {
  const notes: string[] = [];
  // The home currency itself without a rate: one note, naming it, since a
  // rate for any other currency would change nothing.
  const homeOut = base.left_out.filter((l) => l.why === 'base_has_no_rate');
  if (homeOut.length > 0) {
    const n = homeOut.reduce((s, l) => s + l.accounts, 0);
    notes.push(
      `Nothing can be converted into ${home} yet: the ECB doesn’t publish ${home}, so ${n === 1 ? '1 account in another currency isn’t' : `${n} accounts in other currencies aren’t`} in base. You can set a rate of your own for ${home} in the app`
    );
  }
  for (const l of base.left_out) {
    if (l.why === 'base_has_no_rate') continue;
    const which = l.accounts === 1 ? `1 account in ${l.currency} isn’t` : `${l.accounts} accounts in ${l.currency} aren’t`;
    const why =
      l.why === 'not_fetched'
        ? 'Nya doesn’t have the ECB’s rates yet'
        : l.why === 'rates_unreadable'
          ? 'the exchange rates couldn’t be read just now; try again in a moment'
          : l.why === 'quote_has_no_rate'
          ? `your own rate for ${l.currency} is in a currency the ECB has no rate for`
          : `there is no rate for ${l.currency}; you can set your own in the app`;
    notes.push(`${which} in base, which is in ${home}: ${why}`);
  }
  if (base.rates_stale) notes.push(`The newest exchange rates Nya has are from ${base.rate_day}, so base may be out of date`);
  return notes;
}

/** The note when the settings that say the home currency can't be read. */
export const SETTINGS_UNREADABLE_NOTE = 'Your currency settings couldn’t be read, so nothing is converted into your home currency';

/** What a total of transactions in base_currency converted (the `base`
 *  beside /spending, /cash-flow and the recurring bills, and how /budgets
 *  counts spending in other currencies): each currency and how many
 *  transactions in it, the first and last day of the ECB's rates used, and
 *  what was left out for having no rate, with why. Never guessed. */
export type ApiFlowsConverted = {
  converted: { currency: string; transactions: number }[];
  /** The first and last day of the ECB's rates used, or null when none was. */
  rate_days: { from: string; to: string } | null;
  /** True when a transaction dated after the newest rates Nya has was
   *  converted at them, and they are older than they should be. */
  rates_stale: boolean;
  /** The person's own rates used, as me.own_rates gives them. */
  own_rates: ApiOwnRate[];
  /** Transactions left out for having no rate, by currency, with why. */
  left_out: { currency: string; transactions: number; why: ApiNoRate }[];
  /** Transactions that say no currency, nor is their account's known (only
   *  the oldest stored history has them): counted as in `currency`, the one
   *  most transactions are in. Null when there are none. */
  assumed: { currency: string; transactions: number } | null;
};

/** A conversion (lib/fx/totals.ts) in the API's words, with what its total
 *  left out (lib/spending.ts leftOutByCurrency). */
export function flowsConverted(
  c: {
    into: string;
    from: { currency: string; count: number }[];
    days: { first: string; last: string } | null;
    own: string[];
    unrated: { currency: string; why: NoRate; unrated: string }[];
    stale: boolean;
    assumed?: number;
    assumedIn?: string;
  },
  fx: Pick<FxTable, 'own'>,
  leftOut: readonly { currency: string; count: number }[]
): ApiFlowsConverted {
  const why = new Map(c.unrated.map((u) => [u.currency, apiNoRate(u.currency, u.why, u.unrated, c.into)] as const));
  return {
    converted: c.from.map((f) => ({ currency: f.currency, transactions: f.count })),
    rate_days: c.days ? { from: c.days.first, to: c.days.last } : null,
    rates_stale: c.stale,
    own_rates: apiOwnRates(fx.own.filter((o) => c.own.includes(o.currency))),
    left_out: leftOut.map((l) => ({ currency: l.currency, transactions: l.count, why: why.get(l.currency) ?? 'no_rate' })),
    assumed: c.assumed && c.assumedIn ? { currency: c.assumedIn, transactions: c.assumed } : null,
  };
}

/** The notes a converted total of transactions adds (flowsConverted): each
 *  currency left out, and why, and rates older than they should be. */
export function flowsNotes(b: ApiFlowsConverted, home: string): string[] {
  const notes: string[] = [];
  for (const l of b.left_out) {
    const which = l.transactions === 1 ? `1 transaction in ${l.currency} isn’t` : `${l.transactions} transactions in ${l.currency} aren’t`;
    const why =
      l.why === 'base_has_no_rate'
        ? `the ECB doesn’t publish ${home}; you can set a rate of your own for it in the app`
        : l.why === 'not_fetched'
          ? 'Nya doesn’t have the ECB’s rates for those days yet'
          : l.why === 'rates_unreadable'
            ? 'the exchange rates couldn’t be read just now; try again in a moment'
            : l.why === 'quote_has_no_rate'
            ? `your own rate for ${l.currency} is in a currency the ECB has no rate for`
            : `there is no rate for ${l.currency} on those days; you can set your own in the app`;
    notes.push(`${which} in base, which is in ${home}: ${why}`);
  }
  if (b.rates_stale && b.rate_days) notes.push(`The newest exchange rates Nya has are from ${b.rate_days.to}, so base may be out of date`);
  if (b.assumed) {
    const one = b.assumed.transactions === 1;
    notes.push(
      `${one ? '1 transaction says' : `${b.assumed.transactions} transactions say`} no currency, nor is ${one ? 'its account’s' : 'their accounts’'} known, so ${one ? 'it is' : 'they are'} counted in base as in ${b.assumed.currency}, the currency most are in`
    );
  }
  return notes;
}
