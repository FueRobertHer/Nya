// lib/connectors/types.ts
//
// The connector interface: what a service the person brings themselves (their
// own SimpleFIN account, or their own Lunch Flow API key) supplies, so the
// rest of Nya never depends on which one it is. A connector is two calls:
//
//   exchange  what the person pastes (SimpleFIN's one-time Setup Token, or a
//             Lunch Flow API key) for the credential Nya keeps (SimpleFIN's
//             Access URL, or the key itself once Lunch Flow has taken it),
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

/** The connectors Nya knows. Stored with each connection, and as the
 *  `source` of each transaction one brings (lib/connectors/sync.ts). */
export const CONNECTOR_KINDS = ['simplefin', 'lunchflow'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export const isConnectorKind = (v: unknown): v is ConnectorKind => typeof v === 'string' && (CONNECTOR_KINDS as readonly string[]).includes(v);

/** How each connector is named, in the words every screen and message uses,
 *  here so client code needs no connector module:
 *    label        what the person calls it;
 *    credential   what they paste to connect it;
 *    again        what connecting again takes, after "Connect again with";
 *    balance_date whose day a balance's date is: the institution's own
 *                 (SimpleFIN's balance-date), or the day Nya received it,
 *                 for a connector that gives no time with its balances
 *                 (Lunch Flow: lib/connectors/lunchflow.ts). */
export const CONNECTOR_WORDS: Readonly<Record<ConnectorKind, { label: string; credential: string; again: string; balance_date: 'institution' | 'received' }>> = {
  simplefin: { label: 'SimpleFIN', credential: 'Setup Token', again: 'a new Setup Token', balance_date: 'institution' },
  lunchflow: { label: 'Lunch Flow', credential: 'API key', again: 'an API key from Lunch Flow', balance_date: 'received' },
};

/** What the person calls a connector: "SimpleFIN", "Lunch Flow" (a kind this
 *  release doesn't know, as it is). */
export const connectorLabel = (kind: string): string => (isConnectorKind(kind) ? CONNECTOR_WORDS[kind].label : kind);

/** Every connector's name, for words about them all ("SimpleFIN or Lunch Flow"). */
export const ANY_CONNECTOR = CONNECTOR_KINDS.map(connectorLabel).join(' or ');

/** The line under a connector account's balance on the Accounts tab, `day`
 *  written for the person: the institution's own day (SimpleFIN's
 *  balance-date), or, for a connector that gives none, the day Nya received
 *  it, said as such, never as the bank's. */
export function connectorBalanceDay(kind: string, day: string): string {
  const words = isConnectorKind(kind) ? CONNECTOR_WORDS[kind] : null;
  return words?.balance_date === 'received' ? `Balance as ${words.label} gave it on ${day}` : `Balance as of ${day}`;
}

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
  /** The balance as the connector reports it: by the protocol's rule, from
   *  the account holder's side, positive money held and negative money owed.
   *  Nya's own sign for a card or a loan (positive is owed, lib/balance.ts)
   *  is applied once the person says what kind of account it is, and for one
   *  reported positive, how to read it (lib/connectors/institutions.ts SIGNS):
   *  the protocol doesn't pin a debt's sign, and some servers report it
   *  positive. */
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

/** What kind of problem one is, when it isn't the connector's own word about
 *  a bank (which is fixed at the connector, and has no kind): `retry`, a
 *  request about these accounts that brought nothing usable this time (no
 *  answer, the connector's own error, an answer Nya couldn't read, or Nya's
 *  own time for the fetch running out), which asking again should clear. It
 *  holds the accounts' bank all the same, and is worded as a wait
 *  (lib/connectors/institutions.ts, health.ts), never as something to fix. */
export type ProblemKind = 'retry';

/** A problem the connector reported. */
export type RemoteProblem = {
  /** Its own words, as it sent them (cleaned of control characters, capped). */
  message: string;
  side: Side;
  /** The remote ids of the accounts it concerns, when that can be told; null
   *  when it could concern any of them. */
  accounts: string[] | null;
  /** Absent for the connector's word about a bank. */
  kind?: ProblemKind;
};

/** An account a connector listed but wasn't asked about, since Nya already
 *  offers it with what it needs (FetchRequest `offered`): its names, to keep
 *  the offer up to date with. */
export type ListedAccount = { remote_id: string; name: string; institution: RemoteAccount['institution'] };

/** One answer: the accounts, and the problems reported beside them. */
export type RemoteAnswer = {
  accounts: RemoteAccount[];
  problems: RemoteProblem[];
  /** Accounts listed in a shape Nya can't read (no id, no balance): counted,
   *  never guessed at. A tracked one among them reads as missing. */
  unreadable_accounts: number;
  /** Accounts not tracked that the connector listed without being asked
   *  about (a connector that asks account by account, for those in the
   *  request's `offered`): still offered, as they were. */
  listed?: ListedAccount[];
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
  /** It isn't a token (or a key) at all. */
  | 'invalid'
  /** The connector refused it: already used (a SimpleFIN token works once),
   *  or never valid (a key Lunch Flow doesn't accept). */
  | 'claimed'
  /** Its address isn't one Nya connects to. */
  | 'blocked'
  /** No answer came. A SimpleFIN token may have been used up all the same. */
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
 *  balances. One whose single answer holds every account (SimpleFIN) needs
 *  nothing more; for a connector that asks account by account (Lunch Flow):
 *    accounts  the remote ids whose transactions are wanted (the tracked
 *              ones), asked about first; no others' transactions are asked;
 *    offered   remote ids of accounts not tracked that Nya already offers,
 *              with their currency: their balances needn't be asked again,
 *              only their names listed (RemoteAnswer `listed`). Any other
 *              account is still listed with its balance, to be offered;
 *    since     the earliest day of transactions wanted at all (the
 *              history's limit, lib/connectors/sync.ts HISTORY_DAYS): an
 *              answer's rows from before `start` but not before it are kept,
 *              for a connector whose rows can turn up after the days they are
 *              dated (Lunch Flow dates a card's held purchase by its own day,
 *              and sends it once it posts). */
export type FetchRequest =
  | { start: string; end: string | null; balancesOnly?: false; accounts?: readonly string[]; offered?: readonly string[]; since?: string }
  | { balancesOnly: true };

export type ConnectorDef = {
  kind: ConnectorKind;
  /** What the person calls it: "SimpleFIN" (CONNECTOR_WORDS). */
  label: string;
  /** The longest window of days one request may ask for. */
  windowDays: number;
  /** How many days consecutive windows overlap, so a transaction that posts
   *  late into the day a window ends on is still caught. */
  overlapDays: number;
  /** How many requests a day the connector allows per credential, or null
   *  when it documents no number. */
  providerDailyLimit: number | null;
  /** The longest text the connect route takes for what is pasted, before
   *  checkInput reads it. */
  maxInputChars: number;
  /** Checks what the person pasted before anything is sent or counted:
   *  throws ExchangeFailure('invalid') when it can't be what `exchange` takes. */
  checkInput(input: string): void;
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
  /** A card or a loan the connector reports as money held (a positive
   *  balance), which the person hasn't said how to read: never counted until
   *  they do. */
  | 'sign'
  /** The latest balance the connector has is from days ago: its link to the
   *  bank has stopped updating. */
  | 'old_balance'
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
