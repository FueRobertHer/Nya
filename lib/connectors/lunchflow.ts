// lib/connectors/lunchflow.ts
//
// The Lunch Flow Personal API, as a connector (lib/connectors/types.ts). The
// person pays Lunch Flow, which connects to their banks through the providers
// it uses (GoCardless, MX, Finicity, Akahu, SnapTrade, Pluggy and others), and
// gives Nya the API key of an "API destination" they create there: read-only
// access to the accounts Lunch Flow holds for them, in countries Plaid's US
// connections don't reach. Only Lunch Flow's own host is ever asked
// (LUNCHFLOW_API): nothing the person pastes names an address.
//
// SOURCES, read on 2026-10-17 and 18. Lunch Flow's documentation pages could
// not be opened from where this was written, only found and quoted by a
// search engine, so each detail below says where it comes from:
//   [docs]        the Personal API overview,
//                 https://www.lunchflow.app/docs/api/personal-api-overview: the
//                 base URL https://lunchflow.app/api/v1, the key in an
//                 `x-api-key` header, made by creating an API destination in
//                 the dashboard and copied from its settings, and GET
//                 /accounts, /accounts/:id/transactions, /accounts/:id/balance
//                 and /accounts/:id/holdings. It adds: "if you'd like to build
//                 an app that accesses other users' data, check out the
//                 Platform API" (see TERMS).
//   [holdings]    https://www.lunchflow.app/docs/api/personal-api/getAccountHoldings:
//                 holdings for accounts from SnapTrade, MX, Finicity and
//                 Pluggy only.
//   [guides]      https://www.lunchflow.app/docs/guides/destinations/lunch-money:
//                 its Lunch Money destination imports 90 days at first, then
//                 syncs the last seven days each day. And
//                 https://lunchflow.app/docs/guides/destinations/actual-budget:
//                 a SimpleFIN Bridge destination, for Actual Budget "and other
//                 compatible apps", whose Setup Token works once, within 7
//                 days (not tried with Nya's SimpleFIN connector).
//   [changelog]   https://feedback.lunchflow.app/changelog/electricplug-new-rest-api-your-data-your-way:
//                 the REST API, and transactions dated by their own date when
//                 the bank gives one, else the day the bank confirmed them.
//   [feedback]    https://feedback.lunchflow.app/p/document-rate-limit-handling-and-implement-retry-after-headers:
//                 no rate limit or Retry-After is documented ("generous rate
//                 limits", says the API's page); when a provider behind Lunch
//                 Flow limits it, the API answers 503 "Bank data is
//                 temporarily unavailable. This usually resolves within a
//                 minute." On the same board, a last sync time per account is
//                 planned, not built.
//   [terms]       https://www.lunchflow.app/terms: general rules of use
//                 (nothing unlawful, no spam, no collecting others' data
//                 without their consent). Nothing found on a subscriber's key
//                 used in an app they choose.
//   [price]       Lunch Flow's site: $34.99 a year ($2.92 a month) with two
//                 connections, $10 for each more, a 7-day trial, daily syncs.
//   [actual-flow] Lunch Flow's own client, https://github.com/lunchflow/actual-flow
//                 (npm @lunchflow/actual-flow 0.0.22): the base URL, the fields
//                 of an account (id, a number; name; institution_name) and of
//                 a transaction (id, null for a pending one; accountId; amount;
//                 currency; date; merchant; description; isPending), and its
//                 amounts handed to Actual Budget as they come, where money
//                 out is negative.
//   [mcp]         Lunch Flow's MCP server (a fork, npm @iflow-mcp/lunchflow-mcp
//                 0.1.0, author "Lunch Flow"): its error bodies, { error,
//                 message }: 401 "API key is required. Please provide
//                 x-api-key header.", 403 "Invalid API key.", 404 "Account not
//                 found.", 500.
//   [sure]        Sure, https://github.com/we-promise/sure (app/models/provider/lunchflow.rb,
//                 lunchflow_item/importer.rb, lunchflow_entry/processor.rb,
//                 lunchflow_account/processor.rb, and the provider's test): the
//                 answers { accounts, total }, { transactions, total } and
//                 { balance: { amount, currency } } (an amount as the string
//                 "10.00" in its test), no balance on /accounts and often no
//                 currency there, `include_pending`, 501 from /holdings for an
//                 account without any, 503 "GCRateLimited" and a 500 wrapping a
//                 429, card and loan balances negated into what is owed, and
//                 some banks (Halifax, through Lloyds) reporting a card's
//                 available credit as its balance.
//   [firefly]     Firefly III's data importer, https://github.com/firefly-iii/data-importer
//                 (app/Services/LunchFlow, config/lunchflow.php): the base URL,
//                 and sample answers with `status` "ACTIVE", `provider`
//                 "gocardless" and 32-character transaction ids.
//   [sdks]        lunchflow-rs (crates.io lunchflow 0.3.0) and lunchflowpy
//                 (PyPI 0.1.4): `status` one of ACTIVE, DISCONNECTED and ERROR;
//                 `from` and `to`, inclusive YYYY-MM-DD days; 403 "invalid API
//                 key or inactive subscription"; www.lunchflow.app as the host.
//   [zerosum]     https://help.zerosumapp.com/articles/3950774-bank-sync:
//                 ZeroSum, a hosted budgeting app, takes a subscriber's own
//                 Lunch Flow Personal API account on its Plus plan.
//
// TERMS. The Personal API is for "your own connected accounts"; Lunch Flow
// points an app that accesses other users' data to its Platform API, which is
// a partnership. Here each person connects their own Lunch Flow account, with
// a key they make and can delete, to see their own data, as Sure, Firefly III
// and ZeroSum's Plus plan do. Nothing found forbids it, and whoever runs Nya
// should still confirm it with Lunch Flow (hello@lunchflow.app) before
// offering it widely.
//
// CONNECTING. The person pastes the key; Nya checks it once with GET
// /accounts (it is not spent, unlike a SimpleFIN token) and keeps it as the
// connection's credential (lib/connectors/store.ts). It is sent in the
// x-api-key header to Lunch Flow's host and nowhere else: a redirect is
// followed only to the same site's other name (lunchflow.app and
// www.lunchflow.app both serve it, [docs] and [sdks]), and every request is
// held to the rules of lib/connectors/http.ts.
//
// READING, account by account, since no one answer holds every account:
// GET /accounts lists them; then each one's balance (GET
// /accounts/:id/balance), which also says its currency, as /accounts often
// doesn't; then, for the accounts tracked (FetchRequest `accounts`), their
// transactions in the window (GET /accounts/:id/transactions?from=&to=). A
// fetch is 1 + (accounts) + (tracked) requests, at most PARALLEL at a time,
// within the fetch's one deadline. A request about one account that brings
// nothing usable is a problem for that account only (its bank is held, and
// the window asked again); a fetch where none came through failed whole; and
// a refused key, a limit reached, a request Lunch Flow refuses or an address
// Nya won't use stops it at once.
//
// UNVERIFIED, AND THE SAFE READING. The documentation couldn't be read in
// full, so where the clients above disagree or say nothing:
//   - the window: `from` and `to` ([sdks]; Sure sends `start_date` and
//     `end_date`). Nya sends `from` and `to` and keeps only what an answer
//     holds inside the window, so a parameter Lunch Flow ignores costs a
//     larger answer, never a wrong one;
//   - pages: none documented, and no client asks for a second. `total` is
//     read as the count of what the answer holds: one whose `total` is more
//     than it sent may have been cut short, so it is a problem for that
//     account (held, and asked again), never taken as whole;
//   - signs: a transaction's amount is from the holder's side, money out
//     negative, as Lunch Flow's own client hands it to Actual Budget, so each
//     is negated once into Plaid's sign. A balance is taken from the holder's
//     side too (owed negative), as Sure reads a card's and a loan's, and as
//     for SimpleFIN a card or a loan whose balance comes positive isn't
//     counted until the person says how to read it
//     (lib/connectors/institutions.ts SIGNS). A card a bank reports by its
//     available credit comes positive too, and then neither reading is
//     right, which the docs say;
//   - a balance's time: none is given (a last sync time is only planned), so
//     a balance is as of when Nya received it (`balance_at` null, its fetch's
//     time shown, and never called the bank's day), and a bank whose link at
//     Lunch Flow broke is told by its account's `status`, DISCONNECTED or
//     ERROR (a problem for its bank), not by an old date. Any other status
//     says nothing Nya reads;
//   - pending transactions: `include_pending` is never sent (false unless
//     asked, in every client), and one that comes all the same (`isPending`,
//     or no id) is left out and counted, as SimpleFIN's are;
//   - ids: an account's is a number, a transaction's a string, each stable,
//     as every client takes them;
//   - days: `date` is a calendar day as the bank gives it (YYYY-MM-DD). A
//     time after it, which Sure allows for, is cut off, never moved into a
//     time zone;
//   - text: `merchant` names a row when there is one, else `description`;
//     a row with neither is kept, named "No description".
//
// HOLDINGS are not read. /holdings serves only some brokerages' accounts, with
// no time for its prices, and an account a connector feeds is kept like a
// manual one, with no positions (lib/connectors/institutions.ts): an
// investment account has its balance, which allocation counts as
// unclassified until the person gives the account a split.

import { guardedRequest, RequestFailedError, UnsafeUrlError } from './http';
import { readNumber } from './simplefin';
import {
  CONNECTOR_WORDS,
  ConnectorFailure,
  ExchangeFailure,
  type ConnectorDef,
  type FetchRequest,
  type RemoteAccount,
  type RemoteAnswer,
  type RemoteProblem,
} from './types';
import { cleanText } from '../import/normalize';
import { addDays, isCalendarDay, knownCurrency } from '../manual-txn-input';
import type { RawRecord } from '../import/record';

/** Where the Personal API is ([docs]). */
export const LUNCHFLOW_API = 'https://lunchflow.app/api/v1';
/** The header the key goes in ([docs]). */
export const KEY_HEADER = 'x-api-key';
/** How long checking a key may take. */
export const CHECK_TIMEOUT_MS = 15_000;
/** The most one answer may be: two years of a busy account's transactions
 *  are a few hundred kilobytes. */
export const ANSWER_MAX_BYTES = 5 * 1024 * 1024;
/** The longest key taken, and the shortest: anything shorter is not a key,
 *  and is refused before anything is counted or sent. */
export const MAX_KEY_CHARS = 512;
export const MIN_KEY_CHARS = 8;
/** The most accounts a listing may hold, and transactions one account's
 *  answer may hold: far past any person's, so more is not an answer to read.
 *  Each account costs a request, so the first bound is low. */
export const MAX_ANSWER_ACCOUNTS = 100;
export const MAX_ANSWER_TRANSACTIONS = 25_000;
/** How many problems are kept, and how long each may be. */
export const MAX_PROBLEMS = 20;
export const MAX_PROBLEM_CHARS = 300;
/** How many of a fetch's requests are in flight at once: gentle, since no
 *  limit is documented ([feedback]). */
export const PARALLEL = 4;
/** A request isn't started with less of the fetch's time left than this. */
const MIN_LEFT_MS = 1_000;
/** A row that comes with no words at all is kept under this name. */
export const NO_DESCRIPTION = 'No description';

let apiBase = LUNCHFLOW_API;

/** For tests: Lunch Flow at a local fake server's address (the transport
 *  routes its host there, lib/connectors/http.ts), or back with null. */
export function setLunchFlowApiForTests(base: string | null): void {
  apiBase = base ?? LUNCHFLOW_API;
}

/** The host every Lunch Flow connection reaches. */
export const lunchFlowHost = (): string => new URL(apiBase).host;

/** The API's address, and the one other origin that is Lunch Flow's: the
 *  same site with or without its www. */
function api(): { base: URL; trusted: string[] } {
  const base = new URL(apiBase);
  const twin = new URL(base.href);
  twin.hostname = base.hostname.startsWith('www.') ? base.hostname.slice(4) : `www.${base.hostname}`;
  return { base, trusted: [twin.origin] };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? cleanText(v) : '');
const textOrNumber = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 100) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

/** Text from Lunch Flow, safe to keep and show: cleaned, with the key taken
 *  out should it ever echo it (before it is cut, so no part of it is left at
 *  the end), and capped. */
function serverText(said: string, key: string): string {
  let out = cleanText(said);
  if (key.length >= 4) out = out.split(key).join('…');
  return out.slice(0, MAX_PROBLEM_CHARS);
}

// ---- The key ----

/**
 * What the person pasted, as a key: trimmed, one word of visible characters,
 * of a key's length. Throws ExchangeFailure('invalid') with words for the
 * person otherwise. Lunch Flow documents no format for its keys, so nothing
 * stricter is asked.
 */
export function checkKey(input: string): string {
  const invalid = (why: string) => new ExchangeFailure('invalid', why);
  const key = typeof input === 'string' ? input.trim() : '';
  if (!key) throw invalid('Paste the API key from your API destination in Lunch Flow.');
  if (key.length > MAX_KEY_CHARS) throw invalid('That is too long to be a Lunch Flow API key.');
  if (/^https?:/i.test(key)) throw invalid('That is a web address, not an API key. In Lunch Flow, open your API destination and copy its API key.');
  if (/\s/.test(key)) throw invalid('An API key has no spaces in it: copy the key alone and paste it again.');
  if (key.length < MIN_KEY_CHARS || !/^[\x21-\x7e]+$/.test(key)) throw invalid('That doesn’t look like a Lunch Flow API key: copy the whole key and paste it again.');
  return key;
}

// ---- One request ----

type Got = { status: number; body: string };

/** One GET to the API with the key, within `deadline` (a time): its status
 *  and body. Throws ConnectorFailure when no answer came, never with the key
 *  or the URL in it. */
async function get(path: string, key: string, deadline: number, query: Record<string, string> = {}): Promise<Got> {
  const { base, trusted } = api();
  const url = new URL(base.href);
  url.pathname = `${base.pathname.replace(/\/+$/, '')}${path}`;
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const timeoutMs = deadline - Date.now();
  if (timeoutMs < MIN_LEFT_MS) throw new ConnectorFailure('down', 'connector', 'Lunch Flow didn’t answer in time.');
  try {
    const { status, body } = await guardedRequest({
      method: 'GET',
      url,
      key: { header: KEY_HEADER, value: key },
      trustedOrigins: trusted,
      accept: 'application/json',
      timeoutMs,
      maxBytes: ANSWER_MAX_BYTES,
    });
    return { status, body };
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw new ConnectorFailure('blocked', 'unknown', `Nya won’t connect to Lunch Flow there: ${err.message}`);
    if (err instanceof RequestFailedError && err.reason === 'too-large') throw new ConnectorFailure('answer', 'connector', 'Lunch Flow’s answer was larger than Nya reads.');
    if (err instanceof RequestFailedError) {
      throw new ConnectorFailure(
        'down',
        'connector',
        err.reason === 'timeout' ? 'Lunch Flow didn’t answer in time.' : `Lunch Flow couldn’t be reached (${err.reason === 'tls' ? 'its certificate couldn’t be verified' : (err.code ?? 'a network error')}).`
      );
    }
    throw new ConnectorFailure('down', 'connector', 'Lunch Flow couldn’t be reached.');
  }
}

/** The words an error answer carries: its `message` (else its `error`), or
 *  its text when that is short and not a page. */
function saidIn(body: string, key: string): string {
  try {
    const json = JSON.parse(body);
    if (isRecord(json)) {
      const said = typeof json.message === 'string' && json.message.trim() ? json.message : typeof json.error === 'string' ? json.error : '';
      return said ? serverText(said, key) : '';
    }
  } catch {
    // Not JSON: its text, if it is a message rather than a page.
  }
  return body.length <= 1000 && !/^\s*</.test(body) ? serverText(body, key) : '';
}

/** What an answer's HTTP status means, when it isn't 200. */
export function failureOfStatus(status: number, said: string): ConnectorFailure {
  const theirs = said ? ` Lunch Flow said: “${said}”` : '';
  if (status === 401 || status === 403) {
    return new ConnectorFailure(
      'refused',
      'you',
      `Lunch Flow no longer accepts the API key Nya has (HTTP ${status}): it was deleted or replaced in Lunch Flow, or your Lunch Flow subscription isn’t active.${theirs}`,
      status
    );
  }
  if (status === 402) return new ConnectorFailure('payment', 'you', `Lunch Flow says your subscription needs paying (HTTP 402).${theirs}`, status);
  if (status === 429) return new ConnectorFailure('limited', 'nya', `Lunch Flow says Nya asked too often (HTTP 429).${theirs}`, status);
  if (status >= 400 && status < 500) return new ConnectorFailure('rejected', 'nya', `Lunch Flow refused Nya’s request (HTTP ${status}).${theirs}`, status);
  if (status >= 500) return new ConnectorFailure('down', 'connector', `Lunch Flow had a problem of its own (HTTP ${status}).${theirs}`, status);
  return new ConnectorFailure('answer', 'connector', `Lunch Flow’s answer couldn’t be read (HTTP ${status}).`, status);
}

/** A request about one account, as the fetch takes it: its JSON, or why it
 *  brought nothing for that account (`gone`: Lunch Flow no longer has it).
 *  Throws ConnectorFailure for what holds for every account alike: a refused
 *  key, payment, a limit, a request refused, an address Nya won't use. */
type Asked = { ok: true; json: unknown } | { ok: false; gone: boolean; failure: ConnectorFailure; why: string };

async function ask(path: string, key: string, deadline: number, query?: Record<string, string>): Promise<Asked> {
  let got: Got;
  try {
    got = await get(path, key, deadline, query);
  } catch (err) {
    if (err instanceof ConnectorFailure && err.kind !== 'blocked') return { ok: false, gone: false, failure: err, why: err.message };
    throw err;
  }
  if (got.status !== 200) {
    const said = saidIn(got.body, key);
    const failure = failureOfStatus(got.status, said);
    if (got.status === 404) return { ok: false, gone: true, failure, why: said || 'HTTP 404' };
    if (failure.kind !== 'down') throw failure;
    return { ok: false, gone: false, failure, why: said ? `${said} (HTTP ${got.status})` : `Lunch Flow had a problem of its own (HTTP ${got.status})` };
  }
  try {
    return { ok: true, json: JSON.parse(got.body) };
  } catch {
    const failure = new ConnectorFailure('answer', 'connector', 'Lunch Flow’s answer couldn’t be read: it isn’t JSON.', 200);
    return { ok: false, gone: false, failure, why: 'its answer isn’t JSON' };
  }
}

/** Runs `fn` over `items`, at most PARALLEL at a time, in order. A throw
 *  stops anything not yet started, and is thrown once those started end. */
async function inTurn<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let stopped = false;
  let error: unknown;
  const worker = async () => {
    while (!stopped && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (err) {
        if (!stopped) error = err;
        stopped = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  if (stopped) throw error;
  return out;
}

// ---- Reading the answers ----

/** An account as /accounts lists it. */
type Listed = {
  remote_id: string;
  name: string;
  institution: RemoteAccount['institution'];
  currency_text: string;
  status: string;
};

/** An id Lunch Flow gave: a whole number, or a short word of the characters
 *  a stored id may hold (it is a field name, and part of a path here). */
function idText(v: unknown): string {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : '';
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return /^[A-Za-z0-9_.:-]{1,200}$/.test(t) ? t : '';
}

/** An ISO 4217 code this runtime knows, or null. */
function currencyCode(v: unknown): string | null {
  if (typeof v !== 'string' || !/^[A-Za-z]{3}$/.test(v.trim())) return null;
  const code = v.trim().toUpperCase();
  return knownCurrency(code) ? code : null;
}

/** The day a row is on: YYYY-MM-DD as given, a time after it cut off. */
function dayOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const day = v.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(v.trim()) && isCalendarDay(day) ? day : null;
}

/** /accounts, read. Throws ConnectorFailure('answer') when it isn't a list
 *  of accounts, or lists more than any person's. An account without an id is
 *  counted, never guessed at. */
export function readAccountList(json: unknown): { listed: Listed[]; unreadable: number } {
  const bad = (why: string) => new ConnectorFailure('answer', 'connector', `Lunch Flow’s answer couldn’t be read: ${why}.`, 200);
  if (!isRecord(json) || !Array.isArray(json.accounts)) throw bad('it has no list of accounts');
  if (json.accounts.length > MAX_ANSWER_ACCOUNTS) throw bad(`it lists more than ${MAX_ANSWER_ACCOUNTS} accounts`);
  const listed: Listed[] = [];
  const seen = new Set<string>();
  let unreadable = 0;
  for (const a of json.accounts) {
    const remote_id = isRecord(a) ? idText(a.id) : '';
    if (!isRecord(a) || !remote_id || seen.has(remote_id)) {
      unreadable++;
      continue;
    }
    seen.add(remote_id);
    const institution = text(a.institution_name).slice(0, 100);
    const provider = text(a.provider).toLowerCase().slice(0, 40);
    listed.push({
      remote_id,
      name: text(a.name).slice(0, 100) || 'Account',
      // Grouped by the provider and the name Lunch Flow gives the bank: it
      // gives the bank no id of its own.
      institution: { name: institution || 'Your bank', key: institution ? `name:${provider}:${institution.toLowerCase()}` : 'unknown', domain: null },
      currency_text: text(a.currency).slice(0, 200),
      status: typeof a.status === 'string' ? a.status.trim().toUpperCase().slice(0, 40) : '',
    });
  }
  return { listed, unreadable };
}

/** /accounts/:id/balance, read: { balance: { amount, currency } } ([sure],
 *  [sdks]), or `current` and `available` in its place (an older shape,
 *  [mcp]). Null when it holds no number. */
export function readBalance(json: unknown): { balance: number; available: number | null; currency_text: string } | null {
  if (!isRecord(json) || !isRecord(json.balance)) return null;
  const b = json.balance;
  const balance = readNumber(b.amount) ?? readNumber(b.current);
  if (balance === null) return null;
  return { balance, available: readNumber(b.available), currency_text: text(b.currency).slice(0, 200) };
}

/** One transaction as a pipeline record, or why not: pending, or unreadable. */
function recordOf(t: unknown, remote_id: string, currency: string | null): RawRecord | 'pending' | 'unreadable' {
  if (!isRecord(t)) return 'unreadable';
  const id = idText(t.id);
  const pending = t.isPending === true || t.pending === true;
  // Pending, said outright, or without the id a posted one has ([actual-flow]).
  if (pending || t.id === null || t.id === undefined || t.id === '') return pending || t.isPending !== false ? 'pending' : 'unreadable';
  if (!id) return 'unreadable';
  const of = t.accountId ?? t.account_id;
  if (of !== undefined && of !== null && idText(of) !== remote_id) return 'unreadable';
  const amount = readNumber(t.amount);
  const day = dayOf(t.date);
  if (amount === null || day === null) return 'unreadable';
  // A row's own currency when it says one; one Nya doesn't know isn't read
  // as the account's.
  const own = text(t.currency);
  const rowCurrency = own ? currencyCode(own) : currency;
  if (own && !rowCurrency) return 'unreadable';
  const merchant = text(t.merchant ?? t.merchant_name);
  const description = text(t.description);
  return {
    source: 'lunchflow',
    source_id: id,
    date: day,
    posted_date: day,
    // Plaid's sign: Lunch Flow's negative amount is money out.
    amount: amount === 0 ? 0 : -amount,
    description: merchant || description || NO_DESCRIPTION,
    ...(rowCurrency ? { currency: rowCurrency } : {}),
    raw: {
      id,
      date: typeof t.date === 'string' ? t.date.slice(0, 40) : null,
      amount: textOrNumber(t.amount),
      ...(merchant ? { merchant: merchant.slice(0, 1000) } : {}),
      ...(description ? { description: description.slice(0, 1000) } : {}),
      ...(own ? { currency: own.slice(0, 20) } : {}),
    },
  };
}

/**
 * /accounts/:id/transactions, read: the records posted in `window` (from
 * `start` up to, not including, `end`), what the answer held that isn't among
 * them (pending, unreadable; those outside the window aren't counted, see the
 * header), and whether it may have been cut short (`total` more than it
 * sent). Null when it isn't a list of transactions.
 */
export function readTransactions(
  json: unknown,
  remote_id: string,
  window: { start: string; end: string | null },
  currency: string | null
): { records: RawRecord[]; left_out: { pending: number; unreadable: number }; cut: { held: number; total: number } | null } | null {
  if (!isRecord(json) || !Array.isArray(json.transactions) || json.transactions.length > MAX_ANSWER_TRANSACTIONS) return null;
  const records: RawRecord[] = [];
  const left_out = { pending: 0, unreadable: 0 };
  for (const t of json.transactions) {
    const r = recordOf(t, remote_id, currency);
    if (r === 'pending') left_out.pending++;
    else if (r === 'unreadable') left_out.unreadable++;
    else if (r.date >= window.start && (window.end === null || r.date < window.end)) records.push(r);
  }
  const total = json.total;
  const cut = typeof total === 'number' && Number.isSafeInteger(total) && total > json.transactions.length ? { held: json.transactions.length, total } : null;
  return { records, left_out, cut };
}

/** "A", "A and B", "A, B and C". */
const names = (list: string[]) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/** What a status says, when it says something is wrong ([sdks]). */
const STATUS_WORDS: Readonly<Record<string, string>> = { DISCONNECTED: 'is disconnected', ERROR: 'has an error' };

// ---- Fetching ----

/**
 * Every account the key can see, each with its balance, and, for a window,
 * the tracked accounts' transactions posted in it (see READING in the
 * header). Throws ConnectorFailure (never with the key in it).
 */
export async function fetchLunchFlow(secret: string, request: FetchRequest, opts: { timeoutMs: number }): Promise<RemoteAnswer> {
  const key = secret.trim();
  if (!key) throw new ConnectorFailure('credentials', 'nya', 'The API key Nya keeps for Lunch Flow isn’t one it can use.');
  const deadline = Date.now() + opts.timeoutMs;

  const listing = await get('/accounts', key, deadline);
  if (listing.status !== 200) throw failureOfStatus(listing.status, saidIn(listing.body, key));
  let json: unknown;
  try {
    json = JSON.parse(listing.body);
  } catch {
    throw new ConnectorFailure('answer', 'connector', 'Lunch Flow’s answer couldn’t be read: it isn’t JSON.', 200);
  }
  const { listed, unreadable } = readAccountList(json);

  const balances = await inTurn(listed, (a) => ask(`/accounts/${encodeURIComponent(a.remote_id)}/balance`, key, deadline));
  const window = request.balancesOnly ? null : { start: request.start, end: request.end };
  // The accounts whose transactions are wanted: the tracked ones, or every
  // one when the request names none.
  const only = request.balancesOnly ? null : (request.accounts ?? null);
  const wanted = window ? listed.filter((a, i) => balances[i].ok && (only === null || only.includes(a.remote_id))) : [];
  // `from` and `to` are inclusive days ([sdks]); the window's end is not.
  const query = window ? { from: window.start, ...(window.end ? { to: addDays(window.end, -1) } : {}) } : undefined;
  const asked = await inTurn(wanted, (a) => ask(`/accounts/${encodeURIComponent(a.remote_id)}/transactions`, key, deadline, query));
  const transactionsOf = new Map(wanted.map((a, i) => [a.remote_id, asked[i]]));

  const accounts: RemoteAccount[] = [];
  const problems: RemoteProblem[] = [];
  const problem = (message: string, ids: string[]) => problems.push({ message: serverText(message, key), side: 'connector', accounts: ids });
  // How many accounts came through whole, and the first failure, for a fetch
  // where none did.
  let whole = 0;
  let first: ConnectorFailure | null = null;

  for (const [i, a] of listed.entries()) {
    const b = balances[i];
    if (!b.ok) {
      // Gone from Lunch Flow since the listing: missing, as it would be from
      // a listing of its own.
      if (b.gone) continue;
      first ??= b.failure;
      problem(`${a.name}: no balance came. ${b.why}`, [a.remote_id]);
      continue;
    }
    const read = readBalance(b.json);
    if (!read) {
      first ??= new ConnectorFailure('answer', 'connector', 'Lunch Flow’s answer couldn’t be read: it held no balance.', 200);
      problem(`${a.name}: its balance couldn’t be read`, [a.remote_id]);
      continue;
    }
    const currency = currencyCode(read.currency_text) ?? currencyCode(a.currency_text);
    const account: RemoteAccount = {
      remote_id: a.remote_id,
      name: a.name,
      institution: a.institution,
      currency,
      currency_text: read.currency_text || a.currency_text,
      balance: read.balance,
      available: read.available,
      // Lunch Flow gives no time with a balance: see the header.
      balance_at: null,
      transactions: [],
      left_out: { pending: 0, unreadable: 0 },
    };
    accounts.push(account);
    const t = transactionsOf.get(a.remote_id);
    if (!t || !window) {
      whole++;
      continue;
    }
    if (!t.ok) {
      first ??= t.failure;
      problem(`${a.name}: no transactions came. ${t.why}`, [a.remote_id]);
      continue;
    }
    const got = readTransactions(t.json, a.remote_id, window, currency);
    if (!got) {
      first ??= new ConnectorFailure('answer', 'connector', 'Lunch Flow’s answer couldn’t be read: it held no list of transactions.', 200);
      problem(`${a.name}: its transactions couldn’t be read`, [a.remote_id]);
      continue;
    }
    account.transactions = got.records;
    account.left_out = got.left_out;
    if (got.cut) {
      problem(`The answer for ${a.name} held ${got.cut.held} of the ${got.cut.total} transactions it counted, so it may have been cut short: Nya asks again`, [a.remote_id]);
      continue;
    }
    whole++;
  }
  // Nothing came through for any account: the fetch failed, as one request would.
  if (whole === 0 && first) throw first;

  // A broken link at Lunch Flow, said once for each bank.
  const broken = new Map<string, { institution: string; words: string; ids: string[] }>();
  for (const a of listed) {
    const words = STATUS_WORDS[a.status];
    if (!words) continue;
    const at = `${a.status}\n${a.institution.key}`;
    const entry = broken.get(at) ?? { institution: a.institution.name, words, ids: [] };
    entry.ids.push(a.remote_id);
    broken.set(at, entry);
  }
  for (const b of broken.values()) problem(`The connection to ${b.institution} ${b.words}`, b.ids);

  return { accounts, problems: problems.slice(0, MAX_PROBLEMS), unreadable_accounts: unreadable };
}

/**
 * Checks a key with one GET /accounts, and answers it as the credential to
 * keep, with the host it reaches. Throws ExchangeFailure. The key isn't spent
 * by it: a failure here leaves it as it was.
 */
export async function checkWithLunchFlow(input: string, opts: { timeoutMs?: number } = {}): Promise<{ secret: string; host: string }> {
  const key = checkKey(input);
  let got: Got;
  try {
    got = await get('/accounts', key, Date.now() + (opts.timeoutMs ?? CHECK_TIMEOUT_MS));
  } catch (err) {
    if (err instanceof ConnectorFailure && err.kind === 'blocked') throw new ExchangeFailure('blocked', err.message);
    if (err instanceof ConnectorFailure && err.kind === 'answer') throw new ExchangeFailure('answer', 'Lunch Flow’s answer couldn’t be read. Try again in a few minutes.');
    throw new ExchangeFailure('down', `${err instanceof ConnectorFailure ? err.message : 'Lunch Flow couldn’t be reached.'} Try again in a few minutes: checking a key doesn’t use it up.`);
  }
  if (got.status === 401 || got.status === 403) {
    throw new ExchangeFailure(
      'claimed',
      'Lunch Flow didn’t accept this API key: it isn’t valid, it was deleted, or your Lunch Flow subscription isn’t active. Copy the key from your API destination in Lunch Flow again, or create a new destination and paste its key.'
    );
  }
  if (got.status !== 200) throw new ExchangeFailure('down', `Lunch Flow couldn’t check the key just now (HTTP ${got.status}). Try again in a few minutes.`);
  try {
    readAccountList(JSON.parse(got.body));
  } catch {
    throw new ExchangeFailure('answer', 'Lunch Flow’s answer couldn’t be read. Try again in a few minutes.');
  }
  return { secret: key, host: lunchFlowHost() };
}

export const LUNCHFLOW = {
  kind: 'lunchflow',
  label: CONNECTOR_WORDS.lunchflow.label,
  // No longest window is documented: two years in one answer, as far back as
  // the daily fetch reaches (lib/connectors/sync.ts HISTORY_DAYS), so older
  // history is one more request.
  windowDays: 731,
  // Lunch Flow's own Lunch Money destination syncs the last seven days each
  // day ([guides]), as late as rows are taken to come.
  overlapDays: 7,
  providerDailyLimit: null,
  maxInputChars: MAX_KEY_CHARS + 200,
  checkInput: (input) => {
    checkKey(input);
  },
  exchange: (input, opts) => checkWithLunchFlow(input, opts),
  hostOf: (secret) => (secret.trim() ? lunchFlowHost() : null),
  fetch: (secret, request, opts) => fetchLunchFlow(secret, request, opts),
} satisfies ConnectorDef;
