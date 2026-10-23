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

/**
 * Whether tracking an account through a connector may carry on an account
 * a restore brought back (lib/connectors/continue.ts; docs/operations.md,
 * "Carrying a restored account on"). Off unless RESTORE_CARRY_ON_ENABLED=1:
 * a carried-on account's entry is in a shape the release before can't read,
 * so the release that reads it runs first, and the switch goes on a release
 * later. With it off, tracking asks nothing and makes a new account, as
 * Choose accounts says; an account carried on already is still read,
 * matched and can still be undone. The answers about restored banks
 * (lib/user-restore/answering.ts) need no switch.
 */
export function carryOnEnabled(): boolean {
  return process.env.RESTORE_CARRY_ON_ENABLED === '1';
}
