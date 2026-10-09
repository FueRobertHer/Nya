// lib/api-limits.ts
//
// The numbers the read-only API (app/api/v1, app/api/mcp) keeps to, in a
// module of their own, free of server imports, because three places state
// them and must agree: the limits themselves (lib/api-tokens.ts,
// lib/api-http.ts), the API tokens card (components/ApiTokens.tsx) and the
// developer page (app/developers).

/** The version of the API's paths and shapes: /api/v1. */
export const API_VERSION = '1';

/** What every token starts with, so it can be recognised (by a person, or a
 *  secret scanner). */
export const TOKEN_PREFIX = 'nya_';

/** Tokens one person may have at once. */
export const MAX_TOKENS = 10;

/** The longest name a token may have. */
export const LABEL_MAX = 60;

/** Requests each token may make in RATE_WINDOW_SECONDS. */
export const REQUESTS_PER_MINUTE = 100;
export const RATE_WINDOW_SECONDS = 60;

/** Transactions per page of /api/v1/transactions: the default, and the most. */
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;
