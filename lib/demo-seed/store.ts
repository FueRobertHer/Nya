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
export const SEED_VERSION = 1;

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

export const resetCount = defineCounterStore('demo-reset', {
  what: 'demo resets',
  windowSeconds: RESET_WINDOW_SECONDS,
});

