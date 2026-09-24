// lib/investments.ts
//
// Reads /investments/transactions/get and turns it into two things:
//   1. an activity list for the expanded investment account row, and
//   2. `valueDelta`, the signed change a transaction makes to an account's
//      TOTAL value, which is what lets the net-worth backfill walk brokerage
//      balances backward instead of holding them flat at today's number.
//
// Unlike cash transactions there is no persisted store here. lib/transactions.ts
// keeps a gzipped encrypted blob per Item because transactionsSync is
// cursor-based and stateful -- losing the cursor loses the delta stream.
// /investments/transactions/get is a plain date-range query, so it can be
// re-asked at any time and needs nothing kept between calls.

import { plaidClient } from './plaid';

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

const PAGE_SIZE = 500;
const MAX_PAGES = 20;

// Unsettled rows. Investment transactions carry no `pending` boolean the way
// cash transactions do (which backfill skips for the same reason) -- these two
// subtypes are the equivalent. Left in, they'd be un-applied by the walk once
// and then again when the settled row appears.
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
  // Not a subtype Plaid emits today (it has no rollover value at all, see
  // isRollover). Listed anyway because the alternative is worse than useless:
  // if it ever appears, an unrecognised subtype falls through to 0 below, and a
  // $60k arrival would be invisible to the balance walk AND to both figures the
  // activity panel shows.
  'rollover',
]);

// Corporate actions. Plaid files these under type 'transfer', but they are not
// money entering or leaving: a spin-off or merger reports the notional value of
// the shares RECEIVED while the matching position leaves the account, so the
// net change in account value is ~0 and only the receiving leg carries a
// nonzero amount. Treating them as external inflow would push the reconstructed
// balance down by their full value a year ago -- the same class of error this
// whole file exists to remove.
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
// InvestmentTransactionSubtype has no value for them, so they arrive wearing an
// ordinary one -- `transfer`, `contribution` or `deposit` on the receiving side,
// `withdrawal` or `distribution` on the sending side -- with the word itself
// only in Plaid's free-text `name`, which is the institution's own description
// of the transaction.
//
// Matching that description takes some care, because the word appears there for
// two entirely different reasons.

// Descriptions are formatted by the institution, so the same phrase arrives
// separated by spaces, runs of spaces, underscores or hyphens, or not separated
// at all. Flattening every non-alphanumeric run to one space lets the patterns
// below be written once, against words.
function normalizeName(name: string): string {
  return (name || '')
    // Split a camel-case run first: "RolloverIRA" is the account label with the
    // space left out, and without this the event pattern's trailing boundary
    // fails on it, sending a real rollover to the contributions line.
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
}

// "Rollover IRA" is the NAME OF AN ACCOUNT, not a description of what happened:
// an IRA opened to receive a former employer's plan keeps that label for life,
// and an institution that puts it in the description puts it on every row in
// the account, contributions included. Institutions that do it don't agree on
// the word order, so every spelling has to be here -- recognising one of them
// is worse than recognising none, since it splits an account's rows between the
// two figures according to nothing but phrasing.
const ROLLOVER_ACCOUNT_LABEL =
  /\b(?:rollover (?:roth |trad |traditional )?(?:iras?|individual retirement accounts?)|iras? rollover)\b/g;

// Words that identify an ordinary periodic contribution on their own, used to
// decide whether a stripped label was really just a label (see isRollover).
const CONTRIBUTION_MARKER = /\b(?:contributions?|contrib|payroll|employee|employer|deferrals?)\b/;

// The event itself: rollover, roll over, rolled over, rolling over, rollovers.
// The leading \b keeps this off words that merely end in "roll" -- the "ROLL
// OVER" inside "PAYROLL OVERTIME" is not a rollover -- and the trailing one off
// "ROLL OVERTIME".
const ROLLOVER_EVENT = /\broll(?:ed|s|ing)?\s?overs?\b/;

/**
 * A rollover, in either direction.
 *
 * The subtype gate comes first: only a subtype that actually moves money across
 * the account boundary can be a rollover leg, so a dividend or interest payment
 * credited inside a rollover IRA can't be read as one on the strength of the
 * account's name.
 *
 * The description is then read twice, because the account label and the event
 * are the same word. Stripping the label unconditionally was wrong: it made
 * "ROLLOVER IRA DEPOSIT" -- a plain description of an arriving 401k -- an
 * ordinary contribution, and the two mistakes here are not the same size. A
 * contribution misread as a rollover is capped by the annual limit and lands on
 * a line the user can see next to it; a rollover misread as a contribution is
 * the whole 401k, and it lands on the headline figure with nothing to explain
 * its size. So the label is only believed to BE a label when removing it takes
 * the last mention of a rollover with it AND what remains identifies an
 * ordinary contribution by itself. Everything else stays a rollover.
 *
 * Irreducibly ambiguous, and resolved toward contribution: an institution that
 * stamps the label and also calls arriving rollover money a "contribution"
 * (some recordkeepers do) writes both cases as "ROLLOVER IRA CONTRIBUTION".
 *
 * valueDelta deliberately still counts these: the money really did enter or
 * leave the account, so the balance reconstruction needs them. What they are
 * not is a *contribution* -- no new money entered the holder's retirement
 * savings and none of it counts against the annual limit -- which is why
 * isContribution excludes them. A $60k 401k rollover counted as
 * "contributed this year" overstates the figure by an order of magnitude.
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
 * Plaid's `amount` is positive when cash is debited from the account
 * (api.d.ts: "Positive values when cash is debited, e.g. purchases of stock"),
 * so an external flow changes the account's value by -amount: a $500 deposit
 * arrives as -500 and raises the balance by 500.
 *
 * - buy / sell            -> -(fees). The principal nets out, because cash
 *                            becomes securities or back and both sit inside the
 *                            same account. Not zero, though: `amount` is "the
 *                            complete value of the transaction" and `fees` is
 *                            "the combined value of all fees applied to this
 *                            transaction", i.e. fees are inside amount. A buy
 *                            spends principal + fees of cash for principal of
 *                            securities, so the account is down by the fees.
 * - transfer + corporate  -> 0, see CORPORATE_ACTION_SUBTYPES above.
 * - cash / fee / external -> -amount.
 * - anything unrecognized -> 0, so a subtype Plaid adds later can't silently
 *                            corrupt the reconstruction.
 *
 * Judges ONE row, so it cannot see a contribution booked as a single buy: that
 * takes the rows beside it (countedTrades). Callers walking a set use
 * walkDelta, which layers that answer on top of this.
 *
 * Known imprecision: a dividend that the broker reports as a single reinvestment
 * row typed `buy` is treated as internal, so its inflow is missed. The chart
 * draws every point derived from this as estimated, which is the honest framing
 * -- market movement isn't modelled here either.
 */
export function valueDelta(t: InvestmentTxn): number {
  const subtype = (t.subtype || '').toLowerCase();
  const type = (t.type || '').toLowerCase();

  // The corporate-action list is scoped to `transfer`, the type Plaid files
  // those under. Unscoped it would shadow the type checks below, and several of
  // its members are ordinary subtypes elsewhere: `{type:'cash', subtype:
  // 'adjustment'}` is a real cash correction, `{type:'buy', subtype:'trade'}` is
  // an ordinary bond purchase. Both would have been zeroed and dropped.
  if (type === 'transfer' && CORPORATE_ACTION_SUBTYPES.has(subtype)) return 0;
  // `t.fees ? ... : 0` rather than -(fees ?? 0), which yields -0 for a
  // fee-free trade. Harmless arithmetically, but it survives JSON and compares
  // false under Object.is, so it's not worth leaving lying around.
  if (type === 'buy' || type === 'sell') return t.fees ? -t.fees : 0;
  if (type === 'cash' || type === 'fee') return -t.amount;
  if (EXTERNAL_FLOW_SUBTYPES.has(subtype)) return t.amount === 0 ? inKindValue(t) : -t.amount;
  return 0;
}

/**
 * The value of an in-kind transfer: shares moved between institutions with no
 * cash, which some institutions report with `amount` 0 and the shares in
 * `quantity` and `price`. Counted as 0, a $40k ACATS transfer would read as $40k
 * of growth on the chart and be missing from the walk.
 *
 * Plaid documents quantity's sign only for trades (positive for a buy, negative
 * for a sell), so a transfer is read the same way: positive is shares
 * arriving. Only reached for a transfer-type external row whose amount is
 * exactly 0, so no row that reports a cash amount is affected.
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
 * This is the "money added" side of the chart's added-vs-growth split, so the
 * line it draws matters in both directions. Dividends, interest and fees are
 * left out because they ARE growth (or its opposite). Buys and sells are left
 * out because they are internal, even when an institution stamps them with an
 * external-sounding subtype. Rollovers count: for this account they are money
 * arriving, not money the market made, which is the question being answered
 * (isContribution excludes them for a different one, the annual limit).
 * Corporate actions are already zero in valueDelta.
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

// Trade subtypes that can mean money crossing the boundary, by direction: a buy
// made with outside money (a paycheck, a 401k loan repayment, a deposit or
// transfer that lands directly as shares) and a sell whose proceeds leave the
// account (a distribution or withdrawal). Plaid's documented pairings rarely
// put deposit, transfer or withdrawal on a trade, but a recordkeeper that books
// buys only has nowhere else to put them, and countedTrades still refuses them
// in any account that books that subtype as cash.
const MONEY_IN_BUY_SUBTYPES = new Set(['contribution', 'loan payment', 'deposit', 'transfer']);
// Transfer is on both sides so a fund exchange booked as a sell/transfer and a
// buy/transfer nets to zero instead of counting only the buy.
const MONEY_OUT_SELL_SUBTYPES = new Set(['distribution', 'withdrawal', 'transfer']);

/**
 * A single-row contribution or distribution: some recordkeepers report a
 * paycheck contribution as one `buy` row (subtype contribution) that buys fund
 * shares directly, with no cash row, and a payout as one `sell` row (subtype
 * distribution). externalFlow alone reads both as internal trades, which would
 * put every paycheck on the growth side. Their value change is `amount` itself:
 * positive for shares bought with outside money, negative for shares sold and
 * paid out. Whether a given one counts is countedTrades' decision.
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
    externalFlow(t) !== 0
  );
}

/**
 * The contribution and distribution trades (tradeFlow) in a set that carry
 * their own money.
 *
 * Institutions report these one of two ways. Some book the money as a cash row
 * (cash/contribution) and then the shares it bought as a buy that is purely
 * internal. Others book only the buy. The question is which style an account
 * uses, and it is answered PER ACCOUNT AND SUBTYPE from the evidence NEAR
 * each trade: if the account has a cash row of that subtype within
 * STYLE_EVIDENCE_DAYS of it, the trade is the internal half and doesn't count;
 * if not, it is the only record of the money and counts.
 *
 * Deliberately not matched row to row. Pairing a cash row with a trade of the
 * same amount on the same day broke on ordinary cases, each counting the money
 * twice: a paycheck split across two funds (one cash row, two buys), an
 * employer match (two cash rows, one buy), a cash row that settles days before
 * the buy, and a distribution with tax withheld (one sell, a smaller cash row).
 * An institution does not switch styles between paychecks, so nearby evidence
 * answers for all of them.
 *
 * Nearby rather than lifetime or calendar year. With years of stored history,
 * one cash row from before a recordkeeper change would flip every later trade
 * to internal. By calendar year, a cash contribution on Dec 31 whose buy
 * settles Jan 2 (or an RMD sold Dec 30 and paid Jan 3) would leave each year
 * seeing one leg and count the money twice.
 *
 * Matched on the SAME subtype so an unrelated cash row can't suppress the
 * trades: a rollover arriving as a cash transfer says nothing about how the
 * same account books its paychecks.
 *
 * Decided over the whole set because no single row can answer it. The balance
 * walk (addInvestmentFlows), the chart's money-added line (dailyFlows) and the
 * year-to-date figures (contributedAmount) all read the same answer, so they
 * cannot disagree about whether a paycheck happened. Callers pass every row
 * they have for the account, not a window of them, so that answer can't depend
 * on where a window happens to start.
 */
const STYLE_EVIDENCE_DAYS = 45;

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

/**
 * Every investment transaction in [start, end], paginated.
 *
 * Returns a `note` instead of throwing, matching syncItem's contract in
 * lib/transactions.ts. Callers decide what an unavailable product means for
 * them: the backfill leaves that Item's investment accounts held flat and
 * carries on, rather than aborting a run it can't retry automatically.
 *
 * `pending` separates the one failure that fixes itself from the ones that
 * don't. PRODUCT_NOT_READY means Plaid is extracting right now and the same
 * call will work shortly (async_update below is what starts that extraction);
 * every other note is a standing property of the Item. The backfill needs the
 * distinction because it records a done-flag: holding an account flat because
 * the data hadn't arrived yet, and then marking the reconstruction complete,
 * freezes that gap in place with nothing to retry it.
 */
export async function fetchInvestmentTxns(
  access_token: string,
  start: string,
  end: string,
  account_ids?: string[]
): Promise<{ txns: InvestmentTxn[]; note: string | null; truncated: boolean; pending: boolean }> {
  const txns: InvestmentTxn[] = [];
  const securities: Record<string, any> = {};
  const cancelled = new Set<string>();
  let truncated = false;

  try {
    let offset = 0;
    let total = Infinity;

    for (let page = 0; page < MAX_PAGES && offset < total; page++) {
      const res = await plaidClient.investmentsTransactionsGet({
        access_token,
        start_date: start,
        end_date: end,
        options: {
          count: PAGE_SIZE,
          offset,
          ...(account_ids ? { account_ids } : {}),
          // Lets Items that were linked without the investments product still
          // serve this endpoint; Plaid extracts in the background and returns
          // PRODUCT_NOT_READY until it finishes.
          async_update: true,
        },
      });

      (res.data.securities || []).forEach((s) => (securities[s.security_id] = s));
      const page_txns = res.data.investment_transactions || [];
      // A full page with no reported total means "unknown", not "exactly this
      // many". Defaulting to the page length there would let the loop exit
      // satisfied at MAX_PAGES with truncated: false, publishing a walk missing
      // its oldest flows.
      total =
        res.data.total_investment_transactions ??
        (page_txns.length === PAGE_SIZE ? Infinity : page_txns.length);

      for (const t of page_txns) {
        if (t.cancel_transaction_id) cancelled.add(t.cancel_transaction_id);
        txns.push(toInvestmentTxn(t, securities));
      }

      // A short page means the end, whatever `total` claims. Without this a
      // stale total would keep asking for pages that return nothing.
      // Advanced BEFORE the short-page break, so the truncation test below
      // compares a real count against the total. Breaking first left offset at
      // its pre-page value, which made `offset < total` true on every ordinary
      // single-page fetch and flagged the whole thing truncated.
      offset += page_txns.length;
      if (page_txns.length < PAGE_SIZE) break;
    }

    // Hit the page cap with rows still outstanding. Plaid returns newest first,
    // so what's missing is the OLDEST activity -- exactly the part the backfill
    // walk needs. Flagged rather than swallowed: a reconstruction missing its
    // left edge is wrong in a way that looks perfectly reasonable on the chart.
    // The activity list is unaffected, since it only shows the newest rows.
    if (offset < total) truncated = true;
  } catch (err: any) {
    const { note, pending } = classifyFetchError(err);
    return { txns: [], note, truncated: false, pending };
  }

  // Cancellations come in pairs: the reversing row and the row it reverses.
  // Drop both. cancel_transaction_id is documented as a legacy field that is
  // usually null, so dropping type 'cancel' is what does the real work here.
  const clean = txns.filter(
    (t) =>
      t.type.toLowerCase() !== 'cancel' &&
      !cancelled.has(t.investment_transaction_id) &&
      !isPendingSubtype(t.subtype)
  );

  return { txns: clean, note: null, truncated, pending: false };
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
 * whether it will fix itself. Shared by fetchInvestmentTxns and the stored sync
 * (lib/invstore.ts) so both classify every failure the same way.
 */
export function classifyFetchError(err: any): { note: string; pending: boolean } {
  const code = err?.response?.data?.error_code;
  if (code === 'PRODUCT_NOT_READY') {
    return { note: 'Investment activity is still importing', pending: true };
  }
  // A client-side timeout (lib/plaid.ts) reaches here with no Plaid error
  // code at all, because Plaid never answered. It is transient in exactly the
  // way PRODUCT_NOT_READY is, so it gets the same `pending` treatment, and
  // that classification is load-bearing rather than cosmetic: /api/backfill
  // deliberately does NOT treat an investment failure as a blocking note, so
  // an unclassified one would leave invCovered AND invPending both false, and
  // the run would persist an estimated layer with every investment account
  // held flat and then MARK IT DONE. Nothing retries a done backfill, so one
  // slow call would permanently cost the chart its investment history.
  // `pending` instead leaves the flag unset for the next load, bounded by the
  // MAX_PENDING_RUNS counter that already exists for the same reason.
  if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') {
    return { note: 'Investment activity timed out', pending: true };
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
