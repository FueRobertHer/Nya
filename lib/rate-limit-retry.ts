// lib/rate-limit-retry.ts
//
// Plaid answers a burst it will not serve with HTTP 429 and error_type
// RATE_LIMIT_EXCEEDED. That is the one failure worth waiting out: it says
// "not now", not "not this", and a failed balance call closes the snapshot
// gate for the whole day (lib/networth.ts). Anything else is thrown at once.

/** Waits between attempts, in ms: three tries in all, about 3 s at most. */
export const RATE_LIMIT_DELAYS_MS = [1000, 2000] as const;

export function isRateLimited(err: any): boolean {
  const res = err?.response;
  return res?.status === 429 || res?.data?.error_type === 'RATE_LIMIT_EXCEEDED' || res?.data?.error_code === 'RATE_LIMIT_EXCEEDED';
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `call`, trying again after each delay while it is rate limited. */
export async function withRateLimitRetry<T>(
  call: () => Promise<T>,
  delays: readonly number[] = RATE_LIMIT_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = wait
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= delays.length || !isRateLimited(err)) throw err;
      await sleep(delays[attempt]);
    }
  }
}
