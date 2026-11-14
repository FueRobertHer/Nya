// lib/returns-rate.ts
//
// The rate of return Accounts > Investments gives for a range
// (components/InvestmentGrowth.tsx): money-weighted, by the Modified Dietz
// method, so a deposit made late in the range counts for less than one made
// at its start, as a brokerage's personal rate of return does.
//
//   rate = returns / (what was invested at the start + each flow weighed by
//          the share of the range it was invested for)
//
// Over several accounts, each is a leg with its own days (lib/growth-
// summary.ts counts one from a later day when its record starts later): one
// that starts after the range does enters with its balance on its first day,
// weighed as a deposit then, and one that stops early leaves with its balance
// on its last day, weighed as a withdrawal. The returns are the legs' own, so
// the rate and the returns figure beside it always agree in sign.
//
// A flow counts from the day after its date, as on the account's chart
// (lib/growth.ts contributionBaseline): the balance on its own date doesn't
// hold it yet. Past a year the rate is given a year, as a brokerage gives
// it, and is then the internal rate of return on the same money: Modified
// Dietz assumes simple interest, which over years reads low (a steady 7% a
// year with monthly deposits reads about 6.9% over five).
//
// For all time from the deposits and withdrawals a person typed there is no
// rate: the totals say how much went in, never when. The total return stands
// instead (totalReturn): the returns as a share of every deposit since the
// account opened, withdrawals not taken off, so an account that has had more
// taken out than put in still has one. It is never a year's.
//
// Pure, and imports only types: the view runs it in the browser.

import type { Flow } from './growth';

/** One account's part of the range: its first and last day, its balance on
 *  each, and the flows between them (dated from `from` up to, not including,
 *  `to`, those the balance on `to` holds). */
export type RateLeg = { from: string; to: string; begin: number; end: number; flows: readonly Flow[] };

/** The rate as a fraction (0.092 for 9.2%), and whether it is a year's. */
export type Rate = { value: number; annual: boolean };

/** The returns as a fraction of what was deposited (0.276 for 27.6%), and
 *  what was deposited, to the cent. */
export type TotalReturn = { value: number; deposited: number };

/**
 * The total return of `returns` on everything `deposited` (see the header),
 * or null with nothing deposited: a cent's worth is as good as nothing, and
 * would make any return a huge share.
 */
export function totalReturn(returns: number, deposited: number): TotalReturn | null {
  if (!(deposited > 0.005)) return null;
  return { value: returns / deposited, deposited: Math.round(deposited * 100) / 100 };
}

const DAY_MS = 86_400_000;
const parse = (d: string) => Date.parse(`${d}T00:00:00Z`);
const days = (a: string, b: string) => Math.round((parse(b) - parse(a)) / DAY_MS);
const shift = (d: string, n: number) => new Date(parse(d) + n * DAY_MS).toISOString().slice(0, 10);

/** Longer than this many days, the rate is given a year. A year's range
 *  (1Y) spans 365 or 366 days and is a year's rate already. */
const YEAR_DAYS = 366;

/**
 * The money-weighted rate of return over the legs together, or null where
 * there is none to give: no legs, a range of no days, or nothing invested to
 * measure it against (the weighted sum is zero or below, as when everything
 * was withdrawn early on).
 */
export function returnsRate(legs: readonly RateLeg[]): Rate | null {
  if (legs.length === 0) return null;
  const start = legs.reduce((m, l) => (l.from < m ? l.from : m), legs[0].from);
  const end = legs.reduce((m, l) => (l.to > m ? l.to : m), legs[0].to);
  const span = days(start, end);
  if (span <= 0) return null;
  // The share of the range money in from `day` on was invested for.
  const weight = (day: string) => Math.min(1, Math.max(0, days(day, end) / span));
  let returns = 0;
  let invested = 0;
  for (const l of legs) {
    let net = 0;
    invested += l.begin * weight(l.from);
    for (const f of l.flows) {
      net += f.amount;
      invested += f.amount * weight(shift(f.date, 1));
    }
    // Stopping early: its balance leaves the range on its last day.
    if (l.to < end) invested -= l.end * weight(l.to);
    returns += l.end - l.begin - net;
  }
  // Nothing invested to weigh the returns by; a cent's worth is as good as
  // nothing, and would make any return a huge rate.
  if (!(invested > 0.005)) return null;
  if (span <= YEAR_DAYS) return { value: returns / invested, annual: false };
  const yearly = yearlyRate(legs, end);
  return yearly === null ? null : { value: yearly, annual: true };
}

/** Lowest and highest yearly rates searched: all but everything lost, and a
 *  thousand percent. */
const LOWEST = -0.9999;
const HIGHEST = 10;

/**
 * The yearly rate r at which the money put in, grown to `end`, comes to what
 * the legs hold there: each beginning balance and deposit grows from the day
 * it is in, each withdrawal (and each early end) stops growing on its day.
 * Found by halving the search between LOWEST and HIGHEST; null where no rate
 * there gives it.
 */
function yearlyRate(legs: readonly RateLeg[], end: string): number | null {
  const money: { amount: number; years: number }[] = [];
  let held = 0;
  for (const l of legs) {
    money.push({ amount: l.begin, years: days(l.from, end) / 365 });
    for (const f of l.flows) money.push({ amount: f.amount, years: days(shift(f.date, 1), end) / 365 });
    if (l.to < end) money.push({ amount: -l.end, years: days(l.to, end) / 365 });
    else held += l.end;
  }
  const gap = (r: number) => money.reduce((t, m) => t + m.amount * Math.pow(1 + r, Math.max(0, m.years)), 0) - held;
  let lo = LOWEST;
  let hi = HIGHEST;
  let atLo = gap(lo);
  if (Math.sign(atLo) === Math.sign(gap(hi))) return null;
  for (let i = 0; i < 200 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2;
    const atMid = gap(mid);
    if (Math.sign(atMid) === Math.sign(atLo)) {
      lo = mid;
      atLo = atMid;
    } else hi = mid;
  }
  return (lo + hi) / 2;
}
