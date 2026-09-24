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
  // Fidelity ('FCASH' is its non-fund core position, typed by some feeds as an
  // ordinary security with a name that matches nothing below)
  'SPAXX', 'FDRXX', 'FZFXX', 'FDLXX', 'SPRXX', 'FCASH',
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
//
// Narrow is all this rule can be, not all the classifier is: Plaid's flag is
// checked first and means "highly liquid asset [that] can be treated like
// cash", which is broader than uninvested. A T-bill ETF that Plaid marks
// cash-equivalent is still flagged, and that is Plaid's call, not this one's.
const CASH_NAME = /\b(?:money market|cash reserves?|cash sweep|sweep account|settlement fund)\b/i;

/** True when this position is money sitting in cash rather than invested. */
export function isCashHolding(h: CashHolding): boolean {
  if (h.is_cash_equivalent === true) return true;
  if (CASH_SECURITY_TYPES.has((h.security_type || '').toLowerCase())) return true;
  if (h.ticker && CASH_TICKERS.has(h.ticker.toUpperCase())) return true;
  return CASH_NAME.test(h.name || '');
}

// Investment account subtypes that are cash BY DESIGN. A Fidelity cash
// management account or a money market account carried under an investment Item
// holds ~100% cash at all times, so the flag below would be true forever with
// nothing the holder could ever do to clear it -- a permanent amber dot on an
// account that is working exactly as intended, and there is no dismiss.
//
// HSAs are deliberately NOT here. An HSA sitting entirely in cash is the
// textbook case of money that should have been invested and wasn't, which is
// the thing this whole module exists to surface.
const CASH_BY_DESIGN_SUBTYPES = new Set(['cash management', 'money market']);

/**
 * Whether an idle-cash warning would be meaningless for this account, by
 * Plaid's account subtype. Callers use it to suppress the badge entirely rather
 * than to change the arithmetic: the cash is real, it just isn't news.
 */
export function isCashByDesign(subtype: string | null | undefined): boolean {
  return CASH_BY_DESIGN_SUBTYPES.has((subtype || '').toLowerCase());
}

export type CashSummary = {
  /** Value sitting in cash and cash equivalents. */
  cash: number;
  /** Value in everything else. */
  invested: number;
  total: number;
  /**
   * Fraction of the priced holdings sitting in cash, clamped to 0..1.
   *
   * Clamped at BOTH ends because either can go out of range on a margin
   * account (see summarizeCash). A denominator at or below zero reads as 1
   * rather than 0: cash outweighing everything else is the extreme of this
   * scale, not the absence of it, and rounding it to 0 would hide the pile the
   * badge exists to show. Callers that print it as "% of holdings" should
   * still check `total > 0` first -- the ratio is honest, the phrase isn't.
   */
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
    // An unpriced holding contributes nothing either way. (Skipping it and
    // adding zero are the same arithmetic; it's skipped because a holding with
    // no value isn't evidence of anything, cash or invested.)
    if (h.value == null) continue;
    if (isCashHolding(h)) cash += h.value;
    else invested += h.value;
  }
  const total = cash + invested;
  // Clamped at both ends, because Plaid reports a short position or a margin
  // debit with a NEGATIVE institution_value and either side can carry one:
  // $15k of settlement cash against a $5k short is a $10k total and a raw share
  // of 1.5, and a margin debit on the cash line itself is a negative numerator.
  // Neither "150% of holdings is sitting in cash" nor "-5%" is a sentence worth
  // shipping. The cash figure itself stays exact; only the ratio is bounded.
  const share =
    total > 0 ? Math.min(Math.max(cash / total, 0), 1) : cash > 0 ? 1 : 0;
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
 * A cash share as a percentage for display: whole numbers from 10% up, one
 * decimal below that, and "<0.1%" rather than "0.0%" for a nonzero share too
 * small to show. A row that has just printed a cash amount and then says 0.0%
 * reads as a contradiction, or worse, as a statement about the invested part.
 */
export function cashSharePct(share: number): string {
  if (share > 0 && share < 0.0005) return '<0.1%';
  return `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%`;
}

/**
 * Per-account summaries, for the badge on an individual brokerage row.
 *
 * A holding with no `account_id` -- one from a localStorage payload written
 * before that field was carried at all -- can't be attributed to a row, so it's
 * dropped here rather than lumped under a key that isn't an account. It still
 * counts toward the institution-level figure, which sums the whole list.
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

/** The subset of an account this module needs to judge its holdings. */
export type CashAccount = { account_id: string; subtype?: string | null };

/**
 * One institution's idle-cash verdict, for every surface that renders it.
 *
 * Three places ask about the same money -- the badge under an account row, the
 * chip on each cash holding, and the Holdings header -- and they must not
 * disagree, so they all read this. In particular the header's AMOUNT and its
 * COLOUR come from the same population here; sourcing them separately let a
 * $600 flag paint a $50,600 total amber.
 *
 * Accounts that are cash by design drop out of all of it: their holdings
 * aren't counted, so they get no summary, no amber, and no share of the header
 * figure. The factual "Cash" label on their holding rows is unaffected -- that
 * one is a statement about the security, not about whether anything ought to be
 * done.
 *
 * Pass the accounts that are actually RENDERED. Hidden accounts are already
 * gone from the Accounts tab list, and this drops their holdings with them.
 */
export function institutionCash(
  accounts: CashAccount[],
  holdings: CashHolding[]
): {
  cash: number;
  flagged: boolean;
  byAccount: Record<string, CashSummary>;
  flaggedAccounts: Set<string>;
} {
  const rendered = new Map(accounts.map((a) => [a.account_id, a] as const));
  const counted = holdings.filter((h) => {
    const owner = h.account_id ? rendered.get(h.account_id) : undefined;
    return !owner || !isCashByDesign(owner.subtype);
  });

  const byAccount = cashByAccount(counted);
  const flaggedAccounts = new Set(
    Object.keys(byAccount).filter((id) => byAccount[id].flagged && rendered.has(id))
  );

  // Cash belonging to no rendered account: a payload cached before holdings
  // carried account_id, or a position whose parent account this Item didn't
  // return. No row can badge it, so the header answers for it -- but on its own
  // merits, rather than by falling back to a total that already includes cash
  // the rows have judged and passed on.
  const unattributed = counted.filter((h) => !h.account_id || !rendered.has(h.account_id));

  // An institution that is nothing BUT cash-by-design accounts has nothing to
  // say, including about holdings it couldn't attribute to one of them.
  const allByDesign = accounts.length > 0 && accounts.every((a) => isCashByDesign(a.subtype));

  return {
    cash: summarizeCash(counted).cash,
    flagged: !allByDesign && (flaggedAccounts.size > 0 || summarizeCash(unattributed).flagged),
    byAccount,
    flaggedAccounts,
  };
}
