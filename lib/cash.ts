// lib/cash.ts
//
// Which part of an investment account is money that hasn't been put to work.
//
// A brokerage balance is one number but it is not one thing. An account holding
// $40k of VTSAX plus $12k sitting in VMFXX -- Vanguard's federal money market
// fund, where uninvested cash lands by default -- reports $52k and looks
// identical to a fully invested $52k. The second case is a decision waiting to
// be made; the first is not. This module is the rule that tells them apart,
// shared by the Accounts tab badge and the Home tab insight.
//
// Imports nothing, for the same reason lib/balance.ts and lib/format.ts import
// nothing: the Dashboard is a client component, so anything it pulls in is
// bundled for the browser.

export type CashHolding = {
  account_id?: string;
  name?: string | null;
  /** Plaid security.ticker_symbol. "CUR:USD" for a broker's plain cash row. */
  ticker?: string | null;
  /** Plaid security.type: cash | equity | etf | mutual fund | fixed income | ... */
  security_type?: string | null;
  /** Plaid security.is_cash_equivalent. */
  is_cash_equivalent?: boolean | null;
  value?: number | null;
};

// Plaid's `cash` security type is documented as "Cash, currency, and money
// market funds", so it covers both shapes of idle money on its own -- where the
// institution reports enough for Plaid to classify the security at all. It's
// null "when institutional data is insufficient", which is why the rules below
// don't stop here. 'money market' is not a value Plaid emits today; it's listed
// so that a future one wouldn't silently fall through to "invested".
const CASH_SECURITY_TYPES = new Set(['cash', 'money market']);

// Settlement and sweep funds at the big brokerages. `is_cash_equivalent` comes
// from Plaid's securities reference data and is not uniformly populated, and
// the two mistakes are not the same size: a money market fund the holder chose
// on purpose, flagged as idle, is a line they can read and dismiss; $12k of
// settlement cash that never gets flagged is the thing this feature exists to
// catch. So a known ticker counts even when the flag says otherwise.
const CASH_TICKERS = new Set([
  'CUR:USD',
  // Vanguard
  'VMFXX', 'VMRXX', 'VUSXX', 'VMSXX',
  // Fidelity
  'SPAXX', 'FDRXX', 'FZFXX', 'FDLXX', 'SPRXX',
  // Schwab
  'SWVXX', 'SNVXX', 'SNSXX', 'SWGXX',
  // E*TRADE / Morgan Stanley, Merrill, T. Rowe
  'MMDA1', 'TTTXX', 'TSCXX',
]);

// The catch-all for everyone not on that list. A fund with "money market" in
// its name is a money market fund; a "cash reserves" or "settlement fund" line
// is the sweep account under another name. Deliberately narrow: short-duration
// bond and T-bill ETFs are cash-LIKE but they are still a position someone
// chose, and calling them idle would cry wolf on the badge.
const CASH_NAME =
  /\b(?:money market|cash reserves?|cash sweep|sweep account|settlement fund|federal money market)\b/i;

/** True when this position is money sitting in cash rather than invested. */
export function isCashHolding(h: CashHolding): boolean {
  if (h.is_cash_equivalent === true) return true;
  if (CASH_SECURITY_TYPES.has((h.security_type || '').toLowerCase())) return true;
  if (h.ticker && CASH_TICKERS.has(h.ticker.toUpperCase())) return true;
  return CASH_NAME.test(h.name || '');
}

export type CashSummary = {
  /** Value sitting in cash and cash equivalents. */
  cash: number;
  /** Value in everything else. */
  invested: number;
  total: number;
  /** cash / total, 0 when there is nothing to divide by. */
  share: number;
  /** Material enough to be worth acting on -- see the thresholds below. */
  flagged: boolean;
};

// When idle cash is worth interrupting someone over. Every settlement account
// carries a little cash (a dividend that landed this morning, the rounding left
// over from a buy), so flagging any nonzero amount would make the badge
// meaningless within a week.
//
// Two ways to qualify, because share and size each miss a real case on their
// own: 3% of a $400k portfolio is $12k that should be invested, and 100% of a
// $600 IRA is a contribution that never got placed.
export const IDLE_CASH_MIN_VALUE = 500;
export const IDLE_CASH_MIN_SHARE = 0.02;
export const IDLE_CASH_LARGE_VALUE = 10_000;

export function summarizeCash(holdings: CashHolding[]): CashSummary {
  let cash = 0;
  let invested = 0;
  for (const h of holdings) {
    // A null value is unknown, not zero: counting it as zero would shrink the
    // denominator and overstate the cash share.
    if (h.value == null) continue;
    if (isCashHolding(h)) cash += h.value;
    else invested += h.value;
  }
  const total = cash + invested;
  const share = total > 0 ? cash / total : 0;
  return {
    cash,
    invested,
    total,
    share,
    flagged:
      cash >= IDLE_CASH_MIN_VALUE &&
      (share >= IDLE_CASH_MIN_SHARE || cash >= IDLE_CASH_LARGE_VALUE),
  };
}

/**
 * Per-account summaries, for the badge on an individual brokerage row.
 *
 * Holdings cached before this shipped -- and those from a payload written
 * before `account_id` was carried at all -- can't be attributed to a row, so
 * they're dropped here rather than lumped under a key that isn't an account.
 * They still count toward the institution-level figure, which sums the whole
 * list.
 */
export function cashByAccount(holdings: CashHolding[]): Record<string, CashSummary> {
  const grouped: Record<string, CashHolding[]> = {};
  for (const h of holdings) {
    if (!h.account_id) continue;
    (grouped[h.account_id] ??= []).push(h);
  }
  const out: Record<string, CashSummary> = {};
  for (const [id, hs] of Object.entries(grouped)) out[id] = summarizeCash(hs);
  return out;
}
