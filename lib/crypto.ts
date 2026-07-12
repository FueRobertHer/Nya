// lib/crypto.ts
//
// Encrypts Plaid access tokens before they're written to Vercel KV, so that
// a leak of KV credentials or env vars alone doesn't hand over usable
// account-access tokens -- the encryption key is required too.
//
// Uses the Web Crypto API (available in Bun, Node 19+, and Vercel's Edge
// runtime) so this file works unmodified across all of them.

const KEY_ENV_VAR = 'PLAID_ENCRYPTION_KEY';

function getKeyMaterial(): string {
  const key = process.env[KEY_ENV_VAR];
  if (!key) {
    throw new Error(
      `${KEY_ENV_VAR} is not set. Generate one with: openssl rand -base64 32`
    );
  }
  return key;
}

// The key never changes within a process, so import it once and reuse it --
// history/account reads decrypt hundreds of values per request, and
// re-importing for each one is pure waste. A failed import isn't cached, so
// a missing env var stays a per-call error rather than a poisoned singleton.
let _keyPromise: Promise<CryptoKey> | null = null;
function importKey(): Promise<CryptoKey> {
  if (!_keyPromise) {
    _keyPromise = (async () => {
      const raw = Uint8Array.from(atob(getKeyMaterial()), (c) => c.charCodeAt(0));
      if (raw.length !== 32) {
        throw new Error(
          `${KEY_ENV_VAR} must decode to exactly 32 bytes (AES-256). Generate with: openssl rand -base64 32`
        );
      }
      return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    })().catch((err) => {
      _keyPromise = null;
      throw err;
    });
  }
  return _keyPromise;
}

/** Encrypts a plaintext string. Returns a single base64 string (IV + ciphertext). */
export async function encrypt(plaintext: string): Promise<string> {
  const key = await importKey();
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV, standard for GCM
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  // btoa expects a binary string
  let binary = '';
  combined.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

/** Decrypts a string produced by encrypt(). */
export async function decrypt(payload: string): Promise<string> {
  const key = await importKey();
  const binary = atob(payload);
  const combined = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) combined[i] = binary.charCodeAt(i);

  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plainBuf);
}
