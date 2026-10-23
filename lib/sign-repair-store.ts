// lib/sign-repair-store.ts
//
// The jobs of lib/sign-repair.ts, one per account under way, declared alone
// so the store catalogue (lib/stores.ts) loads nothing else: a map store on
// the storage seam (lib/repo.ts), by account id (a provider's own, or a
// manual account's random one). Bookkeeping, not in the download; in
// backups, so a backup taken part way through a job restores it with the
// values it was planned on, and finishing it there negates only those.

import { defineMapStore } from './repo';
import type { SignLayer } from './history';

export const SIGN_LAYERS: readonly SignLayer[] = ['r', 'p', 'e', 'f', 'x'];

/** What a job negates: each layer's days, each with a digest of the stored
 *  map it was planned on. */
export type SignPlan = Partial<Record<SignLayer, [string, string][]>>;

/** One account's re-sign, as stored (see the header). */
export type SignJob = {
  v: 1;
  kind: 'retype' | 'repair';
  /** The kind it was read as, and is once the job is done (for a repair,
   *  both its type now). */
  from: string;
  to: string;
  /** When it began: a retype's day is the first its kind applies to. */
  at: string;
  /** The tag its progress is marked under (lib/history.ts). */
  tag: string;
  /** Planned once its kind is the new one; absent before. */
  plan?: SignPlan;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DIGEST = /^[0-9a-f]{16}$/;
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function isPlan(v: unknown): v is SignPlan {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v).every(
    ([k, list]) =>
      (SIGN_LAYERS as readonly string[]).includes(k) &&
      Array.isArray(list) &&
      list.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && DAY.test(e[0]) && typeof e[1] === 'string' && DIGEST.test(e[1]))
  );
}

/** The stored shape, closed: a field a later release adds makes a job
 *  unrecognised, never run as something it isn't. */
export function isSignJob(v: unknown): v is SignJob {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const j = v as Record<string, unknown>;
  return (
    Object.keys(j).every((k) => ['v', 'kind', 'from', 'to', 'at', 'tag', 'plan'].includes(k)) &&
    j.v === 1 &&
    (j.kind === 'retype' || j.kind === 'repair') &&
    isText(j.from, 40) &&
    isText(j.to, 40) &&
    isText(j.at, 40) &&
    !Number.isNaN(Date.parse(j.at)) &&
    isText(j.tag, 80) &&
    (j.plan === undefined || isPlan(j.plan))
  );
}

/** Jobs under way, by account id (see the header). */
export const signJobStore = defineMapStore<SignJob>('sign-repairs', {
  what: 'balance sign repairs',
  isValid: isSignJob,
  exportable: false, // which days of an account's history a job negates: bookkeeping
});
