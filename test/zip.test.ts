import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib';
import { crc32, isZip, listZip, readEntry, type ZipEntry } from '@/lib/zip';

// lib/zip.ts, shared by the migration importers (lib/import/apps/zip.ts, whose
// messages test/migration-parsers.test.ts checks) and the ECB's history file.

const LIMITS = { maxEntries: 4, maxEntryBytes: 64 * 1024 };
const FIXTURE = new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures/ecb/eurofxref-hist-cut.zip')));
const CSV = readFileSync(join(import.meta.dir, 'fixtures/ecb/eurofxref-hist-cut.csv'));

type Spec = { name: string; data: Buffer; method?: number; flags?: number; crc?: number; streamed?: boolean; size?: number };

/** A zip of these entries, as a writer would make it: deflated by default;
 *  `streamed` puts zero sizes and CRC in the local header and a data
 *  descriptor after the data (flag bit 3), as a zip written to a stream does. */
function zipOf(entries: Spec[], opts: { count?: number } = {}): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let at = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const packed = method === 8 ? deflateRawSync(e.data) : e.data;
    const crc = e.crc ?? zlibCrc32(e.data);
    const size = e.size ?? e.data.length;
    const flags = (e.flags ?? 0) | (e.streamed ? 8 : 0);
    const n = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!e.streamed) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(size, 22);
    }
    local.writeUInt16LE(n.length, 26);
    const descriptor = Buffer.alloc(e.streamed ? 16 : 0);
    if (e.streamed) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(packed.length, 8);
      descriptor.writeUInt32LE(size, 12);
    }
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(n.length, 28);
    cd.writeUInt32LE(at, 42);
    parts.push(local, n, packed, descriptor);
    central.push(cd, n);
    at += 30 + n.length + packed.length + descriptor.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(opts.count ?? entries.length, 8);
  end.writeUInt16LE(opts.count ?? entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(at, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, end]));
}

const only = (bytes: Uint8Array) => (listZip(bytes, LIMITS) as ZipEntry[])[0];

describe('a zip', () => {
  test('written by another tool reads back whole, its CRC checked', () => {
    expect(isZip(FIXTURE)).toBe(true);
    const entries = listZip(FIXTURE, { maxEntries: 4, maxEntryBytes: 1024 * 1024 });
    expect(Array.isArray(entries)).toBe(true);
    const e = (entries as ZipEntry[])[0];
    expect(e.name).toBe('eurofxref-hist.csv');
    const out = readEntry(FIXTURE, e, { maxEntries: 4, maxEntryBytes: 1024 * 1024 });
    expect(Buffer.from(out as Uint8Array).equals(CSV)).toBe(true);
  });

  test('streamed, its sizes after the data, reads through its index', () => {
    const bytes = zipOf([{ name: 'a.csv', data: Buffer.from('Date,USD,\n2026-09-14,1.1551,\n'), streamed: true }]);
    expect(Buffer.from(readEntry(bytes, only(bytes), LIMITS) as Uint8Array).toString()).toBe('Date,USD,\n2026-09-14,1.1551,\n');
  });

  test('stored, uncompressed, reads too', () => {
    const bytes = zipOf([{ name: 'a.txt', data: Buffer.from('plain'), method: 0 }]);
    expect(Buffer.from(readEntry(bytes, only(bytes), LIMITS) as Uint8Array).toString()).toBe('plain');
  });

  test('the CRC-32 is the zip format’s', () => {
    for (const s of ['', 'a', 'The quick brown fox jumps over the lazy dog', 'x'.repeat(100_000)]) {
      const b = Buffer.from(s);
      expect(crc32(b)).toBe(zlibCrc32(b));
    }
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('what is refused', () => {
  test('a wrong CRC, or a size the data doesn’t have, is damage', () => {
    const data = Buffer.from('Date,USD,\n2026-09-14,1.1551,\n');
    const wrongCrc = zipOf([{ name: 'a.csv', data, crc: 1 }]);
    expect(readEntry(wrongCrc, only(wrongCrc), LIMITS)).toEqual({ problem: 'damaged' });
    const wrongSize = zipOf([{ name: 'a.csv', data, size: data.length + 1 }]);
    expect(readEntry(wrongSize, only(wrongSize), LIMITS)).toEqual({ problem: 'damaged' });
  });

  test('inflate stops at the bound, whatever the index says', () => {
    const big = Buffer.alloc(LIMITS.maxEntryBytes * 4, 'a');
    const lying = zipOf([{ name: 'bomb.csv', data: big, size: 10 }]);
    expect(readEntry(lying, only(lying), LIMITS)).toEqual({ problem: 'damaged' });
    const honest = zipOf([{ name: 'big.csv', data: big }]);
    expect(readEntry(honest, only(honest), LIMITS)).toEqual({ problem: 'too-large' });
  });

  test('encrypted, another method, too many entries, split or ZIP64, or no zip at all', () => {
    const data = Buffer.from('x');
    const locked = zipOf([{ name: 'a', data, flags: 1 }]);
    expect(readEntry(locked, only(locked), LIMITS)).toEqual({ problem: 'encrypted' });
    const bzip = zipOf([{ name: 'a', data, method: 12 }]);
    expect(readEntry(bzip, only(bzip), LIMITS)).toEqual({ problem: 'method' });
    const many = zipOf([1, 2, 3, 4, 5].map((i) => ({ name: `f${i}`, data })));
    expect(listZip(many, LIMITS)).toEqual({ problem: 'too-many', count: 5 });
    expect(listZip(zipOf([{ name: 'a', data }], { count: 0xffff }), LIMITS)).toEqual({ problem: 'unsupported' });
    expect(listZip(new Uint8Array([1, 2, 3]), LIMITS)).toEqual({ problem: 'damaged' });
    expect(listZip(FIXTURE.subarray(0, FIXTURE.length - 30), LIMITS)).toEqual({ problem: 'damaged' });
    expect(isZip(new Uint8Array([0x50, 0x4b]))).toBe(false);
  });
});
