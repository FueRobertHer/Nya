// lib/connectors/institutions.ts
//
// The accounts a connector feeds, as net worth sees institutions
// (lib/networth.ts InstitutionResult): one card per bank per connection,
// labelled with the connector ("via SimpleFIN" on the Accounts tab), each
// with its health (lib/connectors/health.ts). Read from what the last fetch
// stored (lib/connectors/sync.ts): opening the app never asks the connector
// anything, so it costs none of the day's requests.
//
// KEPT LIKE MANUAL ACCOUNTS. A SimpleFIN account's id is a manual account's
// kind ("manual_" and a random UUID), its transactions are in a book in
// manual-transactions, and its institution is `manual` beside `connector`:
// it is not a Plaid Item, so nothing Plaid-shaped (account links, reconnecting
// through Link, holdings, Plaid's own health and emails, the duplicate
// connection check) ever reaches for it, and it never joins an account link
// (lib/links.ts leaves manual ids out). What makes it SimpleFIN's is its
// entry in connector-accounts. So keeping its history as a manual account on
// a disconnect is the same id carried on: its balances, its transactions,
// whether it is hidden, its goals and its shares all stay with it.
//
// BALANCES ARE MEASUREMENTS, ONLY WHEN WHOLE AND CURRENT. A balance is the
// one the institution gave through SimpleFIN, with the time it gave it
// (balance-date), measured as a Plaid balance is: on a clean answer it is
// recorded in the real history layer like any other (lib/networth.ts
// recordFetch), in the day's total and its breakdown, as a Plaid balance up to
// a day behind is. A card is held out of that (`error` set, which closes the
// snapshot gate, and its balances marked `stale`, which keeps them out of the
// per-account layers too) whenever its accounts' latest word is not a whole,
// current answer:
//   - the latest request failed (nothing came);
//   - SimpleFIN reported a problem that concerns this bank, or names no bank
//     at all (it could be any);
//   - one of its tracked accounts was missing from the answer;
//   - no answer has held a balance for it yet, or none has been asked for
//     since it was connected again;
//   - a card or a loan reports a positive balance the person hasn't said how
//     to read (below);
//   - the bank's latest balance is more than OLD_BALANCE_HOURS old: SimpleFIN
//     answers, but its link to the bank has stopped updating;
//   - no answer has come for FRESH_HOURS (the daily update didn't run).
// The same holds for Lunch Flow's accounts (lib/connectors/lunchflow.ts),
// with one difference: Lunch Flow gives no time with a balance, so its
// balance is as of when Nya received it, the old-balance rule never applies,
// and a link of its that stopped updating is a problem it reports (the
// account's status), which holds the bank as any reported problem does.
// Its last balances are still shown, with their own date, as last known;
// never written as measured, and never recovered from the history layer.
//
// AN ACCOUNT THAT ENDED (lib/lifecycle.ts: closed, no longer the person's, or
// no longer followed, from a day that has come) holds nothing: it counts in
// nothing from its end, so its going missing from an answer, a problem
// SimpleFIN names for it alone, its waiting for a balance or an answer about
// its sign, or its bank's old balance for it says nothing about the rest of
// its bank, as a Plaid account's absence holds nothing once it has an end
// (lib/vanished.ts). It stays on its card only while the latest answer was
// whole and current for it (its balance is a measurement, recorded with the
// day's total, which the history subtracts from its end on); else it is left
// off: its last balance is no measurement of today, and a total recorded
// with it would count it with nothing to subtract. The rest of the bank is
// held, and recorded, as ever; a bank where every account ended, by nothing,
// a failed request included. `ended` is those accounts' ids, from the
// caller's read of the lifecycle: none when that couldn't be read, which only
// holds more.
//
// SIGNS. A balance is kept as SimpleFIN reported it and turned into Nya's
// sign here. The protocol's convention, which SimpleFIN Bridge follows, is the
// holder's side: money held positive, money owed negative. So an account the
// person calls a card or a loan normally reports a negative balance, which is
// the positive amount owed in Nya's sign, and whatever type is chosen, its
// contribution to net worth is the reported balance. But the protocol doesn't
// pin a liability's sign, and some servers report what is owed as positive,
// which read that way would add a debt to net worth. So a card or a loan with
// a positive balance is never counted until the person says how to read it,
// once per account (ConnectorAccount.sign): money held, as reported (a card
// paid past zero), or what is owed (the server reports it positive, so its
// sign is turned). Until then its bank is held, and it has no balance at all.

import { createHash } from 'node:crypto';
import type { Ctx } from '../containers';
import type { InstitutionResult } from '../networth';
import { isOwedType } from '../balance';
import { connectionsStore, connectorAccountsStore, type ConnectorAccount, type ConnectorConnection } from './store';
import { connectorHealth, shortDay } from './health';
import { formatMoney } from '../format';
import { connectorOf } from './registry';
import { ANY_CONNECTOR, type ConnectorDetail, type ConnectorIssue, type ConnectorKind } from './types';
import type { Side } from '../connection-state';

/** How long the last answer counts as current: a day and a half, so a
 *  daily update a few hours late still counts. */
export const FRESH_HOURS = 36;
/** How old the bank's own balance may be and still count as current: three
 *  days, so a weekend's quiet at the bank still counts, and a link that has
 *  stopped updating at SimpleFIN doesn't for long. */
export const OLD_BALANCE_HOURS = 72;

const HOUR = 3_600_000;

/** The id of a bank's card within a connection: a hash of the connection's
 *  random id and the connector's key for the bank, so it is the same on every
 *  load and never content on its own. */
export function institutionRef(connection_id: string, institution_key: string): string {
  return createHash('sha256').update(`${connection_id}\n${institution_key}`).digest('hex').slice(0, 16);
}

/** Whether a tracked account's balance can't be counted until the person
 *  says how to read it: a card or a loan reported as money held, with no
 *  answer from them yet (see SIGNS in the header). */
export function needsSign(a: Pick<ConnectorAccount, 'type' | 'reported_balance' | 'sign'>): boolean {
  return isOwedType(a.type) && a.reported_balance !== null && a.reported_balance > 0 && (a.sign ?? null) === null;
}

/**
 * A tracked account's balance in Nya's sign (a card's or a loan's is the
 * positive amount owed), or null when there is none to count: before an
 * answer held one, and while a card's or a loan's positive balance waits for
 * the person to say how to read it (needsSign).
 */
export function nyaBalance(a: Pick<ConnectorAccount, 'type' | 'reported_balance' | 'sign'>): number | null {
  if (a.reported_balance === null) return null;
  let b = a.reported_balance;
  if (isOwedType(a.type)) {
    if (needsSign(a)) return null;
    // The protocol's way, owed negative, turned into an amount owed; or the
    // server's own way, owed positive, as the person said.
    b = a.sign === 'owed_positive' ? a.reported_balance : -a.reported_balance;
  }
  return b === 0 ? 0 : b;
}

/** The time a balance is from: the institution's, else when Nya received it. */
const asOfOf = (a: ConnectorAccount) => a.balance_at ?? a.fetched_at;

/** An account as two connections could both name it: its bank's name and its
 *  own, case and spacing aside. */
const fingerprint = (institution: string, name: string) => `${institution.trim().replace(/\s+/g, ' ').toLowerCase()}\n${name.trim().replace(/\s+/g, ' ').toLowerCase()}`;

/** Another connection's account that an offered one is, or may be. */
export type Elsewhere = { account: ConnectorAccount; host: string | null; certain: boolean };

/**
 * The account another connection already tracks that an offered one is, or
 * null. For certain when it has the same connector id on the same host:
 * tracking it again would count it twice, so it is refused
 * (lib/connectors/manage.ts trackAccounts). Only likely when, on another
 * host, it has the same bank and account name and the same balance as that
 * account last reported (`offer.balance`, known only in the answer to
 * connecting): said, never refused, since two accounts can share all three
 * (two people's "Checking" at one bank, on one server, are two accounts, and
 * are never matched by name at all).
 */
export function trackedElsewhere(
  offer: { remote_id: string; name: string; institution: string; balance?: number },
  host: string,
  others: readonly { account: ConnectorAccount; host: string | null }[]
): Elsewhere | null {
  const same = others.find(({ account, host: there }) => there === host && account.remote_id === offer.remote_id);
  if (same) return { ...same, certain: true };
  if (offer.balance === undefined) return null;
  const print = fingerprint(offer.institution, offer.name);
  const likely = others.find(
    ({ account, host: there }) =>
      there !== host && account.reported_balance !== null && account.reported_balance === offer.balance && fingerprint(account.institution_name, account.name) === print
  );
  return likely ? { ...likely, certain: false } : null;
}

/** Whether the bank's own balance is too old to count as current. */
export function balanceTooOld(a: Pick<ConnectorAccount, 'balance_at'>, now: number): boolean {
  if (!a.balance_at) return false;
  const at = Date.parse(a.balance_at);
  return Number.isFinite(at) && now - at > OLD_BALANCE_HOURS * HOUR;
}

/**
 * Whether a connection's latest answer was whole for every account it tracks:
 * an answer came, no problem it reported concerns them or names no bank, none
 * was missing, each has a balance, and none of those is too old. The daily run
 * asks again within REFETCH_HOURS unless it was (lib/connectors/sync.ts), so a
 * held bank is never left held for a day by a fetch it skipped.
 */
export function answeredWhole(conn: ConnectorConnection, tracked: readonly ConnectorAccount[], now: number, ended: ReadonlySet<string> = new Set()): boolean {
  const f = conn.last_fetch;
  if (!f || f.failure) return false;
  // An account that ended holds nothing (see the header).
  const live = tracked.filter((a) => !ended.has(a.account_id));
  const ids = new Set(live.map((a) => a.account_id));
  if (f.problems.some((p) => p.accounts === null || p.accounts.some((id) => ids.has(id)))) return false;
  if (f.missing.some((id) => ids.has(id))) return false;
  return live.every((a) => a.reported_balance !== null && !balanceTooOld(a, now));
}

const NONE: ReadonlySet<string> = new Set();

/** What is wrong with one card's accounts, its words, and whose side a
 *  failed request said it was on. */
function issueOf(
  conn: ConnectorConnection | undefined,
  all: ConnectorAccount[],
  now: number,
  ended: ReadonlySet<string>
): { issue: ConnectorIssue; messages: string[]; accounts: string[]; side?: Side } {
  if (!conn) return { issue: 'gone', messages: [], accounts: [] };
  // An account that ended holds nothing (see the header): a bank where every
  // one has, nothing at all.
  const group = all.filter((a) => !ended.has(a.account_id));
  if (group.length === 0 && all.length > 0) return { issue: 'ok', messages: [], accounts: [] };
  const ids = new Set(group.map((a) => a.account_id));
  const fetch = conn.last_fetch;
  if (fetch?.failure) return { issue: fetch.failure.kind, messages: [fetch.failure.message], accounts: [], side: fetch.failure.side };
  const reported = (fetch?.problems ?? []).filter((p) => p.accounts === null || p.accounts.some((id) => ids.has(id)));
  if (reported.length > 0) {
    return { issue: 'reported', messages: reported.map((p) => p.message), accounts: [], side: reported[0].side };
  }
  const missing = group.filter((a) => fetch?.missing.includes(a.account_id));
  if (missing.length > 0) return { issue: 'missing', messages: [], accounts: missing.map((a) => a.name) };
  // No answer yet, or none asked for since it was connected again.
  if (!fetch || group.some((a) => a.reported_balance === null)) return { issue: 'waiting', messages: [], accounts: [] };
  const unsure = group.filter(needsSign);
  if (unsure.length > 0) {
    return { issue: 'sign', messages: unsure.map((a) => `${a.name} (+${formatMoney(a.reported_balance!, a.currency)})`), accounts: unsure.map((a) => a.name) };
  }
  const old = group.filter((a) => balanceTooOld(a, now)).sort((x, y) => (x.balance_at! < y.balance_at! ? -1 : 1));
  if (old.length > 0) return { issue: 'old_balance', messages: [old[0].balance_at!], accounts: old.map((a) => a.name) };
  const last = conn.last_answer_at ? Date.parse(conn.last_answer_at) : NaN;
  if (!Number.isFinite(last) || now - last > FRESH_HOURS * HOUR) return { issue: 'stale', messages: [], accounts: [] };
  return { issue: 'ok', messages: [], accounts: [] };
}

/** The line on the card for each issue (the health view says more). */
function errorLine(issue: ConnectorIssue, label: string, messages: string[]): string | null {
  switch (issue) {
    case 'ok':
      return null;
    case 'reported':
      return `${label} reports: ${messages[0]}`;
    case 'missing':
      return `Not every account was in ${label}'s latest answer`;
    case 'waiting':
      return `Waiting for ${label}'s answer`;
    case 'sign':
      return `${label} reports a card or loan as money held: say which way it goes`;
    case 'old_balance':
      return `${label}'s latest balance is from ${shortDay(messages[0])}`;
    case 'stale':
      return `No answer from ${label} in over a day`;
    case 'gone':
      return `Its ${label} connection is gone`;
    case 'refused':
    case 'credentials':
      return `${label} needs connecting again`;
    case 'payment':
      return `${label} says your subscription needs paying`;
    case 'unreadable':
      return `What Nya keeps about this ${label} connection couldn't be read`;
    default:
      return `Couldn't refresh from ${label}`;
  }
}

/** The id of the card an account is on: "connector:<connection>:<ref>". */
export const connectorCardId = (a: Pick<ConnectorAccount, 'connection_id' | 'institution_ref'>): string => `connector:${a.connection_id}:${a.institution_ref}`;

/**
 * The cards, from what is stored. Pure. Each connection's accounts are
 * grouped by bank, in name order; the card's id is connectorCardId's.
 * `ended`: the accounts whose end has come, which hold nothing (see the header).
 */
export function buildConnectorInstitutions(
  connections: ReadonlyMap<string, ConnectorConnection>,
  accounts: Iterable<ConnectorAccount>,
  now: number,
  ended: ReadonlySet<string> = new Set()
): InstitutionResult[] {
  const groups = new Map<string, ConnectorAccount[]>();
  for (const a of accounts) {
    const key = `${a.connection_id}\n${a.institution_ref}`;
    const list = groups.get(key);
    if (list) list.push(a);
    else groups.set(key, [a]);
  }
  const out: InstitutionResult[] = [];
  for (const group of groups.values()) {
    group.sort((x, y) => x.name.localeCompare(y.name) || (x.account_id < y.account_id ? -1 : 1));
    const first = group[0];
    const conn = connections.get(first.connection_id);
    const kind: ConnectorKind = conn?.connector ?? first.connector;
    const label = connectorOf(kind).label;
    const found = issueOf(conn, group, now, ended);
    const error = errorLine(found.issue, label, found.messages);
    // One that ended, only while the latest answer measured it (see the header).
    const kept = group.filter((a) => !ended.has(a.account_id) || issueOf(conn, [a], now, NONE).issue === 'ok');
    const shown = kept.map((a) => {
      const balance = nyaBalance(a);
      const at = asOfOf(a);
      return {
        account_id: a.account_id,
        name: a.name,
        official_name: null,
        mask: null,
        type: a.type,
        subtype: a.subtype,
        balance,
        // Only where it means money there to spend: a card's "available" is
        // credit, which SimpleFIN doesn't say from which side.
        available: a.type === 'depository' ? a.reported_available : null,
        limit: null,
        currency: a.currency,
        ...(at ? { updated_at: at } : {}),
        // Display only: held out of every history layer (see the header).
        ...(error && balance !== null ? { stale: true } : {}),
      };
    });
    // The oldest of the balances shown, for "balances as of".
    const asOf = error
      ? kept
          .filter((a) => a.reported_balance !== null && asOfOf(a))
          .map((a) => asOfOf(a)!)
          .sort()[0]
      : undefined;
    // When the bank last synced cleanly: the oldest of its accounts' (an
    // answer that reported a problem with it doesn't count), but those that
    // ended, which no longer need to.
    const synced = group.filter((a) => !ended.has(a.account_id)).map((a) => a.ok_at ?? null);
    const lastOk = synced.length > 0 && synced.every((t) => t !== null) ? (synced as string[]).sort()[0] : null;
    const detail: ConnectorDetail = {
      connector: kind,
      label,
      host: conn?.host ?? null,
      connection_id: first.connection_id,
      issue: found.issue,
      messages: found.messages,
      accounts: found.accounts,
    };
    out.push({
      institution_name: first.institution_name,
      item_id: connectorCardId(first),
      accounts: shown,
      holdings: [],
      error,
      needs_reauth: false,
      // A card's payment terms come from Plaid's liabilities product, which a
      // connector account has none of: never an Enable button.
      liabilities: 'unavailable',
      manual: true,
      connector: kind,
      connection_id: first.connection_id,
      health: connectorHealth(detail, lastOk, found.side),
      ...(asOf ? { stale_as_of: asOf.slice(0, 10), stale_as_of_at: asOf } : {}),
    });
  }
  return out.sort((a, b) => a.institution_name.localeCompare(b.institution_name) || (a.item_id < b.item_id ? -1 : 1));
}

/** The cards, read from the stores: strict, so a connection or an account
 *  that can't be read throws, and the caller holds the gate. `ended` as for
 *  buildConnectorInstitutions. */
export async function connectorInstitutions(ctx: Ctx, now: number = Date.now(), ended: ReadonlySet<string> = new Set()): Promise<InstitutionResult[]> {
  // The accounts first: with none tracked, a connection entry that can't be
  // read holds nothing up.
  const accounts = await connectorAccountsStore.getAll(ctx);
  if (accounts.size === 0) return [];
  const connections = await connectionsStore.getAll(ctx);
  return buildConnectorInstitutions(connections, accounts.values(), now, ended);
}

/** What a read-only display needs of the connector's banks (the API,
 *  lib/api-read.ts, and reports, lib/report/read.ts): each card, the
 *  connection it comes through, and what couldn't be read, named. */
export type ConnectorBanksReport = {
  cards: InstitutionResult[];
  /** The readable account entries, by id: what each card shows them from. */
  accounts: ReadonlyMap<string, ConnectorAccount>;
  /** The readable connection entries, by id: their history, host and label. */
  connections: ReadonlyMap<string, ConnectorConnection>;
  /** Each card's connection entry that couldn't be read, by connection id:
   *  how its banks are doing isn't known (their cards say `unreadable`). */
  unreadableConnections: ReadonlySet<string>;
  /** Account entries that couldn't be read, by id and why: never listed as
   *  accounts, and never taken for none. */
  unreadable: { account_id: string; reason: 'unreadable' | 'unrecognised' }[];
  /** When each card's latest request was made, by card id (`item_id`): when
   *  what is wrong was last found, or null before any. */
  askedAt: ReadonlyMap<string, string | null>;
};

/**
 * The cards, read for a display that names what it can't read rather than
 * stopping: the read-only API and reports. LENIENT, for those displays only,
 * which nothing writes, deletes or records on: an account entry that can't be
 * read is named (`unreadable`) and left out; a connection entry that can't be
 * read leaves its banks' cards saying so (issue 'unreadable'), never gone.
 * Recording a snapshot reads both stores strictly (connectorInstitutions).
 * Storage out of reach still throws.
 */
export async function connectorBanksReport(
  ctx: Ctx,
  now: number = Date.now(),
  /** As for buildConnectorInstitutions, or a read of them still under way. */
  endedRead: ReadonlySet<string> | Promise<ReadonlySet<string>> = new Set()
): Promise<ConnectorBanksReport> {
  const accounts = await connectorAccountsStore.getAllReport(ctx);
  const unreadable = [
    ...accounts.unreadable.map((account_id) => ({ account_id, reason: 'unreadable' as const })),
    ...accounts.unrecognised.map((account_id) => ({ account_id, reason: 'unrecognised' as const })),
  ];
  if (accounts.entries.size === 0) return { cards: [], accounts: accounts.entries, connections: new Map(), unreadableConnections: new Set(), unreadable, askedAt: new Map() };
  const [connections, ended] = await Promise.all([connectionsStore.getAllReport(ctx), endedRead]);
  const damaged = new Set([...connections.unreadable, ...connections.unrecognised]);
  const cards = buildConnectorInstitutions(connections.entries, accounts.entries.values(), now, ended).map((card) => {
    const id = card.connection_id ?? null;
    if (!id || !damaged.has(id) || !card.health?.detail) return card;
    const detail: ConnectorDetail = { ...card.health.detail, issue: 'unreadable', messages: [], accounts: [] };
    return { ...card, error: errorLine('unreadable', detail.label, []), health: connectorHealth(detail, card.health.last_ok_at) };
  });
  const askedAt = new Map(
    cards.map((card) => {
      const conn = card.connection_id ? connections.entries.get(card.connection_id) : undefined;
      return [card.item_id, conn?.last_fetch?.at ?? null] as const;
    })
  );
  return { cards, accounts: accounts.entries, connections: connections.entries, unreadableConnections: damaged, unreadable, askedAt };
}

/** The card for connector accounts that couldn't be read: no accounts, an
 *  error, so the snapshot gate stays shut rather than a total going short.
 *  Which connector they came through can't be read either, so its words name
 *  every one (its `connector` is only the shape's placeholder). */
export function unreadableConnectorInstitution(): InstitutionResult {
  const label = ANY_CONNECTOR;
  return {
    institution_name: `${label} accounts`,
    item_id: 'connector:unreadable',
    accounts: [],
    holdings: [],
    error: `Could not load the accounts ${label} keeps up to date`,
    needs_reauth: false,
    liabilities: 'unavailable',
    manual: true,
    connector: 'simplefin',
    health: connectorHealth({ connector: 'simplefin', label, host: null, connection_id: null, issue: 'unreadable', messages: [], accounts: [] }, null),
  };
}
