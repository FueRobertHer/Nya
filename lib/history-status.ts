// lib/history-status.ts
//
// Client-safe checks on the net-worth series the dashboard already holds. Its
// own module rather than part of lib/history.ts because that one imports the
// Redis client, and this runs in the browser.

/**
 * The last recorded day, when recording has stalled; null when it hasn't.
 *
 * A day is only saved when every institution answers, so one broken bank stops
 * the chart silently; this once went unnoticed for three weeks.
 *
 * Measured against the payload's `asOf`, not the clock, so the localStorage
 * snapshot painted on open can't raise the alarm just for being old. Two days
 * rather than one: the cron records at 13:00 UTC, so yesterday being the
 * newest point is normal for most of the day. Null when nothing real was ever
 * recorded, which the empty-chart note already covers.
 */
export function historyPausedSince(
  history: { date: string; estimated?: boolean }[],
  asOf: string | null
): string | null {
  if (!asOf) return null;
  let lastReal: string | null = null;
  for (const p of history) if (!p.estimated && (!lastReal || p.date > lastReal)) lastReal = p.date;
  if (!lastReal) return null;
  const days =
    (Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`) - Date.parse(`${lastReal}T00:00:00Z`)) /
    (24 * 60 * 60 * 1000);
  return days >= 2 ? lastReal : null;
}
