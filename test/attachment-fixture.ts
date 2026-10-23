// test/attachment-fixture.ts
//
// What the receipts and documents tests share (lib/attachments.ts): a file
// store kept in memory that records every call, a container given a data
// key of its own (attachments need one), and small files to send: a JPEG
// header the server's checks read, a PDF, with markers to look for in what
// is stored.

import type { AttachmentObjects, StoredObject } from '@/lib/attachment-objects';

export type ObjectCall = { op: 'put' | 'get' | 'del' | 'list' | 'folders'; path: string };

/** A file store in memory. `fail` makes the named operations throw; `clock`
 *  is what an object's upload time is read from. */
export class FakeObjects implements AttachmentObjects {
  readonly objects = new Map<string, { bytes: Uint8Array; uploadedAt: Date }>();
  readonly calls: ObjectCall[] = [];
  fail = new Set<ObjectCall['op']>();
  /** How long each operation takes, in milliseconds (a slow store). */
  delay = new Map<ObjectCall['op'], number>();
  clock: () => Date = () => new Date();

  private async check(op: ObjectCall['op'], path: string) {
    this.calls.push({ op, path });
    const ms = this.delay.get(op);
    if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
    if (this.fail.has(op)) throw new Error(`the fake store refused ${op}`);
  }
  async put(pathname: string, bytes: Uint8Array) {
    await this.check('put', pathname);
    this.objects.set(pathname, { bytes: new Uint8Array(bytes), uploadedAt: this.clock() });
  }
  async get(pathname: string) {
    await this.check('get', pathname);
    return this.objects.get(pathname)?.bytes ?? null;
  }
  async del(pathnames: string[]) {
    await this.check('del', pathnames.join(','));
    for (const p of pathnames) this.objects.delete(p);
  }
  async list(prefix: string): Promise<StoredObject[]> {
    await this.check('list', prefix);
    return [...this.objects]
      .filter(([p]) => p.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([pathname, o]) => ({ pathname, size: o.bytes.length, uploadedAt: o.uploadedAt }));
  }
  async folders(prefix: string): Promise<string[]> {
    await this.check('folders', prefix);
    const out = new Set<string>();
    for (const p of this.objects.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash > 0) out.add(prefix + rest.slice(0, slash + 1));
    }
    return [...out].sort();
  }
  /** Every byte stored, end to end. */
  everything(): Uint8Array {
    const all = [...this.objects.values()].map((o) => o.bytes);
    const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of all) {
      out.set(b, at);
      at += b.length;
    }
    return out;
  }
  reset() {
    this.objects.clear();
    this.calls.length = 0;
    this.fail.clear();
    this.delay.clear();
    this.clock = () => new Date();
  }
}

/** Whether `needle` occurs anywhere in `hay`. */
export function contains(hay: Uint8Array, needle: Uint8Array | string): boolean {
  const n = typeof needle === 'string' ? new TextEncoder().encode(needle) : needle;
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

const bytes = (...parts: (number[] | Uint8Array | string)[]) => {
  const arrays = parts.map((p) => (typeof p === 'string' ? new TextEncoder().encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
};

/** A JPEG segment: its marker, its length and its data. */
export function segment(marker: number, data: Uint8Array | string): Uint8Array {
  const d = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return bytes([0xff, marker, (d.length + 2) >> 8, (d.length + 2) & 0xff], d);
}

/** An Exif block whose first directory holds these tags (each a dummy value). */
export function exif(tags: number[]): Uint8Array {
  const entries = tags.flatMap((t) => [t & 0xff, t >> 8, 3, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  const count = tags.length;
  return bytes('Exif\0\0', [0x49, 0x49, 42, 0, 8, 0, 0, 0, count & 0xff, count >> 8], entries, [0, 0, 0, 0]);
}

/** Something that reads as a JPEG to the server's checks: the start of one
 *  (as a canvas writes it, with only a JFIF block, unless `extra` adds
 *  others), a marker string in its "image data", and padding to `size`. */
export function jpeg(size = 4000, marker = 'RECEIPT-MARKER-PLAINTEXT', extra: Uint8Array[] = []): Uint8Array {
  const head = bytes([0xff, 0xd8], segment(0xe0, bytes('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0])), ...extra, segment(0xda, bytes([1, 1, 0, 0, 0x3f, 0])), marker);
  const out = new Uint8Array(Math.max(size, head.length + 2));
  out.set(head);
  for (let i = head.length; i < out.length - 2; i++) out[i] = (i * 31) & 0xff;
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  return out;
}

/** Something that reads as a PDF, with a marker in it. */
export function pdf(size = 6000, marker = 'PDF-MARKER-PLAINTEXT'): Uint8Array {
  const head = bytes('%PDF-1.7\n', marker, '\n');
  const out = new Uint8Array(Math.max(size, head.length));
  out.set(head);
  for (let i = head.length; i < out.length; i++) out[i] = 0x20 + ((i * 7) % 90);
  return out;
}

export async function sha(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** The SHA-256 of each part of a file, as the page sends them. */
export async function partShas(file: Uint8Array, partBytes: number): Promise<string[]> {
  const out: string[] = [];
  for (let at = 0; at < file.length; at += partBytes) out.push(await sha(file.subarray(at, at + partBytes)));
  return out;
}

export const MASTER = Buffer.alloc(32, 3).toString('base64');
