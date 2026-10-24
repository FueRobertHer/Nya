// lib/blob-attempts.ts
//
// A Vercel Blob call that does the same thing when sent twice (a page of a
// listing, a delete, a read), sent again on a new request when an attempt
// doesn't finish in its time.
//
// Neither Blob nor its SDK times out a request: the SDK waits as long as the
// runtime's fetch lets it, and it retries only a call that fails, never one
// still waiting. So one request whose connection went quiet used to sit until
// the caller's whole limit ran out (the backup's read-back, list, keys and
// prune steps; the receipts sweep's listings, at 30 s) and fail a night that a
// second request would have finished in a second. Each attempt now has a time
// of its own, doubling, and is aborted with no reason when it runs out (the
// SDK stops only on the default AbortError, as lib/backup.ts explains), which
// drops its connection, so the next goes out on a new one. The caller's signal
// still bounds them all: once it aborts, nothing is sent again.
//
// An attempt can also run out while the SDK is waiting between its own
// retries of a server or network error. It is then sent again from the start,
// which is why the log says it didn't finish, not that it didn't answer: set
// DEBUG=blob to see the SDK's retries (docs/operations.md).
//
// Never for a put: the backup's refuses to overwrite, so one sent again after
// a first that landed would fail.

/** How long the first attempt may take. A listing's page, a delete or a read
 *  of a backup's file finishes in well under a second; this is for one that
 *  never does, short enough that a 20 s step has room for three. */
export const FIRST_ATTEMPT_MS = 5_000;
/** Attempts at most, whatever time the caller has left. */
export const MAX_ATTEMPTS = 3;

export async function retryStalled<T>(
  what: string,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  firstMs = FIRST_ATTEMPT_MS
): Promise<T> {
  for (let attempt = 1, ms = firstMs; ; attempt++, ms *= 2) {
    signal?.throwIfAborted();
    const own = new AbortController();
    const combined = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        stalled = true;
        // Rejected before the abort, so a last attempt fails saying it ran
        // out rather than with the SDK's "aborted".
        reject(new Error(`Vercel Blob didn't finish ${what} within ${ms / 1000}s`));
        own.abort();
      }, ms);
    });
    try {
      return await Promise.race([run(combined), timeout]);
    } catch (err) {
      if (!stalled || signal?.aborted || attempt >= MAX_ATTEMPTS) throw err;
      console.warn(`Vercel Blob didn't finish ${what} within ${ms / 1000}s; sent again on a new request`);
    } finally {
      clearTimeout(timer);
    }
  }
}
