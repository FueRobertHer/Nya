// lib/connectors/simplefin.ts
//
// The SimpleFIN protocol (https://www.simplefin.org/protocol.html), as a
// connector (lib/connectors/types.ts). The person pays SimpleFIN Bridge, or
// another server that speaks the protocol (Redbark, for Australia and New
// Zealand), and gives Nya read-only access to the accounts they choose there.
// Nothing here names SimpleFIN's own host: every address comes from the token.
//
// CONNECTING. The person creates a Setup Token at their SimpleFIN server and
// pastes it. A Setup Token is the base64 of a claim URL; Nya POSTs to that
// URL, once, and the answer is the Access URL, which carries the credentials
// to read the accounts (https://user:password@host/path). A token can be
// claimed once: a second claim is refused (403), by Nya or by anyone else who
// saw it, which is what makes pasting it safe. The Access URL is the secret
// Nya keeps (lib/connectors/store.ts); its credentials are sent as HTTP Basic
// authorization, never in a URL, and every request is held to the rules of
// lib/connectors/http.ts (https only, public addresses after DNS resolution,
// bounded redirects, a deadline, a bounded answer).
//
// READING. GET <Access URL>/accounts, with `start-date` and `end-date` (Unix
// times: transactions posted on or after the first and before the second) or
// `balances-only=1`. Pending transactions are not asked for (`pending=1` is
// never sent), and any the answer holds all the same (`pending: true`, or no
// posted time) are left out and counted: the protocol doesn't link a pending
// transaction to the posted one that replaces it, which often has another id,
// so keeping both would count a purchase twice. The answer is an Account Set:
//
//   errors    a list of messages for the person (shown as they came)
//   accounts  each with org (name, domain, sfin-url, id), id, name, currency
//             (an ISO code, or a URL for a currency of the server's own),
//             balance, available-balance, balance-date, and transactions,
//             each with id, posted, amount, description, and optionally
//             payee, memo, transacted_at and pending
//
// SIGNS. A transaction's amount is from the account holder's side: positive
// is money into the account, negative is money out, on a card as on a
// checking account. Nya keeps Plaid's sign (positive is money out), so every
// amount is negated here, once. A balance is from the holder's side too:
// money held is positive, money owed (a card, a loan) negative; it is kept as
// reported, and lib/connectors/institutions.ts turns an owed one into Nya's
// positive amount owed once the person has said the account is a card or a
// loan (the protocol has no account types).
//
// DATES. Times are Unix seconds. A transaction's day is the UTC day of its
// posted time, the protocol's own date for it; its transacted_at, when given,
// is kept in its raw record.
//
// PROBLEMS. Each message in `errors` is reported with the accounts it
// concerns, when it names their institution (SimpleFIN's messages read
// "Connection to <bank> may need attention"); a message that names none could
// concern any of them. A server that also sends `errlist`, entries with a
// message and an account id, is read the same way, by id.

import { guardedRequest, RequestFailedError, UnsafeUrlError } from './http';
import {
  ConnectorFailure,
  ExchangeFailure,
  type ConnectorDef,
  type FetchRequest,
  type RemoteAccount,
  type RemoteAnswer,
  type RemoteProblem,
} from './types';
import { cleanText } from '../import/normalize';
import { knownCurrency } from '../manual-txn-input';
import type { RawRecord } from '../import/record';

/** How long a claim may take. */
export const CLAIM_TIMEOUT_MS = 15_000;
/** The most a claim's answer (an Access URL) may be. */
export const CLAIM_MAX_BYTES = 4096;
/** The most an accounts answer may be: 90 days of 25 busy institutions is a
 *  few megabytes. */
export const ACCOUNTS_MAX_BYTES = 10 * 1024 * 1024;
/** The longest Setup Token taken. */
export const MAX_TOKEN_CHARS = 4096;
/** The most accounts an answer may list, and transactions one account may
 *  have in one answer: far past any person's, so more is not an answer to read. */
export const MAX_ANSWER_ACCOUNTS = 500;
export const MAX_ANSWER_TRANSACTIONS = 25_000;
/** How many of the server's messages are kept, and how long each may be. */
export const MAX_PROBLEMS = 20;
export const MAX_PROBLEM_CHARS = 300;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---- Setup Token and Access URL ----

/**
 * The claim URL a Setup Token holds: base64 (standard or URL-safe, line
 * breaks and spaces ignored) of an https address without credentials. Throws
 * ExchangeFailure('invalid') with words for the person otherwise.
 */
export function decodeSetupToken(input: string): URL {
  const invalid = (why: string) => new ExchangeFailure('invalid', why);
  const token = typeof input === 'string' ? input.replace(/\s+/g, '') : '';
  if (!token) throw invalid('Paste the Setup Token from SimpleFIN.');
  if (token.length > MAX_TOKEN_CHARS) throw invalid('That is too long to be a SimpleFIN Setup Token.');
  if (/^https?:/i.test(token)) {
    throw invalid('That is a web address, not a Setup Token. In SimpleFIN Bridge, create a Setup Token for Nya and paste the token itself.');
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(token)) throw invalid("That doesn't look like a SimpleFIN Setup Token: copy the whole token and paste it again.");
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64')).trim();
  } catch {
    throw invalid("That doesn't look like a SimpleFIN Setup Token: copy the whole token and paste it again.");
  }
  let url: URL;
  try {
    if (/[\u0000-\u001f\u007f\s]/.test(text)) throw new Error('control characters');
    url = new URL(text);
  } catch {
    throw invalid("That doesn't look like a SimpleFIN Setup Token: copy the whole token and paste it again.");
  }
  if (url.protocol !== 'https:') throw invalid('That Setup Token points to an address that isn’t https, so Nya won’t use it.');
  if (url.username || url.password) throw invalid('That Setup Token points to an address with credentials in it, so Nya won’t use it.');
  return url;
}

/** An Access URL read: where it points (without its credentials) and the
 *  credentials, which go in an Authorization header. */
export type AccessUrl = { base: URL; user: string; password: string };

/** An Access URL, or null when the text isn't one: https, with a user name
 *  and a password in it. */
export function parseAccessUrl(text: string): AccessUrl | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.username || !url.password) return null;
  let user: string;
  let password: string;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    return null;
  }
  const base = new URL(url.toString());
  base.username = '';
  base.password = '';
  base.search = '';
  base.hash = '';
  return { base, user, password };
}

/** Text from the server, safe to keep and show: cleaned, capped, and with
 *  the credentials taken out should it ever echo them. */
function serverText(text: string, access?: AccessUrl | null): string {
  let out = cleanText(text).slice(0, MAX_PROBLEM_CHARS);
  if (access) {
    for (const secret of [access.password, access.user]) {
      if (secret.length >= 4) out = out.split(secret).join('…');
    }
  }
  return out;
}

/**
 * Claims a Setup Token: one POST to its claim URL. Answers with the Access
 * URL (the secret to keep) and the host it reaches. Throws ExchangeFailure.
 */
export async function claimSetupToken(input: string, opts: { timeoutMs?: number } = {}): Promise<{ secret: string; host: string }> {
  const claimUrl = decodeSetupToken(input);
  let status: number;
  let body: string;
  try {
    ({ status, body } = await guardedRequest({
      method: 'POST',
      url: claimUrl,
      accept: 'text/plain, */*',
      timeoutMs: opts.timeoutMs ?? CLAIM_TIMEOUT_MS,
      maxBytes: CLAIM_MAX_BYTES,
    }));
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw new ExchangeFailure('blocked', `Nya won’t use this Setup Token: ${err.message}`);
    if (err instanceof RequestFailedError && err.reason === 'too-large') {
      throw new ExchangeFailure('answer', 'SimpleFIN’s answer wasn’t an access Nya can use. Create a new Setup Token and try again.');
    }
    throw new ExchangeFailure(
      'down',
      `${claimUrl.hostname} didn’t answer${err instanceof RequestFailedError && err.reason === 'timeout' ? ' in time' : ''}. If it received the request, this token is used up: if trying again says so, create a new one.`
    );
  }
  if (status === 403 || status === 401 || status === 404 || status === 410) {
    throw new ExchangeFailure(
      'claimed',
      'SimpleFIN didn’t accept this Setup Token: it has already been used (each token works once), or it isn’t valid. Create a new one in SimpleFIN Bridge and paste that.'
    );
  }
  if (status !== 200) {
    throw new ExchangeFailure('down', `${claimUrl.hostname} couldn’t take the token just now (HTTP ${status}). If trying again says it was already used, create a new one.`);
  }
  const access = parseAccessUrl(body);
  if (!access) throw new ExchangeFailure('answer', 'SimpleFIN’s answer wasn’t an access Nya can use. Create a new Setup Token and try again.');
  return { secret: body.trim(), host: access.base.host };
}

// ---- Reading an Account Set ----

const NUMERIC = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/** A protocol number (a numeric string, or a JSON number), or null. */
export function readNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!NUMERIC.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The latest time a protocol timestamp may name (the year 3000), so a
 *  number in milliseconds, or nonsense, is never read as a date. */
const LATEST_SECONDS = 32_503_680_000;

/** A Unix time in seconds, as a JavaScript time, or null (0 or less too). */
export function readTime(v: unknown): number | null {
  const n = readNumber(v);
  return n !== null && n > 0 && n < LATEST_SECONDS ? n * 1000 : null;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A UTC day (YYYY-MM-DD) as the Unix time of its start, for a query. */
export function epochOfDay(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
}

/** An ISO 4217 code this runtime knows, from the protocol's currency, or null. */
function currencyCode(v: unknown): string | null {
  if (typeof v !== 'string' || !/^[A-Za-z]{3}$/.test(v.trim())) return null;
  const code = v.trim().toUpperCase();
  return knownCurrency(code) ? code : null;
}

const text = (v: unknown) => (typeof v === 'string' ? cleanText(v) : '');
const textOrNumber = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

/** An organization as an institution: its name, a key that groups its
 *  accounts, and its domain. */
function institutionOf(org: unknown): RemoteAccount['institution'] {
  const o = isRecord(org) ? org : {};
  const name = text(o.name).slice(0, 100);
  const domain = text(o.domain).toLowerCase().slice(0, 253) || null;
  const id = textOrNumber(o.id).slice(0, 200);
  const sfin = text(o['sfin-url']).slice(0, 500);
  const key = id ? `id:${id}` : domain ? `domain:${domain}` : name ? `name:${name.toLowerCase()}` : sfin ? `url:${sfin}` : 'unknown';
  return { name: name || domain || 'Your bank', key, domain };
}

/** One transaction as a pipeline record, or why not: pending, or unreadable. */
function recordOf(t: unknown, currency: string | null): RawRecord | 'pending' | 'unreadable' {
  if (!isRecord(t)) return 'unreadable';
  // Pending: said outright, or without the posted time a posted one has.
  const posted = readTime(t.posted);
  if (t.pending === true || posted === null) return t.pending === true || readNumber(t.posted) === 0 ? 'pending' : 'unreadable';
  const id = textOrNumber(t.id);
  if (!id || id.length > 200) return 'unreadable';
  const amount = readNumber(t.amount);
  if (amount === null) return 'unreadable';
  const description = text(t.description);
  const payee = text(t.payee);
  const memo = text(t.memo);
  const transactedAt = readTime(t.transacted_at);
  const day = utcDay(posted);
  return {
    source: 'simplefin',
    source_id: id,
    date: day,
    posted_date: day,
    // Plaid's sign: SimpleFIN's positive amount is money in.
    amount: amount === 0 ? 0 : -amount,
    // The payee when the server names one (a merchant's name), else the
    // bank's own description of it.
    description: payee || description,
    ...(currency ? { currency } : {}),
    raw: {
      id,
      posted: posted / 1000,
      amount: textOrNumber(t.amount),
      description: description.slice(0, 1000),
      ...(payee ? { payee: payee.slice(0, 1000) } : {}),
      ...(memo ? { memo: memo.slice(0, 1000) } : {}),
      ...(transactedAt !== null ? { transacted_at: transactedAt / 1000 } : {}),
    },
  };
}

/** Which accounts a message concerns: those whose institution's name it
 *  contains (case aside), or null when it names none of them. */
export function accountsNamedIn(message: string, accounts: readonly RemoteAccount[]): string[] | null {
  const lower = message.toLowerCase();
  const hit = accounts.filter((a) => a.institution.name.length >= 3 && a.institution.name !== 'Your bank' && lower.includes(a.institution.name.toLowerCase()));
  return hit.length > 0 ? hit.map((a) => a.remote_id) : null;
}

/**
 * An Account Set as the connector's answer (see the header). Throws
 * ConnectorFailure('answer') when it isn't one: not an object, or without a
 * list of accounts, or larger than any real answer. An account without an id,
 * a balance or its time is counted in `unreadable_accounts`, never guessed.
 */
export function readAccountSet(json: unknown, opts: { access?: AccessUrl | null; balancesOnly?: boolean } = {}): RemoteAnswer {
  const bad = (why: string) => new ConnectorFailure('answer', 'connector', `SimpleFIN’s answer couldn’t be read: ${why}.`, 200);
  if (!isRecord(json) || !Array.isArray(json.accounts)) throw bad('it has no list of accounts');
  if (json.accounts.length > MAX_ANSWER_ACCOUNTS) throw bad(`it lists more than ${MAX_ANSWER_ACCOUNTS} accounts`);

  const accounts: RemoteAccount[] = [];
  const seen = new Set<string>();
  let unreadable = 0;
  for (const a of json.accounts) {
    if (!isRecord(a)) {
      unreadable++;
      continue;
    }
    const remote_id = textOrNumber(a.id);
    const balance = readNumber(a.balance);
    if (!remote_id || remote_id.length > 200 || balance === null || seen.has(remote_id)) {
      unreadable++;
      continue;
    }
    seen.add(remote_id);
    const currency_text = text(a.currency).slice(0, 200);
    const currency = currencyCode(a.currency);
    const balanceAt = readTime(a['balance-date']);
    const rows = Array.isArray(a.transactions) && !opts.balancesOnly ? a.transactions : [];
    if (rows.length > MAX_ANSWER_TRANSACTIONS) throw bad(`one account has more than ${MAX_ANSWER_TRANSACTIONS} transactions`);
    const transactions: RawRecord[] = [];
    const left_out = { pending: 0, unreadable: 0 };
    for (const t of rows) {
      const r = recordOf(t, currency);
      if (r === 'pending') left_out.pending++;
      else if (r === 'unreadable') left_out.unreadable++;
      else transactions.push(r);
    }
    accounts.push({
      remote_id,
      name: text(a.name).slice(0, 100) || 'Account',
      institution: institutionOf(a.org),
      currency,
      currency_text,
      balance,
      available: readNumber(a['available-balance']),
      balance_at: balanceAt === null ? null : new Date(balanceAt).toISOString(),
      transactions,
      left_out,
    });
  }

  const problems: RemoteProblem[] = [];
  const errors = Array.isArray(json.errors) ? json.errors : [];
  for (const e of errors) {
    const message = typeof e === 'string' ? serverText(e, opts.access) : '';
    if (message) problems.push({ message, side: 'connector', accounts: accountsNamedIn(message, accounts) });
  }
  // A server that also lists its errors with the account each concerns.
  const errlist = Array.isArray(json.errlist) ? json.errlist : [];
  for (const e of errlist) {
    if (!isRecord(e)) continue;
    const message = serverText(text(e.msg) || text(e.message), opts.access);
    if (!message || problems.some((p) => p.message === message)) continue;
    const id = textOrNumber(e.account_id);
    problems.push({ message, side: 'connector', accounts: id ? [id] : accountsNamedIn(message, accounts) });
  }
  return { accounts, problems: problems.slice(0, MAX_PROBLEMS), unreadable_accounts: unreadable };
}

// ---- Fetching ----

/** What an answer's HTTP status means, when it isn't 200. */
function failureOfStatus(status: number, said: string): ConnectorFailure {
  const theirs = said ? ` SimpleFIN said: “${said}”` : '';
  if (status === 401 || status === 403 || status === 404 || status === 410) {
    return new ConnectorFailure('refused', 'you', `SimpleFIN no longer accepts Nya’s access (HTTP ${status}).${theirs}`, status);
  }
  if (status === 402) return new ConnectorFailure('payment', 'you', `SimpleFIN says your subscription needs paying (HTTP 402).${theirs}`, status);
  if (status === 429) return new ConnectorFailure('limited', 'nya', `SimpleFIN says Nya asked too often (HTTP 429).${theirs}`, status);
  if (status >= 400 && status < 500) return new ConnectorFailure('rejected', 'nya', `SimpleFIN refused Nya’s request (HTTP ${status}).${theirs}`, status);
  if (status >= 500) return new ConnectorFailure('down', 'connector', `SimpleFIN had a problem of its own (HTTP ${status}).${theirs}`, status);
  return new ConnectorFailure('answer', 'connector', `SimpleFIN’s answer couldn’t be read (HTTP ${status}).`, status);
}

/** The words an error answer carries: its `errors`, or its text. */
function saidIn(body: string, access: AccessUrl): string {
  try {
    const json = JSON.parse(body);
    if (isRecord(json) && Array.isArray(json.errors)) {
      return serverText(json.errors.filter((e: unknown) => typeof e === 'string').join(' '), access);
    }
  } catch {
    // Not JSON: its text, if it is short enough to be a message.
  }
  return body.length <= 1000 ? serverText(body, access) : '';
}

/**
 * GET <Access URL>/accounts for a window, or balances only. Throws
 * ConnectorFailure (never with the Access URL in it).
 */
export async function fetchAccountSet(secret: string, request: FetchRequest, opts: { timeoutMs: number }): Promise<RemoteAnswer> {
  const access = parseAccessUrl(secret);
  if (!access) throw new ConnectorFailure('credentials', 'nya', 'The access Nya keeps for SimpleFIN isn’t one it can use.');
  const url = new URL(`${access.base.pathname.replace(/\/+$/, '')}/accounts`, access.base.origin);
  if (request.balancesOnly) url.searchParams.set('balances-only', '1');
  else {
    url.searchParams.set('start-date', String(epochOfDay(request.start)));
    if (request.end) url.searchParams.set('end-date', String(epochOfDay(request.end)));
  }
  let status: number;
  let body: string;
  try {
    ({ status, body } = await guardedRequest({
      method: 'GET',
      url,
      auth: { user: access.user, password: access.password },
      accept: 'application/json',
      timeoutMs: opts.timeoutMs,
      maxBytes: ACCOUNTS_MAX_BYTES,
    }));
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw new ConnectorFailure('blocked', 'unknown', `Nya won’t connect to SimpleFIN there: ${err.message}`);
    if (err instanceof RequestFailedError && err.reason === 'too-large') {
      throw new ConnectorFailure('answer', 'connector', 'SimpleFIN’s answer was larger than Nya reads.');
    }
    if (err instanceof RequestFailedError) {
      throw new ConnectorFailure('down', 'connector', err.reason === 'timeout' ? 'SimpleFIN didn’t answer in time.' : `SimpleFIN couldn’t be reached (${err.reason === 'tls' ? 'its certificate couldn’t be verified' : (err.code ?? 'a network error')}).`);
    }
    throw new ConnectorFailure('down', 'connector', 'SimpleFIN couldn’t be reached.');
  }
  if (status !== 200) throw failureOfStatus(status, saidIn(body, access));
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ConnectorFailure('answer', 'connector', 'SimpleFIN’s answer couldn’t be read: it isn’t JSON.', 200);
  }
  return readAccountSet(json, { access, balancesOnly: !!request.balancesOnly });
}

export const SIMPLEFIN: ConnectorDef = {
  kind: 'simplefin',
  label: 'SimpleFIN',
  windowDays: 90,
  overlapDays: 5,
  providerDailyLimit: 24,
  exchange: (input, opts) => claimSetupToken(input, opts),
  hostOf: (secret) => parseAccessUrl(secret)?.base.host ?? null,
  fetch: (secret, request, opts) => fetchAccountSet(secret, request, opts),
};
