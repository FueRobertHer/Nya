// lib/demo-seed/reset.ts
//
// Resetting a demo account to a scenario (lib/demo-seed/scenarios.ts): what
// the Demo data card asks for (app/api/demo/seed) and the CLI runs
// (scripts/seed-demo.ts), each through resetDemoAccount, so both are held to
// the same limit and lock.
//
// ONE AT A TIME, AND NOT TOO OFTEN. Each demo account may be reset once in
// RESET_WINDOW_SECONDS, counted on the seam (a counter store, kept when the
// account is emptied). The count is atomic, so of two resets started together
// only one runs: the limit is the lock too, since a reset ends long before
// its window does (the route's maxDuration is a few minutes). A visitor who
// signs in as Alex can't keep Alex empty for the next one.
//
// A RECORD of the last reset (the `demo-seed` store, kept when emptied):
// which scenario, when it started and whether it finished. One that started
// and never finished (a function stopped part way) is shown on the card as
// partly reset, to be reset again. It also holds the seed's version, so a
// Preview deployment of an older branch, which shares the database, doesn't
// reset the demo to what a newer one has moved past.
//
// SHARING ENDS. The account's connections to other people go before the
// reset, so nobody it shared with goes on seeing whatever the next scenario
// is (lib/sharing.ts dropConnectionsOf, as deleting an account does).

import { dropConnectionsOf } from '../sharing';
import type { Ctx } from '../containers';
import { checkEmptiable, seedDemoAccount, type SeedOptions, type SeedReport } from './seed';
import { SeedRefused } from './guard';
import type { Scenario } from './scenarios';
import { minutesText } from './words';
import { RESET_WINDOW_SECONDS, SEED_VERSION, resetCount, seedRecordStore, type SeedRecord } from './store';

export { RESET_WINDOW_SECONDS, SEED_VERSION, type SeedRecord };

/** Refused for the limit: how long until a reset may run again. */
export class ResetLimited extends Error {
  constructor(readonly secondsLeft: number) {
    super(`This demo account was reset in the last ${RESET_WINDOW_SECONDS / 60} minutes. Try again in ${minutesText(secondsLeft)}.`);
    this.name = 'ResetLimited';
  }
}

export type ResetState = { record: SeedRecord | null; secondsLeft: number };

/** Longer than a reset can run (the route's maxDuration, with room): one
 *  unfinished for longer stopped part way. */
export const RESET_RUNS_AT_MOST_MS = 6 * 60_000;

/** Where the last reset stands: finished, still running, or stopped part way
 *  (unfinished, and older than any reset can run). */
export function resetPhase(record: SeedRecord, now: number = Date.now()): 'finished' | 'running' | 'stopped' {
  if (record.finished_at !== null) return 'finished';
  const started = Date.parse(record.started_at);
  return Number.isFinite(started) && now - started < RESET_RUNS_AT_MOST_MS ? 'running' : 'stopped';
}

/** The last reset, and how long until the next may run (0: now). */
export async function resetState(ctx: Ctx): Promise<ResetState> {
  const [record, window] = await Promise.all([seedRecordStore.get(ctx), resetCount.read(ctx)]);
  return { record, secondsLeft: window.count > 0 ? window.secondsLeft : 0 };
}

/** Replaces everything in the demo account with the scenario, as of `today`.
 *  Checks first what would refuse it part way, then takes the one reset its
 *  window allows. */
export async function resetDemoAccount(
  target: { ctx: Ctx; userId: string },
  scenario: Scenario,
  today: string,
  opts: SeedOptions = {}
): Promise<SeedReport> {
  const { ctx, userId } = target;
  const before = await seedRecordStore.get(ctx);
  if (before && before.version > SEED_VERSION) {
    throw new SeedRefused('A newer version of Nya last reset this demo account, so this one leaves it alone: reset it from the newest deployment.');
  }
  await checkEmptiable(ctx);
  const window = await resetCount.take(ctx);
  if (window.count > 1) throw new ResetLimited(window.secondsLeft);

  await seedRecordStore.set(ctx, { version: SEED_VERSION, scenario: scenario.id, started_at: new Date().toISOString(), finished_at: null });
  await dropConnectionsOf(userId);
  const report = await seedDemoAccount(ctx, userId, scenario.build(today), today, opts);
  await seedRecordStore.update(ctx, (cur) => (cur ? { ...cur, finished_at: new Date().toISOString() } : cur));
  return report;
}
