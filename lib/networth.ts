// lib/networth.ts
//
// Fetches live balances (and holdings) for every linked institution and
// computes total net worth. Shared by the dashboard API route and the daily
// snapshot cron route.

import { plaidClient } from './plaid';
import { decrypt } from './crypto';
import { getItems, type StoredItem } from './storage';

export type InstitutionResult = {
  institution_name: string;
  item_id: string;
  accounts: any[];
  holdings: any[];
  error: string | null;
  needs_reauth: boolean;
};

async function fetchInstitution(item: StoredItem): Promise<InstitutionResult> {
  const result: InstitutionResult = {
    institution_name: item.institution_name,
    item_id: item.item_id,
    accounts: [],
    holdings: [],
    error: null,
    needs_reauth: false,
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
      type: a.type,
      subtype: a.subtype,
      balance: a.balances.current,
      available: a.balances.available,
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

  // Investment holdings -- fails silently for non-brokerage items, that's expected.
  try {
    const holdingsRes = await plaidClient.investmentsHoldingsGet({ access_token });
    const securities: Record<string, any> = {};
    (holdingsRes.data.securities || []).forEach((s) => (securities[s.security_id] = s));
    result.holdings = (holdingsRes.data.holdings || []).map((h) => ({
      name: securities[h.security_id]?.name || securities[h.security_id]?.ticker_symbol || 'Unknown',
      quantity: h.quantity,
      price: h.institution_price,
      value: h.institution_value,
      cost_basis: h.cost_basis, // total cost of the position, for gain/loss
    }));
  } catch {
    // not a brokerage account, or investments not supported -- fine, skip
  }

  return result;
}

export async function computeNetWorth(): Promise<{
  institutions: InstitutionResult[];
  netWorth: number;
}> {
  const items = await getItems();

  // Fetch every institution concurrently instead of one at a time --
  // with N linked accounts this used to take N sequential round trips.
  const institutions = await Promise.all(items.map(fetchInstitution));

  // Net worth = sum of depository/investment/other balances minus credit/loan balances.
  // Holdings values are already reflected in the parent investment account's balance,
  // so they aren't added again here.
  let netWorth = 0;
  institutions.forEach((inst) => {
    inst.accounts.forEach((a) => {
      if (a.balance == null) return;
      netWorth += a.type === 'credit' || a.type === 'loan' ? -a.balance : a.balance;
    });
  });

  return { institutions, netWorth };
}

/** Flat { account_id: current balance } map, for per-account history snapshots. */
export function accountBalanceMap(institutions: InstitutionResult[]): Record<string, number> {
  const map: Record<string, number> = {};
  institutions.forEach((inst) => {
    inst.accounts.forEach((a) => {
      if (a.balance != null) map[a.account_id] = a.balance;
    });
  });
  return map;
}
