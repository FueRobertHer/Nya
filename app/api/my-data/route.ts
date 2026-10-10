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
  type ExportFile,
  type UserData,
  type UserExport,
} from '@/lib/user-export';
import { ACCOUNT_ID, DOWNLOAD_FORMATS, isDownloadFormat, passphraseProblem, type DownloadFormat } from '@/lib/download-options';
import { ofxFile } from '@/lib/ofx-export';
import { protectFile } from '@/lib/protected-download';
import { sendAccessNotice } from '@/lib/download-notice';
import { background } from '@/lib/background';

// Download my data (lib/user-export.ts): everything Nya stores about the
// person signed in, decrypted, as one file streamed to the browser. It is
// never written anywhere as plaintext on the way.
//
// POST { format: "json" | "transactions-csv" | "balances-csv" | "ofx",
//        account_id? (with "ofx", and only then), passphrase?, password? }.
// POST, not GET: the request carries a password in the shared-password mode,
// and a passphrase when the file is to be protected, and a download link must
// not be something a page can make a browser fetch.
//
// OFX is one account's statement (lib/ofx-export.ts): a bank account or a
// card of the person's own, found in what was read for the download; any
// other id is a 404, and a loan or an investment account a 400 saying why.
// Both come after the download is counted, since everything was read to
// know: the card only offers the person's own bank accounts and cards.
//
// A PASSPHRASE protects the file, any format, in the age format
// (lib/protected-download.ts), encrypted as it streams. It is used for that
// alone: never stored, never logged, never in an answer or an email. It is
// checked (at least PASSPHRASE_MIN characters) with the rest of the request,
// before the limit or the sign-in, so a short one costs nothing.
//
// THE OWNER IS EMAILED each time a file goes out (lib/download-notice.ts):
// when, which format, protected or not, and what to do if it wasn't them.
// Started as the file starts and never waited for (lib/background.ts): the
// download never waits on the email, nor fails because it failed.
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

type Body = { format: DownloadFormat; account_id: string | null; passphrase: string | null; password: string | null };

/** The request, or what is wrong with it. A message never repeats the
 *  password or the passphrase it was sent. */
function parseBody(raw: unknown): Body | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Send { format }.';
  const { format, password, account_id, passphrase } = raw as Record<string, unknown>;
  if (!isDownloadFormat(format)) return `format must be one of: ${DOWNLOAD_FORMATS.join(', ')}.`;
  if (password !== undefined && password !== null && (typeof password !== 'string' || password.length > PASSWORD_MAX)) {
    return 'password must be text.';
  }
  if (format === 'ofx') {
    if (typeof account_id !== 'string' || !ACCOUNT_ID.test(account_id)) return 'Send the account_id of the account to download as OFX.';
  } else if (account_id !== undefined && account_id !== null) {
    return 'account_id goes only with format "ofx".';
  }
  if (passphrase !== undefined && passphrase !== null) {
    const problem = passphraseProblem(passphrase);
    if (problem) return problem;
  }
  return {
    format,
    account_id: format === 'ofx' ? (account_id as string) : null,
    passphrase: typeof passphrase === 'string' ? passphrase : null,
    password: typeof password === 'string' ? password : null,
  };
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

  const now = new Date();
  let data: UserData;
  let doc: UserExport;
  try {
    data = await collectUserData({ ctx, userId: signedIn.userId });
    doc = buildUserExport(data, now);
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
    if (body.format === 'ofx') {
      const made = ofxFile(data, doc, body.account_id!, now);
      if ('refused' in made) return NextResponse.json({ error: made.refused }, { status: made.status });
      file = made.file;
    } else {
      file = exportFile(doc, body.format);
    }
    bytes = fileByteLength(file);
  } catch (err) {
    return notPrepared(err);
  }

  // With a passphrase, the same bytes encrypted as they go: the size of the
  // encrypted file is known from the plaintext's, so it still goes ahead of
  // the body. The slow key derivation runs once, here, before the first byte.
  let sent: { filename: string; contentType: string; bytes: number; chunks: Generator<Uint8Array> };
  try {
    if (body.passphrase !== null) {
      const plain = file;
      const protectedFile = await protectFile({ filename: plain.filename, chunks: () => fileChunks(plain) }, bytes, body.passphrase);
      sent = { filename: protectedFile.filename, contentType: protectedFile.contentType, bytes: protectedFile.bytes, chunks: protectedFile.chunks() };
    } else {
      sent = { filename: file.filename, contentType: file.contentType, bytes, chunks: fileChunks(file) };
    }
  } catch (err) {
    return notPrepared(err);
  }

  // The owner hears of it (see the header), and nothing waits for that.
  background(sendAccessNotice(ctx, { kind: 'download', format: body.format, protected: body.passphrase !== null }, now));
  // An incomplete file names its parts by key, for whoever runs Nya to look
  // at: a store's name, never an id or a value.
  console.log(
    `Data download: ${body.format}${body.passphrase !== null ? ', protected' : ''}${file.incomplete.length > 0 ? `, incomplete: ${file.incomplete.join(', ')}` : ''}`
  );

  // The second pass: the same bytes, streamed.
  const chunks = sent.chunks;
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
    'Content-Type': sent.contentType,
    'Content-Disposition': `attachment; filename="${sent.filename}"`,
    'Content-Length': String(sent.bytes),
    'X-Nya-Export-Bytes': String(sent.bytes),
    // Financial data: no intermediary or browser cache may keep a copy.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  // The JSON carries its caveats inside; a CSV or an OFX statement has
  // nowhere to, and a protected file can't be read until it is opened, so
  // they also travel as headers for the page to show: in words, and, when the
  // file is missing something, which parts (exportFile says which a CSV is
  // made of, ofxFile which an OFX statement is).
  if (file.notes.length > 0) headers['X-Nya-Export-Notes'] = encodeURIComponent(JSON.stringify(file.notes));
  if (file.incomplete.length > 0) headers['X-Nya-Export-Incomplete'] = file.incomplete.join(', ');
  return new Response(stream, { headers });
}
