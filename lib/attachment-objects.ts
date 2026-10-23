// lib/attachment-objects.ts
//
// Where the sealed parts of receipts and documents live (lib/attachments.ts,
// lib/attachment-crypto.ts): Vercel Blob, the same private store the nightly
// backups use (docs/operations.md), behind a small interface, so tests use one
// kept in memory and another store could take its place.
//
// WHERE: attachments/<environment>/<container>/<attachment>/<part>, random ids
// only, no name, no extension, application/octet-stream. Computed from the
// Ctx and the record's id, never stored and never taken from a request, so a
// copy of one environment's records restored into another reads its own
// folder (and finds nothing there), and can never delete the first one's
// objects. A container's folder always ends with its slash, so one id can
// never be read as the start of another.
//
// PRIVATE, AND CHECKED. Every write is access 'private' (the SDK requires the
// mode on every call; it is never 'public' here, and a test reads the source
// for it), no random suffix, a retried part replacing itself, the shortest
// cache lifetime Blob allows (60 s, so a deleted object stops being served
// within a minute, and only ever to holders of the token). After each write
// the URL Blob answers must be on the private host: a store made public by
// mistake would answer another, and then the object is deleted at once and
// the write fails (StoreNotPrivateError), so nothing is ever left readable by
// its address.
//
// ONE CREDENTIAL. Every SDK call is given the read-write token
// (BLOB_READ_WRITE_TOKEN) itself, which the SDK then uses over any OIDC token
// it would otherwise prefer, so the store written to is the store whose id
// the read URL is built from. docs/operations.md has the operator give it to
// Production only: whoever holds it can read, list and delete every file.
//
// READS go by node's own https client, not the SDK's get(): inside a Next route
// handler the SDK's body never delivered a byte (it reads through fetch,
// which Next patches; lib/backup.ts found this), and the token is sent only
// to a Vercel Blob host.
//
// TIME LIMITS. Neither Blob nor its SDK times out a request, and the SDK
// retries failures with a doubling backoff, so every call here has a limit,
// aborted with no reason (the SDK stops only on the default AbortError, as
// lib/backup.ts explains).

import { get as httpsGet } from 'node:https';
import { envPrefix } from './storage';
import type { Ctx } from './containers';
import type { PartName } from './attachment-crypto';

export type StoredObject = { pathname: string; size: number; uploadedAt: Date };

/** What attachments need from object storage. Each call is given a signal
 *  that aborts when its time is up. */
export type AttachmentObjects = {
  put(pathname: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  /** The bytes, or null only when the store answers that it isn't there. */
  get(pathname: string, signal: AbortSignal): Promise<Uint8Array | null>;
  del(pathnames: string[], signal: AbortSignal): Promise<void>;
  /** Every object under a prefix, with its size and upload time. */
  list(prefix: string, signal: AbortSignal): Promise<StoredObject[]>;
  /** The folders directly under a prefix (each ending "/"). */
  folders(prefix: string, signal: AbortSignal): Promise<string[]>;
};

/** A store that answered a write on a public address: refused, the object
 *  deleted. */
export class StoreNotPrivateError extends Error {
  constructor() {
    super('The file store answered on a public address, so nothing was kept. It must be a private Blob store (docs/operations.md).');
    this.name = 'StoreNotPrivateError';
  }
}

/** The file store answered too slowly, or not at all. */
export class StoreTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`The file store didn’t answer ${what} within ${ms / 1000}s.`);
    this.name = 'StoreTimeoutError';
  }
}

// ---- Where ----

const environment = () => envPrefix().replace(/:$/, '');

/** Every container's folders, in this environment. */
export const environmentFolder = (): string => `attachments/${environment()}/`;
/** One container's folder, with its slash. */
export const containerFolder = (ctx: Ctx): string => `${environmentFolder()}${ctx.container}/`;
/** One attachment's folder, with its slash. */
export const attachmentFolder = (ctx: Ctx, id: string): string => `${containerFolder(ctx)}${id}/`;
/** One part of one attachment. */
export const objectPath = (ctx: Ctx, id: string, part: PartName): string => `${attachmentFolder(ctx, id)}${part}`;

/** Every object path of an attachment with `parts` parts, and its thumbnail
 *  if it has one. */
export function objectPaths(ctx: Ctx, id: string, parts: number, thumb: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < parts; i++) out.push(objectPath(ctx, id, i));
  if (thumb) out.push(objectPath(ctx, id, 't'));
  return out;
}

/** The attachment id and part an object path in this container's folder
 *  names, or null for anything else. */
export function parseObjectPath(ctx: Ctx, pathname: string): { id: string; part: string } | null {
  const folder = containerFolder(ctx);
  if (!pathname.startsWith(folder)) return null;
  const rest = pathname.slice(folder.length).split('/');
  if (rest.length !== 2 || !rest[0] || !rest[1]) return null;
  return { id: rest[0], part: rest[1] };
}

// ---- Which store ----

let forTests: AttachmentObjects | null | undefined;

/** Tests put a store kept in memory here (null: none connected); undefined
 *  puts back the real one. */
export function setAttachmentObjectsForTests(store: AttachmentObjects | null | undefined): void {
  forTests = store;
}

/** Whether a file store is connected (the Blob token is set): what viewing,
 *  deleting, downloading and the sweep need (lib/attachments.ts). */
export function objectsConnected(): boolean {
  return forTests !== undefined ? forTests !== null : Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/** The connected store, or null when there is none. */
export function attachmentObjects(): AttachmentObjects | null {
  if (forTests !== undefined) return forTests;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return token ? vercelAttachmentObjects(token) : null;
}

/** Runs one call against a time limit (see the header). */
export async function withLimit<T>(what: string, ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new StoreTimeoutError(what, ms));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The private host a store's objects are read from, by its id in the token
 *  (as the SDK reads it: the fourth "_" part). */
export function privateHost(token: string): string {
  const storeId = token.split('_')[3] ?? '';
  if (!/^[A-Za-z0-9]{1,64}$/.test(storeId)) throw new Error('BLOB_READ_WRITE_TOKEN is not a Vercel Blob read-write token.');
  return `${storeId.toLowerCase()}.private.blob.vercel-storage.com`;
}

/** Whether a URL Blob answered is on a private Blob host. */
export const isPrivateBlobUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.endsWith('.private.blob.vercel-storage.com');
  } catch {
    return false;
  }
};

/** GETs a private object with node's own client (see the header): its bytes,
 *  or null on a 404. */
function readBytes(url: string, token: string, signal: AbortSignal): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'identity' }, signal }, (res) => {
      if (res.statusCode === 404) {
        res.resume();
        resolve(null);
        return;
      }
      const encoding = res.headers['content-encoding'];
      if (res.statusCode !== 200 || (encoding && encoding !== 'identity')) {
        res.resume();
        reject(new Error(res.statusCode !== 200 ? `The file store answered ${res.statusCode}.` : `The file store answered with content-encoding ${encoding}.`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/** The parts of the SDK used here, and the reader: a test passes stand-ins
 *  to see every option sent. */
export type BlobSdk = Pick<typeof import('@vercel/blob'), 'put' | 'del' | 'list'>;
export type ReadBytes = (url: string, token: string, signal: AbortSignal) => Promise<Uint8Array | null>;

/** Vercel Blob, private, with the read-write token given on every call. */
export function vercelAttachmentObjects(token: string, deps: { sdk?: () => Promise<BlobSdk>; read?: ReadBytes } = {}): AttachmentObjects {
  // Worked out when first read, so a token that isn't one fails the read
  // that needs it, never the code that only lists or deletes.
  const host = () => privateHost(token);
  const sdk = deps.sdk ?? (() => import('@vercel/blob'));
  const read = deps.read ?? readBytes;
  return {
    async put(pathname, bytes, signal) {
      const blob = await sdk();
      const result = await blob.put(pathname, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
        token,
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/octet-stream',
        cacheControlMaxAge: 60,
        multipart: false,
        abortSignal: signal,
      });
      if (!isPrivateBlobUrl(result.url)) {
        await blob.del(pathname, { token }).catch(() => {});
        throw new StoreNotPrivateError();
      }
    },
    async get(pathname, signal) {
      const url = new URL(`https://${host()}/${pathname}`);
      url.searchParams.set('cache', '0');
      return read(url.toString(), token, signal);
    },
    async del(pathnames, signal) {
      const blob = await sdk();
      for (let i = 0; i < pathnames.length; i += 100) await blob.del(pathnames.slice(i, i + 100), { token, abortSignal: signal });
    },
    async list(prefix, signal) {
      const blob = await sdk();
      const out: StoredObject[] = [];
      let cursor: string | undefined;
      do {
        const page = await blob.list({ token, prefix, cursor, limit: 1000, abortSignal: signal });
        for (const b of page.blobs) out.push({ pathname: b.pathname, size: b.size, uploadedAt: new Date(b.uploadedAt) });
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
    async folders(prefix, signal) {
      const blob = await sdk();
      const out: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await blob.list({ token, prefix, cursor, mode: 'folded', abortSignal: signal });
        out.push(...page.folders);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
  };
}
