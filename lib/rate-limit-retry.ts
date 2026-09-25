// lib/rate-limit-retry.ts
//
// Plaid answers a burst it will not serve with HTTP 429 and error_type
// RATE_LIMIT_EXCEEDED. That is the one failure worth waiting out: it says
// "not now", not "not this", and a failed balance call closes the snapshot
// gate for the whole day (lib/networth.ts). Anything else is thrown at once.
//
// Only the balance call is wrapped: holdings and liabilities do not decide
// the recorded total. Plaid's per-Item balance limit
// (ACCOUNTS_BALANCE_GET_LIMIT) often outlasts these few seconds; this covers
// the short bursts, and the catch-up cron covers the rest. On the dashboard it
// can add up to 3 s to a load that would otherwise show a failed card.

/** Waits between attempts, in ms: three tries in all, about 3 s at most. */
export const RATE_LIMIT_DELAYS_MS = [1000, 2000] as const;
/** No retry once this long has passed since the first try. A 429 is normally
 *  immediate; one that took most of the 45 s timeout to arrive is not waited
 *  out again, or three tries could outlast the snapshot's time budget. */
export const RATE_LIMIT_MAX_ELAPSED_MS = 10_000;

export function isRateLimited(err: any): boolean {
  const res = err?.response;
  return res?.status === 429 || res?.data?.error_type === 'RATE_LIMIT_EXCEEDED' || res?.data?.error_code === 'RATE_LIMIT_EXCEEDED';
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `call`, trying again after each delay while it is rate limited. */
export async function withRateLimitRetry<T>(
  call: () => Promise<T>,
  delays: readonly number[] = RATE_LIMIT_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = wait,
  now: () => number = Date.now
): Promise<T> {
  const start = now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= delays.length || !isRateLimited(err)) throw err;
      if (now() - start > RATE_LIMIT_MAX_ELAPSED_MS) throw err;
      await sleep(delays[attempt]);
    }
  }
}
