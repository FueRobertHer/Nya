// lib/sign-repair-store.ts
//
// The jobs of lib/sign-repair.ts, one per account under way, declared alone
// so the store catalogue (lib/stores.ts) loads nothing else: a map store on
// the storage seam (lib/repo.ts), by account id (a provider's own, or a
// manual account's random one). Bookkeeping, not in the download; in
// backups, so a backup taken part way through a job restores it with the
// values it was planned on, and finishing it there turns over only those
// still holding them.

import { defineMapStore } from './repo';
import type { SignLayer } from './history';
import type { Ctx } from './containers';

export const SIGN_LAYERS: readonly SignLayer[] = ['r', 'p', 'e', 'f', 'x'];

/** What a job turns over: each layer's days, each with the account's value
 *  there when it was planned, which it negates only while it is still that. */
export type SignPlan = Partial<Record<SignLayer, [string, number][]>>;

/** Why nothing says how a day was counted (lib/sign-repair.ts): no total that
 *  day, more than one set of accounts explaining it, an account on it whose
 *  type isn't known, more accounts on it than are weighed, a total nothing
 *  explains, or something on it that can't be read. */
export const WHYS = ['no-total', 'ambiguous', 'untyped', 'too-many', 'unexplained', 'unreadable'] as const;
export type Why = (typeof WHYS)[number];

/** One account's re-sign, as stored (see lib/sign-repair.ts). */
export type SignJob = {
  v: 1;
  /** A 'settle' is what a finished job leaves: its day and the day before,
   *  decided again by their totals once a recording that read the old kind
   *  can no longer land. It holds no plan, and refuses nothing. */
  kind: 'retype' | 'repair' | 'settle';
  /** The kind it was read as, and is once the job is done (for a repair,
   *  both its type when it was planned). */
  from: string;
  to: string;
  /** When it began (a retype's day is the first its kind applies to); for a
   *  settle, when its job finished. */
  at: string;
  /** The tag its progress is marked under (lib/history.ts). */
  tag: string;
  /** A settle record's: the day its job began, decided again too. */
  began?: string;
  /** Planned once its kind is the new one; absent before. What a run has
   *  been through is taken out of it when the run stops, so the next one
   *  starts where it left off. */
  plan?: SignPlan;
  /** The days it left as they were, each with why nothing says how it was counted. */
  left?: [string, Why][];
  /** Nights it failed (or turned nothing over, out of time: 'Stalled'), and
   *  the last failure's kind: past MAX_FAILED_NIGHTS
   *  the nightly job leaves it to the operator, whose dry run names it. */
  failures?: number;
  error?: string;
};

/** How many nights a job may fail before the nightly job stops trying it. */
export const MAX_FAILED_NIGHTS = 3;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function isPlan(v: unknown): v is SignPlan {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v).every(
    ([k, list]) =>
      (SIGN_LAYERS as readonly string[]).includes(k) &&
      Array.isArray(list) &&
      list.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && DAY.test(e[0]) && typeof e[1] === 'number' && Number.isFinite(e[1]) && e[1] !== 0)
  );
}

/** The stored shape, closed: a field a later release adds makes a job
 *  unrecognised, never run as something it isn't. */
export function isSignJob(v: unknown): v is SignJob {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const j = v as Record<string, unknown>;
  return (
    Object.keys(j).every((k) => ['v', 'kind', 'from', 'to', 'at', 'tag', 'began', 'plan', 'left', 'failures', 'error'].includes(k)) &&
    j.v === 1 &&
    (j.kind === 'retype' || j.kind === 'repair' || j.kind === 'settle') &&
    isText(j.from, 40) &&
    isText(j.to, 40) &&
    isText(j.at, 40) &&
    !Number.isNaN(Date.parse(j.at)) &&
    isText(j.tag, 80) &&
    (j.began === undefined || (typeof j.began === 'string' && DAY.test(j.began))) &&
    (j.plan === undefined || isPlan(j.plan)) &&
    (j.left === undefined ||
      (Array.isArray(j.left) && j.left.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && DAY.test(e[0]) && (WHYS as readonly unknown[]).includes(e[1])))) &&
    (j.failures === undefined || (Number.isInteger(j.failures) && (j.failures as number) > 0)) &&
    (j.error === undefined || isText(j.error, 80))
  );
}

/** Jobs under way, by account id (see the header). */
export const signJobStore = defineMapStore<SignJob>('sign-repairs', {
  what: 'balance sign repairs',
  isValid: isSignJob,
  exportable: false, // which days of an account's history a job turns over: bookkeeping
});

/** The job turning the account's balances over, if one is under way (a
 *  settle record aside, which holds nothing half turned over). */
export async function pendingJob(ctx: Ctx, account_id: string): Promise<SignJob | null> {
  const job = await signJobStore.get(ctx, account_id);
  return job && job.kind !== 'settle' ? job : null;
}

/** Thrown by what would fold or forget an account's balances while a job
 *  turns them over (lib/history.ts): never meant to be reached, since the
 *  forget and the undo refuse first, with words (lib/links.ts, lib/api-undo.ts). */
export class SignJobPending extends Error {
  constructor(readonly account_id: string) {
    super(`The balances of ${account_id} are being turned over to match its kind.`);
    this.name = 'SignJobPending';
  }
}

/** What the forget and the undo say while one is pending. */
export const SIGN_JOB_PENDING = 'Its past balances are being turned over to match what it is. Try again once that is done: Nya’s next daily update finishes it.';
/** And for one the nightly job has stopped trying (MAX_FAILED_NIGHTS). */
export const SIGN_JOB_STOPPED = 'Its past balances are being turned over to match what it is, and that stopped part way: whoever runs your Nya can finish it. Try again once that is done.';

/** The words for a job pending, by how it has gone. */
export const pendingWords = (job: SignJob): string => ((job.failures ?? 0) >= MAX_FAILED_NIGHTS ? SIGN_JOB_STOPPED : SIGN_JOB_PENDING);
