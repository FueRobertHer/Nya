// lib/api-token-store.ts
//
// Where API tokens are kept (lib/api-tokens.ts says what they are and how a
// request is checked), in two stores on the storage seam (lib/repo.ts), inside
// the container whose data each token reads:
//
//   api-tokens    a map store, one entry per token under its id (random): its
//                 label, the SHA-256 of its secret, the sign-in account that
//                 made it (with Clerk), when it was made and when it was last
//                 used. Encrypted, like every seam value. Not
//                 exportable: the hashes are credential material, and the data
//                 download lists each token's label and dates itself
//                 (lib/user-export.ts).
//   api-requests  a counter map store: each token's requests in the current
//                 window, for its rate limit. Bookkeeping, never exported.
//
// NEITHER IS BACKED UP (backup: false; lib/export.ts leaves both out). A token
// revoked after a backup was taken must never work again because that backup
// was restored, and nothing could tell the person it had. So a restore deletes
// every token, and people make new ones; restoring never brings one back.
//
// Deleting the account deletes both with the rest of the container. This module
// only declares the stores, so lib/stores.ts can load it without pulling in
// anything else.

import { defineMapStore, defineCounterMapStore } from './repo';
import { RATE_WINDOW_SECONDS } from './api-limits';

/** One token as stored: a label, a hash and dates. */
export type ApiToken = {
  v: 1;
  /** What the person called it ("Raycast", "Claude"). */
  label: string;
  /** SHA-256 of the secret, hex. */
  hash: string;
  /** The Clerk account that made it, which must still own this container and
   *  be allowed in for it to work (lib/api-tokens.ts); null with the shared
   *  password, which has no accounts. */
  user_id: string | null;
  created_at: string;
  /** When it last made a request, to within a minute (lib/api-tokens.ts
   *  LAST_USED_EVERY_MS); null if never. */
  last_used_at: string | null;
};

const KEYS: readonly string[] = ['v', 'label', 'hash', 'user_id', 'created_at', 'last_used_at'];
const HASH = /^[0-9a-f]{64}$/;
const isInstant = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && !Number.isNaN(Date.parse(v));

/**
 * The stored shape, CLOSED: a field this version doesn't know (scopes, say,
 * from a later one) makes the record unrecognised, and an unrecognised token
 * doesn't authenticate, so a rollback can never let a token do more than the
 * version that made it meant. Today's limits on a label are checked when one
 * is made (cleanLabel in lib/api-tokens.ts), not here.
 */
export function isApiToken(v: unknown): v is ApiToken {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const t = v as Record<string, unknown>;
  return (
    Object.keys(t).every((k) => KEYS.includes(k)) &&
    t.v === 1 &&
    typeof t.label === 'string' &&
    typeof t.hash === 'string' &&
    HASH.test(t.hash) &&
    (t.user_id === null || (typeof t.user_id === 'string' && t.user_id.length > 0 && t.user_id.length <= 200)) &&
    isInstant(t.created_at) &&
    (t.last_used_at === null || isInstant(t.last_used_at))
  );
}

export const apiTokenStore = defineMapStore<ApiToken>('api-tokens', {
  what: 'API tokens',
  isValid: isApiToken,
  exportable: false, // credential material; the download lists labels and dates itself
  backup: false, // a restore must never bring back a revoked token (see the header)
});

/** Each token's requests in the current window (lib/api-tokens.ts takeRequest). */
export const apiRequestCount = defineCounterMapStore('api-requests', {
  what: 'API request counts',
  windowSeconds: RATE_WINDOW_SECONDS,
  backup: false, // the tokens' bookkeeping, which goes with them
});
