// lib/user-restore/enabled.ts
//
// What the restore routes answer while bringing a download back is off. It is
// the `restore` feature switch (lib/flags.ts; docs/operations.md, "Turning on
// restores"), RESTORE_ENABLED=1 while that is set, off by default, so that the
// release which reads what a restore writes (held rows, the totals hold, the
// unfinished checks) runs before any restore is written: a rollback then
// lands on a release that already reads them. With it off, the read side is
// live, the routes refuse to start, finish or empty, and the card isn't
// offered; a restore already recorded can still be undone.
//
// Carrying a restored account on (lib/connectors/continue.ts; "Carrying a
// restored account on") is the `restore-carry-on` switch, RESTORE_CARRY_ON_ENABLED=1
// while set: a carried-on account's entry is in a shape the release before
// can't read, so the release that reads it runs first, and the switch goes on
// a release later. With it off, tracking asks nothing and makes a new account,
// as Choose accounts says; an account carried on already is still read,
// matched and can still be undone. The answers about restored banks
// (lib/user-restore/answering.ts) need no switch.

/** What the routes answer while it is off. */
export const RESTORE_OFF = 'Bringing back a download isn’t turned on for this copy of Nya yet. Ask whoever runs it.';
