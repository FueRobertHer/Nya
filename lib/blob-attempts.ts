// lib/blob-attempts.ts
//
// A Vercel Blob call that does the same thing when sent twice (a page of a
// listing, a delete, the lookup before a read), sent again on a new request
// when an attempt stalls.
//
// Neither Blob nor its SDK times out a request: the SDK's client waits up to
// 300 s for an answer, and it retries only a call that fails, never one still
// waiting. So one request whose connection went quiet used to sit until the
// caller's whole limit ran out (the backup's list, keys and prune steps; the
// receipts sweep's listings, at 30 s) and fail a night that a second request
// would have finished in a second. Each attempt now has a time of its own,
// doubling, and is aborted with no reason when it runs out (the SDK stops only
// on the default AbortError, as lib/backup.ts explains), which also drops its
// connection, so the next goes out on a fresh one. The caller's signal still
// bounds them all: once it aborts, nothing is sent again.
//
// Never for a put: the backup's refuses to overwrite, so one sent again after
// a first that landed would fail.

/** How long the first attempt may take. A listing's page or a delete answers
 *  in well under a second; this is for one that never answers. */
export const FIRST_ATTEMPT_MS = 8_000;
/** Attempts at most, for a caller that passes no signal. */
export const MAX_ATTEMPTS = 3;

export async function retryStalled<T>(
  what: string,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  firstMs = FIRST_ATTEMPT_MS
): Promise<T> {
  for (let attempt = 1, ms = firstMs; ; attempt++, ms *= 2) {
    const own = new AbortController();
    const combined = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        stalled = true;
        // Rejected before the abort, so a last attempt fails saying it
        // stalled rather than with the SDK's "aborted".
        reject(new Error(`Vercel Blob didn't answer ${what} within ${ms / 1000}s`));
        own.abort();
      }, ms);
    });
    try {
      return await Promise.race([run(combined), timeout]);
    } catch (err) {
      if (!stalled || signal?.aborted || attempt >= MAX_ATTEMPTS) throw err;
      console.warn(`Vercel Blob didn't answer ${what} within ${ms / 1000}s; sent again on a new request`);
    } finally {
      clearTimeout(timer);
    }
  }
}
