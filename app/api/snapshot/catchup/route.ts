// The catch-up run of the daily snapshot (vercel.json), two hours after the
// first: the same job, which skips every container already recorded that day.
// Its own path so it is its own cron entry, and excluded from the session gate
// in proxy.ts like /api/snapshot.
export { GET } from '../route';

export const maxDuration = 300;
