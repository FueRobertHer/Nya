// lib/redis-limit.ts
//
// How long one request to Upstash may take (lib/storage.ts gives it to both
// clients). Upstash sets no limit, and its client retries only a request that
// fails, never one still waiting, so one that went quiet used to hold a cron
// (the snapshot, the backup) until Vercel ended it, with no outcome recorded.
// Over the limit, the request fails like any other error, which every caller
// already handles. A module of its own so test/storage-limit.test.ts reaches
// it whatever other tests do to lib/storage.ts.

/** Generous: a page of the export (about 190 keys) answers in well under a
 *  second. */
export const REDIS_REQUEST_MS = 15_000;
/** The same for the client the export and the restore use (rawRedis), whose
 *  requests carry pages of whole values, up to about 8 MB. */
export const RAW_REDIS_REQUEST_MS = 60_000;

/** The limit as the client takes it: a function, called for each request.
 *  Only then does the client throw when it aborts. Handed a signal itself, it
 *  answers the abort's reason as if it were the stored value (@upstash/redis
 *  1.38, HttpClient.request; test/storage-limit.test.ts holds it to that). */
export const requestLimit = (ms: number) => () => AbortSignal.timeout(ms);
