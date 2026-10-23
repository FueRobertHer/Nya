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

// ---- Writing (lib/api-run.ts, lib/api-writes.ts) ----

/** What a token may do, chosen once when it is made (lib/api-tokens.ts):
 *  read; read only the accounts and set a manual account's balance; or read
 *  and make the changes this release offers (WRITE_V1 in lib/api-spec.ts).
 *  A value means the same for good: a kind of change added later comes with
 *  a value of its own, so no token ever gains it. */
export const ACCESS = ['read', 'balances', 'write'] as const;
export type Access = (typeof ACCESS)[number];

/** Writes each token may send in WRITE_WINDOW_SECONDS, valid or not. */
export const WRITES_PER_MINUTE = 30;
export const WRITE_WINDOW_SECONDS = 60;
/** Changes in a window of DAY_WINDOW_SECONDS (from its first count): each
 *  token's, all of a person's tokens' together, and each token's creates. A
 *  balance sent that changes nothing is none. */
export const CHANGES_PER_DAY = 500;
export const PERSON_CHANGES_PER_DAY = 2000;
export const CREATES_PER_DAY = 100;
export const DAY_WINDOW_SECONDS = 24 * 60 * 60;

/** The share of each of the app's own limits (categories, groups, tags,
 *  manual accounts) a create through the API may fill: the rest is kept for
 *  what the app makes itself, such as a category a bank starts using. */
export const API_ROOM = 0.9;

/** How long the record of changes keeps each change (lib/api-changes.ts). */
export const CHANGES_KEEP_DAYS = 30;
/** How long an Idempotency-Key names its create. */
export const IDEMPOTENCY_HOURS = 24;
/**
 * How long a create's first attempt, or an undo, may still be running: past
 * every route that can run one (the REST writes' maxDuration of 30 seconds,
 * the MCP server's and the undo routes' 120), with room, so a takeover never
 * runs beside a first attempt that is still running (test/api-writes.test.ts
 * holds the routes to it).
 */
export const PENDING_MS = 150_000;
/** The largest body a write takes, in characters. */
export const WRITE_BODY_MAX = 8 * 1024;

/** The most a tool's result may come to, as JSON, in bytes (lib/mcp.ts): it
 *  is sent twice, so an answer stays well inside what a function may send
 *  back (Vercel's 4.5 MB). A larger one is refused with how to ask for less. */
export const MCP_MAX_RESULT_BYTES = 1_000_000;
