import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { downloadAllowed, takeDownload, DOWNLOADS_PER_WINDOW } from '@/lib/rate-limit';
import { freshSignIn, PASSWORD_MAX } from '@/lib/fresh-sign-in';
import {
  collectUserData,
  buildUserExport,
  exportFile,
  fileByteLength,
  fileChunks,
  ExportReadError,
  EXPORT_FORMATS,
  type ExportFile,
  type ExportFormat,
  type UserExport,
} from '@/lib/user-export';

// Download my data (lib/user-export.ts): everything Nya stores about the
// person signed in, decrypted, as one file streamed to the browser. It is
// never written anywhere as plaintext on the way.
//
// POST { format: "json" | "transactions-csv" | "balances-csv", password? }.
// POST, not GET: the request carries a password in the shared-password mode,
// and a download link must not be something a page can make a browser fetch.
//
// Behind a FRESH SIGN-IN (lib/fresh-sign-in.ts, which making an API token
// shares), on top of the session the proxy already checked:
//   - with Clerk (lib/auth-mode.ts), a sign-in verified within the last ten
//     minutes (Clerk's "strict" reverification: the second factor if the
//     account has one, the first otherwise). Without it the answer is Clerk's
//     reverification hint, a 403 its useReverification hook knows: it asks
//     the person to confirm it is them, then sends this request again.
//   - with the shared password, the password again, in the request, compared
//     in constant time. Wrong ones count against the login's own limit (per
//     IP, lib/rate-limit.ts), so a stolen session cookie can't use this to
//     guess the password faster than the login allows. A wrong password is a
//     403, never a 401: the dashboard takes any 401 to mean signed out.
//
// RATE LIMITED per container (lib/rate-limit.ts): checked before the sign-in,
// so a person over the limit isn't asked to sign in for nothing, and counted
// after it, so a reverification round trip doesn't use one up.
//
// NOTHING MISSING WITHOUT A WORD (lib/user-export.ts, rule 1): all of it is
// read before the first byte is sent. A store that can't be read for a reason
// that says nothing about its data (storage, keys) is a 500 naming it, never a
// file that is quietly short. An entry that is damaged, or saved in a form
// this version doesn't know, is named in the file instead, and the file comes
// with X-Nya-Export-Incomplete: the parts it is made from that are missing
// something, by their keys in the JSON file, comma-separated, beside notes
// that say it in words. Logs carry the kind of store, the error's class and
// the incomplete parts' keys, never data, ids or institution names.
//
// A WHOLE FILE OR NONE. The file is written twice from the document already
// in memory: once to count its bytes, keeping none of them, then again to
// stream it. The count goes ahead of the body, as Content-Length and as
// X-Nya-Export-Bytes (which survives an edge that compresses the response and
// rewrites the length), and the page saves nothing unless that many bytes
// arrived. A stream the platform ends cleanly part way (the time limit, an
// instance recycled) would otherwise look like a whole file.

// The time streaming takes counts against this, and a large account's file
// over a slow connection takes minutes: the same allowance as the operator
// export and the nightly backup.
export const maxDuration = 300;

type Body = { format: ExportFormat; password: string | null };

function parseBody(raw: unknown): Body | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Send { format }.';
  const { format, password } = raw as Record<string, unknown>;
  if (typeof format !== 'string' || !(EXPORT_FORMATS as readonly string[]).includes(format)) {
    return `format must be one of: ${EXPORT_FORMATS.join(', ')}.`;
  }
  if (password !== undefined && password !== null && (typeof password !== 'string' || password.length > PASSWORD_MAX)) {
    return 'password must be text.';
  }
  return { format: format as ExportFormat, password: typeof password === 'string' ? password : null };
}

function tooMany(retryAfterSeconds: number): NextResponse {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return NextResponse.json(
    {
      error: `You can download your data ${DOWNLOADS_PER_WINDOW} times an hour. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      retry_after_seconds: retryAfterSeconds,
    },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
  );
}

const limitUnreadable = () =>
  NextResponse.json({ error: 'The download limit could not be checked just now, so nothing was downloaded. Try again in a minute.' }, { status: 503 });

/** Anything but a store that couldn't be read, before a byte is sent: the
 *  error's class goes to the log, never its message, which could quote data. */
function notPrepared(err: unknown): NextResponse {
  console.error('Data download failed', err instanceof Error ? err.name : typeof err);
  return NextResponse.json({ error: 'The download could not be prepared, so nothing was downloaded. Try again later.' }, { status: 500 });
}

export async function POST(req: Request) {
  let ctx: Ctx;
  try {
    ctx = await dataCtx();
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error('Data download: the account could not be resolved', err instanceof Error ? err.name : typeof err);
    return NextResponse.json({ error: 'Could not start the download.' }, { status: 500 });
  }

  const body = parseBody(await req.json().catch(() => null));
  if (typeof body === 'string') return NextResponse.json({ error: body }, { status: 400 });

  try {
    const allowed = await downloadAllowed(ctx);
    if (!allowed.ok) return tooMany(allowed.retryAfterSeconds);
  } catch {
    return limitUnreadable();
  }

  const signedIn = await freshSignIn(req, body.password);
  if (signedIn instanceof NextResponse) return signedIn;

  try {
    const taken = await takeDownload(ctx);
    if (!taken.ok) return tooMany(taken.retryAfterSeconds);
  } catch {
    return limitUnreadable();
  }

  let doc: UserExport;
  try {
    doc = buildUserExport(await collectUserData({ ctx, userId: signedIn.userId }), new Date());
  } catch (err) {
    if (err instanceof ExportReadError) {
      const cause = err.cause instanceof Error ? err.cause.name : typeof err.cause;
      console.error(`Data download stopped: ${err.store} could not be read (${cause})`);
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    return notPrepared(err);
  }

  // The first pass: the size, with nothing kept (see the header). A writer
  // that meets a stored value of a shape it doesn't expect throws here, before
  // anything is sent, and gets the same answer as a document that couldn't be
  // built.
  let file: ExportFile;
  let bytes: number;
  try {
    file = exportFile(doc, body.format);
    bytes = fileByteLength(file);
  } catch (err) {
    return notPrepared(err);
  }

  // Tell the owner a download happened, here, once that email is built: Nya
  // can send email now (lib/mail.ts, #51). When, and which format; never
  // anything from the file itself. An incomplete one names its parts by key,
  // for whoever runs Nya to look at: a store's name, never an id or a value.
  console.log(`Data download: ${body.format}${file.incomplete.length > 0 ? `, incomplete: ${file.incomplete.join(', ')}` : ''}`);

  // The second pass: the same bytes, streamed.
  const chunks = fileChunks(file);
  const stream = new ReadableStream<Uint8Array>({
    // Pulled: the next chunk is written only when the browser has taken the
    // last, so a slow connection never makes the whole file sit in memory.
    pull(controller) {
      const next = chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel() {
      chunks.return(undefined);
    },
  });

  const headers: Record<string, string> = {
    'Content-Type': file.contentType,
    'Content-Disposition': `attachment; filename="${file.filename}"`,
    'Content-Length': String(bytes),
    'X-Nya-Export-Bytes': String(bytes),
    // Financial data: no intermediary or browser cache may keep a copy.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  // The JSON carries its caveats inside; a CSV has nowhere to, so they also
  // travel as headers for the page to show: in words, and, when the file is
  // missing something, which parts (exportFile says which a CSV is made of).
  if (file.notes.length > 0) headers['X-Nya-Export-Notes'] = encodeURIComponent(JSON.stringify(file.notes));
  if (file.incomplete.length > 0) headers['X-Nya-Export-Incomplete'] = file.incomplete.join(', ');
  return new Response(stream, { headers });
}
