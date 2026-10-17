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

/** Requests with tokens that don't work, per address, before it is turned
 *  away for the rest of the window (lib/rate-limit.ts). A flood limit, not a
 *  guessing one: a 256-bit secret can't be guessed, so this only bounds what
 *  garbage costs. 600 in 10 minutes is one a second, held for ten minutes:
 *  a forgotten script retrying a revoked token every few seconds stays far
 *  under it, as do several behind one office, VPN, carrier or CI address,
 *  while a flood (dozens a second) reaches it within a minute. Until then a
 *  failure costs three commands (two reads and the count), so an address
 *  costs at most 1,800 in a window before each request costs one read. */
export const API_AUTH_MAX_FAILURES = 600;
export const API_AUTH_WINDOW_SECONDS = 10 * 60;

/** Transactions per page of /api/v1/transactions: the default, and the most. */
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;

/** The same for the MCP server's search_transactions, whose answer carries
 *  the result twice (as text, and as structured content) into a model's
 *  context: smaller pages, the same cursor. */
export const MCP_DEFAULT_PAGE_SIZE = 25;
export const MCP_MAX_PAGE_SIZE = 100;

/** The most a tool's result may come to, as JSON, in bytes (lib/mcp.ts): it
 *  is sent twice, so an answer stays well inside what a function may send
 *  back (Vercel's 4.5 MB). A larger one is refused with how to ask for less. */
export const MCP_MAX_RESULT_BYTES = 1_000_000;
