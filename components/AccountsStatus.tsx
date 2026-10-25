// components/AccountsStatus.tsx
//
// The Accounts tab's status pill (rollout phase 3c): how many connections
// have a problem, in each one's color from lib/accounts-status.ts, so it
// agrees with the cards and Settings > Connections. It counts and jumps; the
// words of what is wrong stay on the card. Red says "problem", not "needs
// you": a total missing money during an outage is red with nothing for the
// person to do. Green only when every connection was read in this load.

import { worse, type Severity } from '@/lib/accounts-status';

/** One connection's color. Cards of one SimpleFIN or Lunch Flow connection
 *  share a key and count once, at the worst of them. */
export type StatusEntry = { key: string; severity: Severity | null };

export function statusCounts(entries: readonly StatusEntry[]): { critical: number; caution: number } {
  const byKey = new Map<string, Severity | null>();
  for (const e of entries) byKey.set(e.key, worse(byKey.get(e.key) ?? null, e.severity));
  const all = [...byKey.values()];
  return { critical: all.filter((s) => s === 'critical').length, caution: all.filter((s) => s === 'caution').length };
}

const CHEVRON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

const CHECK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export default function AccountsStatus({
  entries,
  known,
  healthRead,
  syncing,
  onGo,
}: {
  entries: readonly StatusEntry[];
  /** Every connection's state was read in this load: the accounts came from
   *  the server, not this device's snapshot, and so did the connector
   *  list. Otherwise nothing is shown: a count from old data could be wrong,
   *  and the tab's notices say what wasn't read. */
  known: boolean;
  /** Plaid's warnings and last sync times were read, so a connection that is
   *  about to end would say so. Without them, no "All synced". */
  healthRead: boolean;
  /** At least one connection that syncs (not only accounts typed by hand). */
  syncing: boolean;
  /** Go to the first that needs attention, worst first. */
  onGo: () => void;
}) {
  if (!known) return null;
  const { critical, caution } = statusCounts(entries);
  if (critical > 0) {
    const also = caution > 0 ? `, ${caution} to check` : '';
    return (
      <button
        type="button"
        className="chip neg"
        aria-label={`${critical} problem${critical === 1 ? '' : 's'}${also}: go to the first connection`}
        onClick={onGo}
      >
        {`${critical} problem${critical === 1 ? '' : 's'}`}
        {CHEVRON}
      </button>
    );
  }
  if (caution > 0) {
    return (
      <button type="button" className="chip warn" aria-label={`${caution} to check: go to the first connection`} onClick={onGo}>
        {`${caution} to check`}
        {CHEVRON}
      </button>
    );
  }
  if (!syncing || !healthRead) return null;
  return (
    <span className="badge pos">
      {CHECK}
      All synced
    </span>
  );
}
