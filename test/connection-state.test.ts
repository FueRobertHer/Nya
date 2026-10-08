import { describe, expect, test } from 'bun:test';
import {
  CAUSES,
  HEALTH_STATES,
  PENDING_DISCONNECT_LEAD_DAYS,
  RECONNECT_SOON_DAYS,
  classifyFailure,
  healthOf,
  isoTime,
  mergeWarning,
  utcDaysBetween,
  warningFromWebhook,
  warningLapsed,
  type Cause,
  type ConnectionWarning,
  type Side,
} from '@/lib/connection-state';

// The one mapping from Plaid's answers to what a connection's state is, whose
// side the problem is on, and what to offer (#51). A wrong answer here sends
// someone to reconnect a bank that is merely down, or tells them to wait on
// one that will never come back.

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-08T13:00:00.000Z');
const at = (days: number) => new Date(NOW + days * DAY).toISOString();
const failed = (code: string | null, type: string | null = null, responded = true) => ({
  error: 'Could not fetch balances',
  failure: classifyFailure({ code, type, responded }),
});
const answered = (over: Record<string, unknown> = {}) => ({ error: null, ...over });
const warning = (over: Partial<ConnectionWarning> = {}): ConnectionWarning => ({
  kind: 'pending_expiration',
  received_at: at(-1),
  ends_at: at(6),
  ends_estimated: false,
  reason: null,
  ...over,
});

describe("Plaid's error codes, by family", () => {
  const families: [string[], Cause, Side][] = [
    [['ITEM_LOGIN_REQUIRED', 'INVALID_CREDENTIALS', 'INVALID_MFA', 'INSUFFICIENT_CREDENTIALS'], 'login', 'you'],
    [['ACCESS_NOT_GRANTED'], 'access', 'you'],
    [['ITEM_LOCKED'], 'locked', 'bank'],
    [['USER_SETUP_REQUIRED', 'PASSWORD_RESET_REQUIRED'], 'bank_action', 'bank'],
    [['INSTITUTION_DOWN', 'INSTITUTION_NOT_RESPONDING', 'INSTITUTION_NOT_AVAILABLE'], 'institution_down', 'bank'],
    [['INTERNAL_SERVER_ERROR', 'PLANNED_MAINTENANCE'], 'provider', 'plaid'],
    [['USER_PERMISSION_REVOKED'], 'revoked', 'you'],
    [['ITEM_NOT_FOUND', 'ITEM_NO_LONGER_AVAILABLE'], 'gone', 'plaid'],
    [['INVALID_ACCESS_TOKEN'], 'token', 'nya'],
    [['ITEM_NOT_SUPPORTED', 'MFA_NOT_SUPPORTED'], 'unsupported', 'bank'],
    [['INSTITUTION_NO_LONGER_SUPPORTED'], 'unsupported', 'plaid'],
    [['NO_ACCOUNTS'], 'no_accounts', 'bank'],
  ];

  test('each family gets its cause, and the side it is on', () => {
    for (const [codes, cause, side] of families) {
      for (const code of codes) expect([code, classifyFailure({ code, responded: true })]).toEqual([code, { cause, side, code }]);
    }
  });

  test('the four failures the issue names each offer their own action', () => {
    const action = (code: string) => CAUSES[classifyFailure({ code, responded: true }).cause];
    // Reauth: reconnect now, through update mode.
    expect(action('ITEM_LOGIN_REQUIRED')).toEqual({ state: 'needs_reauth', action: 'reconnect' });
    // An outage at the institution: nothing to do, it will recover.
    expect(action('INSTITUTION_DOWN')).toEqual({ state: 'outage', action: 'wait' });
    // An error needing removal and re-link: re-link, and the history carries over.
    expect(action('USER_PERMISSION_REVOKED')).toEqual({ state: 'relink', action: 'relink' });
    expect(action('ITEM_NOT_FOUND')).toEqual({ state: 'relink', action: 'relink' });
    // Closed at the bank: resolve the closed account.
    expect(action('NO_ACCOUNTS')).toEqual({ state: 'closed', action: 'resolve' });
    expect(CAUSES.vanished).toEqual({ state: 'partial', action: 'resolve' });
    // Connecting an unsupported institution again would fail the same way.
    expect(action('ITEM_NOT_SUPPORTED')).toEqual({ state: 'relink', action: 'remove' });
  });

  test('a rate limit or Plaid API error is Plaid having trouble, whatever its code', () => {
    expect(classifyFailure({ code: 'ACCOUNTS_LIMIT', type: 'RATE_LIMIT_EXCEEDED', responded: true })).toEqual({ cause: 'provider', side: 'plaid', code: 'ACCOUNTS_LIMIT' });
    expect(classifyFailure({ code: 'SOMETHING', type: 'API_ERROR', responded: true }).cause).toBe('provider');
  });

  test('no answer at all is "unreachable"; an answer with a code nobody knows is "unknown", not a guess', () => {
    expect(classifyFailure({ responded: false })).toEqual({ cause: 'unreachable', side: 'unknown', code: null });
    expect(classifyFailure({ code: 'BRAND_NEW_CODE', responded: true })).toEqual({ cause: 'unknown', side: 'unknown', code: 'BRAND_NEW_CODE' });
    expect(classifyFailure({ responded: true })).toEqual({ cause: 'unknown', side: 'unknown', code: null });
    expect(CAUSES.unknown.state).toBe('outage');
  });

  test('only something shaped like a code is kept as one', () => {
    for (const code of ['', 'lowercase', 'HAS SPACE', 'A'.repeat(65), 42, { x: 1 }, '__proto__']) {
      expect(classifyFailure({ code, responded: true }).code).toBeNull();
    }
    expect(classifyFailure({ code: 'constructor', responded: true }).cause).toBe('unknown');
  });

  test('every cause has a state in the list and an action', () => {
    for (const [cause, { state, action }] of Object.entries(CAUSES)) {
      expect([cause, HEALTH_STATES.includes(state)]).toEqual([cause, true]);
      expect(typeof action).toBe('string');
    }
  });
});

describe('the health of one connection', () => {
  test('a failed fetch is what it failed with, with the code and the last good sync', () => {
    const h = healthOf(failed('ITEM_LOGIN_REQUIRED'), null, at(-4), NOW);
    expect(h).toEqual({ state: 'needs_reauth', cause: 'login', side: 'you', action: 'reconnect', last_ok_at: at(-4), code: 'ITEM_LOGIN_REQUIRED' });
    expect(healthOf(failed('INSTITUTION_DOWN'), null, null, NOW)).toMatchObject({ state: 'outage', cause: 'institution_down', side: 'bank', action: 'wait', last_ok_at: null });
  });

  test('a failed fetch wins over a warning that it would fail: it already has', () => {
    expect(healthOf(failed('ITEM_LOGIN_REQUIRED'), warning(), at(-1), NOW).state).toBe('needs_reauth');
  });

  test('a failure from a payload older than the classification reads as unknown', () => {
    expect(healthOf({ error: 'Could not fetch balances' }, null, null, NOW)).toMatchObject({ state: 'outage', cause: 'unknown', side: 'unknown' });
  });

  test("Plaid's warning makes a working connection \"reconnect soon\", with its date", () => {
    expect(healthOf(answered(), warning(), at(0), NOW)).toEqual({
      state: 'reconnect_soon',
      cause: 'consent_ending',
      side: 'bank',
      action: 'reconnect',
      last_ok_at: at(0),
      ends_at: at(6),
      ends_estimated: false,
    });
    const disconnect = warning({ kind: 'pending_disconnect', ends_estimated: true, reason: 'INSTITUTION_MIGRATION' });
    expect(healthOf(answered(), disconnect, at(0), NOW)).toMatchObject({ state: 'reconnect_soon', cause: 'disconnect_pending', ends_estimated: true });
  });

  test('a warning lapses once the connection answers after the end it announced', () => {
    const over = warning({ ends_at: at(-1) });
    expect(healthOf(answered(), over, at(0), NOW).state).toBe('healthy');
    expect(warningLapsed(over, at(0), null)).toBe(true);
    // Answered last before the end: it still stands.
    expect(warningLapsed(over, at(-2), null)).toBe(false);
    expect(warningLapsed(over, null, null)).toBe(false);
  });

  test('a pending expiration lapses when Plaid reports the consent renewed past its end', () => {
    const w = warning({ ends_at: at(6) });
    expect(healthOf(answered({ consent_expires_at: at(365) }), w, at(0), NOW).state).toBe('healthy');
    // The same expiry written another way is not a renewal.
    expect(warningLapsed(w, at(0), new Date(NOW + 6 * DAY).toUTCString())).toBe(false);
    // A pending disconnect is not about consent: a far consent does not end it.
    expect(warningLapsed(warning({ kind: 'pending_disconnect', ends_at: at(6) }), at(0), at(365))).toBe(false);
  });

  test('a consent Plaid reports as ending within the week is "reconnect soon" without any webhook', () => {
    expect(healthOf(answered({ consent_expires_at: at(RECONNECT_SOON_DAYS - 1) }), null, at(0), NOW)).toMatchObject({
      state: 'reconnect_soon',
      cause: 'consent_ending',
      ends_at: at(RECONNECT_SOON_DAYS - 1),
      ends_estimated: false,
    });
    expect(healthOf(answered({ consent_expires_at: at(RECONNECT_SOON_DAYS + 1) }), null, at(0), NOW).state).toBe('healthy');
    expect(healthOf(answered({ consent_expires_at: 'not a date' }), null, at(0), NOW).state).toBe('healthy');
    expect(healthOf(answered({ consent_expires_at: null }), null, at(0), NOW).state).toBe('healthy');
  });

  test('of a warning and a near consent expiry, the earlier end is the one shown', () => {
    const h = healthOf(answered({ consent_expires_at: at(2) }), warning({ kind: 'pending_disconnect', ends_at: at(5), ends_estimated: true }), at(0), NOW);
    expect(h).toMatchObject({ cause: 'consent_ending', ends_at: at(2), ends_estimated: false });
  });

  test('a good answer missing accounts it used to report is partial; otherwise healthy', () => {
    expect(healthOf(answered({ unconfirmed_missing: 2 }), null, at(0), NOW)).toMatchObject({ state: 'partial', cause: 'vanished', action: 'resolve' });
    expect(healthOf(answered(), null, at(0), NOW)).toEqual({ state: 'healthy', cause: 'ok', side: 'none', action: 'none', last_ok_at: at(0) });
  });
});

describe("Plaid's early warnings, from the webhook", () => {
  test('a pending expiration carries its end, from consent_expiration_time', () => {
    expect(warningFromWebhook({ webhook_code: 'PENDING_EXPIRATION', consent_expiration_time: '2026-10-15T08:00:00Z' }, NOW)).toEqual({
      kind: 'pending_expiration',
      received_at: at(0),
      ends_at: '2026-10-15T08:00:00.000Z',
      ends_estimated: false,
      reason: null,
    });
  });

  test("one without a usable time gets Plaid's stated week, marked as an estimate", () => {
    for (const consent_expiration_time of [undefined, 'soon', at(-3), at(500)]) {
      expect(warningFromWebhook({ webhook_code: 'PENDING_EXPIRATION', consent_expiration_time }, NOW)).toMatchObject({
        ends_at: at(PENDING_DISCONNECT_LEAD_DAYS),
        ends_estimated: true,
      });
    }
  });

  test("a pending disconnect carries no time: a week from now, estimated, with Plaid's reason", () => {
    expect(warningFromWebhook({ webhook_code: 'PENDING_DISCONNECT', reason: 'INSTITUTION_MIGRATION' }, NOW)).toEqual({
      kind: 'pending_disconnect',
      received_at: at(0),
      ends_at: at(7),
      ends_estimated: true,
      reason: 'INSTITUTION_MIGRATION',
    });
    expect(warningFromWebhook({ webhook_code: 'PENDING_DISCONNECT', reason: '<script>' }, NOW)?.reason).toBeNull();
  });

  test('other webhooks carry none', () => {
    for (const webhook_code of ['LOGIN_REPAIRED', 'ERROR', 'NEW_ACCOUNTS_AVAILABLE', undefined]) {
      expect(warningFromWebhook({ webhook_code }, NOW)).toBeNull();
    }
  });

  test('a retried pending disconnect keeps the first estimate, rather than pushing it later', () => {
    const first = warningFromWebhook({ webhook_code: 'PENDING_DISCONNECT' }, NOW)!;
    const retry = warningFromWebhook({ webhook_code: 'PENDING_DISCONNECT' }, NOW + 2 * DAY)!;
    expect(mergeWarning(first, retry)).toEqual(first);
  });

  test("a later pending expiration takes Plaid's latest figure, and keeps when it was first heard", () => {
    const first = warningFromWebhook({ webhook_code: 'PENDING_EXPIRATION', consent_expiration_time: at(7) }, NOW)!;
    const second = warningFromWebhook({ webhook_code: 'PENDING_EXPIRATION', consent_expiration_time: at(6) }, NOW + DAY)!;
    expect(mergeWarning(first, second)).toEqual({ ...second, received_at: first.received_at });
  });

  test('a warning that ended before the new one arrived is replaced; between kinds, the earlier end wins', () => {
    const old = warning({ ends_at: at(-30), received_at: at(-37) });
    const fresh = warning({ kind: 'pending_disconnect', received_at: at(0), ends_at: at(7), ends_estimated: true });
    expect(mergeWarning(old, fresh)).toEqual(fresh);
    expect(mergeWarning(null, fresh)).toEqual(fresh);
    const sooner = warning({ ends_at: at(3) });
    expect(mergeWarning(sooner, fresh)).toEqual(sooner);
    expect(mergeWarning(fresh, sooner)).toEqual(sooner);
  });
});

describe('dates', () => {
  test('isoTime normalizes an ISO time and refuses anything else', () => {
    expect(isoTime('2026-10-15T08:00:00Z')).toBe('2026-10-15T08:00:00.000Z');
    for (const v of [null, undefined, '', 'tomorrow', 12, 'x'.repeat(65)]) expect(isoTime(v)).toBeNull();
  });

  test('days are counted between UTC calendar days, the way the daily job dates its runs', () => {
    expect(utcDaysBetween('2026-10-01T23:59:00Z', Date.parse('2026-10-02T00:01:00Z'))).toBe(1);
    expect(utcDaysBetween('2026-10-01T00:01:00Z', Date.parse('2026-10-01T23:59:00Z'))).toBe(0);
    expect(utcDaysBetween('2026-10-01T13:00:05Z', Date.parse('2026-10-08T13:00:00Z'))).toBe(7);
    expect(Number.isNaN(utcDaysBetween('not a time', NOW))).toBe(true);
  });
});
