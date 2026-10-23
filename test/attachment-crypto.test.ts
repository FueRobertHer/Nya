import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer } from './fake-redis';
import { jpeg, pdf, segment, exif, contains, MASTER } from './attachment-fixture';

// How a receipt or document is sealed (lib/attachment-crypto.ts), the key
// that seals it wrapped under the account's own key and nothing else
// (lib/crypto.ts encryptOwn, decryptOwn), what is checked of its bytes, and
// the file store's options (lib/attachment-objects.ts): every write private,
// with the token given, on the private host or deleted at once.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const c = await import('@/lib/crypto');
const ac = await import('@/lib/attachment-crypto');
const objects = await import('@/lib/attachment-objects');

const ctx = TEST_CTX;
const OTHER = { container: '5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70' } as typeof TEST_CTX;
const saved = { ...process.env };

async function giveKey(container: string): Promise<string> {
  const p = await c.prepareContainerKey(container as never, { born: false });
  expect((await c.claimContainerKey(p!)).outcome).toBe('made');
  return p!.id;
}

beforeEach(async () => {
  fake.reset();
  c.forgetActiveKey();
  c.forgetContainerKey();
  process.env.MASTER_KEY = MASTER;
  await registerTestContainer(fake);
  await fake.hset('test:containers', { [OTHER.container]: JSON.stringify({ status: 'active', primary: false, created_at: '2026-01-01T00:00:00.000Z' }) });
});
afterEach(() => {
  process.env = { ...saved };
  c.forgetContainerKey();
});

describe('a file key is wrapped under the account’s own key and nothing else', () => {
  test('wrapped and opened again, only for its own attachment in its own account', async () => {
    await giveKey(ctx.container);
    await giveKey(OTHER.container);
    const key = ac.newFileKey();
    const wrapped = await ac.wrapFileKey(ctx, 'a1', key);
    expect(c.formatOf(wrapped).flags).toBe('c');
    expect(await ac.unwrapFileKey(ctx, 'a1', wrapped)).toEqual(key);
    // Another attachment's context, another account: never opened.
    await expect(ac.unwrapFileKey(ctx, 'a2', wrapped)).rejects.toThrow();
    await expect(ac.unwrapFileKey(OTHER, 'a1', wrapped)).rejects.toThrow();
  });

  test('a container with no key of its own can wrap nothing (NoOwnKeyError), never under a shared key', async () => {
    await expect(ac.wrapFileKey(ctx, 'a1', ac.newFileKey())).rejects.toBeInstanceOf(c.NoOwnKeyError);
    expect(await c.hasOwnKey(ctx)).toBe(false);
  });

  test('decryptOwn refuses what decrypt reads: a value under a shared key, or one bound to no context', async () => {
    await giveKey(ctx.container);
    // Bound to the context but under the environment's shared key (as a bug
    // that sealed it some other way would): decrypt reads it in any
    // container, decryptOwn never.
    const sharedKey = c.formatOf(await c.encrypt(OTHER, 'x')).keyId;
    const shared = await c.encryptV2('secret', sharedKey, 'attachment:x');
    expect(await c.decrypt(ctx, shared, 'attachment:x')).toBe('secret');
    await expect(c.decryptOwn(ctx, shared, 'attachment:x')).rejects.toBeInstanceOf(c.DecryptFailedError);
    const unbound = await c.encrypt(ctx, 'secret');
    expect(await c.decrypt(ctx, unbound, 'attachment:x')).toBe('secret');
    await expect(c.decryptOwn(ctx, unbound, 'attachment:x')).rejects.toBeInstanceOf(c.DecryptFailedError);
  });

  test('THE INVARIANT: a container’s own key is never replaced while it lives, because file keys sealed under it are inside records no re-keying pass can see', async () => {
    // What would happen if it were: a file key sealed under the first key no
    // longer opens once the map names another. docs/architecture.md says so,
    // and any future re-keying must open each with decryptOwn and seal it again.
    await giveKey(ctx.container);
    const wrapped = await ac.wrapFileKey(ctx, 'a1', ac.newFileKey());
    const raw = await fake.hget<unknown>(c.containerKeysKey(), ctx.container);
    const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
    // A second key made for the SAME container, stored and mapped in the
    // first one's place: its record names this container, so it loads as the
    // container's own, and only decryptOwn's check of the key id refuses the
    // file key sealed under the first (review 14).
    const another = (await c.prepareContainerKey(ctx.container as never, { born: false }))!;
    await fake.hset(c.keysHashKey(), { [another.id]: another.record });
    await fake.hset(c.containerKeysKey(), { [ctx.container]: JSON.stringify({ ...entry, key: another.id }) });
    c.forgetContainerKey();
    expect(await c.hasOwnKey(ctx)).toBe(true);
    await expect(ac.unwrapFileKey(ctx, 'a1', wrapped)).rejects.toThrow('not under this container’s own key');
  });
});

describe('a part, sealed', () => {
  const key = ac.newFileKey();
  test('opens only as the part of the file and account it was sealed for', async () => {
    const body = jpeg(5000);
    const sealed = await ac.sealPart(key, ctx.container, 'a1', 0, 2, body);
    expect(sealed[0]).toBe(ac.PART_FORMAT);
    expect(sealed.length).toBe(ac.sealedSize(body.length));
    expect(await ac.openPart(key, ctx.container, 'a1', 0, 2, sealed)).toEqual(body);
    for (const [container, id, part, parts] of [
      [OTHER.container, 'a1', 0, 2],
      [ctx.container, 'a2', 0, 2],
      [ctx.container, 'a1', 1, 2],
      [ctx.container, 'a1', 't', 2],
      [ctx.container, 'a1', 0, 1], // cut short: the count is in every part
    ] as const) {
      await expect(ac.openPart(key, container, id, part, parts, sealed)).rejects.toBeInstanceOf(ac.AttachmentDamagedError);
    }
    await expect(ac.openPart(ac.newFileKey(), ctx.container, 'a1', 0, 2, sealed)).rejects.toBeInstanceOf(ac.AttachmentDamagedError);
    const flipped = new Uint8Array(sealed);
    flipped[40] ^= 1;
    await expect(ac.openPart(key, ctx.container, 'a1', 0, 2, flipped)).rejects.toBeInstanceOf(ac.AttachmentDamagedError);
  });

  test('nothing readable in it: no JPEG or PDF start, no marker', async () => {
    for (const body of [jpeg(9000), pdf(9000)]) {
      const sealed = await ac.sealPart(key, ctx.container, 'a1', 0, 1, body);
      expect(contains(sealed, 'RECEIPT-MARKER-PLAINTEXT')).toBe(false);
      expect(contains(sealed, 'PDF-MARKER-PLAINTEXT')).toBe(false);
      expect(contains(sealed, '%PDF')).toBe(false);
      expect(contains(sealed, new Uint8Array([0xff, 0xd8, 0xff]))).toBe(false);
    }
  });

  test('parts and sizes', () => {
    expect(ac.partSizes(1)).toEqual([1]);
    expect(ac.partSizes(ac.PART_BYTES)).toEqual([ac.PART_BYTES]);
    expect(ac.partSizes(ac.PART_BYTES + 1)).toEqual([ac.PART_BYTES, 1]);
    expect(ac.partSizes(ac.MAX_FILE_BYTES).length).toBe(ac.MAX_PARTS);
    expect(ac.partSizes(0)).toEqual([]);
    expect(ac.storedBytes(ac.PART_BYTES + 1, 100)).toBe(ac.PART_BYTES + 1 + 2 * ac.SEAL_OVERHEAD + 100 + ac.SEAL_OVERHEAD);
    expect(ac.storedBytes(10, null)).toBe(10 + ac.SEAL_OVERHEAD);
  });
});

describe('what is checked of the bytes', () => {
  test('a JPEG as a canvas writes it passes; one carrying a location never does', () => {
    expect(ac.jpegProblem(jpeg())).toBeNull();
    // Exif without a location (an orientation tag): fine.
    expect(ac.jpegProblem(jpeg(4000, 'x', [segment(0xe1, exif([0x0112]))]))).toBeNull();
    // Exif with a GPS directory, XMP, Photoshop: refused.
    expect(ac.jpegProblem(jpeg(4000, 'x', [segment(0xe1, exif([0x0112, 0x8825]))]))).toContain('where it was taken');
    expect(ac.jpegProblem(jpeg(4000, 'x', [segment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>')]))).toContain('where it was taken');
    expect(ac.jpegProblem(jpeg(4000, 'x', [segment(0xed, 'Photoshop 3.0\0')]))).toContain('where it was taken');
    // An Exif block that can't be read is refused rather than guessed.
    expect(ac.jpegProblem(jpeg(4000, 'x', [segment(0xe1, 'Exif\0\0garbage')]))).toContain('where it was taken');
    // Not a JPEG, or a header that never reaches its first scan.
    expect(ac.jpegProblem(pdf())).toBe('This isn’t a JPEG photo.');
    expect(ac.jpegProblem(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2]))).toBe('This photo can’t be read.');
  });

  test('extended XMP, and a location segment placed between scans, are refused too (review nit 17)', () => {
    expect(ac.jpegProblem(jpeg(4000, 'x', [segment(0xe1, 'http://ns.adobe.com/xmp/extension/\0ABCDEF')]))).toContain('where it was taken');
    // A progressive JPEG's second scan, with an Exif GPS block before it.
    const scan = (data: number[]) => new Uint8Array([...data]);
    const later = (extra: Uint8Array) => {
      const first = jpeg(600, 'x');
      const tail = new Uint8Array([...segment(0xc4, new Uint8Array([0, 1, 2, 3])), ...extra, ...segment(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0])), ...scan([1, 2, 0xff, 0x00, 3, 0xff, 0xd0, 4]), 0xff, 0xd9]);
      const out = new Uint8Array(first.length - 2 + tail.length);
      out.set(first.subarray(0, first.length - 2));
      out.set(tail, first.length - 2);
      return out;
    };
    expect(ac.jpegProblem(later(new Uint8Array()))).toBeNull();
    expect(ac.jpegProblem(later(segment(0xe1, exif([0x8825]))))).toContain('where it was taken');
    expect(ac.jpegProblem(later(segment(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x/>')))).toContain('where it was taken');
    // A part cut off inside a scan is walked as far as it goes.
    expect(ac.jpegProblem(later(segment(0xe1, exif([0x8825]))).subarray(0, 300))).toBeNull();
  });

  test('a PDF says so in its first kilobyte, as readers allow', () => {
    expect(ac.pdfProblem(pdf())).toBeNull();
    const late = new Uint8Array(2000);
    late.set(new TextEncoder().encode('%PDF-1.4'), 900);
    expect(ac.pdfProblem(late)).toBeNull();
    const tooLate = new Uint8Array(2000);
    tooLate.set(new TextEncoder().encode('%PDF-1.4'), 1100);
    expect(ac.pdfProblem(tooLate)).toBe('This isn’t a PDF.');
    expect(ac.pdfProblem(jpeg())).toBe('This isn’t a PDF.');
  });
});

describe('the file store', () => {
  const TOKEN = 'vercel_blob_rw_AbCd1234_secretpart';

  function sdk(url: (path: string) => string) {
    const calls: { op: string; args: unknown[] }[] = [];
    return {
      calls,
      sdk: async () =>
        ({
          put: async (path: string, _body: unknown, opts: unknown) => {
            calls.push({ op: 'put', args: [path, opts] });
            return { url: url(path) };
          },
          del: async (paths: unknown, opts: unknown) => {
            calls.push({ op: 'del', args: [paths, opts] });
          },
          list: async (opts: unknown) => {
            calls.push({ op: 'list', args: [opts] });
            return { blobs: [], folders: [], hasMore: false };
          },
        }) as never,
    };
  }

  test('every write is private, with the token given, no suffix, a 60 second cache, on the private host', async () => {
    const s = sdk((p) => `https://abcd1234.private.blob.vercel-storage.com/${p}`);
    const store = objects.vercelAttachmentObjects(TOKEN, { sdk: s.sdk });
    await store.put('attachments/test/c/a/0', new Uint8Array([1, 2, 3]), new AbortController().signal);
    const opts = s.calls[0].args[1] as Record<string, unknown>;
    expect(opts).toMatchObject({ token: TOKEN, access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/octet-stream', cacheControlMaxAge: 60, multipart: false });
    await store.del(['x'], new AbortController().signal);
    await store.list('p/', new AbortController().signal);
    await store.folders('p/', new AbortController().signal);
    for (const call of s.calls) expect(JSON.stringify(call.args)).toContain(TOKEN);
  });

  test('a store that answers on a public address: the object is deleted at once, and the write fails', async () => {
    const s = sdk((p) => `https://abcd1234.public.blob.vercel-storage.com/${p}`);
    const store = objects.vercelAttachmentObjects(TOKEN, { sdk: s.sdk });
    await expect(store.put('attachments/test/c/a/0', new Uint8Array([1]), new AbortController().signal)).rejects.toBeInstanceOf(objects.StoreNotPrivateError);
    expect(s.calls.map((c) => c.op)).toEqual(['put', 'del']);
    // Within a time of its own (review nit 18), with the token.
    expect(s.calls[1].args[1]).toMatchObject({ token: TOKEN, abortSignal: expect.any(AbortSignal) });
  });

  test('reads go to the private host of the token’s store, with the token, past the cache', async () => {
    const seen: string[] = [];
    const store = objects.vercelAttachmentObjects(TOKEN, {
      sdk: sdk(() => '').sdk,
      read: async (url, token) => {
        seen.push(`${url} ${token}`);
        return null;
      },
    });
    expect(await store.get('attachments/test/c/a/0', new AbortController().signal)).toBeNull();
    expect(seen).toEqual([`https://abcd1234.private.blob.vercel-storage.com/attachments/test/c/a/0?cache=0 ${TOKEN}`]);
    expect(() => objects.privateHost('not-a-token')).toThrow();
  });

  test('paths: random ids only, the container’s folder with its slash, from the Ctx alone', () => {
    expect(objects.containerFolder(ctx)).toBe(`attachments/test/${ctx.container}/`);
    expect(objects.objectPath(ctx, 'a1', 0)).toBe(`attachments/test/${ctx.container}/a1/0`);
    expect(objects.objectPaths(ctx, 'a1', 2, true)).toEqual([0, 1, 't'].map((p) => `attachments/test/${ctx.container}/a1/${p}`));
    expect(objects.parseObjectPath(ctx, objects.objectPath(ctx, 'a1', 't'))).toEqual({ id: 'a1', part: 't' });
    expect(objects.parseObjectPath(ctx, objects.objectPath(OTHER, 'a1', 0))).toBeNull();
    expect(objects.isPrivateBlobUrl('https://x.private.blob.vercel-storage.com/a')).toBe(true);
    expect(objects.isPrivateBlobUrl('https://x.public.blob.vercel-storage.com/a')).toBe(false);
    expect(objects.isPrivateBlobUrl('http://x.private.blob.vercel-storage.com/a')).toBe(false);
  });

  test('no code ever passes Blob a public access mode', () => {
    const root = join(import.meta.dir, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|js)$/.test(name) && /access:\s*['"]public['"]/.test(readFileSync(path, 'utf8'))) offenders.push(path);
      }
    };
    for (const dir of ['lib', 'app', 'components', 'scripts']) walk(join(root, dir));
    expect(offenders).toEqual([]);
  });
});
