// components/device-cache.ts
//
// The key the dashboard keeps its last-known snapshot under, on this device.
// One per signed-in account (Clerk), so on a shared device one person's
// balances never paint for another; the shared password's single user keeps
// the plain key.

export const LOCAL_CACHE_KEY = 'nya:dashboard';

export const cacheKeyFor = (viewer?: string) => (viewer ? `${LOCAL_CACHE_KEY}:${viewer}` : LOCAL_CACHE_KEY);

/**
 * What the parts read beside the balances (the timeline notes, the
 * connections, what is shared with you) read again on, after a load whose
 * balances are from `asOf`: that time, once it differs from what they were
 * read with. `key` is the one they have; `saved`, the time of the snapshot
 * this device painted first (undefined when it had none). Before any load the
 * key is null, and a first load whose time is the snapshot's keeps it: the
 * parts were read as the page opened, after both, so reading them again then
 * would only repeat it.
 */
export function reloadKeyAfter(key: string | null, asOf: string | null, saved: string | null | undefined): string | null {
  return key === null && asOf === saved ? key : asOf;
}
