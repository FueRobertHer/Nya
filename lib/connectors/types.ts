// lib/connectors/types.ts
//
// The connector interface: what a service the person brings themselves (their
// own SimpleFIN account first; a Lunch Flow key later) supplies, so the rest
// of Nya never depends on which one it is. A connector is two calls:
//
//   exchange  what the person pastes (SimpleFIN's one-time Setup Token) for
//             the credential Nya keeps (SimpleFIN's Access URL), which is
//             stored as a per-container secret (lib/connectors/store.ts);
//   fetch     with that credential: every account it can see, each with its
//             balance and the day the institution gave it, the transactions
//             posted in a window of days as the import pipeline's records
//             (lib/import/record.ts RawRecord, Plaid's sign, with the
//             connector's own id as source_id), and the problems it reports,
//             in its own words, with whose side each is on and which
//             accounts it concerns when that can be told.
//
// Everything else is shared and knows nothing of the protocol: the daily
// fetch and its request budget (lib/connectors/sync.ts), the stores, how the
// accounts join net worth and the history gate (lib/connectors/institutions.ts),
// connection health, and the screens. A new connector is a module
// implementing ConnectorDef, registered in lib/connectors/registry.ts.
//
// Pure types and two error classes, safe to import from client code.

import type { RawRecord } from '../import/record';
import type { Side } from '../connection-state';

/** The connectors Nya knows. Stored with each connection. */
export const CONNECTOR_KINDS = ['simplefin'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export const isConnectorKind = (v: unknown): v is ConnectorKind => typeof v === 'string' && (CONNECTOR_KINDS as readonly string[]).includes(v);

/** One account as a connector reports it. */
export type RemoteAccount = {
  /** The connector's own id for it: stable, opaque, unique in the connection. */
  remote_id: string;
  name: string;
  /** The institution that holds it, as the connector names it. `key` groups
   *  its accounts (the institution's own id, else its domain, else its name);
   *  `site` is its web address when the connector gives one. */
  institution: { name: string; key: string; domain: string | null };
  /** Its currency's ISO 4217 code, or null when it is one Nya doesn't know
   *  (SimpleFIN allows a URL describing a currency of its own, like points).
   *  An account without one can't be tracked. */
  currency: string | null;
  /** The currency as the connector wrote it, to say what an unknown one was. */
  currency_text: string;
  /** The balance from the account holder's side, as the connector reports
   *  it: positive is money held, negative is money owed. Nya's own sign for a
   *  card or a loan (positive is owed, lib/balance.ts) is applied once the
   *  person says what kind of account it is. */
  balance: number;
  /** The available balance, from the same side, when the connector gives one. */
  available: number | null;
  /** When the institution says the balance was, as an ISO time, or null when
   *  the connector didn't say. */
  balance_at: string | null;
  /** The transactions posted in the window asked for, as the pipeline's
   *  records: `source` the connector's kind, `source_id` its id, Plaid's
   *  sign. Pending ones are never here (see left_out). */
  transactions: RawRecord[];
  /** What the answer held for it that isn't in `transactions`, counted:
   *  pending transactions (left out by design) and ones that couldn't be read. */
  left_out: { pending: number; unreadable: number };
};

/** A problem the connector reported. */
export type RemoteProblem = {
  /** Its own words, as it sent them (cleaned of control characters, capped). */
  message: string;
  side: Side;
  /** The remote ids of the accounts it concerns, when that can be told; null
   *  when it could concern any of them. */
  accounts: string[] | null;
};

/** One answer: the accounts, and the problems reported beside them. */
export type RemoteAnswer = {
  accounts: RemoteAccount[];
  problems: RemoteProblem[];
  /** Accounts listed in a shape Nya can't read (no id, no balance): counted,
   *  never guessed at. A tracked one among them reads as missing. */
  unreadable_accounts: number;
};

/** Why a request brought nothing usable, in kinds every connector maps its
 *  own failures to (lib/connectors/health.ts words them). */
export type FailureKind =
  /** The connector no longer accepts Nya's access (withdrawn, reset, never
   *  valid): connect again with a new token. */
  | 'refused'
  /** The connector wants the person's subscription paid. */
  | 'payment'
  /** The connector says Nya asked too often. */
  | 'limited'
  /** The connector refused the request itself: Nya sent something it doesn't take. */
  | 'rejected'
  /** No answer: a timeout, the network, or the connector's own error. */
  | 'down'
  /** An answer Nya can't read: not the protocol's shape, or too large. */
  | 'answer'
  /** The connector's address isn't one Nya connects to (lib/connectors/net-guard.ts),
   *  or it redirected somewhere Nya won't follow. */
  | 'blocked'
  /** Nya can't read the credential it keeps. */
  | 'credentials';

export const FAILURE_KINDS: readonly FailureKind[] = ['refused', 'payment', 'limited', 'rejected', 'down', 'answer', 'blocked', 'credentials'];

/** A fetch that brought nothing usable. The message is the person's to read
 *  and safe to log: it never holds the credential, a URL or a path. */
export class ConnectorFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly side: Side,
    message: string,
    /** The HTTP status, when an answer came. */
    readonly status: number | null = null
  ) {
    super(message);
    this.name = 'ConnectorFailure';
  }
}

/** Why an exchange of what the person pasted didn't give Nya its access. */
export type ExchangeFailureKind =
  /** It isn't a token at all. */
  | 'invalid'
  /** The connector refused it: already used (a token works once), or never valid. */
  | 'claimed'
  /** Its address isn't one Nya connects to. */
  | 'blocked'
  /** No answer came. The token may have been used up all the same. */
  | 'down'
  /** The answer wasn't a credential Nya can use. */
  | 'answer';

export class ExchangeFailure extends Error {
  constructor(
    readonly kind: ExchangeFailureKind,
    message: string
  ) {
    super(message);
    this.name = 'ExchangeFailure';
  }
}

/** What one fetch asks for: transactions posted from `start` (a UTC day) up
 *  to, not including, `end` (a UTC day; none for "until now"), or only the
 *  balances. */
export type FetchRequest = { start: string; end: string | null; balancesOnly?: false } | { balancesOnly: true };

export type ConnectorDef = {
  kind: ConnectorKind;
  /** What the person calls it: "SimpleFIN". */
  label: string;
  /** The longest window of days one request may ask for. */
  windowDays: number;
  /** How many days consecutive windows overlap, so a transaction that posts
   *  late into the day a window ends on is still caught. */
  overlapDays: number;
  /** How many requests a day the connector allows per credential. */
  providerDailyLimit: number;
  /** Exchanges what the person pasted for the credential to keep, and the
   *  host it reaches. Throws ExchangeFailure. */
  exchange(input: string, opts: { timeoutMs: number }): Promise<{ secret: string; host: string }>;
  /** The host a stored credential reaches, or null if it can't be read as one. */
  hostOf(secret: string): string | null;
  /** Fetches with a stored credential. Throws ConnectorFailure. */
  fetch(secret: string, request: FetchRequest, opts: { timeoutMs: number }): Promise<RemoteAnswer>;
};

/** What is wrong with a connector's accounts, if anything (lib/connectors/health.ts
 *  words each): a failed request's kind, or one of these. */
export type ConnectorIssue =
  | 'ok'
  /** No answer has held its balance yet. */
  | 'waiting'
  /** The connector reported a problem that concerns it, in its own words. */
  | 'reported'
  /** A tracked account wasn't in the latest answer. */
  | 'missing'
  /** No answer for longer than Nya's daily update allows. */
  | 'stale'
  /** What Nya keeps about these accounts couldn't be read. */
  | 'unreadable'
  /** Its connection is gone (a disconnect that stopped part way). */
  | 'gone'
  | FailureKind;

/** A connector's part of a connection's health (lib/connection-state.ts
 *  ConnectionHealth.detail): who it is, and what is wrong in its words. */
export type ConnectorDetail = {
  connector: ConnectorKind;
  /** What the person calls it: "SimpleFIN". */
  label: string;
  /** The host it reaches, for "fix it there". */
  host: string | null;
  connection_id: string | null;
  issue: ConnectorIssue;
  /** The connector's own words (its error list, or why a request failed). */
  messages: string[];
  /** The accounts a problem or an absence concerns, by name. */
  accounts: string[];
};
