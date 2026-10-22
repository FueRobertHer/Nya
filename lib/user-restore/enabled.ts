// lib/user-restore/enabled.ts
//
// Whether this deployment offers bringing a download back (docs/operations.md,
// "Turning on restores"). Off unless RESTORE_ENABLED=1, so that the release
// which reads what a restore writes (held rows, the totals hold, the
// unfinished checks) runs before any restore is written: a rollback then
// lands on a release that already reads them. With it off, the read side is
// live, the routes refuse to start, finish or empty, and the card isn't
// offered; a restore already recorded can still be undone.

export function restoreEnabled(): boolean {
  return process.env.RESTORE_ENABLED === '1';
}

/** What the routes answer while it is off. */
export const RESTORE_OFF = 'Bringing back a download isn’t turned on for this copy of Nya yet. Ask whoever runs it.';
