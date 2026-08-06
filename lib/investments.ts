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
  return CONTRIBUTION_SUBTYPES.has((t.subtype || '').toLowerCase()) && valueDelta(t) > 0;
}

/**
 * Every investment transaction in [start, end], paginated.
 *
 * Returns a `note` instead of throwing, matching syncItem's contract in
 * lib/transactions.ts. Callers decide what an unavailable product means for
 * them: the backfill leaves that Item's investment accounts held flat and
 * carries on, rather than aborting a run it can't retry automatically.
 */
export async function fetchInvestmentTxns(
  access_token: string,
  start: string,
  end: string,
  account_ids?: string[]
): Promise<{ txns: InvestmentTxn[]; note: string | null; truncated: boolean }> {
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
      return { txns: [], note: 'Investment activity is still importing', truncated: false };
    }
    if (code === 'ITEM_LOGIN_REQUIRED') {
      return { txns: [], note: 'This account needs to be reconnected', truncated: false };
    }
    if (code === 'PRODUCTS_NOT_SUPPORTED' || code === 'NO_INVESTMENT_ACCOUNTS') {
      return { txns: [], note: 'Investment activity is not available here', truncated: false };
    }
    console.error(err?.response?.data || err);
    return { txns: [], note: 'Could not fetch investment activity', truncated: false };
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

  return { txns: clean, note: null, truncated };
}
