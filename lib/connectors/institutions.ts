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
// BALANCES ARE MEASUREMENTS, ONLY WHEN WHOLE. A balance is the one the
// institution gave through SimpleFIN, with the day it gave it, measured as a
// Plaid balance is: on a clean answer it is recorded in the real history layer
// like any other (lib/networth.ts recordFetch). A card is held out of that
// (`error` set, which closes the snapshot gate, and its balances marked
// `stale`, which keeps them out of the per-account layers too) whenever its
// accounts' latest word is not a whole answer:
//   - the latest request failed (nothing came);
//   - SimpleFIN reported a problem that concerns this bank, or names no bank
//     at all (it could be any);
//   - one of its tracked accounts was missing from the answer;
//   - no answer has held a balance for it yet;
//   - no answer has come for FRESH_HOURS (the daily update didn't run).
// Its last balances are still shown, with their date, as last known; never
// written as measured, and never recovered from the history layer.
//
// A balance is kept as SimpleFIN reported it (positive held, negative owed)
// and turned into Nya's sign here, by the type the person gave the account:
// a card's or a loan's is the amount owed, positive. Its contribution to net
// worth is the reported balance whichever type is chosen, so a type picked
// wrongly misnames the account, never misstates the total.

import { createHash } from 'node:crypto';
import type { Ctx } from '../containers';
import type { InstitutionResult } from '../networth';
import { isOwedType } from '../balance';
import { connectionsStore, connectorAccountsStore, type ConnectorAccount, type ConnectorConnection } from './store';
import { connectorHealth } from './health';
import { connectorOf } from './registry';
import type { ConnectorDetail, ConnectorIssue, ConnectorKind } from './types';
import type { Side } from '../connection-state';

/** How long the last answer counts as current: a day and a half, so a
 *  daily update a few hours late still counts. */
export const FRESH_HOURS = 36;

const HOUR = 3_600_000;

/** The id of a bank's card within a connection: a hash of the connection's
 *  random id and the connector's key for the bank, so it is the same on every
 *  load and never content on its own. */
export function institutionRef(connection_id: string, institution_key: string): string {
  return createHash('sha256').update(`${connection_id}\n${institution_key}`).digest('hex').slice(0, 16);
}

/** A tracked account's balance in Nya's sign, or null before an answer held one. */
export function nyaBalance(a: Pick<ConnectorAccount, 'type' | 'reported_balance'>): number | null {
  if (a.reported_balance === null) return null;
  const b = isOwedType(a.type) ? -a.reported_balance : a.reported_balance;
  return b === 0 ? 0 : b;
}

/** The time a balance is from: the institution's, else when Nya received it. */
const asOfOf = (a: ConnectorAccount) => a.balance_at ?? a.fetched_at;

/** What is wrong with one card's accounts, its words, and whose side a
 *  failed request said it was on. */
function issueOf(
  conn: ConnectorConnection | undefined,
  group: ConnectorAccount[],
  now: number
): { issue: ConnectorIssue; messages: string[]; accounts: string[]; side?: Side } {
  if (!conn) return { issue: 'gone', messages: [], accounts: [] };
  const ids = new Set(group.map((a) => a.account_id));
  const fetch = conn.last_fetch;
  if (fetch?.failure) return { issue: fetch.failure.kind, messages: [fetch.failure.message], accounts: [], side: fetch.failure.side };
  const reported = (fetch?.problems ?? []).filter((p) => p.accounts === null || p.accounts.some((id) => ids.has(id)));
  if (reported.length > 0) {
    return { issue: 'reported', messages: reported.map((p) => p.message), accounts: [], side: reported[0].side };
  }
  const missing = group.filter((a) => fetch?.missing.includes(a.account_id));
  if (missing.length > 0) return { issue: 'missing', messages: [], accounts: missing.map((a) => a.name) };
  if (group.some((a) => a.reported_balance === null)) return { issue: 'waiting', messages: [], accounts: [] };
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
      return `Waiting for ${label}'s first answer`;
    case 'stale':
      return `No answer from ${label} in over a day`;
    case 'gone':
      return `Its ${label} connection is gone`;
    case 'refused':
    case 'credentials':
      return `${label} needs connecting again`;
    case 'payment':
      return `${label} says your subscription needs paying`;
    default:
      return `Couldn't refresh from ${label}`;
  }
}

/**
 * The cards, from what is stored. Pure. Each connection's accounts are
 * grouped by bank, in name order; the card's id is "connector:<connection>:<ref>".
 */
export function buildConnectorInstitutions(connections: ReadonlyMap<string, ConnectorConnection>, accounts: Iterable<ConnectorAccount>, now: number): InstitutionResult[] {
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
    const found = issueOf(conn, group, now);
    const error = errorLine(found.issue, label, found.messages);
    const shown = group.map((a) => {
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
      ? group
          .filter((a) => a.reported_balance !== null && asOfOf(a))
          .map((a) => asOfOf(a)!)
          .sort()[0]
      : undefined;
    const fetched = group.map((a) => a.fetched_at);
    const lastOk = fetched.every((t) => t !== null) ? (fetched as string[]).sort()[0] : null;
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
      item_id: `connector:${first.connection_id}:${first.institution_ref}`,
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
 *  that can't be read throws, and the caller holds the gate. */
export async function connectorInstitutions(ctx: Ctx, now: number = Date.now()): Promise<InstitutionResult[]> {
  const [connections, accounts] = await Promise.all([connectionsStore.getAll(ctx), connectorAccountsStore.getAll(ctx)]);
  if (accounts.size === 0) return [];
  return buildConnectorInstitutions(connections, accounts.values(), now);
}

/** The card for connector accounts that couldn't be read: no accounts, an
 *  error, so the snapshot gate stays shut rather than a total going short. */
export function unreadableConnectorInstitution(): InstitutionResult {
  const label = connectorOf('simplefin').label;
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
