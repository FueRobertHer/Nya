// lib/connectors/view.ts
//
// What the connector screens (components/Connectors.tsx) are sent about each
// connection: never the credential, never a balance of an account the person
// didn't choose to track except in the answer to connecting, which lists
// what SimpleFIN offers with its balances to choose from, from memory, once.

import type { ConnectorAccount, ConnectorConnection, OwedSign } from './store';
import type { ConnectorKind, FailureKind, RemoteAnswer } from './types';
import { connectorOf } from './registry';
import { needsSign, nyaBalance, trackedElsewhere } from './institutions';
import { connectorSite } from './health';

export type AccountView = {
  account_id: string;
  name: string;
  institution_name: string;
  type: string;
  currency: string;
  /** In Nya's sign; null before an answer held one, and while a card's or a
   *  loan's positive balance waits for the person to say how to read it. */
  balance: number | null;
  /** As SimpleFIN reported it: positive held, negative owed by its rule. */
  reported: number | null;
  /** How the person said to read a card's or a loan's sign, if they did. */
  sign: OwedSign | null;
  /** A card or a loan reported as money held, not yet read either way. */
  needs_sign: boolean;
  balance_at: string | null;
  /** Carried on from an account a restore brought back (lib/connectors/
   *  continue.ts): what it was, and what the first answers found (of the
   *  provider's rows dated up to `until`, how many took over one from the
   *  download, and how many were added). Absent for every other account. */
  continued?: { from: { connector: ConnectorKind; name: string; institution_name: string }; until: string | null; matched: number; added: number };
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
  /** Another connection that tracks this account (`certain`: the same id on
   *  the same host, so it can't be tracked here too) or likely does (on
   *  another host, the same bank, name and balance: said, and left to the
   *  person), by the host it reaches (or the connector's name, when that
   *  connection is gone). Null when none does. */
  elsewhere: { host: string; certain: boolean } | null;
};

export type FetchView = {
  at: string;
  ok: boolean;
  /** What kind of failure, when it failed (lib/connectors/types.ts). */
  kind: FailureKind | null;
  /** Why it failed, in words for the person (the connector's own included). */
  message: string | null;
  /** What the connector reported, in its own words, with the tracked
   *  accounts each concerns by name (null: any of them), and whether asking
   *  again should clear it (ProblemKind `retry`), never the connector's word
   *  about a bank, to fix there. */
  problems: { message: string; accounts: string[] | null; retry: boolean }[];
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

export function accountView(a: ConnectorAccount, evidence?: { until: string | null; matched: number; added: number } | null): AccountView {
  const c = a.continued;
  return {
    ...(c ? { continued: { from: { connector: c.from.connector, name: c.from.name, institution_name: c.from.institution_name }, until: c.until, matched: evidence?.matched ?? 0, added: evidence?.added ?? 0 } } : {}),
    account_id: a.account_id,
    name: a.name,
    institution_name: a.institution_name,
    type: a.type,
    currency: a.currency,
    balance: nyaBalance(a),
    reported: a.reported_balance,
    sign: a.sign ?? null,
    needs_sign: needsSign(a),
    balance_at: a.balance_at ?? a.fetched_at,
  };
}

/** The accounts other connections track, with their hosts, for marking an
 *  offer as tracked elsewhere (lib/connectors/institutions.ts trackedElsewhere). */
export type Others = readonly { account: ConnectorAccount; host: string | null }[];

/** Where an offer is tracked already, for OfferView.elsewhere: the other
 *  connection's host, with its connector's name when it is another one. */
function elsewhereOf(offer: { remote_id: string; name: string; institution: string; balance?: number }, conn: ConnectorConnection, others: Others): OfferView['elsewhere'] {
  const there = trackedElsewhere(offer, { connector: conn.connector, host: conn.host }, others);
  if (!there) return null;
  const by = there.account.connector === conn.connector ? null : connectorOf(there.account.connector).label;
  const host = by ? (there.host ? `${by}, ${there.host}` : by) : (there.host ?? connectorOf(conn.connector).label);
  return { host, certain: there.certain };
}

/** One connection as the screens show it. `others`: the accounts other
 *  connections track, so an offer one of them tracks says so. */
export function connectionView(
  connection_id: string,
  conn: ConnectorConnection,
  accounts: ConnectorAccount[],
  others: Others = [],
  evidence: ReadonlyMap<string, { until: string | null; matched: number; added: number }> = new Map()
): ConnectionView {
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
          kind: f.failure?.kind ?? null,
          message: f.failure?.message ?? null,
          problems: f.problems
            .filter((p) => p.accounts === null || p.accounts.length > 0)
            .map((p) => ({ message: p.message, accounts: p.accounts === null ? null : p.accounts.map((id) => nameOf.get(id) ?? 'An account'), retry: p.kind === 'retry' })),
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
      .map((a) => accountView(a, evidence.get(a.account_id))),
    available: conn.available.map((a) => ({
      remote_id: a.remote_id,
      name: a.name,
      institution: a.institution,
      currency: a.currency,
      currency_text: a.currency_text,
      elsewhere: elsewhereOf(a, conn, others),
    })),
  };
}

/** The accounts an answer offers that aren't tracked, with their balances as
 *  SimpleFIN reported them, for choosing right after connecting. */
export function offersIn(answer: RemoteAnswer, tracked: ReadonlySet<string>, conn: ConnectorConnection | null = null, others: Others = []): OfferView[] {
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
      elsewhere: conn ? elsewhereOf({ remote_id: a.remote_id, name: a.name, institution: a.institution.name, balance: a.balance }, conn, others) : null,
    }));
}
