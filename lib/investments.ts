// lib/investments.ts
//
// Reads /investments/transactions/get and turns it into two things:
//   1. an activity list for the expanded investment account row, and
//   2. `valueDelta`, the signed change a transaction makes to an account's
//      TOTAL value, which is what lets the net-worth backfill walk brokerage
//      balances backward instead of holding them flat at today's number.
//
// Fetching and storing live in lib/invstore.ts; this module is the pure rules
// for what a transaction means, plus the helpers the store shares.

export type InvestmentTxn = {
  investment_transaction_id: string;
  account_id: string;
  date: string; // YYYY-MM-DD
  name: string;
  type: string; // buy | sell | cash | fee | transfer | cancel
  subtype: string;
  quantity: number;
  price: number;
  /** Plaid's convention: positive when cash is DEBITED (a buy), negative when credited. */
  amount: number;
  fees: number | null;
  currency: string | null;
  security: string | null;
};

// Unsettled rows. Investment transactions have no `pending` boolean, so these
// two subtypes stand in for it. Left in, they'd be un-applied by the walk once
// and again when the settled row appears.
const PENDING_SUBTYPES = new Set(['pending credit', 'pending debit']);

// Subtypes that move value in or out of the account from outside it. Everything
// here is treated as an external flow of -amount.
const EXTERNAL_FLOW_SUBTYPES = new Set([
  'deposit',
  'withdrawal',
  'contribution',
  'distribution',
  'transfer',
  'send',
  'request',
  // Not a subtype Plaid emits today (see isRollover). Listed anyway: an
  // unrecognised subtype falls through to 0, so a $60k arrival would be
  // invisible to the balance walk and to the activity panel.
  'rollover',
]);

// Corporate actions. Plaid files these under type 'transfer', but they are not
// money entering or leaving: a spin-off or merger reports the value of the shares
// RECEIVED while the matching position leaves, so net account value is ~0.
// Treating them as external inflow would push the reconstructed balance down by
// their full value a year ago.
const CORPORATE_ACTION_SUBTYPES = new Set([
  'merger',
  'spin off',
  'split',
  'stock distribution',
  'assignment',
  'exercise',
  'expire',
  'adjustment',
  'rebalance',
  'trade',
]);

/** Subtypes that represent money the account holder actually put in. */
const CONTRIBUTION_SUBTYPES = new Set(['contribution', 'deposit', 'transfer']);

// Rollovers: retirement money moved between accounts (401k -> IRA, IRA -> IRA).
// Plaid has no subtype for them, so they arrive as `transfer`, `contribution` or
// `deposit` on the receiving side and `withdrawal` or `distribution` on the
// sending side, with the word itself only in the free-text `name`. Matching it
// takes care because the word appears there for two different reasons.

// Institutions format descriptions differently (spaces, underscores, hyphens,
// none), so flatten every non-alphanumeric run to one space and write the
// patterns below once, against words.
function normalizeName(name: string): string {
  return (name || '')
    // Split camel case first: "RolloverIRA" is the account label with the space
    // left out, and without this the event pattern's trailing boundary fails.
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
}

// "Rollover IRA" is the NAME OF AN ACCOUNT, not a description of what happened:
// an IRA opened to receive a former employer's plan keeps the label for life,
// and some institutions put it on every row, contributions included. They don't
// agree on word order, so every spelling has to be here: recognising only one
// splits an account's rows between the two figures by phrasing alone.
const ROLLOVER_ACCOUNT_LABEL =
  /\b(?:rollover (?:roth |trad |traditional )?(?:iras?|individual retirement accounts?)|iras? rollover)\b/g;

// Words that identify an ordinary periodic contribution on their own, used to
// decide whether a stripped label was really just a label (see isRollover).
const CONTRIBUTION_MARKER = /\b(?:contributions?|contrib|payroll|employee|employer|deferrals?)\b/;

// The event itself: rollover, roll over, rolled over, rolling over, rollovers.
// The leading \b keeps it off words ending in "roll" ("PAYROLL OVERTIME"), the
// trailing one off "ROLL OVERTIME".
const ROLLOVER_EVENT = /\broll(?:ed|s|ing)?\s?overs?\b/;

/**
 * A rollover, in either direction.
 *
 * The subtype gate comes first: only a subtype that moves money across the
 * account boundary can be a rollover leg, so a dividend credited inside a
 * rollover IRA isn't read as one because of the account's name.
 *
 * The description is then read twice, because the account label and the event
 * are the same word. Stripping the label unconditionally made "ROLLOVER IRA
 * DEPOSIT" (a plain arriving 401k) an ordinary contribution, and the two
 * mistakes differ in size: a contribution misread as a rollover is capped by the
 * annual limit and shows on a line beside it, while a rollover misread as a
 * contribution is the whole 401k on the headline figure. So the label is only
 * believed to BE a label when removing it takes the last mention of a rollover
 * with it AND what remains identifies an ordinary contribution by itself.
 * Everything else stays a rollover.
 *
 * Irreducibly ambiguous, and resolved toward contribution: an institution that
 * stamps the label and also calls arriving rollover money a "contribution"
 * writes both cases as "ROLLOVER IRA CONTRIBUTION".
 *
 * valueDelta still counts rollovers, since the money really entered or left and
 * the balance reconstruction needs it. They are not a *contribution* (no new
 * retirement savings, nothing against the annual limit), which is why
 * isContribution excludes them: a $60k rollover counted as "contributed this
 * year" overstates it by an order of magnitude.
 */
export function isRollover(t: InvestmentTxn): boolean {
  const subtype = (t.subtype || '').toLowerCase();
  if (subtype === 'rollover') return true;
  if (!EXTERNAL_FLOW_SUBTYPES.has(subtype)) return false;

  const name = normalizeName(t.name);
  if (!ROLLOVER_EVENT.test(name)) return false;

  const residual = name.replace(ROLLOVER_ACCOUNT_LABEL, ' ');
  if (ROLLOVER_EVENT.test(residual)) return true; // said it again outside the label
  return !CONTRIBUTION_MARKER.test(residual);
}

/** No counted trades: the default for callers judging one row on its own. */
const NONE: ReadonlySet<InvestmentTxn> = new Set();

/**
 * A rollover arriving here, for the line shown alongside contributions. Takes
 * `counted` for the same reason isContribution does: a rollover can arrive as
 * a single contribution buy too.
 */
export function isIncomingRollover(t: InvestmentTxn, counted: ReadonlySet<InvestmentTxn> = NONE): boolean {
  return isRollover(t) && contributedAmount(t, counted) > 0;
}

/**
 * Signed change this transaction makes to the account's TOTAL value.
 *
 * Plaid's `amount` is positive when cash is debited (a purchase), so an external
 * flow changes the account's value by -amount: a $500 deposit arrives as -500
 * and raises the balance by 500.
 *
 * - buy / sell            -> -(fees). The principal nets out (cash becomes
 *                            securities inside the same account), but `amount`
 *                            includes fees, so a buy spends principal + fees for
 *                            principal of securities and the account is down by
 *                            the fees.
 * - transfer + corporate  -> 0, see CORPORATE_ACTION_SUBTYPES above.
 * - cash / fee / external -> -amount.
 * - anything unrecognized -> 0, so a subtype Plaid adds later can't silently
 *                            corrupt the reconstruction.
 *
 * Judges ONE row, so it can't see a contribution booked as a single buy; that
 * takes the rows beside it (countedTrades). Callers walking a set use walkDelta.
 *
 * Known imprecision: a dividend the broker reports as a single reinvestment row
 * typed `buy` is treated as internal, so its inflow is missed. Every point
 * derived from this is drawn as estimated, which is the honest framing.
 */
export function valueDelta(t: InvestmentTxn): number {
  const subtype = (t.subtype || '').toLowerCase();
  const type = (t.type || '').toLowerCase();

  // Scoped to `transfer`, the type Plaid files corporate actions under. Unscoped
  // it would shadow the type checks below and zero ordinary rows: `{type:'cash',
  // subtype:'adjustment'}` is a real cash correction and `{type:'buy',
  // subtype:'trade'}` an ordinary bond purchase.
  if (type === 'transfer' && CORPORATE_ACTION_SUBTYPES.has(subtype)) return 0;
  // `t.fees ? ... : 0` rather than -(fees ?? 0), which yields -0 for a fee-free
  // trade (survives JSON, compares false under Object.is).
  if (type === 'buy' || type === 'sell') return t.fees ? -t.fees : 0;
  if (type === 'cash' || type === 'fee') return -t.amount;
  if (EXTERNAL_FLOW_SUBTYPES.has(subtype)) return t.amount === 0 ? inKindValue(t) : -t.amount;
  return 0;
}

/**
 * The value of an in-kind transfer: shares moved between institutions with no
 * cash, which some report with `amount` 0 and the shares in `quantity` and
 * `price`. Counted as 0, a $40k ACATS transfer would read as $40k of growth on
 * the chart and be missing from the walk.
 *
 * Quantity's sign is documented only for trades, so a transfer is read the same
 * way: positive is shares arriving. Only reached for a transfer-type external
 * row whose amount is exactly 0.
 */
function inKindValue(t: InvestmentTxn): number {
  // Only a plain transfer: a zero-amount distribution or withdrawal under type
  // transfer is not shares moving between institutions.
  if ((t.type || '').toLowerCase() !== 'transfer') return 0;
  if ((t.subtype || '').toLowerCase() !== 'transfer') return 0;
  const value = (t.quantity || 0) * (t.price || 0);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

/**
 * Signed change in account value from money CROSSING the account boundary:
 * contributions, deposits, transfers, rollovers, withdrawals and distributions,
 * in either direction. Zero for everything else.
 *
 * This is the "money added" side of the chart's added-vs-growth split.
 * Dividends, interest and fees are left out because they ARE growth (or its
 * opposite), buys and sells because they are internal even when stamped with an
 * external-sounding subtype. Rollovers count: for this account they are money
 * arriving, not money the market made (isContribution excludes them for a
 * different question, the annual limit). Corporate actions are already zero in
 * valueDelta.
 */
export function externalFlow(t: InvestmentTxn): number {
  const subtype = (t.subtype || '').toLowerCase();
  const type = (t.type || '').toLowerCase();
  // A 401k loan repayment is money coming back in from the holder's paycheck.
  // valueDelta already counts it (type cash); it just isn't in the external set.
  if (subtype === 'loan payment' && type === 'cash') return -t.amount;
  if (!EXTERNAL_FLOW_SUBTYPES.has(subtype)) return 0;
  if (type === 'buy' || type === 'sell') return 0;
  // Plaid defines a distribution as money LEAVING the account. One arriving is
  // a fund paying out into it (capital gains, say): return on the holding,
  // which is growth, not money the holder added.
  if (subtype === 'distribution' && -t.amount > 0) return 0;
  return valueDelta(t);
}

// Trade subtypes that can mean money crossing the boundary: a buy made with
// outside money (a paycheck, a 401k loan repayment, a deposit or transfer that
// lands directly as shares) and a sell whose proceeds leave the account. Plaid's
// documented pairings rarely put deposit, transfer or withdrawal on a trade, but
// a recordkeeper that books only buys has nowhere else to put them, and
// countedTrades still refuses them in any account that books that subtype as cash.
const MONEY_IN_BUY_SUBTYPES = new Set(['contribution', 'loan payment', 'deposit', 'transfer']);
// Transfer is on both sides so a fund exchange booked as a sell/transfer and a
// buy/transfer nets to zero instead of counting only the buy.
const MONEY_OUT_SELL_SUBTYPES = new Set(['distribution', 'withdrawal', 'transfer']);

/**
 * A single-row contribution or distribution: some recordkeepers report a
 * paycheck as one `buy` row (subtype contribution) with no cash row, and a payout
 * as one `sell` row (subtype distribution). externalFlow alone reads both as
 * internal trades, putting every paycheck on the growth side. The value change is
 * `amount` itself. Whether a given one counts is countedTrades' decision.
 */
function tradeFlow(t: InvestmentTxn): number {
  const subtype = (t.subtype || '').toLowerCase();
  const type = (t.type || '').toLowerCase();
  if (type === 'buy' && MONEY_IN_BUY_SUBTYPES.has(subtype)) return t.amount;
  if (type === 'sell' && MONEY_OUT_SELL_SUBTYPES.has(subtype)) return t.amount;
  return 0;
}

/** A non-trade row that moves money across the boundary under this subtype. */
function isCashLeg(t: InvestmentTxn, subtype: string): boolean {
  const type = (t.type || '').toLowerCase();
  return (
    type !== 'buy' &&
    type !== 'sell' &&
    (t.subtype || '').toLowerCase() === subtype &&
    // An in-kind transfer (amount 0, valued from its shares) moves securities,
    // not cash, so it says nothing about how the account books its money.
    t.amount !== 0 &&
    externalFlow(t) !== 0
  );
}

// How near a cash row of the same subtype must be for a trade to count as its
// internal half (see countedTrades).
const STYLE_EVIDENCE_DAYS = 45;

/**
 * The contribution and distribution trades (tradeFlow) in a set that carry
 * their own money.
 *
 * Institutions report these one of two ways: a cash row (cash/contribution) plus
 * a purely internal buy of the shares it bought, or only the buy. That is
 * decided PER ACCOUNT AND SUBTYPE from the evidence NEAR each trade: if the
 * account has a cash row of that subtype within STYLE_EVIDENCE_DAYS, the trade is
 * the internal half and doesn't count; if not, it is the only record of the
 * money and counts.
 *
 * Deliberately not matched row to row: pairing a cash row with a same-amount
 * trade on the same day double-counted on ordinary cases (a paycheck split across
 * two funds, an employer match, a cash row settling days before the buy, a
 * distribution with tax withheld). An institution doesn't switch styles between
 * paychecks, so nearby evidence answers for all of them.
 *
 * Nearby rather than lifetime or calendar year: with years of history, one cash
 * row from before a recordkeeper change would flip every later trade to internal,
 * and by calendar year a Dec 31 cash contribution whose buy settles Jan 2 would
 * leave each year seeing one leg and count the money twice.
 *
 * Matched on the SAME subtype so an unrelated cash row (a rollover arriving as a
 * cash transfer) can't suppress the trades.
 *
 * Decided over the whole set because no single row can answer it, so the balance
 * walk (addInvestmentFlows), the chart's money-added line (dailyFlows) and the
 * year-to-date figures (contributedAmount) can't disagree about whether a
 * paycheck happened. Callers pass every row they have for the account, not a
 * window, so the answer doesn't depend on where a window starts.
 */

export function countedTrades(txns: InvestmentTxn[]): Set<InvestmentTxn> {
  const cashLegDays = new Map<string, number[]>(); // `${account_id}\0${subtype}` -> day numbers
  const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  for (const t of txns) {
    const subtype = (t.subtype || '').toLowerCase();
    if (!MONEY_IN_BUY_SUBTYPES.has(subtype) && !MONEY_OUT_SELL_SUBTYPES.has(subtype)) continue;
    if (!isCashLeg(t, subtype)) continue;
    const key = `${t.account_id}\u0000${subtype}`;
    (cashLegDays.get(key) ?? cashLegDays.set(key, []).get(key)!).push(dayNumber(t.date));
  }
  const counted = new Set<InvestmentTxn>();
  for (const t of txns) {
    if (tradeFlow(t) === 0) continue;
    const legs = cashLegDays.get(`${t.account_id}\u0000${(t.subtype || '').toLowerCase()}`) ?? [];
    const day = dayNumber(t.date);
    if (!legs.some((d) => Math.abs(d - day) <= STYLE_EVIDENCE_DAYS)) counted.add(t);
  }
  return counted;
}

/**
 * The change a row makes to the account's value, for the balance walk: a
 * counted contribution trade's `amount` less its fees, and valueDelta for
 * everything else. Fees come out of the shares, which is why they are taken
 * off: $500 contributed with a $2 fee buys $498 of fund.
 */
export function walkDelta(t: InvestmentTxn, counted: ReadonlySet<InvestmentTxn>): number {
  return counted.has(t) ? t.amount - (t.fees ?? 0) : valueDelta(t);
}

/**
 * Money a row moved in or out, for the year-to-date contribution and rollover
 * figures: a counted contribution trade's full `amount`, and valueDelta for
 * everything else (which is what those figures always summed).
 */
export function contributedAmount(t: InvestmentTxn, counted: ReadonlySet<InvestmentTxn>): number {
  return counted.has(t) ? t.amount : valueDelta(t);
}

/**
 * Money crossing the account boundary, summed per date, ascending, with
 * net-zero dates dropped. Counted contribution trades are included; see
 * countedTrades for why the others are not.
 */
export function dailyFlows(
  txns: InvestmentTxn[],
  /** countedTrades decided over a WIDER set than `txns`, when the caller
   *  clips rows to a range but the trades must be judged over everything. */
  counted: ReadonlySet<InvestmentTxn> = countedTrades(txns)
): { date: string; amount: number }[] {
  const byDate = new Map<string, number>();
  for (const t of txns) {
    const flow = counted.has(t) ? t.amount : externalFlow(t);
    if (flow !== 0) byDate.set(t.date, (byDate.get(t.date) ?? 0) + flow);
  }
  return [...byDate]
    .filter(([, amount]) => amount !== 0)
    .map(([date, amount]) => ({ date, amount }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Money the holder added from outside, for the year-to-date contributions line.
 *
 * Pass `counted` (countedTrades over the same set) to include contribution
 * trades that carry their own money. Without it a paycheck booked as a single
 * contribution buy reads as an internal trade and never reaches the figure.
 */
export function isContribution(t: InvestmentTxn, counted: ReadonlySet<InvestmentTxn> = NONE): boolean {
  // Rollovers wear contribution subtypes but aren't new money (see isRollover).
  if (isRollover(t)) return false;
  return CONTRIBUTION_SUBTYPES.has((t.subtype || '').toLowerCase()) && contributedAmount(t, counted) > 0;
}

/** Pending rows: the stand-in Plaid uses for the pending flag cash rows carry. */
export function isPendingSubtype(subtype: string | null | undefined): boolean {
  return PENDING_SUBTYPES.has((subtype || '').toLowerCase());
}

/** A raw Plaid investment transaction in the shape the rest of the app reads. */
export function toInvestmentTxn(
  t: {
    investment_transaction_id: string;
    account_id: string;
    date: string;
    name: string;
    type: unknown;
    subtype: unknown;
    quantity: number;
    price: number;
    amount: number;
    fees?: number | null;
    iso_currency_code?: string | null;
    security_id?: string | null;
  },
  securities: Record<string, { name?: string | null; ticker_symbol?: string | null } | undefined>
): InvestmentTxn {
  const security = securities[t.security_id ?? ''];
  return {
    investment_transaction_id: t.investment_transaction_id,
    account_id: t.account_id,
    date: t.date,
    name: t.name,
    type: String(t.type),
    subtype: String(t.subtype),
    quantity: t.quantity,
    price: t.price,
    amount: t.amount,
    fees: t.fees ?? null,
    currency: t.iso_currency_code ?? null,
    security: security?.name || security?.ticker_symbol || null,
  };
}

/**
 * What a failed investment-transactions call means: a note to show, and
 * whether it will fix itself. Used by the stored sync (lib/invstore.ts); the
 * backfill's decision to wait or give up rests on `pending` being right.
 */
export function classifyFetchError(err: any): { note: string; pending: boolean } {
  const code = err?.response?.data?.error_code;
  if (code === 'PRODUCT_NOT_READY') {
    return { note: 'Investment activity is still importing', pending: true };
  }
  // A client-side timeout (lib/plaid.ts) has no Plaid error code because Plaid
  // never answered. It is transient like PRODUCT_NOT_READY and gets `pending` too,
  // which is load-bearing: /api/backfill doesn't treat an investment failure as a
  // blocking note, so an unclassified one would persist an estimated layer with
  // every investment account held flat and MARK IT DONE, and nothing retries a
  // done backfill. `pending` leaves the flag unset for the next load, bounded by
  // the MAX_PENDING_RUNS counter.
  if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') {
    return { note: 'Investment activity timed out', pending: true };
  }
  // Temporary by Plaid's own classification: the institution is down or slow,
  // Plaid had an internal error or maintenance, or a rate limit was hit. Treated
  // as standing, the backfill would hold the Item's investments flat and mark
  // itself done. HTTP 429 and 5xx without an error body count too.
  const type = err?.response?.data?.error_type;
  const status = err?.response?.status;
  if (
    type === 'INSTITUTION_ERROR' ||
    type === 'API_ERROR' ||
    type === 'RATE_LIMIT_EXCEEDED' ||
    status === 429 ||
    (typeof status === 'number' && status >= 500)
  ) {
    return { note: 'Investment activity is temporarily unavailable', pending: true };
  }
  if (code === 'ITEM_LOGIN_REQUIRED') {
    return { note: 'This account needs to be reconnected', pending: false };
  }
  if (code === 'PRODUCTS_NOT_SUPPORTED' || code === 'NO_INVESTMENT_ACCOUNTS') {
    return { note: 'Investment activity is not available here', pending: false };
  }
  console.error(err?.response?.data || err);
  return { note: 'Could not fetch investment activity', pending: false };
}
