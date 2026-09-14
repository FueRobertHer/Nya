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

/** A rollover arriving here, for the line shown alongside contributions. */
export function isIncomingRollover(t: InvestmentTxn): boolean {
  return isRollover(t) && valueDelta(t) > 0;
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
  if (EXTERNAL_FLOW_SUBTYPES.has(subtype)) return -t.amount;
  return 0;
}

/** Money the holder added from outside, for the year-to-date contributions line. */
export function isContribution(t: InvestmentTxn): boolean {
  // Rollovers wear contribution subtypes but aren't new money (see isRollover).
  if (isRollover(t)) return false;
  return CONTRIBUTION_SUBTYPES.has((t.subtype || '').toLowerCase()) && valueDelta(t) > 0;
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
        txns.push({
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
          security:
            securities[t.security_id ?? '']?.name ||
            securities[t.security_id ?? '']?.ticker_symbol ||
            null,
        });
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
    const code = err?.response?.data?.error_code;
    if (code === 'PRODUCT_NOT_READY') {
      return {
        txns: [],
        note: 'Investment activity is still importing',
        truncated: false,
        pending: true,
      };
    }
    if (code === 'ITEM_LOGIN_REQUIRED') {
      return {
        txns: [],
        note: 'This account needs to be reconnected',
        truncated: false,
        pending: false,
      };
    }
    if (code === 'PRODUCTS_NOT_SUPPORTED' || code === 'NO_INVESTMENT_ACCOUNTS') {
      return {
        txns: [],
        note: 'Investment activity is not available here',
        truncated: false,
        pending: false,
      };
    }
    console.error(err?.response?.data || err);
    return {
      txns: [],
      note: 'Could not fetch investment activity',
      truncated: false,
      pending: false,
    };
  }

  // Cancellations come in pairs: the reversing row and the row it reverses.
  // Drop both. cancel_transaction_id is documented as a legacy field that is
  // usually null, so dropping type 'cancel' is what does the real work here.
  const clean = txns.filter(
    (t) =>
      t.type.toLowerCase() !== 'cancel' &&
      !cancelled.has(t.investment_transaction_id) &&
      !PENDING_SUBTYPES.has(t.subtype.toLowerCase())
  );

  return { txns: clean, note: null, truncated, pending: false };
}
