// lib/user-restore/send.ts
//
// The page's side of a restore's routes (app/api/user-restore and its
// batch route; docs/data-export.md, "Bringing it back"), after the file is
// collected (lib/user-restore/file.ts collect):
//
//   makePlan     every batch built, its SHA-256 taken, and the parts kept on
//                the storage seam sent to the server's checks (nothing
//                written), so a file is checked to its end before the start
//   startBody    what the start sends: the plan, the file's date, size and
//                version, and what comes back and what doesn't, by count
//   sendBatches  the batches built again from the file and sent from the
//                first one the record doesn't have, in order; each is sent
//                only if its SHA-256 is the plan's, and the server checks it
//                again, so a file changed since is never half sent
//   finishRestore  the finish, once every batch is written
//
// A resume is the same file collected again and sendBatches from where the
// record stopped: the server compares every batch it is sent with the plan.
// The fetch is passed in, so the tests drive the routes themselves. Pure but
// for it: no storage, no secrets, nothing kept.

import { buildBatches, checkedFirst, digestOf, planDigest, type FileSource, type Preview } from './file';
import type { Collected } from './plan';
import type { PlannedBatch, RecordView } from './store';

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Why a restore stopped, in words for the person, with what the server
 *  said when it answered (`status` null when it didn't: offline, say). */
export class RestoreStopped extends Error {
  constructor(
    readonly problem: string,
    readonly status: number | null,
    readonly answer: Record<string, unknown> | null = null
  ) {
    super(problem);
    this.name = 'RestoreStopped';
  }
  /** Seconds until the server takes more (a limit reached), if it said. */
  get retryAfter(): number | null {
    const s = this.answer?.retry_after_seconds;
    return typeof s === 'number' ? s : null;
  }
}

export type Plan = { digest: string; batches: PlannedBatch[] };

/** The day a download was made, as the server's checks take it. */
export const exportedDay = (c: Collected): string => new Date(c.exported_at).toISOString().slice(0, 10);

async function call(fetcher: Fetcher, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetcher(url, init);
  } catch {
    throw new RestoreStopped('Nya couldn’t be reached. Check the connection, then go on from where it stopped.', null);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const said = typeof body?.error === 'string' ? body.error : `Nya answered ${res.status}.`;
    throw new RestoreStopped(said, res.status, body);
  }
  return body ?? {};
}

const post = (body: string): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body });

/**
 * Builds every batch (see the header), and sends the parts kept on the seam
 * to the server's checks unless `check` is false. Throws RestoreStopped with
 * the first problem the server finds. `onBatch` says how many are built.
 */
export async function makePlan(source: FileSource, c: Collected, opts: { fetcher: Fetcher; check?: boolean; onBatch?: (n: number) => void }): Promise<Plan> {
  const batches: PlannedBatch[] = [];
  const day = exportedDay(c);
  await buildBatches(source, c, async (b) => {
    if (opts.check !== false && checkedFirst(b.part)) await call(opts.fetcher, `/api/user-restore/batch?check=1&exported=${day}`, post(b.body));
    batches.push({ part: b.part, count: b.count, digest: await digestOf(b.body) });
    opts.onBatch?.(batches.length);
  });
  if (batches.length === 0) throw new RestoreStopped('This file has nothing in it to bring back.', null);
  return { digest: await planDigest(batches), batches };
}

/** The start's body (app/api/user-restore POST "start"). */
export function startBody(p: Preview, plan: Plan, source: FileSource, restoreId: string, password: string | null): Record<string, unknown> {
  const c = p.collected;
  return {
    action: 'start',
    restore_id: restoreId,
    plan,
    source: { exported_at: c.exported_at, version: c.version, bytes: source.size, protected: source.protected },
    brought: p.brought,
    left_out: p.left_out,
    without: Object.fromEntries(p.without.map((w) => [w.part, w.count])),
    history: p.history,
    earlier: p.earlier,
    ...(password ? { password } : {}),
  };
}

/** Starts the restore: the record, claimed. */
export async function startRestore(fetcher: Fetcher, body: Record<string, unknown>): Promise<RecordView> {
  const answer = await call(fetcher, '/api/user-restore', post(JSON.stringify(body)));
  return answer.record as RecordView;
}

/**
 * Sends the batches the record doesn't have yet (see the header), building
 * every batch again from the file. `plan`, when the page has it, is checked
 * batch by batch before sending; without it (a resume), the server's
 * comparison is the check. Answers how many are written. `onProgress` says
 * how many of how many.
 */
export async function sendBatches(
  source: FileSource,
  c: Collected,
  record: Pick<RecordView, 'id' | 'done' | 'plan'>,
  opts: { fetcher: Fetcher; plan?: Plan; onProgress?: (done: number, total: number) => void; stopped?: () => boolean }
): Promise<number> {
  if (opts.plan && opts.plan.digest !== record.plan.digest) {
    throw new RestoreStopped('This isn’t the file this restore started from. Choose that one to go on, or undo the restore.', null);
  }
  const total = record.plan.batches;
  let done = record.done;
  let index = 0;
  opts.onProgress?.(done, total);
  await buildBatches(source, c, async (b) => {
    const i = index++;
    if (i < done) return;
    if (i >= total) throw new RestoreStopped('This file has more in it than the restore planned. Choose the file it started from, or undo the restore.', null);
    if (opts.stopped?.()) throw new RestoreStopped('Stopped. Go on from here with the same file.', null);
    if (opts.plan && (await digestOf(b.body)) !== opts.plan.batches[i].digest) {
      throw new RestoreStopped('The file changed since the restore was planned. Choose it again to go on, or undo the restore.', null);
    }
    const answer = await call(opts.fetcher, `/api/user-restore/batch?restore_id=${encodeURIComponent(record.id)}&index=${i}`, post(b.body));
    done = Math.max(done, typeof answer.done === 'number' ? answer.done : i + 1);
    opts.onProgress?.(done, total);
  });
  if (done < total) throw new RestoreStopped('This file has less in it than the restore planned. Choose the file it started from, or undo the restore.', null);
  return done;
}

/** Finishes the restore, once every batch is written: the record. */
export async function finishRestore(fetcher: Fetcher, id: string): Promise<RecordView> {
  const answer = await call(fetcher, `/api/user-restore/batch?restore_id=${encodeURIComponent(id)}&finish=1`, { method: 'POST' });
  return answer.record as RecordView;
}
