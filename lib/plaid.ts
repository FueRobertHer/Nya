// lib/plaid.ts
import { Configuration, PlaidEnvironments } from 'plaid';
import { makePlaidClient } from './plaid-scrub';

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';

if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
  console.warn(
    'WARNING: PLAID_CLIENT_ID / PLAID_SECRET not set. Copy .env.example to .env.local and fill them in.'
  );
}

/**
 * Per-request ceiling, in ms. The SDK is axios underneath and sets no timeout, so
 * without this one wedged institution holds a whole dashboard load open until the
 * platform kills the function, taking the healthy institutions down with it. With
 * it, only the wedged Item fails, which the caller already renders: its card falls
 * back to last-known balances (lib/last-known.ts) and the snapshot and cache gates
 * close, as for any failed fetch.
 *
 * Deliberately generous, and the number comes from Plaid: its docs for
 * /accounts/balance/get (the slowest balance call, no longer on the critical path
 * since the app reads /accounts/get) say latency is "typically less than 10
 * seconds, but occasionally up to 30 seconds or more". A 30s cutoff would sit on
 * that range and cut off institutions that were going to answer, which matters
 * because the snapshot and cache gates are all-or-nothing: one institution timed
 * out early skips the day's snapshot and clears the cache for every other one.
 * Above the range, this only fires on a call that was not coming back.
 *
 * baseOptions is spread into each request's axios config (a per-call options
 * argument would override it), so this is the floor for every Plaid call:
 * balances, holdings, liabilities and each page of a transaction sync.
 *
 * Callers must classify what comes out: axios reports a timeout as ECONNABORTED
 * (or ETIMEDOUT) with NO response, so `err.response.data.error_code` is undefined
 * and code matching on it falls through to its generic branch. Where that branch
 * is durable rather than retried, the timeout needs naming explicitly (see
 * lib/investments.ts, where one slow call would otherwise permanently mark a
 * backfill complete).
 */
const PLAID_TIMEOUT_MS = 45_000;

const configuration = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV as keyof typeof PlaidEnvironments],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET': PLAID_SECRET,
    },
    timeout: PLAID_TIMEOUT_MS,
  },
});

// Built through makePlaidClient so a failed call never throws an error that
// still holds the request, secret and access token included (lib/plaid-scrub.ts).
export const plaidClient = makePlaidClient(configuration);
