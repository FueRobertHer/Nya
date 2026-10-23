import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { storeFailure } from '@/lib/store-failure';
import { getItems } from '@/lib/storage';
import { secretsStore } from '@/lib/connectors/store';
import { clearCaches } from '@/lib/cache';
import { batchesCount, BATCHES_PER_HOUR, recordView, userRestoreStore, type UserRestoreRecord } from '@/lib/user-restore/store';
import { isUserRestoreId, MAX_BATCH_BODY, UNDO_DAYS } from '@/lib/user-restore/ids';
import { isCalendarDay } from '@/lib/user-restore/records';
import { BatchRefused, checkBatch } from '@/lib/user-restore/check';
import { JsonReadError, parseStrict } from '@/lib/user-restore/stream';
import { BatchNotWritten, finishWrites, writeBatch } from '@/lib/user-restore/commit';
import { restoreEnabled, RESTORE_OFF } from '@/lib/user-restore/enabled';

// One batch of a restore (docs/data-export.md, "Bringing it back"; the page
// builds them, lib/user-restore/file.ts), and its finish. The body is the
// batch itself, { part, records }, exactly the bytes the page took the
// SHA-256 of, so the digest is taken of the bytes received.
//
//   POST ?check=1&exported=YYYY-MM-DD
//        checked and nothing written, before the restore starts: the parts
//        kept on the storage seam, which only the server's own checks can
//        read. No record needed. { ok: true }, or 400 with the problem.
//   POST ?restore_id=…&index=…
//        written, if the record is this restore's and still writing, the
//        index is the next one (or one written already, answered as written),
//        its digest is the plan's for it, and no bank holds a credential here
//        (one linked in another tab while the restore runs). Re-checks the
//        record just before writing, so a batch can't land after an undo
//        began. { done }.
//   POST ?restore_id=…&finish=1
//        every batch written: what the download leaves out because the
//        entries hold it worked out (lib/user-restore/commit.ts finishWrites),
//        and the record finished, undoable for UNDO_DAYS. { record }.
//
// Refused past MAX_BATCH_BODY, declared or actual, before anything is read
// into a value. Batches are counted (BATCHES_PER_HOUR). Off unless
// RESTORE_ENABLED=1. Logs carry counts and the part, never a value, an id or
// a name.

// Shorter than the undo's pause (lib/user-restore/undo.ts UNDO_PAUSE_MS), so
// a batch or a finish that passed its last look at the record before an undo
// began has ended before the undo's second sweep. Vercel enforces it; a host
// that doesn't (a Node server of one's own) is held to WRITE_BY_MS below for
// everything before a batch's write and before each of the finish's, and
// docs/operations.md says what is left.
export const maxDuration = 60;

/** How long after it arrived a batch may still begin writing: well inside
 *  maxDuration, whatever the host enforces, so a request slowed on its way
 *  (a slow read, a slow check) is refused, to be sent again, rather than
 *  writing late. */
const WRITE_BY_MS = 30_000;

const NO_STORE = { 'Cache-Control': 'no-store' };

const refuse = (error: string, status: number, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
const tooLarge = () => refuse('This batch is larger than Nya takes.', 413);

/** The body's bytes, up to `max`: null past it. */
async function bodyBytes(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const utcDay = (at: string | number | Date) => new Date(at).toISOString().slice(0, 10);

/** The batch read and checked: { part, records }, or the answer to send. */
function checked(bytes: Uint8Array, exported: string): { part: string; records: Record<string, unknown>[] } | NextResponse {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refuse('This batch isn’t UTF-8 text.', 400);
  }
  try {
    return checkBatch(parseStrict(text), { exported, today: utcDay(Date.now()) });
  } catch (err) {
    if (err instanceof BatchRefused) return refuse(err.problem, 400, { problem: err.problem });
    if (err instanceof JsonReadError) return refuse(`This batch isn’t JSON Nya can read: ${err.problem}.`, 400);
    throw err;
  }
}

const stillWriting = (r: UserRestoreRecord | null, id: string): r is UserRestoreRecord => !!r && r.id === id && r.status === 'writing';

function notWriting(record: UserRestoreRecord | null): NextResponse {
  if (!record) return refuse('There is no restore here to send this to: it was undone, or never started.', 404);
  if (record.status === 'undoing') return refuse('This restore is being undone.', 409);
  return refuse('This batch is for another restore than the one here.', 409);
}

export async function POST(req: Request) {
  if (!restoreEnabled()) return refuse(RESTORE_OFF, 403);
  let ctx: Ctx;
  try {
    ctx = await dataCtx();
  } catch (err) {
    return containerUnavailable(err) ?? storeFailure(err, 'Couldn’t write this part of the download');
  }
  const params = new URL(req.url).searchParams;
  try {
    if (params.get('check') === '1') return await checkOnly(ctx, req, params);
    const id = params.get('restore_id');
    if (!isUserRestoreId(id)) return refuse('Name the restore: restore_id.', 400);
    if (params.get('finish') === '1') return await finish(ctx, id);
    return await write(ctx, req, id, params.get('index'));
  } catch (err) {
    if (err instanceof BatchNotWritten) {
      console.error(`Restore: a batch wasn't written (${err.status})`);
      return refuse(err.message, err.status);
    }
    return storeFailure(err, 'Couldn’t write this part of the download');
  }
}

async function checkOnly(ctx: Ctx, req: Request, params: URLSearchParams): Promise<NextResponse> {
  const exported = params.get('exported');
  if (!isCalendarDay(exported) || exported > utcDay(Date.now() + 24 * 60 * 60 * 1000)) return refuse('Say the day the download was made: exported=YYYY-MM-DD.', 400);
  const bytes = await bodyBytes(req, MAX_BATCH_BODY);
  if (!bytes) return tooLarge();
  const counted = await batchesCount.take(ctx);
  if (counted.count > BATCHES_PER_HOUR) return refuse(`Nya takes ${BATCHES_PER_HOUR} batches an hour at most. It goes on from here later.`, 429, { retry_after_seconds: counted.secondsLeft });
  const batch = checked(bytes, exported);
  if (batch instanceof NextResponse) return batch;
  return NextResponse.json({ ok: true, part: batch.part, count: batch.records.length }, { headers: NO_STORE });
}

async function write(ctx: Ctx, req: Request, id: string, indexText: string | null): Promise<NextResponse> {
  const began = Date.now();
  if (!indexText || !/^(0|[1-9][0-9]{0,4})$/.test(indexText)) return refuse('Name the batch: index.', 400);
  const index = Number(indexText);
  const bytes = await bodyBytes(req, MAX_BATCH_BODY);
  if (!bytes) return tooLarge();

  const record = await userRestoreStore.get(ctx);
  if (!record || record.id !== id || record.status === 'undoing') return notWriting(record);
  if (index >= record.plan.batches.length) return refuse('This batch isn’t in the restore’s plan.', 400);
  const planned = record.plan.batches[index];
  // Taken of the bytes received: a body cut short, or a file changed since
  // the plan was made, never matches.
  if ((await sha256Hex(bytes)) !== planned.digest) {
    return refuse('This batch isn’t the one the restore planned: it arrived cut short, or the file changed since the restore started. Try again, with the same file.', 409, { done: record.done, mismatch: true });
  }
  // Sent again (its answer lost, or from a second tab): written already.
  if (index < record.done || record.status === 'finished') return NextResponse.json({ done: record.done }, { headers: NO_STORE });
  if (index > record.done) return refuse(`Batches go in order: batch ${record.done + 1} comes next.`, 409, { done: record.done });

  const counted = await batchesCount.take(ctx);
  if (counted.count > BATCHES_PER_HOUR) {
    return NextResponse.json(
      { error: `Nya takes ${BATCHES_PER_HOUR} batches an hour at most. It goes on from here later.`, done: record.done, retry_after_seconds: counted.secondsLeft },
      { status: 429, headers: { ...NO_STORE, 'Retry-After': String(counted.secondsLeft) } }
    );
  }
  // A bank connected in another tab while the restore runs: the account is
  // in use, and an undo would leave the connection running at the provider.
  const [items, secrets] = await Promise.all([getItems(ctx), secretsStore.count(ctx)]);
  if (items.length > 0 || secrets > 0) {
    return refuse('A bank was connected here while the restore was running. Disconnect it (Manage), then resume the restore, or undo the restore.', 409, { done: record.done, connected: true });
  }

  const batch = checked(bytes, utcDay(record.source.exported_at));
  if (batch instanceof NextResponse) return batch;
  if (batch.part !== planned.part || batch.records.length !== planned.count) return refuse('This batch isn’t the one the restore planned.', 409, { done: record.done });

  // Looked at once more just before writing: an undo begun since refuses it.
  const now = await userRestoreStore.get(ctx);
  if (!stillWriting(now, id)) return notWriting(now);
  if (now.done !== index) return NextResponse.json({ done: now.done }, { headers: NO_STORE });
  if (Date.now() - began > WRITE_BY_MS) return refuse('This batch took too long to reach the write. Send it again.', 503, { done: now.done });
  await writeBatch(ctx, batch.part, batch.records, now);
  const after = await userRestoreStore.update(ctx, (cur) => (stillWriting(cur, id) && cur.done === index ? { ...cur, done: index + 1, last_batch_at: new Date().toISOString() } : cur));
  // Net worth and transactions change as the batches land.
  await clearCaches(ctx);
  return NextResponse.json({ done: after?.done ?? index + 1 }, { headers: NO_STORE });
}

async function finish(ctx: Ctx, id: string): Promise<NextResponse> {
  const began = Date.now();
  const record = await userRestoreStore.get(ctx);
  if (record && record.id === id && record.status === 'finished') return NextResponse.json({ record: recordView(record) }, { headers: NO_STORE });
  if (!stillWriting(record, id)) return notWriting(record);
  if (record.done < record.plan.batches.length) {
    return refuse(`This restore has ${record.plan.batches.length - record.done} batches left to send.`, 409, { done: record.done });
  }
  // Held as a batch is (WRITE_BY_MS), before each of its writes, and the
  // record looked at again then: an undo begun since refuses what is left.
  await finishWrites(ctx, {
    record,
    before: async () => {
      if (Date.now() - began > WRITE_BY_MS) throw new BatchNotWritten('Finishing this restore took too long. Finish it again.', 503);
      const now = await userRestoreStore.get(ctx);
      if (now === null || now.id !== id) throw new BatchNotWritten('There is no restore here to finish.', 404);
      // Finished meanwhile (a second tab): these writes are its own again.
      if (now.status === 'undoing') throw new BatchNotWritten('This restore is being undone.', 409);
    },
  });
  const at = new Date();
  const finished = await userRestoreStore.update(ctx, (cur) =>
    stillWriting(cur, id) ? { ...cur, status: 'finished', finished_at: at.toISOString(), undo_until: new Date(at.getTime() + UNDO_DAYS * 24 * 60 * 60 * 1000).toISOString() } : cur
  );
  if (!finished || finished.id !== id || finished.status !== 'finished') return notWriting(finished);
  console.log(`Restore: finished, ${finished.plan.batches.length} batches`);
  return NextResponse.json({ record: recordView(finished) }, { headers: NO_STORE });
}
