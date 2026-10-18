import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { FakeRedis, storageMock, testKey, unscopedDataKeys } from './fake-redis';

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { fetchEcbRates, ECB_HISTORY_URL } = await import('@/lib/fx/ecb-fetch');
const { ecbStore } = await import('@/lib/fx/ecb-store');
const route = await import('@/app/api/fx/fetch/route');

// The ECB's own rows (eurofxref-hist.zip as of 14 Sep 2026), cut to a few
// stretches, zipped by another tool (test/fixtures/ecb).
const ZIP = new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures/ecb/eurofxref-hist-cut.zip')));
const CSV = readFileSync(join(import.meta.dir, 'fixtures/ecb/eurofxref-hist-cut.csv'), 'utf8');
const KEY = testKey('fx:ecb');
const NOW = Date.parse('2026-09-14T16:30:00.000Z');
const env = { ...process.env };

/** A one-entry zip, as the ECB's is. */
function zipOf(name: string, text: string | Uint8Array): Uint8Array {
  const data = typeof text === 'string' ? Buffer.from(text, 'utf8') : Buffer.from(text);
  const packed = deflateRawSync(data);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(crc32(data), 16);
  cd.writeUInt32LE(packed.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(n.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + n.length, 12);
  end.writeUInt32LE(30 + n.length + packed.length, 16);
  return new Uint8Array(Buffer.concat([local, n, packed, cd, n, end]));
}

const serve = (bytes: Uint8Array, status = 200) => async (url: string) => {
  expect(url).toBe(ECB_HISTORY_URL);
  return { status, bytes };
};
const run = (opts: Parameters<typeof fetchEcbRates>[0] = {}) => fetchEcbRates({ now: () => NOW, download: serve(ZIP), ...opts });
const stored = () => fake.hashes.get(KEY) ?? new Map<string, string>();
const fetchRecord = async () => (await ecbStore.getMany(['fetch'])).get('fetch') as any;
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const [e, w] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await f();
  } finally {
    [console.error, console.warn] = [e, w];
  }
};

beforeEach(() => fake.reset());
afterEach(() => {
  process.env = { ...env };
});

describe('the nightly fetch', () => {
  test('fills an empty store from the whole history, newest year first, and records it worked', async () => {
    const outcome = await run();
    expect(outcome).toEqual({ ok: true, newest: '2026-09-14', written: ['2026', '2025', '2022', '2011', '2010', '1999'], refused: [] });
    const fields = await ecbStore.getMany(['latest', 'days:2026', 'USD:2026', 'RUB:2022', 'BGN:2026']);
    expect((fields.get('latest') as any).date).toBe('2026-09-14');
    expect((fields.get('USD:2026') as any)['2026-09-14']).toBe('1.1551');
    expect(fields.has('RUB:2022')).toBe(true);
    expect(fields.has('BGN:2026')).toBe(false);
    expect(await fetchRecord()).toEqual({ at: '2026-09-14T16:30:00.000Z', ok: true, newest: '2026-09-14', last_ok: '2026-09-14T16:30:00.000Z' });
  });

  test('the next night writes only the years that can still change', async () => {
    await run();
    const before = stored().get('USD:2010');
    const again = await run();
    expect(again).toMatchObject({ ok: true, written: ['2026', '2025'] });
    expect(stored().get('USD:2010')).toBe(before);
  });

  test('full compares and rewrites every year', async () => {
    await run();
    expect(await run({ full: true })).toMatchObject({ ok: true, written: ['2026', '2025', '2022', '2011', '2010', '1999'] });
  });

  test('a stored calendar that can’t be used is written again', async () => {
    await run();
    fake.hashes.get(KEY)!.set('days:2010', 'damaged');
    expect((await run()).ok).toBe(true);
    expect(JSON.parse(stored().get('days:2010')!)[0]).toBe('2010-12-27');
  });

  test('a stale copy of the file changes nothing, and says so', async () => {
    await run();
    const before = new Map(stored());
    const stale = zipOf('eurofxref-hist.csv', CSV.split('\n').filter((l) => !l.startsWith('2026-09-14')).join('\n'));
    const outcome = await quiet(() => run({ download: serve(stale), now: () => NOW + 3_600_000 }));
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining('older than the stored 2026-09-14') });
    for (const [k, v] of before) if (k !== 'fetch') expect(stored().get(k)).toBe(v);
    // The last success is kept, so staleness is judged from it.
    expect(await fetchRecord()).toMatchObject({ ok: false, last_ok: '2026-09-14T16:30:00.000Z', newest: '2026-09-11' });
  });

  test.each([
    ['the download fails', { download: async () => Promise.reject(new Error('getaddrinfo ENOTFOUND')) }, 'the download failed'],
    ['the ECB answers 503', { download: serve(new Uint8Array(), 503) }, 'answered 503'],
    ['the zip is damaged', { download: serve(ZIP.map((b, i) => (i === 100 ? b ^ 0xff : b))) }, 'damaged'],
    ['the zip holds another file', { download: serve(zipOf('other.csv', CSV)) }, 'eurofxref-hist.csv'],
    ['the file isn’t the ECB’s', { download: serve(zipOf('eurofxref-hist.csv', 'Day,USD,\n2026-09-14,1.1,\n')) }, 'Date column'],
    ['the file isn’t text', { download: serve(zipOf('eurofxref-hist.csv', new Uint8Array([0x44, 0xff, 0xfe, 0x0a]))) }, 'UTF-8'],
  ])('%s: nothing is written, the reason recorded', async (_, opts, reason) => {
    const outcome = await quiet(() => run(opts as never));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain(reason);
    expect([...stored().keys()]).toEqual(['fetch']);
    expect(await fetchRecord()).toMatchObject({ ok: false, last_ok: null });
  });

  test('a download that hangs is a failure within its limit, recorded', async () => {
    const hang = (_: string, signal: AbortSignal) =>
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason ?? new DOMException('Timed out', 'TimeoutError'))));
    const outcome = await quiet(() => run({ download: hang, downloadTimeoutMs: 20 }));
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining('took longer') });
    expect((await fetchRecord()).ok).toBe(false);
  });

  test('writes past their deadline stop between years, each year whole', async () => {
    // Each year's write takes ten seconds, on the run's clock.
    let t = NOW;
    const hset = fake.hset.bind(fake);
    fake.hset = (async (key: string, fields: Record<string, string>) => {
      t += 10_000;
      return hset(key, fields);
    }) as typeof fake.hset;
    let outcome: Awaited<ReturnType<typeof run>>;
    try {
      outcome = await quiet(() => run({ now: () => t, writeDeadlineMs: 25_000 }));
    } finally {
      fake.hset = hset;
    }
    expect(outcome.ok).toBe(false);
    expect(outcome.written.length).toBeGreaterThan(0);
    expect(outcome.written.length).toBeLessThan(6);
    // What was written is whole: each written year has its calendar.
    for (const y of outcome.written) expect(stored().has(`days:${y}`)).toBe(true);
  });

  test('a store that can’t be reached is a failure, never a crash', async () => {
    fake.failNext('hkeys');
    const outcome = await quiet(() => run());
    expect(outcome.ok).toBe(false);
  });

  // Upstash doesn't time a request out on its own, and Vercel ends the
  // function at maxDuration with nothing after: every call is raced.
  test('a read of the store that never answers is a failure within the run’s time, recorded', async () => {
    const hkeys = fake.hkeys.bind(fake);
    fake.hkeys = (() => new Promise(() => {})) as typeof fake.hkeys;
    try {
      const outcome = await quiet(() => run({ now: Date.now, readTimeoutMs: 30 }));
      expect(outcome).toMatchObject({ ok: false, reason: 'reading the stored rates’ names took longer than 0.03s, after 0 years written' });
    } finally {
      fake.hkeys = hkeys;
    }
    expect(await fetchRecord()).toMatchObject({ ok: false, reason: expect.stringContaining('took longer') });
  });

  test('a write that never answers is a failure naming its year, and the next night writes it', async () => {
    const hset = fake.hset.bind(fake);
    let calls = 0;
    // The first year's write hangs; the record of the outcome lands.
    fake.hset = ((key: string, fields: Record<string, string>) => (++calls === 1 ? new Promise(() => {}) : hset(key, fields))) as typeof fake.hset;
    try {
      const outcome = await quiet(() => run({ now: Date.now, budgetMs: 60 }));
      expect(outcome).toMatchObject({ ok: false, written: [] });
      if (!outcome.ok) expect(outcome.reason).toMatch(/^writing 2026 took longer than 0\.0\d+s, after 0 years written$/);
    } finally {
      fake.hset = hset;
    }
    expect(await fetchRecord()).toMatchObject({ ok: false });
    // Nothing of the year was half written, and the next run fills it.
    expect(stored().has('days:2026')).toBe(false);
    expect((await run()).ok).toBe(true);
    expect(stored().has('days:2026')).toBe(true);
  });

  test('a record of the outcome that never lands still ends the run in time, its failure said', async () => {
    const hset = fake.hset.bind(fake);
    fake.hset = (() => new Promise(() => {})) as typeof fake.hset;
    const errors: string[] = [];
    const [e, w] = [console.error, console.warn];
    console.error = (...args: unknown[]) => void errors.push(args.join(' '));
    console.warn = () => {};
    try {
      const started = Date.now();
      const outcome = await run({ now: Date.now, budgetMs: 40, recordMs: 40 });
      expect(outcome.ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      fake.hset = hset;
      [console.error, console.warn] = [e, w];
    }
    expect(errors.some((m) => m.includes('the outcome could not be recorded') && m.includes('recording the outcome took longer than 0.04s'))).toBe(true);
  });
});

describe('its cron route', () => {
  const call = (auth?: string, query = '') =>
    route.GET(new Request(`http://x/api/fx/fetch${query}`, { headers: auth ? { authorization: auth } : {} }));

  test('refuses without the cron secret', async () => {
    process.env.CRON_SECRET = 'cron-secret-for-tests';
    expect((await call()).status).toBe(401);
    expect((await call('Bearer wrong')).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await call('Bearer cron-secret-for-tests')).status).toBe(401);
    expect(fake.hashes.has(KEY)).toBe(false);
  });

  test('answers 500 with the reason when the fetch fails', async () => {
    process.env.CRON_SECRET = 'cron-secret-for-tests';
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('no', { status: 503 })) as unknown as typeof fetch;
    try {
      const r = await quiet(() => call('Bearer cron-secret-for-tests'));
      expect(r.status).toBe(500);
      expect(await r.json()).toMatchObject({ ok: false, reason: expect.stringContaining('503') });
    } finally {
      globalThis.fetch = original;
    }
  });
});
