// lib/networth.ts
//
// Fetches live balances (and holdings) for every linked institution and
// computes total net worth. Shared by the dashboard API route and the daily
// snapshot cron route.

import { plaidClient } from './plaid';
import { decrypt } from './crypto';
import { getItems, type StoredItem } from './storage';
import { getManualAccounts, toInstitutions, MANUAL_ITEM_PREFIX } from './manual';
import { normalizeLiabilities } from './liabilities';
import { isOwedType, signedContribution } from './balance';

/**
 * Whether this Item can serve /liabilities/get, and if not, whether asking the
 * user to do anything about it would help.
 *
 * Four states rather than a boolean because the UI decision differs in each:
 *   on          - data is attached to the accounts.
 *   off         - the product was never initialized on this Item. Offer Enable,
 *                 which re-opens Link in update mode to add it.
 *   loading     - Plaid is extracting. Say so; do NOT offer Enable, or the
 *                 forced reload right after a successful enable would show the
 *                 button again and the user would tap it in a loop.
 *   unavailable - nothing to get (no liability accounts, or the institution
 *                 can't serve it). Never offer Enable: it would change nothing.
 */
export type LiabilitiesState = 'on' | 'off' | 'loading' | 'unavailable';

export type InstitutionResult = {
  institution_name: string;
  item_id: string;
  accounts: any[];
  holdings: any[];
  error: string | null;
  needs_reauth: boolean;
  liabilities: LiabilitiesState;
  /**
   * Set when `accounts` was recovered from the last good snapshot after this
   * fetch failed (lib/last-known.ts), as YYYY-MM-DD. Display-only: `error` is
   * still set alongside it, which is what keeps the snapshot and cache gates
   * closed. Never populated by computeNetWorth itself.
   */
  stale_as_of?: string;
  /**
   * Set instead of `stale_as_of` when last-known balances exist but the newest
   * snapshot is past the age limit. The accounts stay empty; this only lets the
   * card explain itself rather than silently reverting to $0.00.
   */
  stale_too_old?: string;
  /**
   * How many of this institution's known accounts recovery could not resolve,
   * set alongside `stale_as_of`. Nonzero means the recovered subtotal is short
   * of the truth, which understates debt and so overstates net worth: the card
   * discloses it rather than presenting an incomplete figure as merely dated.
   */
  stale_missing?: number;
  /** True for manually-tracked accounts (lib/manual.ts) rather than Plaid. */
  manual?: boolean;
};

async function fetchInstitution(item: StoredItem): Promise<InstitutionResult> {
  const result: InstitutionResult = {
    institution_name: item.institution_name,
    item_id: item.item_id,
    accounts: [],
    holdings: [],
    error: null,
    needs_reauth: false,
    liabilities: 'unavailable',
  };

  let access_token: string;
  try {
    access_token = await decrypt(item.encrypted_access_token);
  } catch {
    result.error = 'Could not decrypt stored credentials';
    return result;
  }

  try {
    const balanceRes = await plaidClient.accountsBalanceGet({ access_token });
    result.accounts = balanceRes.data.accounts.map((a) => ({
      account_id: a.account_id,
      name: a.name,
      official_name: a.official_name,
      mask: a.mask, // last 4, for a richer account label
      type: a.type,
      subtype: a.subtype,
      balance: a.balances.current,
      available: a.balances.available,
      limit: a.balances.limit, // credit line, for utilization
      currency: a.balances.iso_currency_code,
    }));
  } catch (err: any) {
    const code = err?.response?.data?.error_code;
    if (code === 'ITEM_LOGIN_REQUIRED') {
      result.needs_reauth = true;
      result.error = 'This account needs to be reconnected';
    } else {
      result.error = 'Could not fetch balances';
    }
    // Balances failed -- holdings would fail identically (same access token/item), skip the extra call.
    return result;
  }

  // Holdings and liabilities are independent of each other and both swallow
  // their own errors, so they run together rather than adding a second and
  // third serial round trip to the uncached dashboard load and the daily cron.
  const hasDebt = result.accounts.some((a) => isOwedType(a.type));
  await Promise.all([
    fetchHoldings(access_token, result),
    // Only worth a call if there's something a liability could describe.
    hasDebt ? fetchLiabilities(access_token, result) : Promise.resolve(),
  ]);

  return result;
}

/** Investment holdings -- fails silently for non-brokerage items, that's expected. */
async function fetchHoldings(access_token: string, result: InstitutionResult): Promise<void> {
  try {
    const holdingsRes = await plaidClient.investmentsHoldingsGet({ access_token });
    const securities: Record<string, any> = {};
    (holdingsRes.data.securities || []).forEach((s) => (securities[s.security_id] = s));
    result.holdings = (holdingsRes.data.holdings || []).map((h) => ({
      // Kept so holdings can be dropped along with a hidden parent account --
      // otherwise hiding a brokerage would zero its balance but leave every
      // position and its gain/loss on the Accounts tab.
      account_id: h.account_id,
      name: securities[h.security_id]?.name || securities[h.security_id]?.ticker_symbol || 'Unknown',
      quantity: h.quantity,
      price: h.institution_price,
      value: h.institution_value,
      cost_basis: h.cost_basis, // total cost of the position, for gain/loss
    }));
  } catch {
    // not a brokerage account, or investments not supported -- fine, skip
  }
}

/**
 * APRs, minimum payments and due dates for credit cards and loans.
 *
 * Note what this never does: set result.error. /api/net-worth and the snapshot
 * cron both gate on `institutions.every(i => !i.error)` before recording a
 * snapshot or writing the cache, so flagging "this Item has no liabilities
 * product" as an error would freeze the entire net-worth history and disable
 * caching outright. Product availability is reported through result.liabilities
 * instead, which nothing gates on.
 */
async function fetchLiabilities(access_token: string, result: InstitutionResult): Promise<void> {
  try {
    const res = await plaidClient.liabilitiesGet({ access_token });
    // Inside the try on purpose: a throw out here would reject the Promise.all
    // in computeNetWorth and 500 both callers -- worse than the error flag the
    // comment above is avoiding. normalizeLiabilities is written to be total,
    // and this is the belt to that braces.
    const byAccount = normalizeLiabilities(res.data.liabilities);
    result.accounts.forEach((a) => {
      if (byAccount[a.account_id]) a.liability = byAccount[a.account_id];
    });
    result.liabilities = Object.keys(byAccount).length > 0 ? 'on' : 'unavailable';
  } catch (err: any) {
    const code = err?.response?.data?.error_code;
    if (code === 'PRODUCT_NOT_READY') {
      result.liabilities = 'loading';
    } else if (code === 'PRODUCTS_NOT_SUPPORTED' || code === 'ADDITIONAL_CONSENT_REQUIRED') {
      // The Item was linked before liabilities was requested. Update mode can
      // add it, so this is the one case worth offering the user a button for.
      result.liabilities = 'off';
    } else {
      // NO_LIABILITY_ACCOUNTS and anything else: enabling would change nothing.
      result.liabilities = 'unavailable';
    }
  }
}

export async function computeNetWorth(): Promise<{
  institutions: InstitutionResult[];
  netWorth: number;
}> {
  const items = await getItems();

  // Fetch every institution concurrently instead of one at a time --
  // with N linked accounts this used to take N sequential round trips.
  const institutions = await Promise.all(items.map(fetchInstitution));

  // Manually-tracked accounts join the same list, so net worth, the Accounts
  // tab, per-account history, goals and insights all treat them like any other
  // account with no special-casing downstream.
  //
  // A failed read becomes an institution with an `error` instead of an empty
  // list. That matters: callers gate snapshot recording on
  // `institutions.every(i => !i.error)`, and if a Redis blip silently returned
  // "no manual accounts" the gate would still pass and a net worth short by
  // the entire manual total would be written to the real history layer -- which
  // nothing ever rewrites for a past date. Surfacing the error blocks the
  // write instead. (Accepted consequence: a broken Plaid item freezes manual
  // history too, since one gate covers the whole snapshot. Splitting it would
  // corrupt the total series, which is worse.)
  try {
    institutions.push(...toInstitutions(await getManualAccounts()));
  } catch (err) {
    console.error('Manual accounts read failed', err);
    institutions.push({
      institution_name: 'Manual accounts',
      item_id: `${MANUAL_ITEM_PREFIX}error`,
      accounts: [],
      holdings: [],
      error: 'Could not load manually-tracked accounts',
      needs_reauth: false,
      liabilities: 'unavailable',
      manual: true,
    });
  }

  // Net worth = sum of depository/investment/other balances minus credit/loan balances.
  // Holdings values are already reflected in the parent investment account's balance,
  // so they aren't added again here.
  let netWorth = 0;
  institutions.forEach((inst) => {
    inst.accounts.forEach((a) => {
      if (a.balance == null) return;
      netWorth += signedContribution(a.type, a.balance);
    });
  });

  return { institutions, netWorth };
}

/**
 * Flat { account_id: current balance } map, for per-account history snapshots.
 *
 * Skips accounts recovered from a past snapshot (lib/last-known.ts). Callers
 * today build this before recovery runs, so the filter never fires -- it is
 * here so the display-only rule survives someone reordering the route. Writing
 * a recovered balance into today's key would record last week's figure as
 * though it had been measured, and nothing ever rewrites a real point for a
 * past date, so that mistake would be permanent.
 */
export function accountBalanceMap(institutions: InstitutionResult[]): Record<string, number> {
  const map: Record<string, number> = {};
  institutions.forEach((inst) => {
    inst.accounts.forEach((a) => {
      if (a.balance != null && !a.stale) map[a.account_id] = a.balance;
    });
  });
  return map;
}
