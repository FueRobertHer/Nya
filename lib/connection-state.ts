// lib/connection-state.ts
//
// What state a bank connection is in, why, whose side the problem is on, and
// what the person should do about it (#51). Pure and dependency-free, so the
// server (which decides) and the browser (which words it, and counts the days
// to a deadline) share one definition.
//
// ONE MAPPING OF PLAID'S ERRORS. A failed Plaid call carries an error code
// (PlaidError.error_code in the plaid package; the item and institution codes
// are listed in the package's CreditBankIncomeErrorType enum and in Plaid's
// error docs). "Could not fetch balances" tells the person nothing, and the
// right action differs by family:
//   - their sign-in at the bank needs redoing (ITEM_LOGIN_REQUIRED and its
//     kin): reconnect now, through Link's update mode, which keeps the
//     connection and its history;
//   - the bank or Plaid is having trouble (INSTITUTION_DOWN, ...): nothing to
//     do, it recovers on its own;
//   - the connection is gone or can't be repaired (USER_PERMISSION_REVOKED,
//     ITEM_NOT_FOUND, ...): remove it and connect again, and the history
//     carries over through account links (lib/links.ts);
//   - the accounts were closed at the bank (NO_ACCOUNTS for the whole
//     connection, or one account missing from a good answer, lib/vanished.ts):
//     resolve the closed account.
// classifyFailure is that mapping, and the only one: lib/networth.ts sets
// needs_reauth from it, so the card's Reconnect button and the health view
// always agree.
//
// WHOSE SIDE. Each cause also says where the problem is: the person's own
// sign-in, the bank, Plaid, or Nya. A broken link looks like a Nya problem
// from the outside, so the health view says which it is.
//
// RECONNECT SOON. Plaid warns about a week ahead when a connection is going to
// end: the PENDING_EXPIRATION and PENDING_DISCONNECT webhooks, which
// lib/connection-health.ts records. A good answer also reports the
// connection's consent expiry, where the institution has one. Either makes a
// working connection "reconnect soon", with the date. A warning lapses once the
// connection has answered after the end it announced, or Plaid reports its
// consent renewed past that end, so a warning that a repair outran never
// lingers.

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead a consent expiry Plaid reports makes a connection "reconnect
 *  soon": the same week's notice Plaid's own warnings give. */
export const RECONNECT_SOON_DAYS = 7;
/** How long before it ends Plaid sends PENDING_DISCONNECT, which carries no
 *  time of its own: "fired 7 days before the existing Item is scheduled for
 *  disconnection" (PendingDisconnectWebhookReason in the plaid package). */
export const PENDING_DISCONNECT_LEAD_DAYS = 7;
/** How many days before a connection ends the Home tab raises it too. */
export const RECONNECT_ALERT_DAYS = 3;

/** The coarse state: what the badge says, and what the notices go by. */
export type HealthState =
  | 'healthy'
  | 'reconnect_soon' // works now, and Plaid says it will stop on a date
  | 'needs_reauth' // the person must sign in again
  | 'outage' // the bank, Plaid or Nya is having trouble; nothing to do yet
  | 'relink' // can't be repaired: remove it, and connect again where that helps
  | 'closed' // the bank reports no open accounts
  | 'partial'; // it answered, but without accounts it used to report

export const HEALTH_STATES: readonly HealthState[] = ['healthy', 'reconnect_soon', 'needs_reauth', 'outage', 'relink', 'closed', 'partial'];

/** Why, more finely than the state: what the health view and the email say. */
export type Cause =
  | 'ok'
  | 'consent_ending' // the consent the bank gave expires (PENDING_EXPIRATION, or the reported expiry is near)
  | 'disconnect_pending' // the bank is ending the connection (PENDING_DISCONNECT)
  | 'login' // ITEM_LOGIN_REQUIRED and the credential codes
  | 'access' // ACCESS_NOT_GRANTED: permission to an account was not given
  | 'locked' // ITEM_LOCKED: the bank locked the login
  | 'bank_action' // USER_SETUP_REQUIRED, PASSWORD_RESET_REQUIRED: something to do on the bank's own site first
  | 'institution_down' // INSTITUTION_DOWN, INSTITUTION_NOT_RESPONDING, INSTITUTION_NOT_AVAILABLE
  | 'provider' // Plaid's own errors, maintenance and rate limits
  | 'unreachable' // no answer at all: a timeout or a network failure
  | 'credentials' // Nya could not read the access token it stores
  | 'unknown' // any other code
  | 'revoked' // USER_PERMISSION_REVOKED: access was withdrawn, and can't be restored
  | 'gone' // ITEM_NOT_FOUND and kin: Plaid no longer has the connection
  | 'token' // INVALID_ACCESS_TOKEN: Plaid doesn't accept the stored token here
  | 'unsupported' // ITEM_NOT_SUPPORTED and kin: Plaid can't reach these accounts any more
  | 'no_accounts' // NO_ACCOUNTS: the bank reports no open accounts
  | 'vanished'; // accounts missing from an otherwise good answer (lib/vanished.ts)

/** Where the problem is. */
export type Side = 'none' | 'you' | 'bank' | 'plaid' | 'nya' | 'unknown';

/** What to offer: reconnect through update mode, wait, remove and connect
 *  again, remove, resolve a closed account, or nothing. */
export type HealthAction = 'none' | 'reconnect' | 'wait' | 'relink' | 'remove' | 'resolve';

/** Each cause's state and action. */
export const CAUSES: Readonly<Record<Cause, { state: HealthState; action: HealthAction }>> = {
  ok: { state: 'healthy', action: 'none' },
  consent_ending: { state: 'reconnect_soon', action: 'reconnect' },
  disconnect_pending: { state: 'reconnect_soon', action: 'reconnect' },
  login: { state: 'needs_reauth', action: 'reconnect' },
  access: { state: 'needs_reauth', action: 'reconnect' },
  locked: { state: 'needs_reauth', action: 'reconnect' },
  bank_action: { state: 'needs_reauth', action: 'reconnect' },
  institution_down: { state: 'outage', action: 'wait' },
  provider: { state: 'outage', action: 'wait' },
  unreachable: { state: 'outage', action: 'wait' },
  // Not something the person can fix at their bank, and not something that
  // clears by itself either: whoever runs Nya restores the key. Waiting is
  // the person's only part, and the view says who has to act.
  credentials: { state: 'outage', action: 'wait' },
  unknown: { state: 'outage', action: 'wait' },
  revoked: { state: 'relink', action: 'relink' },
  gone: { state: 'relink', action: 'relink' },
  token: { state: 'relink', action: 'relink' },
  // Connecting again would fail the same way, so only removal is offered.
  unsupported: { state: 'relink', action: 'remove' },
  no_accounts: { state: 'closed', action: 'resolve' },
  vanished: { state: 'partial', action: 'resolve' },
};

/** What a failed fetch says, kept on the institution (lib/networth.ts). */
export type Failure = {
  cause: Cause;
  side: Side;
  /** Plaid's error code, when Plaid sent one. Codes are Plaid's public
   *  vocabulary, not data, so they may be shown and logged. */
  code: string | null;
};

/** Plaid's codes, by the family they belong to, with whose side each is on. */
const CODES: Readonly<Record<string, readonly [Cause, Side]>> = {
  ITEM_LOGIN_REQUIRED: ['login', 'you'],
  INVALID_CREDENTIALS: ['login', 'you'],
  INVALID_MFA: ['login', 'you'],
  INVALID_OTP: ['login', 'you'],
  INSUFFICIENT_CREDENTIALS: ['login', 'you'],
  INVALID_UPDATED_USERNAME: ['login', 'you'],
  USER_INPUT_TIMEOUT: ['login', 'you'],
  ACCESS_NOT_GRANTED: ['access', 'you'],
  ITEM_LOCKED: ['locked', 'bank'],
  USER_SETUP_REQUIRED: ['bank_action', 'bank'],
  PASSWORD_RESET_REQUIRED: ['bank_action', 'bank'],
  INSTITUTION_DOWN: ['institution_down', 'bank'],
  INSTITUTION_NOT_RESPONDING: ['institution_down', 'bank'],
  INSTITUTION_NOT_AVAILABLE: ['institution_down', 'bank'],
  INTERNAL_SERVER_ERROR: ['provider', 'plaid'],
  PLANNED_MAINTENANCE: ['provider', 'plaid'],
  PRODUCT_NOT_READY: ['provider', 'plaid'],
  USER_PERMISSION_REVOKED: ['revoked', 'you'],
  ITEM_NOT_FOUND: ['gone', 'plaid'],
  ITEM_NO_LONGER_AVAILABLE: ['gone', 'plaid'],
  ITEM_CONCURRENTLY_DELETED: ['gone', 'plaid'],
  // What switching PLAID_ENV or the secret looks like too (lib/item-usage.ts),
  // so it is on Nya's side until shown otherwise.
  INVALID_ACCESS_TOKEN: ['token', 'nya'],
  ITEM_NOT_SUPPORTED: ['unsupported', 'bank'],
  MFA_NOT_SUPPORTED: ['unsupported', 'bank'],
  INSTITUTION_NO_LONGER_SUPPORTED: ['unsupported', 'plaid'],
  NO_ACCOUNTS: ['no_accounts', 'bank'],
};

/** Plaid's error types whose every code means Plaid itself is busy or failing. */
const PROVIDER_TYPES = new Set(['RATE_LIMIT_EXCEEDED', 'API_ERROR']);

/** A code as Plaid writes them, so nothing else is ever kept or shown as one. */
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Plaid's answer to a failed call, mapped to a cause and a side. `responded` is
 * false when no answer came back at all (a timeout, a network failure).
 */
export function classifyFailure(input: { code?: unknown; type?: unknown; responded: boolean }): Failure {
  const code = typeof input.code === 'string' && CODE.test(input.code) ? input.code : null;
  if (code && Object.hasOwn(CODES, code)) {
    const [cause, side] = CODES[code];
    return { cause, side, code };
  }
  if (typeof input.type === 'string' && PROVIDER_TYPES.has(input.type)) return { cause: 'provider', side: 'plaid', code };
  if (!code && !input.responded) return { cause: 'unreachable', side: 'unknown', code: null };
  return { cause: 'unknown', side: 'unknown', code };
}

/** Plaid's early warning that a working connection is going to end, as stored
 *  per connection (lib/connection-records.ts). */
export type ConnectionWarning = {
  kind: 'pending_expiration' | 'pending_disconnect';
  /** When the first verified warning arrived (an ISO time). */
  received_at: string;
  /** When the connection ends (an ISO time): Plaid's consent_expiration_time
   *  for a pending expiration; for a pending disconnect, which carries no time,
   *  received_at plus Plaid's stated lead, marked as an estimate. */
  ends_at: string;
  /** True when ends_at is Nya's estimate rather than Plaid's figure. */
  ends_estimated: boolean;
  /** Plaid's reason for a pending disconnect (INSTITUTION_MIGRATION), or null. */
  reason: string | null;
};

const iso = (ms: number) => new Date(ms).toISOString();
const time = (s: string | null | undefined): number => (typeof s === 'string' ? Date.parse(s) : NaN);

/** An ISO time, or null if `v` isn't one. */
export function isoTime(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 64) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? iso(t) : null;
}

/**
 * The warning a verified ITEM webhook carries, or null for any other webhook.
 * A pending expiration names its end (consent_expiration_time); one that is
 * missing or out of reason is replaced by Plaid's stated week, as an estimate.
 */
export function warningFromWebhook(
  body: { webhook_code?: unknown; consent_expiration_time?: unknown; reason?: unknown },
  now: number
): ConnectionWarning | null {
  const estimate = iso(now + PENDING_DISCONNECT_LEAD_DAYS * DAY_MS);
  if (body.webhook_code === 'PENDING_EXPIRATION') {
    const given = isoTime(body.consent_expiration_time);
    // A day back allows for clocks and a late delivery; a year and a bit ahead
    // is longer than any consent Plaid warns about a week before it ends.
    const usable = given !== null && time(given) > now - DAY_MS && time(given) < now + 400 * DAY_MS;
    return {
      kind: 'pending_expiration',
      received_at: iso(now),
      ends_at: usable ? given : estimate,
      ends_estimated: !usable,
      reason: null,
    };
  }
  if (body.webhook_code === 'PENDING_DISCONNECT') {
    const reason = typeof body.reason === 'string' && CODE.test(body.reason) ? body.reason : null;
    return { kind: 'pending_disconnect', received_at: iso(now), ends_at: estimate, ends_estimated: true, reason };
  }
  return null;
}

/**
 * The warning to keep when another arrives for the same connection. Plaid
 * retries a delivery it thinks failed, so the same warning can come twice: a
 * retried pending disconnect must not push its estimated end later, so the
 * first one stands. A pending expiration takes Plaid's latest figure, keeping
 * when it was first heard. A warning whose end had already passed when the new
 * one came is over, and the new one replaces it. Between the two kinds, the
 * earlier end wins: that is the deadline that matters.
 */
export function mergeWarning(current: ConnectionWarning | null, incoming: ConnectionWarning): ConnectionWarning {
  if (!current || time(current.ends_at) < time(incoming.received_at)) return incoming;
  if (current.kind === incoming.kind) {
    return incoming.kind === 'pending_disconnect' ? current : { ...incoming, received_at: current.received_at };
  }
  return time(current.ends_at) < time(incoming.ends_at) ? current : incoming;
}

/**
 * Whether a warning is over: the connection answered after the end it
 * announced (it did not end, or not then), or Plaid now reports its consent
 * running past that end (renewed, by a reconnect here or elsewhere).
 */
export function warningLapsed(w: ConnectionWarning, lastOkAt: string | null, consentExpiresAt: string | null | undefined): boolean {
  const end = time(w.ends_at);
  if (time(lastOkAt) > end) return true;
  // A day's margin, so the same expiry written two ways never reads as renewed.
  return w.kind === 'pending_expiration' && time(consentExpiresAt) > end + DAY_MS;
}

/** What healthOf needs to know about one connection's latest fetch. */
export type HealthInput = {
  error: string | null;
  failure?: Failure;
  unconfirmed_missing?: number;
  consent_expires_at?: string | null;
};

/** One connection's health, as the health view, the Home notes and the
 *  notices read it. Dates and codes only: never an amount. */
export type ConnectionHealth = {
  state: HealthState;
  cause: Cause;
  side: Side;
  action: HealthAction;
  /** When it last answered without an error (an ISO time), or null if never
   *  recorded. */
  last_ok_at: string | null;
  /** For reconnect soon: when the connection ends (an ISO time). */
  ends_at?: string;
  /** For reconnect soon: true when ends_at is Nya's estimate. */
  ends_estimated?: boolean;
  /** Plaid's error code, when the failure came with one. */
  code?: string;
};

function health(cause: Cause, side: Side, last_ok_at: string | null): ConnectionHealth {
  const known = Object.hasOwn(CAUSES, cause) ? cause : 'unknown';
  const { state, action } = CAUSES[known];
  return { state, cause: known, side, action, last_ok_at };
}

/**
 * The health of one connection now. A failed fetch is what it failed with,
 * whatever Plaid warned before (it has already stopped). A connection that
 * answered is "reconnect soon" while an unlapsed warning or a near consent
 * expiry stands, the earlier end first; then "partial" if accounts it used to
 * report were missing; otherwise healthy. `lastOkAt` is when it last answered
 * without an error, which for one that just answered is now.
 */
export function healthOf(inst: HealthInput, warning: ConnectionWarning | null, lastOkAt: string | null, now: number): ConnectionHealth {
  if (inst.error) {
    // A payload from before failures were classified has none: unknown.
    const f = inst.failure ?? { cause: 'unknown', side: 'unknown', code: null };
    const h = health(f.cause, f.side, lastOkAt);
    return f.code ? { ...h, code: f.code } : h;
  }
  const ends: { at: string; estimated: boolean; cause: Cause }[] = [];
  if (warning && !warningLapsed(warning, lastOkAt, inst.consent_expires_at)) {
    ends.push({
      at: warning.ends_at,
      estimated: warning.ends_estimated,
      cause: warning.kind === 'pending_disconnect' ? 'disconnect_pending' : 'consent_ending',
    });
  }
  const consent = isoTime(inst.consent_expires_at);
  if (consent !== null && time(consent) <= now + RECONNECT_SOON_DAYS * DAY_MS) {
    ends.push({ at: consent, estimated: false, cause: 'consent_ending' });
  }
  if (ends.length > 0) {
    const first = ends.reduce((a, b) => (time(b.at) < time(a.at) ? b : a));
    return { ...health(first.cause, 'bank', lastOkAt), ends_at: first.at, ends_estimated: first.estimated };
  }
  if ((inst.unconfirmed_missing ?? 0) > 0) return health('vanished', 'bank', lastOkAt);
  return health('ok', 'none', lastOkAt);
}

/** Whole calendar days from one UTC day to another (an ISO time's UTC date):
 *  how the notices count days, the way the daily job's dates do. */
export function utcDaysBetween(fromIso: string, to: number): number {
  const from = time(fromIso);
  if (!Number.isFinite(from)) return NaN;
  const day = (ms: number) => Math.floor(ms / DAY_MS);
  return day(to) - day(from);
}
