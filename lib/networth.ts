// lib/networth.ts
//
// Fetches live balances (and holdings) for every linked institution and
// computes total net worth. Shared by the dashboard API route and the daily
// snapshot cron route.

import { plaidClient } from './plaid';
import { decrypt } from './crypto';
import { withRateLimitRetry } from './rate-limit-retry';
import { getItems, type StoredItem } from './storage';
import type { Ctx } from './containers';
import { getManualAccounts, toInstitutions, MANUAL_ITEM_PREFIX } from './manual';
import { normalizeLiabilities } from './liabilities';
import { isOwedType, isInvestmentType, signedContribution } from './balance';
import { loadVanishedInputs, applyVanished } from './vanished';
import { recordSnapshot, recordPartialAccounts } from './history';
import { CAUSES, classifyFailure, isoTime, reconnectFixes, type ConnectionHealth, type Failure } from './connection-state';
import { observeHoldings, recordHoldings, type HoldingsObservation, type HoldingsRecorded } from './holdings-history';

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
  /** Plaid's institution id, when the balance call returned one. Stable across
   *  a disconnect and re-add, unlike item_id and the display name (which is
   *  whatever the client sent at link time); lib/links.ts matches on it. */
  institution_id?: string | null;
  accounts: any[];
  holdings: any[];
  /**
   * What this fetch's holdings call answered, in the shape holdings history
   * records it (lib/holdings-history.ts). Set only when the call answered, so
   * its absence is what keeps a failed call (or a failed fetch) from being
   * recorded as accounts holding nothing. Server-only: /api/net-worth deletes
   * it before the payload is sent or cached.
   */
  holdings_observed?: HoldingsObservation;
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
  /** The instant behind `stale_as_of` (an ISO time), when known, so the date can
   *  be shown in the viewer's own time zone. */
  stale_as_of_at?: string;
  /** Likewise for `stale_too_old`. */
  stale_too_old_at?: string;
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
  /**
   * HOW MANY accounts this institution is known to own that were absent from an
   * otherwise successful fetch, and have not been absent long enough to accept
   * as closed (lib/vanished.ts).
   *
   * Closes the snapshot and cache gates exactly as `error` does: the total on
   * hand isn't a measurement of everything this institution holds. Unlike
   * `error`, the accounts that DID answer are fresh, so the card shows them
   * rather than falling back to last-known balances.
   *
   * A count, not ids: this object is sent to the client whole, and ids would be
   * the one place account ids leave the server in plaintext (lib/vanished.ts
   * keeps them encrypted).
   */
  unconfirmed_missing?: number;
  /** Plaid has found accounts at this Item that the user hasn't shared yet
   *  (lib/new-accounts.ts). Set by /api/net-worth only. */
  new_accounts_available?: boolean;
  /** Why the fetch failed, set alongside `error` for a Plaid Item: the cause,
   *  whose side it is on, and Plaid's error code (lib/connection-state.ts). */
  failure?: Failure;
  /** When the Item's consent at the bank expires, as Plaid reported it on this
   *  fetch (an ISO time), for the institutions that have one. */
  consent_expires_at?: string | null;
  /** The connection's health (lib/connection-state.ts). Set by /api/net-worth
   *  on the response only, never stored in the cache, for the reason
   *  new_accounts_available isn't: a webhook can change it at any time. */
  health?: ConnectionHealth;
  /** The accounts this institution is known to have that its card can't show
   *  (no balance could be recovered for them), by name and mask, so the health
   *  view can say which accounts a failure affects. Set by fillFromLastKnown. */
  unshown_accounts?: { account_id: string; name: string; mask: string | null }[];
};

/**
 * Whether an institution's figures may be written to the permanent history
 * layer or frozen into a cache. One definition for every gate (/api/snapshot,
 * /api/net-worth, /api/ingest/balance), so a new reason to withhold is applied
 * everywhere.
 */
export function isRecordable(inst: InstitutionResult): boolean {
  return !inst.error && !inst.unconfirmed_missing;
}

export async function fetchInstitution(item: StoredItem): Promise<InstitutionResult> {
  const result: InstitutionResult = {
    institution_name: item.institution_name,
    item_id: item.item_id,
    // The stored id, so an Item that fails below still carries one; a
    // successful fetch overwrites it with what Plaid reports.
    institution_id: item.institution_id ?? null,
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
    result.failure = { cause: 'credentials', side: 'nya', code: null };
    return result;
  }

  try {
    // /accounts/get, not /accounts/balance/get: it answers from the balances
    // Plaid already holds (about daily for a healthy Item) with no per-request
    // charge, where the live balance call is billed on every use. The cost is
    // that Refresh can't pull a live balance and a snapshot can be a day behind.
    const balanceRes = await withRateLimitRetry(() => plaidClient.accountsGet({ access_token }));
    // Served from what Plaid holds, a broken Item may answer 200 with the problem
    // on the Item instead of failing. Treat that as the failure it is, or the
    // reconnect prompt would never appear: any of the codes that mean the person
    // must sign in again (lib/connection-state.ts), ITEM_LOGIN_REQUIRED first.
    const itemError = balanceRes.data.item?.error;
    if (itemError && CAUSES[classifyFailure({ code: itemError.error_code, type: itemError.error_type, responded: true }).cause].state === 'needs_reauth') {
      throw { response: { data: { error_code: itemError.error_code, error_type: itemError.error_type } } };
    }
    result.institution_id = balanceRes.data.item?.institution_id ?? result.institution_id;
    // Where the bank's consent runs out on a date (some OAuth institutions), so
    // the health view can say "reconnect soon" even without Plaid's webhook.
    result.consent_expires_at = isoTime(balanceRes.data.item?.consent_expiration_time);
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
      // Plaid's cross-Item identity for the account, where it offers one (Chase
      // in production). Strong evidence when matching a re-added account.
      persistent_account_id: a.persistent_account_id ?? null,
    }));
  } catch (err: any) {
    // One mapping of Plaid's codes (lib/connection-state.ts) decides both the
    // Reconnect button and what the health view says. No answer at all (a
    // timeout, the network) has no response.
    const data = err?.response?.data;
    result.failure = classifyFailure({ code: data?.error_code, type: data?.error_type, responded: err?.response !== undefined });
    result.needs_reauth = reconnectFixes(result.failure.cause);
    result.error = result.needs_reauth ? 'This account needs to be reconnected' : 'Could not fetch balances';
    // Balances failed -- holdings would fail identically (same access token/item), skip the extra call.
    return result;
  }

  // Holdings and liabilities are independent and both swallow their own errors,
  // so they run together rather than adding serial round trips to the uncached
  // load and the daily cron.
  //
  // Both are gated on THIS fetch's account list, not anything remembered: an
  // account opened at an institution that had only checking shows up in the
  // balances on the first load, so the call it needs is made that same load.
  const hasDebt = result.accounts.some((a) => isOwedType(a.type));
  const hasSecurities = result.accounts.some((a) => isInvestmentType(a.type));
  await Promise.all([
    // Holdings exist only for investment accounts; for a cash-and-cards
    // institution this call could only come back empty.
    hasSecurities ? fetchHoldings(access_token, result) : Promise.resolve(),
    // Only worth a call if there's something a liability could describe.
    hasDebt ? fetchLiabilities(access_token, result) : Promise.resolve(),
  ]);

  return result;
}

/** Investment holdings. Only called for Items that actually hold securities (see
 *  the gate in fetchInstitution); still swallows its own errors, because an Item
 *  can have an investment account without the investments product enabled. */
async function fetchHoldings(access_token: string, result: InstitutionResult): Promise<void> {
  try {
    const holdingsRes = await plaidClient.investmentsHoldingsGet({ access_token });
    const securities: Record<string, any> = {};
    (holdingsRes.data.securities || []).forEach((s) => (securities[s.security_id] = s));
    result.holdings = (holdingsRes.data.holdings || []).map((h) => ({
      // Kept so holdings drop along with a hidden parent account; otherwise
      // hiding a brokerage would zero its balance but leave every position.
      account_id: h.account_id,
      name: securities[h.security_id]?.name || securities[h.security_id]?.ticker_symbol || 'Unknown',
      quantity: h.quantity,
      price: h.institution_price,
      value: h.institution_value,
      cost_basis: h.cost_basis, // total cost of the position, for gain/loss
      // The three security fields lib/cash.ts reads to tell a position from money
      // merely sitting in the account. Sent raw, not as a verdict: this payload is
      // cached in localStorage, and a stored verdict would freeze the rule as of
      // the day it was written.
      ticker: securities[h.security_id]?.ticker_symbol ?? null,
      security_type: securities[h.security_id]?.type ?? null,
      is_cash_equivalent: securities[h.security_id]?.is_cash_equivalent ?? null,
    }));
    // For holdings history, from Plaid's own fields rather than the display
    // ones above. Only here, where the call answered, and only for a whole
    // answer (observeHoldings): a call that failed, or an answer that is not
    // whole, leaves it unset, and nothing is recorded for this institution.
    const observed = observeHoldings(holdingsRes.data);
    if (observed) result.holdings_observed = observed;
  } catch {
    // not a brokerage account, or investments not supported -- fine, skip
  }
}

/**
 * APRs, minimum payments and due dates for credit cards and loans.
 *
 * Never sets result.error: /api/net-worth and the snapshot cron gate on
 * `institutions.every(i => !i.error)`, so flagging "no liabilities product" as
 * an error would freeze the net-worth history and disable caching. Product
 * availability goes through result.liabilities, which nothing gates on.
 */
async function fetchLiabilities(access_token: string, result: InstitutionResult): Promise<void> {
  try {
    const res = await plaidClient.liabilitiesGet({ access_token });
    // Inside the try on purpose: a throw here would reject the Promise.all in
    // computeNetWorth and 500 both callers. normalizeLiabilities is written to
    // be total; this is the belt to its braces.
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

export async function computeNetWorth(ctx: Ctx): Promise<{
  institutions: InstitutionResult[];
  netWorth: number;
}> {
  const items = await getItems(ctx);

  // Fetch every institution concurrently. The vanished check's two reads depend
  // only on the Items already in hand, so they are issued alongside the Plaid
  // fan-out rather than after it (same reasoning as eager() in
  // app/api/net-worth/route.ts).
  const vanishedReads = loadVanishedInputs(ctx);

  const institutions = await Promise.all(items.map(fetchInstitution));

  // An account missing from a SUCCESSFUL fetch is either a closure or a provider
  // glitch, and until that resolves the total isn't a measurement of everything
  // held. Only healthy institutions are checked: a failed fetch returns no
  // accounts (lib/last-known.ts owns that) and would look like every account
  // vanishing.
  const healthy = institutions.filter((i) => !i.error);
  const vanished = await applyVanished(ctx, healthy, await vanishedReads);
  for (const inst of healthy) {
    const res = vanished[inst.item_id];
    if (!res) continue;
    if (res.unconfirmed.length > 0) inst.unconfirmed_missing = res.unconfirmed.length;
    // Counts only: account ids are encrypted at rest everywhere else, and which
    // bank someone uses is at least as identifying. The stale-balance warning in
    // /api/net-worth logs a count and a date for the same reason.
    console.warn(
      `net-worth: an institution is missing ${res.unconfirmed.length} account(s) pending confirmation, ${res.accepted.length} accepted as closed`
    );
  }

  // Manually-tracked accounts join the same list, so net worth, the Accounts
  // tab, history, goals and insights treat them like any other account.
  //
  // A failed read becomes an institution with an `error`, not an empty list: a
  // silent "no manual accounts" would pass the snapshot gate and write a net
  // worth short by the whole manual total into the real history layer. Surfacing
  // the error blocks the write. (A broken Plaid item thus freezes manual history
  // too, since one gate covers the snapshot; splitting it would corrupt the
  // total series.)
  try {
    institutions.push(...toInstitutions(await getManualAccounts(ctx)));
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
 * build this before recovery runs, so the filter is a guard for the display-only
 * rule against someone reordering the route: a recovered balance written to
 * today's key would be recorded as measured, permanently.
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

/**
 * The same map, over only the institutions that actually answered: what a partly
 * failed fetch still measured.
 *
 * An institution with `error` is left out whole (its accounts are empty or
 * recovered, never measured today). One with `unconfirmed_missing` stays in: the
 * accounts it returned are real, and a missing account is a question for the
 * total, not for these accounts' own charts.
 */
export function measuredBalanceMap(institutions: InstitutionResult[]): Record<string, number> {
  return accountBalanceMap(institutions.filter((inst) => !inst.error));
}

export type RecordedFetch = {
  /** The date the TOTAL landed on, or null if it didn't. */
  date: string | null;
  /** The accounts whose positions went into holdings history, and those whose
   *  write failed. Never part of `date`. */
  holdings: HoldingsRecorded;
};

/**
 * Writes what a fetch measured to history, and returns the date the TOTAL landed
 * on (null if it didn't) with what holdings history recorded. The one place the
 * recording rule lives, so /api/net-worth, /api/snapshot and /api/ingest/balance
 * agree.
 *
 * A clean, non-empty fetch records a real snapshot. Otherwise (or if that write
 * failed) the measured accounts still go to the partial per-account layer, so one
 * broken bank doesn't turn every other account's chart into an estimate. Run it
 * before fillFromLastKnown: recovered balances must never be written as measured.
 *
 * Each institution whose holdings call answered also has its positions recorded
 * (lib/holdings-history.ts), whether or not the total lands. That runs beside
 * the snapshot, not before it, and never throws, so it can neither hold up nor
 * change what the snapshot records: a failed holdings write is only counted.
 */
export async function recordFetch(
  ctx: Ctx,
  institutions: InstitutionResult[],
  netWorth: number
): Promise<RecordedFetch> {
  const holdings = recordHoldings(ctx, institutions);
  const recorded =
    institutions.length > 0 && institutions.every(isRecordable)
      ? await recordSnapshot(ctx, netWorth, accountBalanceMap(institutions))
      : null;
  if (recorded === null) await recordPartialAccounts(ctx, measuredBalanceMap(institutions));
  return { date: recorded, holdings: await holdings };
}
