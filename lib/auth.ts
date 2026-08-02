// lib/auth.ts
//
// Single shared-password auth: one household password protects every route.
// The session cookie is `issuedAt.signature`, where signature is an HMAC of
// issuedAt keyed by SESSION_SECRET -- it can't be forged without the secret,
// and it naturally expires (checked server-side, not just via cookie maxAge).
//
// Uses Web Crypto so this works identically in Edge middleware, Bun, and Node.

export const SESSION_COOKIE_NAME = 'nwt_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

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

export async function createSessionToken(): Promise<string> {
  const issuedAt = Date.now().toString();
  const sig = await hmac(issuedAt);
  return `${issuedAt}.${sig}`;
}

export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const [issuedAt, sig] = token.split('.');
  if (!issuedAt || !sig) return false;

  const expected = await hmac(issuedAt);
  if (expected !== sig) return false;

  const age = Date.now() - Number(issuedAt);
  if (Number.isNaN(age) || age < 0 || age > SESSION_MAX_AGE_SECONDS * 1000) return false;

  return true;
}

/**
 * Constant-time string equality. Hashes both sides first so the comparison
 * runs over fixed-length hex regardless of input, meaning neither the length
 * nor the content of the real secret leaks through timing.
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
