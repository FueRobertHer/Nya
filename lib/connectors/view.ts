// lib/connectors/view.ts
//
// What the connector screens (components/Connectors.tsx) are sent about each
// connection: never the credential, never a balance of an account the person
// didn't choose to track except in the answer to connecting, which lists
// what SimpleFIN offers with its balances to choose from, from memory, once.

import type { ConnectorAccount, ConnectorConnection } from './store';
import type { ConnectorKind, RemoteAnswer } from './types';
import { connectorOf } from './registry';
import { nyaBalance } from './institutions';
import { connectorSite } from './health';

export type AccountView = {
  account_id: string;
  name: string;
  institution_name: string;
  type: string;
  currency: string;
  /** In Nya's sign; null before an answer held one. */
  balance: number | null;
  balance_at: string | null;
};

/** An account SimpleFIN offers that isn't tracked. Its balance only in the
 *  answer to connecting, from SimpleFIN's answer, never stored. */
export type OfferView = {
  remote_id: string;
  name: string;
  institution: string;
  currency: string | null;
  currency_text: string;
  /** As SimpleFIN reports it: positive held, negative owed. */
  balance?: number;
  balance_at?: string | null;
};

export type FetchView = {
  at: string;
  ok: boolean;
  /** Why it failed, in words for the person (the connector's own included). */
  message: string | null;
  /** What the connector reported, in its own words, with the tracked
   *  accounts each concerns by name (null: any of them). */
  problems: { message: string; accounts: string[] | null }[];
  /** Tracked accounts the answer didn't hold, by name. */
  missing: string[];
  added: number;
  updated: number;
  pending: number;
  unreadable: number;
  note: string | null;
};

export type ConnectionView = {
  connection_id: string;
  connector: ConnectorKind;
  label: string;
  host: string;
  /** The connector's own site, to fix what it reports there. */
  site: string | null;
  created_at: string;
  last_fetch: FetchView | null;
  last_answer_at: string | null;
  history: ConnectorConnection['history'];
  accounts: AccountView[];
  available: OfferView[];
};

export function accountView(a: ConnectorAccount): AccountView {
  return {
    account_id: a.account_id,
    name: a.name,
    institution_name: a.institution_name,
    type: a.type,
    currency: a.currency,
    balance: nyaBalance(a),
    balance_at: a.balance_at ?? a.fetched_at,
  };
}

/** One connection as the screens show it. */
export function connectionView(connection_id: string, conn: ConnectorConnection, accounts: ConnectorAccount[]): ConnectionView {
  const label = connectorOf(conn.connector).label;
  const nameOf = new Map(accounts.map((a) => [a.account_id, a.name]));
  const f = conn.last_fetch;
  return {
    connection_id,
    connector: conn.connector,
    label,
    host: conn.host,
    site: connectorSite({ connector: conn.connector, label, host: conn.host, connection_id, issue: 'ok', messages: [], accounts: [] }),
    created_at: conn.created_at,
    last_fetch: f
      ? {
          at: f.at,
          ok: f.failure === null,
          message: f.failure?.message ?? null,
          problems: f.problems
            .filter((p) => p.accounts === null || p.accounts.length > 0)
            .map((p) => ({ message: p.message, accounts: p.accounts === null ? null : p.accounts.map((id) => nameOf.get(id) ?? 'An account') })),
          missing: f.missing.flatMap((id) => (nameOf.has(id) ? [nameOf.get(id)!] : [])),
          added: f.added,
          updated: f.updated,
          pending: f.pending,
          unreadable: f.unreadable,
          note: f.note ?? null,
        }
      : null,
    last_answer_at: conn.last_answer_at,
    history: conn.history,
    accounts: accounts
      .filter((a) => a.connection_id === connection_id)
      .sort((x, y) => x.institution_name.localeCompare(y.institution_name) || x.name.localeCompare(y.name))
      .map(accountView),
    available: conn.available.map((a) => ({ remote_id: a.remote_id, name: a.name, institution: a.institution, currency: a.currency, currency_text: a.currency_text })),
  };
}

/** The accounts an answer offers that aren't tracked, with their balances as
 *  SimpleFIN reported them, for choosing right after connecting. */
export function offersIn(answer: RemoteAnswer, tracked: ReadonlySet<string>): OfferView[] {
  return answer.accounts
    .filter((a) => !tracked.has(a.remote_id))
    .map((a) => ({
      remote_id: a.remote_id,
      name: a.name,
      institution: a.institution.name,
      currency: a.currency,
      currency_text: a.currency_text,
      balance: a.balance,
      balance_at: a.balance_at,
    }));
}
