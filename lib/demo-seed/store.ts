// lib/demo-seed/store.ts
//
// What a demo account keeps about its resets (lib/demo-seed/reset.ts): the
// record of the last one and the count that limits them. Both are machinery,
// kept when the account is emptied (lib/user-restore/classes.ts), since the
// reset empties it part way through. Apart from reset.ts so lib/stores.ts can
// declare them without loading the seed.

import { defineCounterStore, defineValueStore } from '../repo';

/** Raised when what the seed writes changes shape or meaning, so an older
 *  deployment refuses to reset over a newer one's. */
export const SEED_VERSION = 4;

/** How often one demo account may be reset. */
export const RESET_WINDOW_SECONDS = 10 * 60;

export type SeedRecord = {
  version: number;
  scenario: string;
  started_at: string;
  /** Null while a reset runs, and after one that stopped part way. */
  finished_at: string | null;
};

const isSeedRecord = (v: unknown): v is SeedRecord => {
  const r = v as SeedRecord;
  return (
    typeof v === 'object' &&
    v !== null &&
    Number.isSafeInteger(r.version) &&
    typeof r.scenario === 'string' &&
    typeof r.started_at === 'string' &&
    (r.finished_at === null || typeof r.finished_at === 'string')
  );
};

export const seedRecordStore = defineValueStore<SeedRecord>('demo-seed', {
  what: 'records of demo resets',
  isValid: isSeedRecord,
  exportable: false, // the demo's own bookkeeping
});

/** Longer than a reset can run (the route's maxDuration, with room): one
 *  unfinished for longer stopped part way. */
export const RESET_RUNS_AT_MOST_MS = 6 * 60_000;

/** Where the last reset stands: finished, still running, or stopped part way
 *  (unfinished, and older than any reset can run). Here rather than in
 *  reset.ts, so the sign-in page can read it without loading the seed
 *  (lib/demo-seed/loaded.ts). */
export function resetPhase(record: SeedRecord, now: number = Date.now()): 'finished' | 'running' | 'stopped' {
  if (record.finished_at !== null) return 'finished';
  const started = Date.parse(record.started_at);
  return Number.isFinite(started) && now - started < RESET_RUNS_AT_MOST_MS ? 'running' : 'stopped';
}

export const resetCount = defineCounterStore('demo-reset', {
  what: 'demo resets',
  windowSeconds: RESET_WINDOW_SECONDS,
});

