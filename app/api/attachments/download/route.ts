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
import { planVolumes, setToken, setTokenHolds, volumeChunks, volumeName, volumeSize, type VolumePlan } from '@/lib/attachment-zip';

// Receipts and documents as ZIP files (lib/attachment-zip.ts), decrypted, for
// the signed-in person alone. A download of their data like any other
// (app/api/my-data): behind a fresh sign-in, counted against the same
// DOWNLOADS_PER_WINDOW, emailed to the owner, optionally protected with a
// passphrase, never written down, its size sent ahead so the page keeps only
// a whole file. Needs only a connected file store, never the quota.
//
// GET                 the plan: how many volumes, what each holds, and what
//                     is left out (a file whose objects are missing or
//                     damaged), so the card can list them. Counts nothing.
// POST { volume, set?, passphrase?, password? }
//                     one volume (from 1). The first of a set counts as the
//                     download and sends the email; its answer carries a set
//                     token (X-Nya-Set), and the other volumes of the same
//                     listing that present it within the hour count nothing
//                     more (D7). The fresh sign-in is asked for every volume:
//                     with Clerk, a long set may ask again after ten minutes.

// A volume of about 50 MB over a slow connection.
export const maxDuration = 300;

const MAX_BODY_CHARS = 4096;

async function resolve(): Promise<Ctx | NextResponse> {
  try {
    return await dataCtx();
  } catch (err) {
    return attachmentFailure(err, 'Could not start the download.');
  }
}

const summary = (plan: VolumePlan) => ({
  volumes: plan.volumes.map((files, i) => ({
    volume: i + 1,
    files: files.length,
    bytes: files.reduce((n, f) => n + f.record.bytes, 0),
    from: files[0]?.name.slice(5, 15) ?? null,
    to: files.at(-1)?.name.slice(5, 15) ?? null,
  })),
  left_out: plan.left_out,
  unreadable: plan.unreadable,
});

export async function GET() {
  const ctx = await resolve();
  if (ctx instanceof NextResponse) return ctx;
  const store = attachmentObjects();
  if (!store) return NextResponse.json({ error: NOT_CONNECTED_MESSAGE }, { status: 503, headers: NO_STORE });
  try {
    return NextResponse.json(summary(await planVolumes(ctx, store)), { headers: NO_STORE });
  } catch (err) {
    return attachmentFailure(err, 'Your receipts and documents could not be listed.');
  }
}

type Body = { volume: number; set: string | null; passphrase: string | null; password: string | null };

function parseBody(raw: unknown): Body | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Send { volume }.';
  const b = raw as Record<string, unknown>;
  if (Object.keys(b).some((k) => !['volume', 'set', 'passphrase', 'password'].includes(k))) return 'Unknown field.';
  if (!Number.isInteger(b.volume) || (b.volume as number) < 1 || (b.volume as number) > 10_000) return 'volume must be a whole number from 1.';
  if (b.set !== undefined && b.set !== null && (typeof b.set !== 'string' || b.set.length > 200)) return 'set must be text.';
  if (b.password !== undefined && b.password !== null && (typeof b.password !== 'string' || b.password.length > PASSWORD_MAX)) return 'password must be text.';
  if (b.passphrase !== undefined && b.passphrase !== null) {
    const problem = passphraseProblem(b.passphrase);
    if (problem) return problem;
  }
  return {
    volume: b.volume as number,
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

  let plan: VolumePlan;
  try {
    plan = await planVolumes(ctx, store);
  } catch (err) {
    return attachmentFailure(err, 'Your receipts and documents could not be listed.');
  }
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
  const facts = { container: ctx.container, user: signedIn.userId, digest: plan.digest, volumes: plan.volumes.length };
  const now = new Date();
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

  const files = plan.volumes[body.volume - 1];
  const meta = { exported_at: now.toISOString(), volume: body.volume, volumes: plan.volumes.length, left_out: plan.left_out };
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
  console.log(`Receipts download: volume ${body.volume} of ${plan.volumes.length}${body.passphrase !== null ? ', protected' : ''}${plan.left_out.length > 0 ? `, ${plan.left_out.length} left out` : ''}`);

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
    'X-Nya-Set': inSet ? (body.set as string) : setToken(facts, now.getTime()),
    'X-Nya-Volumes': String(plan.volumes.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  const notes = [
    ...(plan.left_out.length > 0 ? [`${plan.left_out.length} ${plan.left_out.length === 1 ? 'file is' : 'files are'} left out: ${plan.left_out.length === 1 ? 'it isn’t' : 'they aren’t'} whole in storage, or can’t be opened. The manifest names ${plan.left_out.length === 1 ? 'it' : 'them'}.`] : []),
    ...(plan.unreadable > 0 ? [`${plan.unreadable} ${plan.unreadable === 1 ? 'record' : 'records'} of a file couldn’t be read, so ${plan.unreadable === 1 ? 'that file is' : 'those files are'} not in it.`] : []),
  ];
  if (notes.length > 0) headers['X-Nya-Export-Notes'] = encodeURIComponent(JSON.stringify(notes));
  return new Response(stream, { headers });
}
