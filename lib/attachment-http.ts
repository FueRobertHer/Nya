// lib/attachment-http.ts
//
// What the routes of receipts and documents (app/api/attachments) share: how
// each kind of failure is answered, the demo accounts' refusal, a body read
// no further than it may be, and the headers a file goes out with.
//
// FAILURES, as every store's are (lib/store-failure.ts), plus their own: a
// refusal (AttachmentRefused) with its status and words; a file that isn't
// in the store any more, 410; one that doesn't open, 409 flagged `damaged`;
// the file store slow or misconfigured, 503; whether a transaction is stored
// that can't be told, 409 (LookupUnreadableError). Never a file's name, an
// id or a byte in a log.
//
// A FILE'S HEADERS. Its routes are left out of the proxy's page policy
// (proxy.ts), and send their own: a JPEG is shown inline under a policy that
// lets it be nothing but an image (sandboxed, no script, no other load); a
// PDF is only ever saved (`attachment`), since which policy each browser's
// viewer accepts, in the installed iOS app above all, needs real devices
// (docs/operations.md, "Before turning attachments on"). Never cached
// anywhere, never read by another site (Cross-Origin-Resource-Policy), never
// sniffed as anything else. The file's own name goes out in the RFC 6266
// form, its quotes and line breaks taken out, and only here.

import { NextResponse } from 'next/server';
import { storeFailure } from './store-failure';
import { LookupUnreadableError } from './txn-lookup';
import { AttachmentGoneError, AttachmentRefused, NO_OWN_KEY_MESSAGE, wellFormed } from './attachments';
import { AttachmentDamagedError } from './attachment-crypto';
import { StoreNotPrivateError, StoreTimeoutError } from './attachment-objects';
import { NoOwnKeyError } from './crypto';
import { clerkEnabled } from './auth-mode';
import { isDemoUser } from './demo';
import { CONTENT_TYPES, type AttachmentKind } from './attachment-stores';
import { loggable } from './log-safe';
import { attachmentsMode, type AttachmentsMode } from './attachments-mode';

export const NO_STORE = { 'Cache-Control': 'no-store' };

export const DEMO_REFUSAL = 'This is a demo account, shared by everyone who tries the app: nothing can be attached to it.';

/** The signed-in Clerk account is one of Preview's demo accounts. */
export async function isDemo(): Promise<boolean> {
  if (!clerkEnabled()) return false;
  const { auth } = await import('@clerk/nextjs/server');
  const { userId } = await auth();
  return !!userId && isDemoUser(userId);
}

/** What this copy allows (lib/attachments-mode.ts), for the signed-in person:
 *  adding is off for a demo account too, so the page doesn't offer it. */
export async function personMode(): Promise<AttachmentsMode> {
  const mode = attachmentsMode();
  return mode.uploads && (await isDemo().catch(() => false)) ? { ...mode, uploads: false } : mode;
}

/** The answer for anything a route of receipts and documents can fail with. */
export function attachmentFailure(err: unknown, fallback: string): NextResponse {
  if (err instanceof AttachmentRefused) {
    return NextResponse.json({ error: err.message }, { status: err.status, headers: { ...NO_STORE, ...(err.retryAfterSeconds ? { 'Retry-After': String(err.retryAfterSeconds) } : {}) } });
  }
  if (err instanceof AttachmentGoneError) return NextResponse.json({ error: err.message, gone: true }, { status: 410, headers: NO_STORE });
  if (err instanceof AttachmentDamagedError) return NextResponse.json({ error: err.message, damaged: true }, { status: 409, headers: NO_STORE });
  if (err instanceof NoOwnKeyError) return NextResponse.json({ error: NO_OWN_KEY_MESSAGE }, { status: 409, headers: NO_STORE });
  if (err instanceof LookupUnreadableError) return NextResponse.json({ error: err.message, unreadable: true }, { status: 409, headers: NO_STORE });
  if (err instanceof StoreTimeoutError || err instanceof StoreNotPrivateError) {
    console.error('Receipts and documents: the file store failed', err.name);
    return NextResponse.json({ error: 'The file store can’t be reached just now. Try again in a minute.' }, { status: 503, headers: NO_STORE });
  }
  if (err instanceof Error && /file store/.test(err.message)) {
    console.error('Receipts and documents: the file store failed', loggable(err));
    return NextResponse.json({ error: 'The file store can’t be reached just now. Try again in a minute.' }, { status: 503, headers: NO_STORE });
  }
  return storeFailure(err, fallback);
}

/** The request's body, at most `max` bytes, or null when it is longer (a
 *  stated length past it is refused before a byte is read). */
export async function readBodyAtMost(req: Request, max: number): Promise<Uint8Array | null> {
  const stated = req.headers.get('content-length');
  if (stated !== null && (!/^\d+$/.test(stated) || Number(stated) > max)) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** An ASCII stand-in for a name: what isn't printable ASCII, and quotes and
 *  backslashes, become "_". */
const asciiName = (name: string) => name.replace(/[^\x20-\x7e]|["\\]/g, '_');

/** `Content-Disposition` for a file, RFC 6266: `filename` in ASCII and
 *  `filename*` in UTF-8, its line breaks and quotes taken out. Safe on any
 *  string: a lone surrogate (half an emoji, from a record written before
 *  names were cut between characters) becomes U+FFFD, never a URIError
 *  (review 5). */
export function disposition(kind: 'inline' | 'attachment', name: string): string {
  const clean = wellFormed(name).replace(/[\r\n"]/g, '').trim() || 'file';
  return `${kind}; filename="${asciiName(clean)}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/** The name a file is sent under: its own, with the extension its kind
 *  takes, or a plain one. */
export function sentName(kind: AttachmentKind, name: string | null, thumb = false): string {
  const ext = kind === 'pdf' && !thumb ? '.pdf' : '.jpg';
  const base = (name ?? (kind === 'pdf' ? 'document' : 'receipt')).replace(/\.(jpe?g|png|heic|heif|webp|gif|tiff?|pdf)$/i, '');
  return `${thumb ? `${base} thumbnail` : base}${ext}`;
}

/** The headers a file goes out with (see the header). */
export function fileHeaders(kind: AttachmentKind, bytes: number, name: string | null, opts: { thumb?: boolean; download?: boolean } = {}): Record<string, string> {
  const image = kind === 'image' || opts.thumb;
  const inline = image && !opts.download;
  return {
    'Content-Type': image ? CONTENT_TYPES.image : CONTENT_TYPES.pdf,
    'Content-Length': String(bytes),
    'Content-Disposition': disposition(inline ? 'inline' : 'attachment', sentName(kind, name, opts.thumb)),
    'Content-Security-Policy': image ? "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" : "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  };
}
