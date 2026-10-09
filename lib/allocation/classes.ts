// lib/allocation/classes.ts
//
// Asset classes, and which class (or mix of classes) a holding is in.
//
// A holding is classified by the first of these that speaks for it:
//
//   1. a split the person set for its ticker (or, for a holding with no
//      ticker, its name): theirs wins over everything below;
//   2. lib/cash.ts's rule for money sitting in cash (Plaid's cash-equivalent
//      flag, its cash type, the big brokerages' settlement funds), the same
//      rule the idle-cash badge uses;
//   3. Nya's list of broad index funds and ETFs (lib/allocation/funds.ts),
//      each with the split its mandate fixes;
//   4. Plaid's security type, but only where the security is itself one
//      class: a single company's stock is a stock, a bond or CD is a bond, a
//      coin is crypto, an option is "other".
//
// Anything else is UNCLASSIFIED, never a guess: a fund Nya's list doesn't
// have (a target-date fund, whose mix moves every year, or an actively
// managed one), a leveraged or inverse fund (isLeveragedOrInverse: never its
// index's class at face value, even when Plaid types it as an equity), or a
// security Plaid gives no type for. It is shown as its own share until the
// person classifies it.
//
// A stock's region is a class of its own when it isn't known. Plaid's
// "equity" type covers "domestic and foreign equities" and nothing in a
// holding says which, and a world fund's split between US and international
// moves with markets, so these are "Stocks, region unknown": surely stocks
// (the Plan's mix counts them as such), but not called US or international.
//
// Imports only lib/cash.ts, which imports nothing: the Plan tab runs this in
// the browser, and the server classifies recorded days with it too.

import { isCashHolding } from '@/lib/cash';
import { fundSplit } from './funds';

/** The classes a split can name, in the order they are shown: the classes
 *  most portfolios hold first, then the rest. Charts color them in this order
 *  (components/allocation-text.ts), which is the order their colors were
 *  checked for telling neighbours apart. */
export const ASSET_CLASSES = ['us-stocks', 'intl-stocks', 'bonds', 'cash', 'stocks', 'real-estate', 'crypto', 'other'] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];
/** A class, or unclassified: where money goes in an allocation. */
export type Slot = AssetClass | 'unclassified';
export const SLOTS: readonly Slot[] = [...ASSET_CLASSES, 'unclassified'];

export const CLASS_NAMES: Record<Slot, string> = {
  'us-stocks': 'US stocks',
  'intl-stocks': 'International stocks',
  stocks: 'Stocks, region unknown',
  bonds: 'Bonds',
  cash: 'Cash',
  'real-estate': 'Real estate',
  crypto: 'Crypto',
  other: 'Other',
  unclassified: 'Unclassified',
};

/** The classes that are stocks, whatever their region. */
export const STOCK_CLASSES: readonly AssetClass[] = ['us-stocks', 'intl-stocks', 'stocks'];

/** Percents by class, each above 0 and at most one decimal, adding up to
 *  100. Classes it doesn't name hold none. */
export type Split = Partial<Record<AssetClass, number>>;

const isClass = (k: string): k is AssetClass => (ASSET_CLASSES as readonly string[]).includes(k);

/** A percent in tenths, or null when it isn't a whole number of tenths. */
export function tenths(p: number): number | null {
  if (!Number.isFinite(p)) return null;
  const t = Math.round(p * 10);
  return Math.abs(p * 10 - t) < 1e-6 ? t : null;
}

/**
 * Why a split can't be used, or null when it can: every key a class, every
 * share a number above 0 and at most 100 with at most one decimal, adding up
 * to exactly 100 (counted in tenths, so 33.3 + 33.3 + 33.4 is 100).
 */
export function splitProblem(split: unknown): string | null {
  if (typeof split !== 'object' || split === null || Array.isArray(split)) return 'must be an object of percents by class';
  const entries = Object.entries(split as Record<string, unknown>);
  if (entries.length === 0) return 'must name at least one class';
  let sum = 0;
  for (const [k, v] of entries) {
    if (!isClass(k)) return `has an unknown class "${k.slice(0, 40)}"`;
    if (typeof v !== 'number' || !(v > 0) || v > 100) return `gives ${k} a share that isn't above 0 and at most 100`;
    const t = tenths(v);
    if (t === null) return `gives ${k} more than one decimal`;
    sum += t;
  }
  return sum === 1000 ? null : `adds up to ${sum / 10}%, not 100%`;
}

export const isCompleteSplit = (split: unknown): split is Split => splitProblem(split) === null;

/** The names inside a sentence. */
export const CLASS_WORDS: Record<Slot, string> = {
  'us-stocks': 'US stocks',
  'intl-stocks': 'international stocks',
  stocks: 'stocks (region unknown)',
  bonds: 'bonds',
  cash: 'cash',
  'real-estate': 'real estate',
  crypto: 'crypto',
  other: 'other',
  unclassified: 'unclassified',
};

/** "60% US stocks, 40% bonds": the largest share first. */
export function splitText(split: Split): string {
  return ASSET_CLASSES.filter((c) => (split[c] ?? 0) > 0)
    .sort((a, b) => (split[b] as number) - (split[a] as number))
    .map((c) => `${split[c]}% ${CLASS_WORDS[c]}`)
    .join(', ');
}

/** What a holding is classified from: lib/cash.ts's fields, the names Plaid
 *  gives them (and holdings history records them under). */
export type SecurityLike = {
  ticker?: string | null;
  name?: string | null;
  security_type?: string | null;
  is_cash_equivalent?: boolean | null;
};

/** The person's splits, by ticker and, for securities with no ticker, by
 *  name (lib/allocation/settings.ts overridesOf). */
export type FundSplits = {
  byTicker: ReadonlyMap<string, Split>;
  byName: ReadonlyMap<string, Split>;
};

export const NO_SPLITS: FundSplits = { byTicker: new Map(), byName: new Map() };

/** A ticker as it is compared: trimmed, upper case. */
export const tickerKey = (t: string) => t.trim().toUpperCase();
/** A name as it is compared: trimmed, spaces collapsed, lower case. */
export const nameKey = (n: string) => n.trim().replace(/\s+/g, ' ').toLowerCase();

/** The name the live payload gives a security Plaid named nothing
 *  (lib/networth.ts fetchHoldings): never a name to classify by. */
const NO_NAME = 'unknown';

/** How a security is identified for a split: its ticker, or its name when it
 *  has no ticker, or null when it has neither (it can't be classified by
 *  hand). */
export function securityKey(s: SecurityLike): { ticker: string } | { name: string } | null {
  const ticker = s.ticker?.trim();
  if (ticker) return { ticker: tickerKey(ticker) };
  const name = s.name?.trim();
  if (name && nameKey(name) !== NO_NAME) return { name };
  return null;
}

/** Why a holding is unclassified. */
export type UnclassifiedWhy =
  /** A fund (an ETF or mutual fund) Nya's list doesn't have. */
  | 'fund'
  /** A leveraged or inverse fund (isLeveragedOrInverse). */
  | 'leveraged'
  /** Plaid gives no type for it, or "other". */
  | 'unknown'
  /** A split saved for it can't be used (not 100%: an older or later
   *  release's). */
  | 'bad-split';

export type Classified =
  | {
      split: Split;
      /** Your split, the cash rule, Nya's list, or Plaid's type. */
      by: 'yours' | 'cash' | 'list' | 'type';
    }
  | { split: null; why: UnclassifiedWhy };

/** Plaid's security types that are one class by themselves. "cash" is
 *  lib/cash.ts's, checked before these. */
const BY_TYPE: Record<string, AssetClass> = {
  equity: 'stocks',
  'fixed income': 'bonds',
  cryptocurrency: 'crypto',
  derivative: 'other',
  loan: 'other',
};

/**
 * Tickers of well-known leveraged and inverse funds: ETFs and ETNs whose
 * daily return is a multiple of an index's or a stock's, or its opposite.
 * Not every one there is: one off this list is caught by its name.
 */
const LEVERAGED_TICKERS: ReadonlySet<string> = new Set([
  // Nasdaq-100, S&P 500, Dow, small and mid caps
  'TQQQ', 'SQQQ', 'QLD', 'QID', 'PSQ', 'UPRO', 'SPXU', 'SPXL', 'SPXS', 'SSO', 'SDS', 'SH', 'SPDN',
  'UDOW', 'SDOW', 'DDM', 'DXD', 'DOG', 'TNA', 'TZA', 'URTY', 'SRTY', 'UWM', 'TWM', 'RWM', 'MIDU', 'MVV', 'MZZ',
  // Sectors
  'SOXL', 'SOXS', 'TECL', 'TECS', 'FAS', 'FAZ', 'LABU', 'LABD', 'FNGU', 'FNGD', 'BULZ', 'ERX', 'ERY', 'GUSH', 'DRIP',
  'NUGT', 'DUST', 'JNUG', 'JDST', 'DPST', 'CURE', 'NAIL', 'DFEN', 'WEBL', 'HIBL', 'RETL', 'UYG', 'SKF', 'ROM', 'REW',
  'SSG', 'URE', 'SRS', 'DIG', 'DUG',
  // Treasuries
  'TMF', 'TMV', 'TBT', 'TBF', 'UBT', 'TYD', 'TYO', 'TTT', 'PST',
  // Other countries
  'YINN', 'YANG', 'EDC', 'EDZ', 'EET', 'EEV', 'EFO', 'EFU', 'EFZ', 'EUM', 'KORU', 'INDL', 'MEXX', 'BRZU', 'EURL',
  // Commodities and volatility
  'UCO', 'SCO', 'BOIL', 'KOLD', 'AGQ', 'ZSL', 'UGL', 'GLL', 'UVXY', 'SVXY', 'SVIX', 'UVIX',
  // Single stocks and crypto
  'TSLL', 'TSLQ', 'TSLZ', 'NVDL', 'NVDU', 'NVDQ', 'NVDD', 'CONL', 'MSTU', 'MSTX', 'AAPU', 'AMZU', 'GGLL', 'METU', 'MSFU',
  'BITX', 'BITU', 'SBIT', 'ETHU', 'ETHT',
]);

/** Words that say a security is a fund: an ETF, ETN or ETP, a fund or a
 *  trust, or a family that makes only funds (ProShares, Direxion, and the
 *  "Daily Target" and T-REX lines). Every rule on a name below needs one, so
 *  a company whose name holds the same words ("10x Genomics", "Ultra Clean
 *  Holdings", "Build-A-Bear Workshop") is never taken for a fund. */
const FUND_WORDS = /\b(etfs?|etns?|etps?|funds?|trust|proshares|direxion|daily target|t-rex)\b/;

/**
 * Whether a security is a leveraged or inverse fund, by its ticker (a list of
 * the well-known ones) or, in a fund's name (FUND_WORDS), by: a daily
 * multiple ("2x", "3X", "-1x", "1.5x", "2xLeveraged"); a series that makes
 * only such funds ("Direxion Daily", "Daily Target", T-REX); "UltraPro",
 * "UltraShort", "Inverse", "Leveraged" (not a fund of leveraged loans);
 * "Bull", "Bear" and "Ultra"; and "Short" (not a fund of short-dated bonds:
 * "Short-Term Bond", "Ultra-Short Income", "Short Treasury"). An issuer that
 * also makes plain funds (ProShares' NOBL and BITO, say) is not a marker by
 * itself. Such a fund's return is a multiple of its index's, or its
 * opposite, so it is never that index's class at face value: an inverse fund
 * counted as stocks would count a bet against stocks as holding them.
 */
export function isLeveragedOrInverse(s: SecurityLike): boolean {
  const ticker = s.ticker ? tickerKey(s.ticker) : '';
  if (LEVERAGED_TICKERS.has(ticker)) return true;
  const name = ` ${(s.name ?? '').toLowerCase().replace(/\s+/g, ' ')} `;
  if (!FUND_WORDS.test(name)) return false;
  // A multiple: "2x", "-1x", "1.5x", or one run into its word ("2xleveraged").
  if (/(^|[^a-z0-9.])[-+]?\d+(\.\d+)?x(?:(?![a-z0-9])|(?=leveraged|long|short|inverse|bull|bear))/.test(name)) return true;
  if (/\b(direxion daily|daily target|t-rex|ultrapro|ultrashort|inverse|bull|bear)\b/.test(name)) return true;
  if (/\bleveraged\b(?! loans?\b)/.test(name)) return true;
  if (/\bultra\b(?![- ]short\b)/.test(name)) return true;
  // "Short" for a fund of short-dated bonds is followed by what it holds.
  return /\bshort\b(?![- ](term|duration|maturity|dated|treasury|bond|income|municipal|muni|government|govt|tax))/.test(name);
}

/** Which class, or mix of classes, a holding is in (see the top of this
 *  file). Pure and total. */
export function classify(s: SecurityLike, splits: FundSplits = NO_SPLITS): Classified {
  const key = securityKey(s);
  const yours = key === null ? undefined : 'ticker' in key ? splits.byTicker.get(key.ticker) : splits.byName.get(nameKey(key.name));
  if (yours !== undefined) return isCompleteSplit(yours) ? { split: yours, by: 'yours' } : { split: null, why: 'bad-split' };
  if (isCashHolding(s)) return { split: { cash: 100 }, by: 'cash' };
  const listed = s.ticker ? fundSplit(s.ticker) : null;
  if (listed) return { split: listed.split, by: 'list' };
  // Never at face value, whatever type Plaid gives it.
  if (isLeveragedOrInverse(s)) return { split: null, why: 'leveraged' };
  const type = (s.security_type ?? '').toLowerCase();
  if (Object.hasOwn(BY_TYPE, type)) return { split: { [BY_TYPE[type]]: 100 }, by: 'type' };
  return { split: null, why: type === 'etf' || type === 'mutual fund' ? 'fund' : 'unknown' };
}

/** A value spread over a split's classes, exactly: the last class named
 *  takes what rounding leaves, so the parts always add up to the value. */
export function spread(value: number, split: Split): [AssetClass, number][] {
  const named = ASSET_CLASSES.filter((c) => (split[c] ?? 0) > 0);
  const out: [AssetClass, number][] = [];
  let left = value;
  named.forEach((c, i) => {
    const part = i === named.length - 1 ? left : (value * (split[c] as number)) / 100;
    out.push([c, part]);
    left -= part;
  });
  return out;
}
