// lib/auth.ts
//
// Sessions (#56). One household password protects every route; this module
// only decides whether a session token is still good. Who you are is decided
// at /api/login, and the two stay separate: when real accounts arrive, login
// changes completely and this should not have to.
//
// A token is  v1.<base64url(claims JSON)>.<hex HMAC-SHA256 of "v1.<claims>">
// keyed by SESSION_SECRET. The claims:
//
//   v          1. A versioned object rather than a positional format, so
//              adding a user or capabilities later does not break outstanding
//              tokens. Any other version is rejected, never guessed at.
//   container  which data the session may reach (a container id, #53).
//   epoch      the container's session epoch when it was issued. Bumping the
//              stored epoch (lib/sessions.ts) ends every older session.
//   iat        issued at, ms. Checked here, not left to the cookie's maxAge.
//   pw         a tag derived from APP_PASSWORD. Changing the password
//              changes the tag, which ends every session at once.
//
// Tokens from before this format ("<issuedAt>.<hex>") are still accepted until
// they expire (30 days), so nobody is logged out by the upgrade. They name no
// container and carry no password tag, so a password change does not end
// them; "sign out everywhere" does.
//
// Uses Web Crypto so this works the same in the proxy, Bun and Node.

import { isContainerId, type ContainerId } from './containers';

export const SESSION_COOKIE_NAME = 'nwt_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

const VERSION = 1;

export type SessionClaims = { v: 1; container: ContainerId; epoch: number; iat: number; pw: string };

/** A verified session. `container` is null only for a token from before
 *  sessions named one. */
export type Session = { container: ContainerId | null; epoch: number; issuedAt: number; legacy: boolean };

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET is not set. Generate with: openssl rand -base64 32');
  }
  return secret;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(getSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return toHex(sig);
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(buf);
}

function toBase64Url(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** A short tag of APP_PASSWORD, keyed by SESSION_SECRET: it proves nothing
 *  about the password to anyone without the secret, and changes when the
 *  password does. Null when no password is configured. */
async function passwordTag(): Promise<string | null> {
  const password = process.env.APP_PASSWORD;
  if (!password) return null;
  return (await hmac(`nya session password:${password}`)).slice(0, 16);
}

function fresh(issuedAt: number, now: number): boolean {
  const age = now - issuedAt;
  return Number.isFinite(age) && age >= 0 && age <= SESSION_MAX_AGE_SECONDS * 1000;
}

export async function createSessionToken(
  opts: { container: ContainerId; epoch: number },
  now: number = Date.now()
): Promise<string> {
  const pw = await passwordTag();
  if (!pw) throw new Error('APP_PASSWORD is not set.');
  const claims: SessionClaims = { v: VERSION, container: opts.container, epoch: opts.epoch, iat: now, pw };
  const body = `v${VERSION}.${toBase64Url(JSON.stringify(claims))}`;
  return `${body}.${await hmac(body)}`;
}

/**
 * The session a token carries if it is genuine, unexpired and issued under the
 * current password; otherwise null. Whether its epoch is still current is a
 * separate check that needs the database (lib/sessions.ts).
 */
export async function verifySessionToken(
  token: string | undefined | null,
  now: number = Date.now()
): Promise<Session | null> {
  if (!token) return null;
  const parts = token.split('.');

  // The format before claims: "<issuedAt>.<hex>", signed over issuedAt alone.
  if (parts.length === 2 && /^\d{1,16}$/.test(parts[0])) {
    const [issuedAt, sig] = parts;
    if (!(await secretsMatch(sig, await hmac(issuedAt)))) return null;
    const iat = Number(issuedAt);
    if (!fresh(iat, now)) return null;
    return { container: null, epoch: 0, issuedAt: iat, legacy: true };
  }

  if (parts.length !== 3 || parts[0] !== `v${VERSION}`) return null; // unknown or future version
  const body = `${parts[0]}.${parts[1]}`;
  if (!(await secretsMatch(parts[2], await hmac(body)))) return null;

  const json = fromBase64Url(parts[1]);
  if (json === null) return null;
  let claims: Partial<SessionClaims>;
  try {
    claims = JSON.parse(json);
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object' || claims.v !== VERSION) return null;
  if (!isContainerId(claims.container)) return null;
  if (!Number.isSafeInteger(claims.epoch) || (claims.epoch as number) < 0) return null;
  if (typeof claims.iat !== 'number' || !fresh(claims.iat, now)) return null;
  const pw = await passwordTag();
  if (!pw || typeof claims.pw !== 'string' || !(await secretsMatch(claims.pw, pw))) return null;

  return { container: claims.container, epoch: claims.epoch as number, issuedAt: claims.iat, legacy: false };
}

/**
 * Constant-time string equality. Hashes both sides first so the comparison
 * runs over fixed-length hex regardless of input, meaning neither the length
 * nor the content of the real secret leaks through timing. For comparing a
 * shared secret or a signature; it is not a password hash and must never be
 * used as one.
 */
export async function secretsMatch(candidate: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(candidate), sha256Hex(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Compares against APP_PASSWORD via fixed-length hash comparison, so timing doesn't leak the real password's length. */
export async function verifyPassword(candidate: string): Promise<boolean> {
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    throw new Error('APP_PASSWORD is not set.');
  }
  return secretsMatch(candidate, expected);
}
