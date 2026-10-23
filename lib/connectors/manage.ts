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
// their history and their transactions stay, matched by SimpleFIN's ids. What
// the old access came to is forgotten with it: until the new one answers, the
// accounts wait for it, never showing the old refusal as the new token's.
// What was pasted is checked before anything is counted or sent. A Lunch Flow
// API key is not spent: it is checked once against Lunch Flow and kept the
// same way, and connecting again takes a key in its place
// (lib/connectors/lunchflow.ts).
//
// TRACKING an account gives it an id of its own ("manual_" and a random UUID,
// see lib/connectors/institutions.ts), chosen inside the one compare-and-set
// on the connection entry, so the same account tracked from two devices at
// once is one account. One another connection already tracks (the same id on
// the same host) is refused, saying why: tracked twice it would be counted
// twice. Names are never compared on the same host, where two people's own
// "Checking" are two accounts; on another host only a likely match can be
// told (the same bank, name and balance), which the screens say, leaving the
// choice to the person. Its history is then fetched afresh: the recent window
// at once, the older windows over the following nights. A card or a loan
// whose balance comes positive waits for the person to say how to read it
// (confirmSigns).
//
// LETTING GO, of one account or of the whole connection (a disconnect),
// follows the rules of removing a Plaid connection: nothing Nya recorded of
// the past is rewritten, and the person decides, with keeping as the default:
//   - keep: the account becomes a manual account under the same id, at the
//     balance SimpleFIN last reported (in its currency), with its
//     transactions, history, hidden state, goals and shares; from then on it
//     is updated by hand, as any manual account is. One no answer ever held a
//     balance for has nothing to keep, and goes, named in the answer. A card
//     or a loan whose positive balance waits for the person to say how to read
//     it is never lost to that rule: keeping it is refused, changing nothing,
//     until they answer (the screens ask in the same step, and send the answer
//     with the request);
//   - remove: the account and its transactions (and what was said about
//     them) are deleted. Its past balances stay in the history layer, which is
//     never rewritten, so past net-worth totals still hold them, as they do a
//     disconnected bank's; a hidden account stays hidden, so those totals
//     read as they did.
// Either way, what was let go is recorded first (connector-ended: what it
// was, when, and which way), so a report on a period it was tracked in says
// its transactions may be gone, or since then only entered by hand, as the
// account directory lets it say of a removed Plaid connection.
// A disconnect then deletes the Access URL (or the key) and the connection, so
// nothing is fetched again. Neither SimpleFIN nor Lunch Flow can be told: the
// person removes Nya from their SimpleFIN account, or deletes the API
// destination in Lunch Flow, themselves, and the screens say so.

import type { Ctx } from '../containers';
import {
  connectionsStore,
  connectorAccountsStore,
  endedAccountsStore,
  secretsStore,
  claimsCount,
  CLAIMS_PER_HOUR,
  newConnectionId,
  type ConnectorAccount,
  type ConnectorConnection,
  type EndedAccount,
  type OwedSign,
} from './store';
import { connectorOf } from './registry';
import { connectorOffered } from './switch';
import { syncConnection, type SyncResult } from './sync';
import { institutionRef, needsSign, nyaBalance, trackedElsewhere } from './institutions';
import type { ConnectorKind } from './types';
import { CLAIM_TIMEOUT_MS } from './simplefin';
import { getManualAccounts, newManualId, saveManualAccount, MANUAL_TYPES, type ManualType } from '../manual';
import { removeAccountTxns } from '../manual-txns';
import { forgetAnnotations } from '../txn-annotations';
import { forgetSplitsAndGroups } from '../split-gone';
import { MANY_AT_ONCE, UnreadableEntriesError } from '../repo';
import { clearCaches } from '../cache';
import { clearBackfillDone } from '../history';
import { loggable } from '../log-safe';
import { isOwedType } from '../balance';
import { retypeWithHistory, signJobStore } from '../sign-repair';
import { ForgetRefused } from '../links';

/** How many connections a container may have: one SimpleFIN Bridge account
 *  holds the person's banks there; a second is for another server that speaks
 *  the protocol (Redbark, say), or for a Lunch Flow account. No more, since
 *  the day's requests are for every connection together (lib/connectors/sync.ts
 *  DAILY_REQUESTS): two leave enough for each one's daily update, a catch-up
 *  and older history, with some for Refresh, where a third would need a
 *  budget of its own. */
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

/** "A", "A and B", "A, B and C". */
const names = (list: string[]) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/** Counts one claim against the hour's limit: refused past it. */
async function takeClaim(ctx: Ctx): Promise<void> {
  const { count, secondsLeft } = await claimsCount.take(ctx);
  if (count > CLAIMS_PER_HOUR) {
    throw new ConnectorRefused(`Too many tokens or keys were tried this hour. Try again in ${Math.max(1, Math.ceil(secondsLeft / 60))} minutes.`, 429);
  }
}

/**
 * Connects: claims what the person pasted (ExchangeFailure when it can't be),
 * keeps the credential, and lists the accounts with one balances-only
 * request. Returns the new connection's id and what that request came to (a
 * failure there leaves the connection in place, its accounts to list later).
 */
export async function connect(ctx: Ctx, kind: ConnectorKind, input: string, now: number = Date.now()): Promise<{ connection_id: string; result: SyncResult }> {
  // Before anything is counted or sent (lib/connectors/switch.ts): turned off,
  // no new connection, while those made keep working.
  if (!connectorOffered(kind)) {
    throw new ConnectorRefused(`Connecting ${connectorOf(kind).label} isn't turned on for this copy of Nya.`, 403);
  }
  if ((await connectionsStore.count(ctx)) >= MAX_CONNECTIONS) {
    throw new ConnectorRefused(`Nya keeps at most ${MAX_CONNECTIONS} connections like this. Disconnect one first.`, 409);
  }
  const def = connectorOf(kind);
  // Only what could be a token counts against the hour's claims.
  def.checkInput(input);
  await takeClaim(ctx);
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

/** Connects again with a new token (or key), for a connection its connector
 *  no longer accepts: the same connection, its accounts and history kept.
 *  `kind`, when given, is the connector the request says it is for: another
 *  connection's is refused, changing nothing. */
export async function reconnect(ctx: Ctx, connection_id: string, input: string, now: number = Date.now(), kind?: ConnectorKind): Promise<SyncResult> {
  const conn = await connectionsStore.get(ctx, connection_id);
  if (!conn) throw new ConnectorRefused('That connection no longer exists.', 404);
  if (kind !== undefined && kind !== conn.connector) throw new ConnectorRefused(`That connection is through ${connectorOf(conn.connector).label}: connect it again from its own card.`, 400);
  const def = connectorOf(conn.connector);
  def.checkInput(input);
  await takeClaim(ctx);
  const { secret, host } = await def.exchange(input, { timeoutMs: CLAIM_TIMEOUT_MS });
  await secretsStore.set(ctx, connection_id, { connector: conn.connector, secret });
  // The old access's last word goes with it (see the header).
  await connectionsStore.update(ctx, connection_id, (c) => (c ? { ...c, host, last_fetch: null } : c));
  await clearCaches(ctx);
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
  const all = await connectorAccountsStore.getAll(ctx);
  if (all.size + choices.length > MAX_CONNECTOR_ACCOUNTS) {
    throw new ConnectorRefused(`Nya tracks at most ${MAX_CONNECTOR_ACCOUNTS} accounts through connectors.`, 400);
  }
  // Never the same account through two connections: it would be counted twice.
  const others = await othersOf(ctx, connection_id, [...all.values()]);
  for (const c of choices) {
    const a = offered.get(c.remote_id)!;
    const there = trackedElsewhere(a, { connector: conn.connector, host: conn.host }, others);
    if (there?.certain) {
      throw new ConnectorRefused(
        `${a.name} at ${a.institution} is already tracked through your other ${connectorOf(conn.connector).label} connection${there.host ? ` (${there.host})` : ''}, so it isn't tracked again here: it would be counted twice.`,
        409
      );
    }
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
      // With nothing tracked before, the last request was a listing to choose
      // from, which names no account, so its problems would read as any
      // bank's: forgotten, as connecting again forgets it, so until the fetch
      // below answers (skipped when the day's requests are spent) the
      // accounts say they wait for it. With some tracked, it was about them,
      // and stands for them meanwhile; the new ones, with no balance yet,
      // wait all the same (lib/connectors/institutions.ts issueOf).
      last_fetch: current.tracked.length === 0 ? null : current.last_fetch,
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

/** The accounts other connections track, each with the host its connection
 *  reaches (null when that connection's entry is gone). */
export async function othersOf(ctx: Ctx, connection_id: string, accounts: ConnectorAccount[]): Promise<{ account: ConnectorAccount; host: string | null }[]> {
  const theirs = accounts.filter((a) => a.connection_id !== connection_id);
  if (theirs.length === 0) return [];
  const connections = await connectionsStore.getMany(ctx, [...new Set(theirs.map((a) => a.connection_id))]);
  return theirs.map((account) => ({ account, host: connections.get(account.connection_id)?.host ?? null }));
}

/** Changes what kind of account tracked accounts are. With the sign as the
 *  protocol has it (owed negative), their contribution to net worth stays the
 *  balance SimpleFIN reports, and the kind says whether it is money held or
 *  owed; a card or a loan reported positive waits for confirmSigns. A change
 *  between money held and owed also re-signs the account's past balances
 *  (lib/sign-repair.ts retypeWithHistory), since its recorded values follow
 *  its kind: every earlier day goes on counting as it was recorded. */
export async function retypeAccounts(ctx: Ctx, changes: { account_id: string; type: ManualType }[]): Promise<number> {
  let changed = 0;
  // Across held and owed: one at a time, each with its history.
  const current = await connectorAccountsStore.getMany(ctx, changes.map((c) => c.account_id));
  const crossing = changes.filter((c) => {
    const a = current.get(c.account_id);
    return !!a && a.type !== c.type && isOwedType(a.type) !== isOwedType(c.type);
  });
  for (const c of crossing) {
    try {
      if (await retypeWithHistory(ctx, c.account_id, c.type)) changed++;
    } catch (err) {
      // Another change to accounts holds the lock: nothing changed.
      if (err instanceof ForgetRefused) throw new ConnectorRefused(err.message, 409);
      // The kind changed, and its job is kept: finished by the nightly snapshot
      // (lib/snapshot-job.ts), or by the next change of it.
      if (!(await signJobStore.has(ctx, c.account_id))) throw err;
      console.error('Connectors: an account’s past balances could not all be re-signed yet', loggable(err));
      const name = current.get(c.account_id)!.name;
      throw new ConnectorRefused(`The kind of ${name} was changed, but not every earlier day of its history could be turned over to match yet: that is finished by Nya’s next daily update, and until then some of those days may count the other way.`, 503);
    }
  }
  const rest = changes.filter((c) => !crossing.includes(c));
  for (let i = 0; i < rest.length; i += MANY_AT_ONCE) {
    const chunk = rest.slice(i, i + MANY_AT_ONCE);
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

/**
 * Records how to read the sign of tracked cards' and loans' balances, as the
 * person said (lib/connectors/institutions.ts SIGNS): once said, the balance
 * counts. Returns how many changed; an account that isn't a card or a loan is
 * left as it is.
 */
export async function confirmSigns(ctx: Ctx, answers: { account_id: string; sign: OwedSign }[]): Promise<number> {
  let changed = 0;
  for (let i = 0; i < answers.length; i += MANY_AT_ONCE) {
    const chunk = answers.slice(i, i + MANY_AT_ONCE);
    let here = 0;
    await connectorAccountsStore.updateMany(
      ctx,
      chunk.map((c) => c.account_id),
      (current) => {
        here = 0; // this may run more than once
        const writes = new Map<string, ConnectorAccount | null>();
        for (const c of chunk) {
          const a = current.get(c.account_id);
          if (!a || !isOwedType(a.type) || a.sign === c.sign) continue;
          writes.set(c.account_id, { ...a, sign: c.sign });
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

/**
 * Why keeping these accounts as manual ones is refused, or null: a card or a
 * loan among them whose positive balance waits for the person to say how to
 * read it, so whether it is owed or held isn't known. `after`: the kinds and
 * answers a request is about to save first, so a route can refuse before it
 * saves anything (app/api/connectors).
 */
export function keepRefusal(
  accounts: readonly ConnectorAccount[],
  after: { types?: ReadonlyMap<string, ManualType>; signs?: ReadonlyMap<string, OwedSign> } = {}
): string | null {
  const unsure = accounts.filter((a) =>
    needsSign({ ...a, type: after.types?.get(a.account_id) ?? a.type, sign: after.signs?.get(a.account_id) ?? a.sign ?? null })
  );
  if (unsure.length === 0) return null;
  const one = unsure.length === 1;
  return `Say how to read ${names(unsure.map((a) => a.name))} first: ${connectorOf(unsure[0].connector).label} reports ${one ? 'it' : 'them'} as money held, and a balance can't be kept as a manual account until it is known whether it is owed or held.`;
}

export type Released = {
  kept: string[];
  removed: string[];
  /** Accounts removed although keeping was asked for: no answer ever held a
   *  balance for them, so there was nothing to keep. By name, to say so. */
  nothing_to_keep: string[];
};

/**
 * Stops tracking accounts, keeping each as a manual account or removing it
 * (see the header). An account kept as a manual one is written there before
 * its connector entry goes, so it is never without one; the readers take the
 * manual account when both are there. Keeping is refused (ConnectorRefused,
 * 409), with nothing changed, while a card's or a loan's positive balance
 * waits for the person to say how to read it (confirmSigns first).
 */
export async function releaseAccounts(ctx: Ctx, account_ids: string[], keep: boolean, now: number = Date.now()): Promise<Released> {
  const accounts = [...(await connectorAccountsStore.getMany(ctx, account_ids)).values()];
  const refused = keep ? keepRefusal(accounts) : null;
  if (refused) throw new ConnectorRefused(refused, 409);
  // What is let go, and how, recorded before anything changes, so a report on
  // a period it was tracked in says its transactions may be gone, or since
  // then only entered by hand (lib/report/read.ts). Strict: an account goes
  // only once that is kept.
  if (accounts.length > 0) {
    const conns = await connectionsStore.getMany(ctx, [...new Set(accounts.map((a) => a.connection_id))]);
    const at = new Date(now).toISOString();
    await endedAccountsStore.setMany(
      ctx,
      accounts.map((a): [string, EndedAccount] => {
        const conn = conns.get(a.connection_id);
        return [
          a.account_id,
          {
            version: 1,
            connector: a.connector,
            connection_id: a.connection_id,
            host: conn?.host ?? null,
            remote_id: a.remote_id,
            name: a.name,
            institution_name: a.institution_name,
            type: a.type,
            currency: a.currency,
            tracked_at: a.created_at,
            history_from: conn?.history?.from ?? null,
            // The days answers had left it out of (lib/connectors/sync.ts).
            ...(a.left_out?.length ? { left_out: a.left_out } : {}),
            ended_at: at,
            kept: keep && nyaBalance(a) !== null,
          },
        ];
      })
    );
  }
  const out: Released = { kept: [], removed: [], nothing_to_keep: [] };
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
      await forgetSplitsAndGroups(ctx, rows).catch((err) => console.warn('connectors: splits or groups were left behind', loggable(err)));
      out.removed.push(a.account_id);
      if (keep) out.nothing_to_keep.push(a.name);
    }
  }
  if (accounts.length > 0) await connectorAccountsStore.remove(ctx, ...accounts.map((a) => a.account_id));
  // A fetch that read these accounts before they went may have written a
  // book back for one being removed: once more, now that it is gone.
  for (const id of out.removed) {
    const late = await removeAccountTxns(ctx, id);
    if (late.length > 0) await forgetAnnotations(ctx, late).catch((err) => console.warn('connectors: exclusions were left behind', loggable(err)));
    if (late.length > 0) await forgetSplitsAndGroups(ctx, late).catch((err) => console.warn('connectors: splits or groups were left behind', loggable(err)));
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
 * Forgets what Nya keeps of an account the person let go (connector-ended),
 * at their word: its name, its bank and when, so reports no longer say what
 * its going may have left out. Its past balances stay in the net-worth
 * history, which is never rewritten. A record that can't be read may be
 * forgotten unread; one this version doesn't recognise is intact data, and is
 * never forgotten here (the seam's rule). Answers whether there was one.
 */
export async function forgetEnded(ctx: Ctx, account_id: string): Promise<boolean> {
  try {
    if (!(await endedAccountsStore.get(ctx, account_id))) return false;
  } catch (err) {
    if (!(err instanceof UnreadableEntriesError) || err.unrecognised.length > 0) throw err;
  }
  await endedAccountsStore.remove(ctx, account_id);
  return true;
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
