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
 * Deliberately generous rather than tight. /accounts/balance/get refreshes
 * live at the bank and a slow-but-working institution can genuinely take tens
 * of seconds; cutting it off early would turn a slow load into an errored one,
 * and since the gates are all-or-nothing that would ALSO disable caching for
 * every other institution on that load. Slow is better than that.
 *
 * baseOptions is spread into each request's axios config, and a per-call
 * options argument would override it, so this is the floor for every Plaid
 * call in the app -- balances, holdings, liabilities and transaction sync
 * pages alike (each page of a paginated sync gets the full allowance).
 */
const PLAID_TIMEOUT_MS = 30_000;

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
