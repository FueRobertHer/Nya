// components/device-cache.ts
//
// The key the dashboard keeps its last-known snapshot under, on this device.
// One per signed-in account (Clerk), so on a shared device one person's
// balances never paint for another; the shared password's single user keeps
// the plain key.

export const LOCAL_CACHE_KEY = 'nya:dashboard';

export const cacheKeyFor = (viewer?: string) => (viewer ? `${LOCAL_CACHE_KEY}:${viewer}` : LOCAL_CACHE_KEY);
