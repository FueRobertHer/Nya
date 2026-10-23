'use client';

// The unfinished restore, said on every tab (components/RestoreCard.tsx):
// while one is being written or undone here, what the dashboard shows is
// only part of the data, and no net worth total is recorded. From the net
// worth answer's hold (lib/user-restore/restored.ts totalsHold), so it asks
// nothing of its own.

import type { RestoreHoldNote } from './total-notes';

export default function RestoreBanner({ hold, onOpen }: { hold: RestoreHoldNote | null; onOpen: () => void }) {
  if (!hold?.unfinished) return null;
  return (
    <div className="card restore-banner" role="status">
      <p className="stale-note">
        A restore hasn’t finished here: what you see is only part of your data, and no net worth total is recorded until it does. Go on with the same file, or
        undo it.
      </p>
      <button className="secondary" onClick={onOpen}>
        Go to it
      </button>
    </div>
  );
}
