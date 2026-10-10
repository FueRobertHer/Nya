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
// one with no balance to count (none yet, or a card's or a loan's positive one
// waiting for the person to say how to read it) is left out, having none to
// show, except for a reader that only names accounts (`named`: Activity's
// rows, whose transactions show whatever the balance).
// An account kept as a manual one on a disconnect that stopped part way is in
// both stores under one id: the manual one is it.
//
// STRICT: throws when either store can't be read, as getManualAccounts does.

import type { Ctx } from './containers';
import { getManualAccount, getManualAccounts, type ManualAccount } from './manual';
import { connectorAccountsStore, type ConnectorAccount } from './connectors/store';
import { nyaBalance } from './connectors/institutions';
import type { ConnectorKind } from './connectors/types';

/** A manual account, or a connector's account in the same shape. */
export type KeptAccount = ManualAccount & { connector?: ConnectorKind };

export async function getKeptAccounts(ctx: Ctx, opts: { named?: boolean } = {}): Promise<KeptAccount[]> {
  const [manual, fed] = await Promise.all([getManualAccounts(ctx), connectorAccountsStore.getAll(ctx)]);
  return keptFrom(manual, fed.values(), opts);
}

/** The accounts a connector feeds that have no balance to count just now:
 *  none has come yet, or a card's or a loan's positive one waits for the
 *  person to say how to read it. Still the person's, only held: a share of
 *  one is paused, never dropped by an edit that doesn't name it, and the
 *  sharing settings list it as waiting so it can be ended (lib/sharing.ts). */
export async function heldAccounts(ctx: Ctx): Promise<ConnectorAccount[]> {
  const [manual, fed] = await Promise.all([getManualAccounts(ctx), connectorAccountsStore.getAll(ctx)]);
  const own = new Set(manual.map((a) => a.account_id));
  return [...fed.values()].filter((a) => !own.has(a.account_id) && nyaBalance(a) === null);
}

/** heldAccounts, by id. */
export async function heldAccountIds(ctx: Ctx): Promise<Set<string>> {
  return new Set((await heldAccounts(ctx)).map((a) => a.account_id));
}

/** One account Nya keeps, by id: a manual account, else a connector's
 *  (named: its balance may not count), or null when there is neither. */
export async function getKeptAccount(ctx: Ctx, account_id: string): Promise<KeptAccount | null> {
  const manual = await getManualAccount(ctx, account_id);
  if (manual) return manual;
  const fed = await connectorAccountsStore.get(ctx, account_id);
  return fed ? (keptFrom([], [fed], { named: true })[0] ?? null) : null;
}

/**
 * The manual accounts and a connector's accounts as one list (see the
 * header), from what was read. `named` keeps a connector's account with no
 * balance to count, at 0: only for a reader that names accounts and never
 * adds their balances up.
 */
export function keptFrom(manual: ManualAccount[], fed: Iterable<ConnectorAccount>, opts: { named?: boolean } = {}): KeptAccount[] {
  const own = new Set(manual.map((a) => a.account_id));
  const connected: KeptAccount[] = [];
  for (const a of fed) {
    const counted = nyaBalance(a);
    if (own.has(a.account_id) || (counted === null && !opts.named)) continue;
    const balance = counted ?? 0;
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
