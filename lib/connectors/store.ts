// lib/connectors/store.ts
//
// What Nya keeps for the connectors a person brings (lib/connectors/types.ts),
// in five stores on the storage seam (lib/repo.ts), all inside the person's
// container, so deleting the account deletes them:
//
//   connector-secrets      one entry per connection: the credential the
//                          connector gave (SimpleFIN's Access URL, which
//                          carries the user name and password to read the
//                          accounts). Encrypted like every seam value, never
//                          in the person's data download (a credential, not
//                          data), never in a log or an error, removed on a
//                          disconnect, and never in a backup (`backup: false`,
//                          lib/export.ts): an Access URL works on its own, so
//                          a backup must neither carry it nor bring back one
//                          the person disconnected. After a restore each
//                          connection asks to be connected again, and its
//                          accounts, history and transactions carry on.
//   connector-connections  one entry per connection: which connector, the
//                          host it reaches, what its latest request came to
//                          (the connector's own error text among it), when an
//                          answer last came, the accounts it offers that are
//                          not tracked (names only, never balances), and how
//                          far back its history has been fetched. In the
//                          download: it is about the person's own accounts.
//   connector-accounts     one entry per tracked account, under the account's
//                          own id (a manual account's kind of id, "manual_"
//                          and a random UUID: see lib/connectors/institutions.ts
//                          for why), with the connection and the connector's
//                          id for it, what the person said it is (checking, a
//                          card...) and, for a card or a loan, how to read the
//                          sign of its balance, its currency, and the balance
//                          as the connector reported it, with the day the
//                          institution gave it. In the download.
//   connector-requests     a count per container: the requests made to
//                          connectors in the current day's window, the budget
//                          that keeps Nya well under what a connector allows
//                          (lib/connectors/sync.ts). Bookkeeping, not data:
//                          not in the download, and not in backups (a window
//                          restored part way would only shut requests).
//   connector-claims       a count per container: how many tokens were
//                          claimed this hour, a bound on the connect route.
//                          Out of the download and backups the same way.
//
// The ids are random (crypto.randomUUID()), never content: a connection's id
// is plaintext in the database, and so is an account's.
//
// The transactions of a tracked account are not here: they are in its book in
// manual-transactions (lib/manual-txns.ts), the shape every account Nya keeps
// itself uses, each row with source 'simplefin' and SimpleFIN's id as its
// source_id.
//
// This module only declares the stores, so lib/stores.ts can load it without
// pulling in anything else.

import { defineCounterStore, defineMapStore } from '../repo';
import { isConnectorKind, FAILURE_KINDS, type ConnectorKind, type FailureKind } from './types';
import { MANUAL_TYPES, type ManualType } from '../manual';
import { isCalendarDay } from '../manual-txn-input';
import type { Side } from '../connection-state';

const SIDES: readonly Side[] = ['none', 'you', 'bank', 'plaid', 'nya', 'unknown', 'connector'];

/** A failed request, as kept. */
export type StoredFailure = { kind: FailureKind; side: Side; message: string; status: number | null };

/** A problem the connector reported, with the tracked accounts (Nya's ids) it
 *  concerns, or null when it could concern any of them. */
export type StoredProblem = { message: string; side: Side; accounts: string[] | null };

/** What the latest request for balances came to. */
export type FetchRecord = {
  /** When Nya asked. */
  at: string;
  /** Null when an answer came; why not otherwise. */
  failure: StoredFailure | null;
  /** What the connector reported beside its answer, in its own words. */
  problems: StoredProblem[];
  /** Tracked accounts (Nya's ids) the answer didn't hold. */
  missing: string[];
  /** Transactions this request added and updated, and what it left out:
   *  pending ones, and ones that couldn't be read. */
  added: number;
  updated: number;
  pending: number;
  unreadable: number;
  /** Something about the answer Nya couldn't keep (a book too large to save),
   *  in words for the person; absent when there was none. */
  note?: string | null;
};

/** An account the connector offers that isn't tracked. */
export type AvailableAccount = {
  remote_id: string;
  name: string;
  institution: string;
  /** The connector's key for its institution (RemoteAccount.institution.key). */
  institution_key: string;
  currency: string | null;
  currency_text: string;
};

export type ConnectorConnection = {
  version: 1;
  connector: ConnectorKind;
  /** The host its credential reaches, without the credential. */
  host: string;
  created_at: string;
  last_fetch: FetchRecord | null;
  /** When an answer last came without a failure, whatever it reported. */
  last_answer_at: string | null;
  /** The tracked accounts: the connector's id for each, and Nya's. Kept here,
   *  in the one entry every change to the connection goes through, so two
   *  requests tracking the same account at once agree on one id for it
   *  (lib/connectors/sync.ts trackAccounts). */
  tracked: { remote_id: string; account_id: string }[];
  available: AvailableAccount[];
  /** How much history has been fetched: transactions posted from `from` to
   *  `to` (UTC days), with no gap; `complete` once the connector had nothing
   *  older in two whole answers in a row, or the backfill reached its limit;
   *  `failed` when the last try at an older window got no whole answer;
   *  `empty` how many whole answers in a row brought nothing older. Null
   *  before the first. */
  history: { from: string; to: string; complete: boolean; failed?: string | null; empty?: number } | null;
};

/** How to read a card's or a loan's balance, as the person said: the
 *  protocol's way, where what is owed is negative (`as_reported`), or the
 *  other way round, as some servers report it (`owed_positive`). Absent until
 *  they say, which matters only while the balance is positive. */
export type OwedSign = 'as_reported' | 'owed_positive';
export const OWED_SIGNS: readonly OwedSign[] = ['as_reported', 'owed_positive'];

export type ConnectorAccount = {
  version: 1;
  account_id: string;
  connection_id: string;
  connector: ConnectorKind;
  /** The connector's own id for the account. */
  remote_id: string;
  name: string;
  institution_name: string;
  /** The connector's key for the institution, which groups its accounts. */
  institution_key: string;
  /** The id the accounts of one institution share in one connection, its
   *  card's id on the Accounts tab: 16 hex characters of a SHA-256 of the
   *  connection's random id and the institution's key
   *  (lib/connectors/institutions.ts institutionRef), never content alone. */
  institution_ref: string;
  /** What the person said it is: the connector says nothing of it. */
  type: ManualType;
  subtype: string | null;
  /** For a card or a loan, how to read its balance's sign, once the person
   *  said (OwedSign); absent or null before. */
  sign?: OwedSign | null;
  currency: string;
  /** The balance as the connector reported it: positive held, negative owed.
   *  Null until an answer held one. */
  reported_balance: number | null;
  reported_available: number | null;
  /** When the institution says that balance was (an ISO time), if it said. */
  balance_at: string | null;
  /** When Nya received it. */
  fetched_at: string | null;
  /** When the bank last synced it cleanly: the time of the balance (else of
   *  the answer) from the latest answer that held the account with no problem
   *  reported about it. Absent or null before one. */
  ok_at?: string | null;
  created_at: string;
};

export type ConnectorSecret = { connector: ConnectorKind; secret: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));
const isTimeOrNull = (v: unknown) => v === null || isTime(v);
const isText = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const isNumberOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));
const isCount = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isSide = (v: unknown): v is Side => (SIDES as readonly unknown[]).includes(v);
const isIdList = (v: unknown) => Array.isArray(v) && v.length <= 1000 && v.every((x) => isText(x, 200));

function isFailure(v: unknown): v is StoredFailure {
  return isRecord(v) && (FAILURE_KINDS as readonly unknown[]).includes(v.kind) && isSide(v.side) && isText(v.message, 1000) && isNumberOrNull(v.status);
}

function isProblem(v: unknown): v is StoredProblem {
  return isRecord(v) && isText(v.message, 1000) && isSide(v.side) && (v.accounts === null || isIdList(v.accounts));
}

export function isFetchRecord(v: unknown): v is FetchRecord {
  return (
    isRecord(v) &&
    isTime(v.at) &&
    (v.failure === null || isFailure(v.failure)) &&
    Array.isArray(v.problems) &&
    v.problems.length <= 50 &&
    v.problems.every(isProblem) &&
    isIdList(v.missing) &&
    isCount(v.added) &&
    isCount(v.updated) &&
    isCount(v.pending) &&
    isCount(v.unreadable) &&
    (v.note === undefined || v.note === null || isText(v.note, 1000))
  );
}

function isAvailable(v: unknown): v is AvailableAccount {
  return (
    isRecord(v) &&
    isText(v.remote_id, 200) &&
    isText(v.name, 200) &&
    isText(v.institution, 200) &&
    isText(v.institution_key, 600) &&
    (v.currency === null || isText(v.currency, 3)) &&
    isText(v.currency_text, 200)
  );
}

function isHistory(v: unknown): boolean {
  return (
    v === null ||
    (isRecord(v) &&
      isCalendarDay(v.from) &&
      isCalendarDay(v.to) &&
      typeof v.complete === 'boolean' &&
      (v.failed === undefined || isTimeOrNull(v.failed)) &&
      (v.empty === undefined || (isCount(v.empty) && (v.empty as number) <= 10)))
  );
}

export function isConnection(v: unknown): v is ConnectorConnection {
  return (
    isRecord(v) &&
    v.version === 1 &&
    isConnectorKind(v.connector) &&
    isText(v.host, 300) &&
    isTime(v.created_at) &&
    (v.last_fetch === null || isFetchRecord(v.last_fetch)) &&
    isTimeOrNull(v.last_answer_at) &&
    Array.isArray(v.tracked) &&
    v.tracked.length <= 1000 &&
    v.tracked.every((t) => isRecord(t) && isText(t.remote_id, 200) && isText(t.account_id, 200)) &&
    Array.isArray(v.available) &&
    v.available.length <= 1000 &&
    v.available.every(isAvailable) &&
    isHistory(v.history)
  );
}

export function isConnectorAccount(v: unknown): v is ConnectorAccount {
  return (
    isRecord(v) &&
    v.version === 1 &&
    isText(v.account_id, 200) &&
    isText(v.connection_id, 200) &&
    isConnectorKind(v.connector) &&
    isText(v.remote_id, 200) &&
    isText(v.name, 200) &&
    isText(v.institution_name, 200) &&
    isText(v.institution_key, 600) &&
    isText(v.institution_ref, 100) &&
    (MANUAL_TYPES as readonly unknown[]).includes(v.type) &&
    (v.subtype === null || isText(v.subtype, 40)) &&
    typeof v.currency === 'string' &&
    /^[A-Z]{3}$/.test(v.currency) &&
    (v.sign === undefined || v.sign === null || (OWED_SIGNS as readonly unknown[]).includes(v.sign)) &&
    isNumberOrNull(v.reported_balance) &&
    isNumberOrNull(v.reported_available) &&
    isTimeOrNull(v.balance_at) &&
    isTimeOrNull(v.fetched_at) &&
    (v.ok_at === undefined || isTimeOrNull(v.ok_at)) &&
    isTime(v.created_at)
  );
}

function isSecret(v: unknown): v is ConnectorSecret {
  return isRecord(v) && isConnectorKind(v.connector) && typeof v.secret === 'string' && v.secret.length > 0 && v.secret.length <= 4096;
}

export const connectionsStore = defineMapStore<ConnectorConnection>('connector-connections', {
  what: 'connections to SimpleFIN',
  isValid: isConnection,
  exportable: true,
});

export const connectorAccountsStore = defineMapStore<ConnectorAccount>('connector-accounts', {
  what: 'accounts from SimpleFIN',
  isValid: isConnectorAccount,
  exportable: true,
});

export const secretsStore = defineMapStore<ConnectorSecret>('connector-secrets', {
  what: 'connector credentials',
  isValid: isSecret,
  exportable: false, // a credential, not the person's data
  backup: false, // nor in backups: see the header
});

/** The requests made to connectors in the current day's window, per
 *  container: one count for every connection the person has, so the budget
 *  bounds what one person costs as well as what each credential is asked. A
 *  count that can't be read stops requests until its window ends, never
 *  opens them. */
export const requestsCount = defineCounterStore('connector-requests', {
  what: 'connector request counts',
  windowSeconds: 24 * 60 * 60,
  backup: false,
});

/** How many tokens a container may claim an hour. */
export const CLAIMS_PER_HOUR = 10;

export const claimsCount = defineCounterStore('connector-claims', {
  what: 'connector claim counts',
  windowSeconds: 3600,
  backup: false,
});

/** A new connection's id. */
export const newConnectionId = () => `conn_${crypto.randomUUID()}`;

export type { ConnectorKind };
