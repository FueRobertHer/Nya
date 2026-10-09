// lib/kept-accounts.ts
//
// Every account Nya keeps itself rather than reading from Plaid: the manual
// accounts (lib/manual.ts), and the accounts a connector the person brought
// feeds (lib/connectors/, SimpleFIN's), shaped as manual accounts are, for the
// readers that treat the two alike: their transactions on the Activity tab
// (lib/manual-txns.ts), what can be shared and what a share shows
// (lib/sharing.ts), and the balances the estimated history holds flat
// (app/api/backfill). Net worth reads them apart (lib/networth.ts): a
// connector's accounts have cards of their own, with health and a snapshot
// gate of their own (lib/connectors/institutions.ts).
//
// A connector's account is here with the balance SimpleFIN last reported for
// it, in Nya's sign, and the time the institution gave it as `updated_at`;
// one no answer has held a balance for yet is left out, having none to show.
// An account kept as a manual one on a disconnect that stopped part way is in
// both stores under one id: the manual one is it.
//
// STRICT: throws when either store can't be read, as getManualAccounts does.

import type { Ctx } from './containers';
import { getManualAccounts, type ManualAccount } from './manual';
import { connectorAccountsStore } from './connectors/store';
import { nyaBalance } from './connectors/institutions';
import type { ConnectorKind } from './connectors/types';

/** A manual account, or a connector's account in the same shape. */
export type KeptAccount = ManualAccount & { connector?: ConnectorKind };

export async function getKeptAccounts(ctx: Ctx): Promise<KeptAccount[]> {
  const [manual, fed] = await Promise.all([getManualAccounts(ctx), connectorAccountsStore.getAll(ctx)]);
  const own = new Set(manual.map((a) => a.account_id));
  const connected: KeptAccount[] = [];
  for (const a of fed.values()) {
    const balance = nyaBalance(a);
    if (own.has(a.account_id) || balance === null) continue;
    connected.push({
      account_id: a.account_id,
      name: a.name,
      institution_name: a.institution_name,
      type: a.type,
      subtype: a.subtype,
      balance,
      updated_at: a.balance_at ?? a.fetched_at ?? a.created_at,
      ...(a.currency !== 'USD' ? { currency: a.currency } : {}),
      connector: a.connector,
    });
  }
  return [...manual, ...connected].sort((a, b) => a.name.localeCompare(b.name));
}
