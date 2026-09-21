// lib/plaid.ts
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';

if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
  console.warn(
    'WARNING: PLAID_CLIENT_ID / PLAID_SECRET not set. Copy .env.example to .env.local and fill them in.'
  );
}

/**
 * Per-request ceiling, in ms. The SDK is axios underneath and sets no timeout of
 * its own, so without this a single wedged institution holds an entire dashboard
 * load open until the platform kills the whole function -- taking the five
 * healthy institutions down with it and returning nothing at all. With it, the
 * wedged Item alone fails, which the caller already knows how to render: its
 * card falls back to last-known balances (lib/last-known.ts) and the snapshot
 * and cache gates close, exactly as for any other failed fetch.
 *
 * Deliberately generous rather than tight, and the number is taken from Plaid
 * rather than picked. Their own documentation for /accounts/balance/get -- the
 * call on the critical path here -- says latency is "typically less than 10
 * seconds, but occasionally up to 30 seconds or more", and advises adjusting
 * the timeout accordingly. So 30s would sit exactly ON the documented range and
 * cut off institutions that were going to answer. That matters more than it
 * looks: the snapshot and cache gates are all-or-nothing, so one institution
 * timed out early doesn't just lose its own balances, it skips the day's
 * snapshot and clears the cache for every other institution on that load.
 * Above the range, this only ever fires on a call that was not coming back.
 *
 * baseOptions is spread into each request's axios config, and a per-call
 * options argument would override it, so this is the floor for every Plaid
 * call in the app -- balances, holdings, liabilities and transaction sync
 * pages alike (each page of a paginated sync gets the full allowance).
 *
 * Callers must classify what comes out: axios reports a timeout as ECONNABORTED
 * (or ETIMEDOUT) with NO response, so `err.response.data.error_code` is
 * undefined and any code matching on it falls through to its generic branch.
 * Where that generic branch is durable rather than retried, the timeout needs
 * naming explicitly -- see the ECONNABORTED case in lib/investments.ts, which
 * would otherwise let one slow call permanently mark a backfill complete.
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

export const plaidClient = new PlaidApi(configuration);
