import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { downloadAllowed, takeDownload, DOWNLOADS_PER_WINDOW } from '@/lib/rate-limit';
import { freshSignIn, PASSWORD_MAX } from '@/lib/fresh-sign-in';
import { passphraseProblem } from '@/lib/download-options';
import { protectFileAsync } from '@/lib/protected-download';
import { sendAccessNotice } from '@/lib/download-notice';
import { background } from '@/lib/background';
import { attachmentObjects } from '@/lib/attachment-objects';
import { usageStore } from '@/lib/attachment-stores';
import { attachmentFailure, NO_STORE } from '@/lib/attachment-http';
import { NOT_CONNECTED_MESSAGE } from '@/lib/attachments';
import { makePlan, planDigest, planToken, readPlanToken, servePlan, setToken, setTokenHolds, volumeChunks, volumeName, volumeNotes, volumeSize, MAX_PLAN_CHARS } from '@/lib/attachment-zip';

// Receipts and documents as ZIP files (lib/attachment-zip.ts), decrypted, for
// the signed-in person alone. A download of their data like any other
// (app/api/my-data): behind a fresh sign-in, counted against the same
// DOWNLOADS_PER_WINDOW, emailed to the owner, optionally protected with a
// passphrase, never written down, its size sent ahead so the page keeps only
// a whole file. Needs only a connected file store, never the quota.
//
// GET                 makes the download ready: the plan (lib/attachment-zip.ts
//                     makePlan), how many volumes and what each holds, what
//                     is left out (a file whose objects aren't all there),
//                     and `plan`, the signed plan the page sends back with
//                     every volume, for PLAN_MS. Counts nothing.
// POST { volume, plan, set?, passphrase?, password? }
//                     one volume (from 1) of that plan, exactly its files
//                     (servePlan), never a plan worked out again (review
//                     blocking 1): a file deleted since is named in its
//                     volume's manifest and the last one's, and files added
//                     since are in no volume and counted (X-Nya-Added), so the
//                     card offers a new set. A plan that has run out is 409
//                     `plan_expired`. The first volume of a set counts as the
//                     download and sends the email; its answer carries a set
//                     token (X-Nya-Set), and the other volumes of the plan
//                     that present it count nothing more (D7), each answer
//                     renewing it for an hour. The fresh sign-in is asked for
//                     every volume: with Clerk, a long set may ask again after
//                     ten minutes.

// A volume of about 50 MB over a slow connection.
export const maxDuration = 300;

/** The body: the plan, at most MAX_PLAN_CHARS, and a few short fields. */
const MAX_BODY_CHARS = MAX_PLAN_CHARS + 4096;

async function resolve(): Promise<Ctx | NextResponse> {
  try {
    return await dataCtx();
  } catch (err) {
    return attachmentFailure(err, 'Could not start the download.');
  }
}

export async function GET() {
  const ctx = await resolve();
  if (ctx instanceof NextResponse) return ctx;
  const store = attachmentObjects();
  if (!store) return NextResponse.json({ error: NOT_CONNECTED_MESSAGE }, { status: 503, headers: NO_STORE });
  try {
    const made = await makePlan(ctx, store);
    return NextResponse.json(
      {
        volumes: made.volumes.map((files, i) => ({
          volume: i + 1,
          files: files.length,
          bytes: files.reduce((n, f) => n + f.record.bytes, 0),
          // The days its files were added on: the order they go in.
          from: files[0]?.record.created_at.slice(0, 10) ?? null,
          to: files.at(-1)?.record.created_at.slice(0, 10) ?? null,
        })),
        left_out: made.left_out,
        unreadable: made.unreadable,
        plan: planToken(made.plan),
        until: new Date(made.plan.until).toISOString(),
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    return attachmentFailure(err, 'Your receipts and documents could not be listed.');
  }
}

type Body = { volume: number; plan: string; set: string | null; passphrase: string | null; password: string | null };

function parseBody(raw: unknown): Body | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Send { volume, plan }.';
  const b = raw as Record<string, unknown>;
  if (Object.keys(b).some((k) => !['volume', 'plan', 'set', 'passphrase', 'password'].includes(k))) return 'Unknown field.';
  if (!Number.isInteger(b.volume) || (b.volume as number) < 1 || (b.volume as number) > 10_000) return 'volume must be a whole number from 1.';
  if (typeof b.plan !== 'string' || b.plan.length > MAX_PLAN_CHARS) return 'plan must be the one the download was made ready with.';
  if (b.set !== undefined && b.set !== null && (typeof b.set !== 'string' || b.set.length > 200)) return 'set must be text.';
  if (b.password !== undefined && b.password !== null && (typeof b.password !== 'string' || b.password.length > PASSWORD_MAX)) return 'password must be text.';
  if (b.passphrase !== undefined && b.passphrase !== null) {
    const problem = passphraseProblem(b.passphrase);
    if (problem) return problem;
  }
  return {
    volume: b.volume as number,
    plan: b.plan,
    set: typeof b.set === 'string' ? b.set : null,
    passphrase: typeof b.passphrase === 'string' ? b.passphrase : null,
    password: typeof b.password === 'string' ? b.password : null,
  };
}

function tooMany(retryAfterSeconds: number): NextResponse {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return NextResponse.json(
    { error: `You can download your data ${DOWNLOADS_PER_WINDOW} times an hour. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, retry_after_seconds: retryAfterSeconds },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds), ...NO_STORE } }
  );
}

const limitUnreadable = () =>
  NextResponse.json({ error: 'The download limit could not be checked just now, so nothing was downloaded. Try again in a minute.' }, { status: 503, headers: NO_STORE });

export async function POST(req: Request) {
  const ctx = await resolve();
  if (ctx instanceof NextResponse) return ctx;
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: 'Request too large' }, { status: 413, headers: NO_STORE });
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const body = parseBody(raw);
  if (typeof body === 'string') return NextResponse.json({ error: body }, { status: 400, headers: NO_STORE });
  const store = attachmentObjects();
  if (!store) return NextResponse.json({ error: NOT_CONNECTED_MESSAGE }, { status: 503, headers: NO_STORE });

  const now = new Date();
  const plan = readPlanToken(body.plan, ctx.container, now.getTime());
  if (plan === 'expired') {
    return NextResponse.json(
      {
        error:
          'This download was made ready more than six hours ago. Get it ready again, then save every ZIP file of the new set, and put away any you saved from this one: the new set is packed afresh, so files from the two don’t fit together.',
        plan_expired: true,
      },
      { status: 409, headers: NO_STORE }
    );
  }
  if (plan === null) return NextResponse.json({ error: 'This download wasn’t made ready here for this account. Get it ready again.' }, { status: 400, headers: NO_STORE });
  if (plan.volumes.length === 0) return NextResponse.json({ error: 'There are no receipts or documents to download.' }, { status: 404, headers: NO_STORE });
  if (body.volume > plan.volumes.length) return NextResponse.json({ error: `There are ${plan.volumes.length} volumes.` }, { status: 400, headers: NO_STORE });

  // A new set is checked against the limit before the sign-in, so a person
  // over it isn't asked to sign in for nothing, and counted after it, as the
  // data download is.
  const allowed = async (): Promise<NextResponse | null> => {
    try {
      const a = await downloadAllowed(ctx);
      return a.ok ? null : tooMany(a.retryAfterSeconds);
    } catch {
      return limitUnreadable();
    }
  };
  if (body.set === null) {
    const refused = await allowed();
    if (refused) return refused;
  }
  // Who asks, for the set token: the Clerk account, or none with the shared
  // password (only ever one person there).
  const signedIn = await freshSignIn(req, body.password);
  if (signedIn instanceof NextResponse) return signedIn;
  const facts = { container: ctx.container, user: signedIn.userId, digest: planDigest(body.plan), volumes: plan.volumes.length };
  const inSet = setTokenHolds(body.set, facts, now.getTime());
  if (!inSet) {
    if (body.set !== null) {
      const refused = await allowed();
      if (refused) return refused;
    }
    try {
      const taken = await takeDownload(ctx);
      if (!taken.ok) return tooMany(taken.retryAfterSeconds);
    } catch {
      return limitUnreadable();
    }
  }

  let served: Awaited<ReturnType<typeof servePlan>>;
  try {
    served = await servePlan(ctx, store, plan, body.volume);
  } catch (err) {
    return attachmentFailure(err, 'Your receipts and documents could not be listed.');
  }
  const files = served.files;
  const meta = {
    exported_at: now.toISOString(),
    volume: body.volume,
    volumes: plan.volumes.length,
    left_out: served.left_out,
    set_left_out: served.set_left_out,
    added: served.added,
  };
  const plainBytes = volumeSize(files, meta);
  const name = volumeName(now.toISOString().slice(0, 10), body.volume, plan.volumes.length);
  let sent: { filename: string; contentType: string; bytes: number; chunks: AsyncGenerator<Uint8Array> };
  try {
    if (body.passphrase !== null) {
      const p = await protectFileAsync({ filename: name, chunks: () => volumeChunks(ctx, store, files, meta) }, plainBytes, body.passphrase);
      sent = { filename: p.filename, contentType: p.contentType, bytes: p.bytes, chunks: p.chunks() };
    } else {
      sent = { filename: name, contentType: 'application/zip', bytes: plainBytes, chunks: volumeChunks(ctx, store, files, meta) };
    }
  } catch (err) {
    return attachmentFailure(err, 'The download could not be prepared, so nothing was downloaded.');
  }

  if (!inSet) {
    background(sendAccessNotice(ctx, { kind: 'download', format: 'attachments-zip', protected: body.passphrase !== null }, now));
    // For the card's reminder (D3): when the files were last downloaded.
    background(usageStore.update(ctx, (cur) => (cur ? { ...cur, zip_at: now.toISOString() } : cur)).then(() => undefined));
  }
  console.log(
    `Receipts download: volume ${body.volume} of ${plan.volumes.length}${body.passphrase !== null ? ', protected' : ''}${served.left_out.length > 0 ? `, ${served.left_out.length} left out` : ''}${served.added > 0 ? `, ${served.added} added since` : ''}`
  );

  const chunks = sent.chunks;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (err) {
        console.error('Receipts download stopped part way', err instanceof Error ? err.name : typeof err);
        controller.error(err);
      }
    },
    cancel() {
      void chunks.return(undefined);
    },
  });
  const headers: Record<string, string> = {
    'Content-Type': sent.contentType,
    'Content-Disposition': `attachment; filename="${sent.filename}"`,
    'Content-Length': String(sent.bytes),
    'X-Nya-Export-Bytes': String(sent.bytes),
    // Renewed with each volume, so a long set stays one download.
    'X-Nya-Set': setToken(facts, now.getTime()),
    'X-Nya-Volumes': String(plan.volumes.length),
    'X-Nya-Added': String(served.added),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  const notes = volumeNotes(served, plan);
  if (notes.length > 0) headers['X-Nya-Export-Notes'] = encodeURIComponent(JSON.stringify(notes));
  return new Response(stream, { headers });
}
