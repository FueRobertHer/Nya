// lib/demo-seed/loaded.ts
//
// Which scenario each demo account was last reset to (lib/demo-seed/
// scenarios.ts), for the sign-in page, which names it under the account's
// button (app/sign-in, components/DemoSignIn.tsx). Read on the server with
// no session: the container the demo account owns, found as the reset finds
// it (guard.ts demoTarget, which only reads), and in it the record of its
// last reset (store.ts).
//
// It names what was loaded, not what is there now: visitors may change the
// data since, and the line stays true. A reset still running, or one that
// stopped part way (store.ts resetPhase), has no line, and neither does an
// account whose record can't be read: the page is public and loads whatever
// the store does, so any failure is no line, never an error.
//
// NEVER LONG. The reads have LOADED_WAIT_MS in all; an account that hasn't
// answered by then has no line. One answer serves every load for
// LOADED_KEPT_MS in this process (a reset shows on the page within that), so
// bots and reloads don't read storage each time, and loads that arrive
// together wait on one read.

import type { DemoUser } from '../demo';
import { demoTarget, SeedRefused } from './guard';
import { scenarioById } from './scenarios';
import { resetPhase, seedRecordStore } from './store';

/** How long the sign-in page waits for the reads, in all. */
export const LOADED_WAIT_MS = 800;
/** How long one answer is kept. */
export const LOADED_KEPT_MS = 30_000;

/** The title of the scenario each demo account was last reset to, by its
 *  user id; an account with no line isn't in it. */
export type LoadedScenarios = Record<string, string>;

/** The title for one account, or null; never throws. */
async function loadedTitle(user: DemoUser, now: number): Promise<string | null> {
  try {
    const target = await demoTarget(user.id);
    if (!target) return null;
    const record = await seedRecordStore.get(target.ctx);
    if (!record || resetPhase(record, now) !== 'finished') return null;
    return scenarioById(record.scenario)?.title ?? null;
  } catch (err) {
    // A container the reset refuses (another sign-in owns it too, say) is
    // the demo as set up here, not a failure.
    if (!(err instanceof SeedRefused)) console.error('Demo scenario not read for the sign-in page', err instanceof Error ? err.name : typeof err);
    return null;
  }
}

async function readLoaded(users: DemoUser[], now: number, waitMs: number): Promise<LoadedScenarios> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    const titles = await Promise.all(users.map((u) => Promise.race([loadedTitle(u, now), late])));
    const out: LoadedScenarios = {};
    users.forEach((u, i) => {
      const title = titles[i];
      if (title) out[u.id] = title;
    });
    return out;
  } finally {
    clearTimeout(timer);
  }
}

let kept: { users: string; at: number; answer: Promise<LoadedScenarios> } | null = null;

/** Each demo account's last scenario, for the sign-in page: kept for
 *  LOADED_KEPT_MS, read in LOADED_WAIT_MS at most, and never rejected.
 *  `now` and `waitMs` are for tests. */
export function loadedScenarios(users: DemoUser[], opts: { now?: number; waitMs?: number } = {}): Promise<LoadedScenarios> {
  if (users.length === 0) return Promise.resolve({});
  const now = opts.now ?? Date.now();
  const key = users.map((u) => u.id).join(',');
  if (kept && kept.users === key && now >= kept.at && now - kept.at < LOADED_KEPT_MS) return kept.answer;
  const answer = readLoaded(users, now, opts.waitMs ?? LOADED_WAIT_MS).catch((): LoadedScenarios => ({}));
  kept = { users: key, at: now, answer };
  return answer;
}

/** Forgets the kept answer (tests). */
export function forgetLoadedScenarios(): void {
  kept = null;
}
