// lib/fx/net-worth.ts
//
// Net worth in the person's home currency, now and day by day, as pure
// functions over what was stored and what was read once (lib/fx/rates.ts
// FxTable). Safe to import from client code. Nothing here is ever written: the
// stored totals stay the sums they are (in every currency at once, as before),
// and every converted figure is worked out again on each read.
//
// BALANCES CONVERT BY CURRENCY. A total of balances adds each currency's
// signed balances, then converts each subtotal once, rounded once (more exact
// than adding rounded parts: a hundred small accounts would otherwise carry up
// to fifty cents of rounding). Each subtotal and what it came to are kept, so a
// note can list them and they add up to the total exactly. An account that says
// no currency counts in `main`, the currency most of the accounts are in, as
// every total has counted it until now. A currency with no rate is left out
// and named, never guessed.
//
// A DAY OF HISTORY converts the same way, from the point's split by currency
// (lib/history.ts getHistoryWithSplit: each account in another currency than
// `main` read from the per-account map behind the point, and `main` the rest),
// at that day's rate. A point whose split can't be told is not drawn (as a
// point a hidden account can't be taken out of isn't), and neither is one
// whose main currency has no rate that day; another currency with no rate is
// left out of it and named with its days.

import { convert, displayRate, precisionOf, type FxTable, type NoRate } from './rates';

/** A balance as a total adds it: signed (owed is negative), in its currency. */
export type BalanceRow = { amount: number; currency: string | null };

export type BalancePart = {
  currency: string;
  /** The subtotal in its own currency, as added (tidied to its precision). */
  amount: number;
  /** What it came to in the home currency, or null with no rate. */
  converted: number | null;
  /** One unit of it in the home currency, for showing, and its day. */
  rate: { value: number; day: string; source: 'ecb' | 'own' } | null;
  /** Why it has no rate, when it has none. */
  why: NoRate | null;
  accounts: number;
};

export type BalancesIn = {
  currency: string;
  /** The converted parts added up. */
  total: number;
  /** Each currency's subtotal: the home currency's, those converted, then
   *  those left out, each by most accounts. */
  parts: BalancePart[];
  /** The currencies left out for having no rate, with how many accounts. */
  left_out: { currency: string; accounts: number; why: NoRate }[];
  /** Accounts that say no currency, counted in `main`. */
  unknown: number;
};

/** Rounded to `digits` places the way a sum of amounts is shown. */
export const tidyNumber = (n: number, digits: number) => {
  const s = 10 ** digits;
  return Math.round(n * s) / s || 0;
};

/**
 * A total of balances in `home`, on `day` (today, for a figure now): each
 * currency's subtotal converted once (see the header). `main` is the currency
 * an account with none counts in.
 */
export function balancesIn(rows: readonly BalanceRow[], fx: FxTable, home: string, day: string, main: string | null): BalancesIn {
  const sums = new Map<string, { amount: number; accounts: number }>();
  let unknown = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.amount)) continue;
    const c = r.currency ?? main ?? home;
    if (r.currency === null) unknown++;
    const s = sums.get(c) ?? { amount: 0, accounts: 0 };
    s.amount += r.amount;
    s.accounts++;
    sums.set(c, s);
  }
  const parts: BalancePart[] = [];
  const leftOut: BalancesIn['left_out'] = [];
  let total = 0;
  for (const [currency, { amount, accounts }] of sums) {
    const own = tidyNumber(amount, precisionOf(currency));
    const c = convert(fx, amount, currency, home, day, { tidy: true });
    if (c.ok) {
      // In the home currency already: itself, tidied, so the parts add up.
      const value = currency === home ? own : c.amount;
      total += value;
      parts.push({ currency, amount: own, converted: value, rate: displayRate(fx, currency, home, day), why: null, accounts });
    } else {
      parts.push({ currency, amount: own, converted: null, rate: null, why: c.why, accounts });
      leftOut.push({ currency, accounts, why: c.why });
    }
  }
  // The home currency's part first, then those converted, then those left
  // out, each by how many accounts, so a note reads in that order.
  const rank = (p: BalancePart) => (p.currency === home ? 0 : p.converted !== null ? 1 : 2);
  parts.sort((a, b) => rank(a) - rank(b) || b.accounts - a.accounts || (a.currency < b.currency ? -1 : 1));
  leftOut.sort((a, b) => b.accounts - a.accounts || (a.currency < b.currency ? -1 : 1));
  return { currency: home, total: tidyNumber(total, precisionOf(home)), parts, left_out: leftOut, unknown };
}

/** A point of net worth's history with its split by currency (see the
 *  header): `parts` each other currency's signed contribution, `main` the
 *  rest; null when it can't be told. Absent: nothing but `main` in it. */
export type SplitPoint = { date: string; value: number; estimated?: boolean; parts?: Record<string, number> | null };

/** What the converted chart couldn't draw or count, for its note. */
export type HistoryGaps = {
  /** Points not drawn: their split couldn't be told. */
  unsplit: number;
  /** Points not drawn: their main currency had no rate that day. */
  main_unrated: number;
  /** Currencies left out of some points for having no rate, with the first
   *  and last day they were. */
  left_out: { currency: string; from: string; to: string; days: number }[];
};

export type ConvertedPoint = { date: string; value: number; estimated?: boolean };

/** The points in `home`, each at its own day's rate, before bridging, and
 *  what couldn't be drawn or counted. */
export function convertHistory(points: readonly SplitPoint[], main: string | null, fx: FxTable, home: string): { points: ConvertedPoint[]; gaps: HistoryGaps } {
  const out: ConvertedPoint[] = [];
  const gaps: HistoryGaps = { unsplit: 0, main_unrated: 0, left_out: [] };
  const leftOut = new Map<string, { from: string; to: string; days: number }>();
  for (const p of points) {
    if (p.parts === null) {
      gaps.unsplit++;
      continue;
    }
    const parts = p.parts ?? {};
    const others = Object.values(parts).reduce((a, b) => a + b, 0);
    const rows: BalanceRow[] = [{ amount: p.value - others, currency: main }, ...Object.entries(parts).map(([currency, amount]) => ({ amount, currency }))];
    const b = balancesIn(rows, fx, home, p.date, main);
    const mainCurrency = main ?? home;
    if (b.left_out.some((l) => l.currency === mainCurrency)) {
      gaps.main_unrated++;
      continue;
    }
    for (const l of b.left_out) {
      const seen = leftOut.get(l.currency);
      if (!seen) leftOut.set(l.currency, { from: p.date, to: p.date, days: 1 });
      else {
        seen.to = p.date > seen.to ? p.date : seen.to;
        seen.from = p.date < seen.from ? p.date : seen.from;
        seen.days++;
      }
    }
    out.push({ date: p.date, value: b.total, ...(p.estimated ? { estimated: true } : {}) });
  }
  gaps.left_out = [...leftOut].map(([currency, r]) => ({ currency, ...r })).sort((a, b) => b.days - a.days || (a.currency < b.currency ? -1 : 1));
  return { points: out, gaps };
}

/** Net worth's change over about the past 30 days, as Home shows it: from the
 *  last point at least 30 days old (else the oldest) to the newest. Null when
 *  there is nothing to compare or the earlier value is zero. */
export function deltaOver(points: readonly ConvertedPoint[], now: number): { value: number; pct: number; days: number; from: string; to: string } | null {
  if (points.length < 2) return null;
  const target = now - 30 * 86_400_000;
  let base = points[0];
  for (const p of points) if (Date.parse(`${p.date}T00:00:00Z`) <= target) base = p;
  const current = points[points.length - 1];
  if (base.date === current.date || base.value === 0) return null;
  const value = current.value - base.value;
  const days = Math.round((Date.parse(`${current.date}T00:00:00Z`) - Date.parse(`${base.date}T00:00:00Z`)) / 86_400_000);
  return { value, pct: (Math.abs(value) / Math.abs(base.value)) * 100, days, from: base.date, to: current.date };
}

/**
 * How much of a change between two days came from exchange rates: what the
 * earlier day's balances, split by currency, come to at the later day's rates,
 * less what they came to at their own. Null when either day can't be told, or
 * when it is no more than rounding (each conversion rounds by at most half a
 * unit, so under one unit of the home currency's smallest per currency
 * converted).
 */
export function rateEffect(earlier: SplitPoint | undefined, laterDay: string, main: string | null, fx: FxTable, home: string): number | null {
  if (!earlier || earlier.parts === null) return null;
  const parts = earlier.parts ?? {};
  const others = Object.values(parts).reduce((a, b) => a + b, 0);
  const rows: BalanceRow[] = [{ amount: earlier.value - others, currency: main }, ...Object.entries(parts).map(([currency, amount]) => ({ amount, currency }))];
  const then = balancesIn(rows, fx, home, earlier.date, main);
  const now = balancesIn(rows, fx, home, laterDay, main);
  // A currency left out on both days (no rate either day) is in neither
  // total, so moves nothing; one left out on only one of them can't be told.
  const out = (b: BalancesIn) => new Set(b.left_out.map((l) => l.currency));
  const [outThen, outNow] = [out(then), out(now)];
  if (outThen.size !== outNow.size || [...outThen].some((c) => !outNow.has(c))) return null;
  const converted = then.parts.filter((p) => p.currency !== home && p.converted !== null).length;
  const effect = tidyNumber(now.total - then.total, precisionOf(home));
  const unit = 10 ** -precisionOf(home);
  return converted > 0 && Math.abs(effect) > converted * unit ? effect : null;
}
