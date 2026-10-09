// lib/connectors/manage.ts
//
// Connecting a connector the person brings, choosing which of its accounts to
// track, and letting them go: what the routes under app/api/connectors do.
//
// CONNECTING spends the token: a SimpleFIN Setup Token can be claimed once,
// so it is claimed first, and its Access URL is kept (connector-secrets)
// before anything else can fail. The connection is listed (its accounts,
// names only) by one balances-only request, which the person chooses from:
// nothing is tracked until they do, and the balances of accounts they don't
// choose are never stored. CONNECTING AGAIN, when SimpleFIN no longer accepts
// Nya's access, claims a new token for the same connection: its accounts,
// their history and their transactions stay, matched by SimpleFIN's ids.
//
// TRACKING an account gives it an id of its own ("manual_" and a random UUID,
// see lib/connectors/institutions.ts), chosen inside the one compare-and-set
// on the connection entry, so the same account tracked from two devices at
// once is one account. Its history is then fetched afresh: the recent window
// at once, the older windows over the following nights.
//
// LETTING GO, of one account or of the whole connection (a disconnect),
// follows the rules of removing a Plaid connection: nothing Nya recorded of
// the past is rewritten, and the person decides, with keeping as the default:
//   - keep: the account becomes a manual account under the same id, at the
//     balance SimpleFIN last reported (in its currency), with its
//     transactions, history, hidden state, goals and shares; from then on it
//     is updated by hand, as any manual account is. One no answer ever held a
//     balance for has nothing to keep, and goes;
//   - remove: the account and its transactions (and what was said about
//     them) are deleted. Its past balances stay in the history layer, which is
//     never rewritten, so past net-worth totals still hold them, as they do a
//     disconnected bank's; a hidden account stays hidden, so those totals
//     read as they did.
// A disconnect then deletes the Access URL and the connection, so nothing is
// fetched again. SimpleFIN can't be told: the person removes Nya from their
// SimpleFIN account themselves, and the routes say so.

import type { Ctx } from '../containers';
import { connectionsStore, connectorAccountsStore, secretsStore, claimsCount, CLAIMS_PER_HOUR, newConnectionId, type ConnectorAccount, type ConnectorConnection } from './store';
import { connectorOf } from './registry';
import { syncConnection, type SyncResult } from './sync';
import { institutionRef, nyaBalance } from './institutions';
import type { ConnectorKind } from './types';
import { CLAIM_TIMEOUT_MS } from './simplefin';
import { getManualAccounts, newManualId, saveManualAccount, MANUAL_TYPES, type ManualType } from '../manual';
import { removeAccountTxns } from '../manual-txns';
import { forgetAnnotations } from '../txn-annotations';
import { MANY_AT_ONCE } from '../repo';
import { clearCaches } from '../cache';
import { clearBackfillDone } from '../history';
import { loggable } from '../log-safe';

/** How many connections a container may have: one SimpleFIN Bridge account
 *  holds up to 25 institutions; a second is for another server that speaks
 *  the protocol (Redbark, say). */
export const MAX_CONNECTIONS = 2;
/** How many accounts connectors may feed one container. */
export const MAX_CONNECTOR_ACCOUNTS = 100;

/** A request refused with nothing changed: `status` is the route's answer. */
export class ConnectorRefused extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ConnectorRefused';
  }
}

/** Counts one claim against the hour's limit: refused past it. */
async function takeClaim(ctx: Ctx): Promise<void> {
  const { count, secondsLeft } = await claimsCount.take(ctx);
  if (count > CLAIMS_PER_HOUR) {
    throw new ConnectorRefused(`Too many tokens were tried this hour. Try again in ${Math.max(1, Math.ceil(secondsLeft / 60))} minutes.`, 429);
  }
}

/**
 * Connects: claims what the person pasted (ExchangeFailure when it can't be),
 * keeps the credential, and lists the accounts with one balances-only
 * request. Returns the new connection's id and what that request came to (a
 * failure there leaves the connection in place, its accounts to list later).
 */
export async function connect(ctx: Ctx, kind: ConnectorKind, input: string, now: number = Date.now()): Promise<{ connection_id: string; result: SyncResult }> {
  if ((await connectionsStore.count(ctx)) >= MAX_CONNECTIONS) {
    throw new ConnectorRefused(`Nya keeps at most ${MAX_CONNECTIONS} connections like this. Disconnect one first.`, 409);
  }
  await takeClaim(ctx);
  const def = connectorOf(kind);
  const { secret, host } = await def.exchange(input, { timeoutMs: CLAIM_TIMEOUT_MS });
  const connection_id = newConnectionId();
  const connection: ConnectorConnection = {
    version: 1,
    connector: kind,
    host,
    created_at: new Date(now).toISOString(),
    last_fetch: null,
    last_answer_at: null,
    tracked: [],
    available: [],
    history: null,
  };
  // The connection first, so a credential is never kept for one nobody can
  // see (and disconnect).
  await connectionsStore.set(ctx, connection_id, connection);
  await secretsStore.set(ctx, connection_id, { connector: kind, secret });
  const result = await syncConnection(ctx, connection_id, { purpose: 'first', now });
  return { connection_id, result };
}

/** Connects again with a new token, for a connection SimpleFIN no longer
 *  accepts: the same connection, its accounts and history kept. */
export async function reconnect(ctx: Ctx, connection_id: string, input: string, now: number = Date.now()): Promise<SyncResult> {
  const conn = await connectionsStore.get(ctx, connection_id);
  if (!conn) throw new ConnectorRefused('That connection no longer exists.', 404);
  await takeClaim(ctx);
  const { secret, host } = await connectorOf(conn.connector).exchange(input, { timeoutMs: CLAIM_TIMEOUT_MS });
  await secretsStore.set(ctx, connection_id, { connector: conn.connector, secret });
  await connectionsStore.update(ctx, connection_id, (c) => (c ? { ...c, host } : c));
  return syncConnection(ctx, connection_id, { purpose: 'refresh', now });
}

/** An account to track, and what the person says it is. */
export type TrackChoice = { remote_id: string; type: ManualType };

/**
 * Tracks accounts the connection offers (its `available` list, from its
 * latest answer: an account it doesn't offer can't be tracked), then fetches
 * their recent window. Returns what that fetch came to, or null when nothing
 * new was tracked.
 */
export async function trackAccounts(ctx: Ctx, connection_id: string, choices: TrackChoice[], now: number = Date.now()): Promise<SyncResult | null> {
  const conn = await connectionsStore.get(ctx, connection_id);
  if (!conn) throw new ConnectorRefused('That connection no longer exists.', 404);
  const offered = new Map(conn.available.map((a) => [a.remote_id, a]));
  for (const c of choices) {
    const a = offered.get(c.remote_id);
    if (!a) throw new ConnectorRefused('An account you chose is no longer offered. Refresh, then choose again.', 409);
    if (!a.currency) throw new ConnectorRefused(`${a.name} is in a currency Nya doesn't know (${a.currency_text.slice(0, 40)}), so it can't be tracked.`, 400);
    if (!MANUAL_TYPES.includes(c.type)) throw new ConnectorRefused('Choose what kind of account each one is.', 400);
  }
  if (choices.length === 0) return null;
  if ((await connectorAccountsStore.count(ctx)) + choices.length > MAX_CONNECTOR_ACCOUNTS) {
    throw new ConnectorRefused(`Nya tracks at most ${MAX_CONNECTOR_ACCOUNTS} accounts through connectors.`, 400);
  }

  // Ids made once, outside the compare-and-set; inside it, an account tracked
  // meanwhile (another device) keeps the id it was given there.
  const fresh = new Map(choices.map((c) => [c.remote_id, newManualId()]));
  let ids = new Map<string, string>();
  await connectionsStore.update(ctx, connection_id, (current) => {
    if (!current) return null;
    ids = new Map(current.tracked.map((t) => [t.remote_id, t.account_id]));
    for (const c of choices) if (!ids.has(c.remote_id)) ids.set(c.remote_id, fresh.get(c.remote_id)!);
    return {
      ...current,
      tracked: [...ids].map(([remote_id, account_id]) => ({ remote_id, account_id })),
      available: current.available.filter((a) => !ids.has(a.remote_id)),
      // New accounts' history is fetched afresh, from the recent window back;
      // what the others have already is matched, never added twice.
      history: null,
    };
  });
  if (ids.size === 0) throw new ConnectorRefused('That connection no longer exists.', 404);

  const at = new Date(now).toISOString();
  const entries = choices.map((c) => {
    const a = offered.get(c.remote_id)!;
    const entry: ConnectorAccount = {
      version: 1,
      account_id: ids.get(c.remote_id)!,
      connection_id,
      connector: conn.connector,
      remote_id: a.remote_id,
      name: a.name,
      institution_name: a.institution,
      institution_key: a.institution_key,
      institution_ref: institutionRef(connection_id, a.institution_key),
      type: c.type,
      subtype: null,
      currency: a.currency!,
      reported_balance: null,
      reported_available: null,
      balance_at: null,
      fetched_at: null,
      created_at: at,
    };
    return entry;
  });
  for (let i = 0; i < entries.length; i += MANY_AT_ONCE) {
    const chunk = entries.slice(i, i + MANY_AT_ONCE);
    // An entry there already (the same account tracked twice) is left as it is.
    await connectorAccountsStore.updateMany(
      ctx,
      chunk.map((e) => e.account_id),
      (current) => new Map(chunk.filter((e) => !current.get(e.account_id)).map((e) => [e.account_id, e]))
    );
  }
  const result = await syncConnection(ctx, connection_id, { purpose: 'first', now });
  // New accounts change every total: the estimated history is rebuilt with
  // them (held flat), and cached payloads go (flag first, as elsewhere).
  await clearBackfillDone(ctx);
  await clearCaches(ctx);
  return result;
}

/** Changes what kind of account tracked accounts are. Their contribution to
 *  net worth stays the balance SimpleFIN reports; the kind says whether it is
 *  money held or owed. */
export async function retypeAccounts(ctx: Ctx, changes: { account_id: string; type: ManualType }[]): Promise<number> {
  let changed = 0;
  for (let i = 0; i < changes.length; i += MANY_AT_ONCE) {
    const chunk = changes.slice(i, i + MANY_AT_ONCE);
    let here = 0;
    await connectorAccountsStore.updateMany(
      ctx,
      chunk.map((c) => c.account_id),
      (current) => {
        here = 0; // this may run more than once
        const writes = new Map<string, ConnectorAccount | null>();
        for (const c of chunk) {
          const a = current.get(c.account_id);
          if (!a || a.type === c.type) continue;
          writes.set(c.account_id, { ...a, type: c.type, subtype: null });
          here++;
        }
        return writes;
      }
    );
    changed += here;
  }
  if (changed > 0) {
    await clearBackfillDone(ctx);
    await clearCaches(ctx);
  }
  return changed;
}

export type Released = { kept: string[]; removed: string[] };

/**
 * Stops tracking accounts, keeping each as a manual account or removing it
 * (see the header). An account kept as a manual one is written there before
 * its connector entry goes, so it is never without one; the readers take the
 * manual account when both are there.
 */
export async function releaseAccounts(ctx: Ctx, account_ids: string[], keep: boolean, now: number = Date.now()): Promise<Released> {
  const accounts = [...(await connectorAccountsStore.getMany(ctx, account_ids)).values()];
  const out: Released = { kept: [], removed: [] };
  const manual = keep ? new Set((await getManualAccounts(ctx)).map((a) => a.account_id)) : new Set<string>();
  for (const a of accounts) {
    const balance = nyaBalance(a);
    if (keep && balance !== null) {
      if (!manual.has(a.account_id)) {
        await saveManualAccount(ctx, {
          account_id: a.account_id,
          name: a.name,
          institution_name: a.institution_name,
          type: a.type,
          subtype: a.subtype,
          balance,
          updated_at: a.balance_at ?? a.fetched_at ?? new Date(now).toISOString(),
          ...(a.currency !== 'USD' ? { currency: a.currency } : {}),
        });
      }
      out.kept.push(a.account_id);
    } else {
      const rows = await removeAccountTxns(ctx, a.account_id);
      await forgetAnnotations(ctx, rows).catch((err) => console.warn('connectors: exclusions were left behind', loggable(err)));
      out.removed.push(a.account_id);
    }
  }
  if (accounts.length > 0) await connectorAccountsStore.remove(ctx, ...accounts.map((a) => a.account_id));
  // A fetch that read these accounts before they went may have written a
  // book back for one being removed: once more, now that it is gone.
  for (const id of out.removed) {
    const late = await removeAccountTxns(ctx, id);
    if (late.length > 0) await forgetAnnotations(ctx, late).catch((err) => console.warn('connectors: exclusions were left behind', loggable(err)));
  }
  // Off each connection's list, so a later answer offers them again.
  const byConnection = new Map<string, Set<string>>();
  for (const a of accounts) byConnection.set(a.connection_id, (byConnection.get(a.connection_id) ?? new Set()).add(a.account_id));
  for (const [connection_id, gone] of byConnection) {
    await connectionsStore.update(ctx, connection_id, (c) => (c ? { ...c, tracked: c.tracked.filter((t) => !gone.has(t.account_id)) } : c));
  }
  if (accounts.length > 0) {
    await clearBackfillDone(ctx);
    await clearCaches(ctx);
  }
  return out;
}

/**
 * Disconnects: lets every account of the connection go (kept as manual
 * accounts, or removed), then deletes the credential and the connection. Also
 * finishes one that stopped part way, whose connection entry may already be
 * gone.
 */
export async function disconnect(ctx: Ctx, connection_id: string, keep: boolean, now: number = Date.now()): Promise<Released> {
  const ids = [...(await connectorAccountsStore.getAll(ctx)).values()].filter((a) => a.connection_id === connection_id).map((a) => a.account_id);
  const released = await releaseAccounts(ctx, ids, keep, now);
  await secretsStore.remove(ctx, connection_id);
  await connectionsStore.remove(ctx, connection_id);
  await clearCaches(ctx);
  return released;
}
