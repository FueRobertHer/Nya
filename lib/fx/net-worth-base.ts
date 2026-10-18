// lib/fx/net-worth-base.ts
//
// Net worth in the person's home currency, as /api/net-worth answers it
// beside the figures it has always answered (`base`): the total now, each
// currency's part, what was left out, the chart converted day by day, its
// change over recent days and how much of that came from exchange rates.
// Pure, given what was read once (lib/fx/rates.ts FxTable). Never stored:
// the cached payload keeps the unconverted split (HistorySplit), and this runs
// after the cache, on every answer.

import { bridgeInteriorEstimates, withTodayPoint, type HistoryPoint } from '../history';
import { balancesIn, convertHistory, deltaOver, rateEffect, tidyNumber, type BalancesIn, type BalancePart, type BalanceRow, type HistoryGaps, type SplitPoint } from './net-worth';
import { isStale, precisionOf, type EcbLatest, type FxTable, type OwnRate } from './rates';

/** What the cache keeps to convert the chart after it: the points with their
 *  split (unconverted), the end days bridging steps on, the currency the
 *  rest of each point is in, and today's live rows by currency. */
export type HistorySplit = {
  main: string | null;
  breaks: string[];
  points: SplitPoint[];
  /** Today's point's rows (the visible accounts, and those whose end comes
   *  after the UTC day it is recorded on), when it landed. */
  today: { date: string; rows: BalanceRow[] } | null;
  /** Accounts in the stored points whose currency Nya doesn't know: counted
   *  in `main`, as before. */
  unknown_currency: number;
};

export type NetWorthBase = {
  currency: string;
  net_worth: number;
  parts: BalancePart[];
  left_out: BalancesIn['left_out'];
  /** Accounts that say no currency, counted in the main one. */
  unknown: number;
  history: HistoryPoint[];
  gaps: HistoryGaps & { unknown_currency: number };
  delta: { value: number; pct: number; days: number; from: string; to: string; from_rates: number | null } | null;
  /** The newest publication's day and whether it is older than it should be
   *  (lib/fx/rates.ts isStale), when anything needed a rate; and the
   *  person's own rates. */
  rates: { day: string | null; stale: boolean; own: OwnRate[] };
  /** For the page's own figures (an institution's total, connection
   *  health's share): the newest publication, only its rates for these
   *  currencies, and the person's own rates. Never a series. */
  fx: { home: string; latest: EcbLatest | null; own: OwnRate[] };
};

/** The currencies a set of rows and points involve. */
export function currenciesOf(rows: readonly BalanceRow[], split: HistorySplit | null): Set<string> {
  const out = new Set<string>();
  for (const r of rows) if (r.currency) out.add(r.currency);
  if (split) {
    if (split.main) out.add(split.main);
    for (const p of split.points) for (const c of Object.keys(p.parts ?? {})) out.add(c);
    for (const r of split.today?.rows ?? []) if (r.currency) out.add(r.currency);
  }
  return out;
}

export function netWorthBase(input: {
  fx: FxTable;
  /** The visible accounts' balances now. */
  rows: readonly BalanceRow[];
  main: string | null;
  split: HistorySplit;
  now: number;
}): NetWorthBase {
  const { fx, rows, main, split, now } = input;
  const home = fx.home!;
  const today = new Date(now).toISOString().slice(0, 10);
  const day = split.today?.date ?? today;
  const hero = balancesIn(rows, fx, home, day, main);

  const converted = convertHistory(split.points, split.main, fx, home);
  let history = bridgeInteriorEstimates(converted.points as HistoryPoint[], split.breaks);
  if (split.today) {
    const point = balancesIn(split.today.rows, fx, home, split.today.date, main);
    if (!point.left_out.some((l) => l.currency === (main ?? home))) history = withTodayPoint(history, split.today.date, point.total, split.breaks);
  }

  const raw = deltaOver(history, now);
  // The change between two converted figures, to the home currency's unit.
  const d = raw ? { ...raw, value: tidyNumber(raw.value, precisionOf(home)) } : null;
  // The rate effect needs the earlier day's split: a point drawn from the
  // stored ones, not one bridging made up.
  const earlier = d ? split.points.find((p) => p.date === d.from) : undefined;
  const delta = d ? { ...d, from_rates: rateEffect(earlier, d.to, split.main, fx, home) } : null;

  const used = currenciesOf(rows, split);
  // No rate is needed when everything is in the home currency: none is said
  // to be old.
  const foreign = [...used].some((c) => c !== home);
  const latest = fx.latest ? { date: fx.latest.date, rates: Object.fromEntries(Object.entries(fx.latest.rates).filter(([c]) => used.has(c) || c === home || fx.own.some((o) => o.quote === c))) } : null;
  return {
    currency: home,
    net_worth: hero.total,
    parts: hero.parts,
    left_out: hero.left_out,
    unknown: hero.unknown,
    history,
    gaps: { ...converted.gaps, unknown_currency: split.unknown_currency },
    delta,
    rates: { day: foreign ? (fx.latest?.date ?? null) : null, stale: foreign && isStale(fx, now), own: [...fx.own] },
    fx: { home, latest, own: [...fx.own] },
  };
}
