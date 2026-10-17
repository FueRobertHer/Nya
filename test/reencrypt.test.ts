import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRedis, storageMock, testKey, ctxKey, TEST_CONTAINER } from './fake-redis';
import { keyNamesIn } from './key-names';
import { startRedis, upstashOn, type RealRedis } from './real-redis';

// The migration pass (lib/reencrypt.ts): a key of its own for every container
// that has none, and its values moved to it, a container at a time from a
// cursor, guarded by the container's map entry.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Raw, like the client the pass uses: values come back exactly as stored.
const fake = new FakeRedis();
let client: unknown = fake; // redis(), which lib/crypto and the registry use
let raw: unknown = fake; // rawRedis(), the pass's
mock.module('@/lib/storage', () => ({ ...storageMock(fake), redis: () => client, rawRedis: () => raw }));

const {
  encrypt,
  encryptV2,
  decrypt,
  formatOf,
  forgetActiveKey,
  activeKeyName,
  importMasterKey,
  dataKeyId,
  keysHashKey,
  containerKeysKey,
  rotationKey,
  keySeqKey,
  prepareContainerKey,
  claimContainerKey,
  ACTIVE_CACHE_MS,
  MAX_KEY_NUMBER,
  MasterKeyError,
} = await import('@/lib/crypto');
const { registryKey } = await import('@/lib/containers');
const { reencrypt, classify, CAS_STRING, CAS_HASH, PROBE } = await import('@/lib/reencrypt');
type Report = Awaited<ReturnType<typeof reencrypt>>;
const route = await import('@/app/api/ops/reencrypt/route');

// Distinct from other files' masters.
const MASTER = Buffer.alloc(32, 51).toString('base64');
const saved = { ...process.env };

const A = TEST_CONTAINER;
const B = '5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70'; // after A in id order
const ctxA = { container: A } as any;
const ctxB = { container: B } as any;
/** A container nobody registered: what it encrypts goes under the
 *  environment's active key. */
const NOBODY = { container: '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f' } as any;

const K0 = await crypto.subtle.importKey('raw', Buffer.alloc(32, 7), 'AES-GCM', false, ['encrypt']);
/** A value as written before data keys existed: v1 under k0. */
async function legacy(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, K0, new TextEncoder().encode(plain)));
  return Buffer.concat([iv, ct]).toString('base64');
}
/** A value under the environment's active data key, as a container without a
 *  key of its own writes. */
const envValue = (plain: string) => encrypt(NOBODY, plain);
const envKey = () => fake.strings.get(activeKeyName())!;

async function register(entries: (string | [string, string])[]) {
  for (const e of entries) {
    const [id, status] = typeof e === 'string' ? [e, 'active'] : e;
    await fake.hset(registryKey(), { [id]: JSON.stringify({ status, primary: id === A, created_at: '2026-01-01T00:00:00.000Z' }) });
  }
}
const entryOf = (container: string) => {
  const v = fake.hashes.get(containerKeysKey())?.get(container);
  return v === undefined ? undefined : JSON.parse(v);
};
/** Gives a registered container a key, as a run would. */
async function giveKey(container: string): Promise<string> {
  const p = (await prepareContainerKey(container as any, { born: false }))!;
  expect((await claimContainerKey(p)).outcome).toBe('made');
  return p.id;
}
/** A data key stored by hand, naming a container or none. */
async function plantKey(n: number, container?: string): Promise<string> {
  const m = await importMasterKey(MASTER);
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const id = await dataKeyId(n, bytes);
  const record = { created_at: '2026-01-01T00:00:00.000Z', wrapped: { [m.fingerprint]: await m.wrap(id, bytes) }, ...(container ? { container } : {}) };
  await fake.hset(keysHashKey(), { [id]: JSON.stringify(record) });
  return id;
}

/** Where a seed writes: the double, or a real Redis. */
type Put = { set(key: string, value: string): Promise<unknown>; hset(key: string, field: string, value: string): Promise<unknown> };
const intoFake: Put = {
  set: async (key, value) => void fake.strings.set(key, value),
  hset: async (key, field, value) => {
    if (!fake.hashes.has(key)) fake.hashes.set(key, new Map());
    fake.hashes.get(key)!.set(field, value);
  },
};
/** Values under shared keys a seed leaves in a container: four under k0, one
 *  under the environment's key. */
const SEEDED = 5;
/** A realistic spread in one container: whole-value strings, hashes, an
 *  item, and plaintext. */
async function seed(ctx: { container: string }, tag: string, put: Put = intoFake) {
  await put.set(ctxKey('goals', ctx), await legacy(`[{"id":"g-${tag}"}]`));
  await put.set(ctxKey('txns:item-1', ctx), await legacy(`{"txns":"${tag}"}`));
  await put.hset(ctxKey('history:net-worth', ctx), '2026-01-01', await legacy('100'));
  await put.hset(ctxKey('history:net-worth', ctx), '2026-01-02', await envValue('101'));
  await put.hset(
    ctxKey('plaid:items', ctx),
    'item-1',
    JSON.stringify({ item_id: 'item-1', institution_name: 'Bank é', encrypted_access_token: await legacy(`access-${tag}`), transactions_billed: false })
  );
  await put.set(ctxKey('history:backfill-done', ctx), '3');
  await put.hset(ctxKey('account-links:dismissed', ctx), 'a>b', '2026-01-01T00:00:00.000Z');
  await put.set(ctxKey('txns-blocked:item-1', ctx), '{"reason":"size"}');
}
/** Every value the seed put in, read back in its container. */
async function readsBack(ctx: { container: string }, tag: string, get: (key: string, field?: string) => Promise<string> = async (k, f) => (f === undefined ? fake.strings.get(k)! : fake.hashes.get(k)!.get(f)!)) {
  expect(await decrypt(ctx as any, await get(ctxKey('goals', ctx)))).toBe(`[{"id":"g-${tag}"}]`);
  expect(await decrypt(ctx as any, await get(ctxKey('txns:item-1', ctx)))).toBe(`{"txns":"${tag}"}`);
  expect(await decrypt(ctx as any, await get(ctxKey('history:net-worth', ctx), '2026-01-01'))).toBe('100');
  expect(await decrypt(ctx as any, await get(ctxKey('history:net-worth', ctx), '2026-01-02'))).toBe('101');
  const item = JSON.parse(await get(ctxKey('plaid:items', ctx), 'item-1'));
  expect(await decrypt(ctx as any, item.encrypted_access_token)).toBe(`access-${tag}`);
}
/** The key ids every value the seed put in is under. */
function keyIdsOf(ctx: { container: string }): string[] {
  const s = (k: string) => fake.strings.get(ctxKey(k, ctx))!;
  const h = (k: string, f: string) => fake.hashes.get(ctxKey(k, ctx))!.get(f)!;
  return [s('goals'), s('txns:item-1'), h('history:net-worth', '2026-01-01'), h('history:net-worth', '2026-01-02'), JSON.parse(h('plaid:items', 'item-1')).encrypted_access_token].map(
    (v) => formatOf(v).keyId
  );
}

/** Past the minute instances take to pick up a container's new key: only then
 *  can a walk that finds nothing to move record the container as moved. */
const later = () => Date.now() + ACTIVE_CACHE_MS + 1000;
const run = (o: { after?: string | null; budgetMs?: number; now?: () => number; afterRollback?: boolean } = {}) =>
  reencrypt({ dryRun: false, budgetMs: o.budgetMs ?? 60_000, after: o.after ?? null, now: o.now, afterRollback: o.afterRollback });
const check = (after: string | null = null) => reencrypt({ dryRun: true, budgetMs: 60_000, after });
const snapshot = () => JSON.stringify([[...fake.strings], [...fake.hashes].map(([k, h]) => [k, [...h]])]);
async function quietly<R>(fn: () => Promise<R>): Promise<R> {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
}

beforeEach(async () => {
  fake.reset();
  client = fake;
  raw = fake;
  process.env.MASTER_KEY = MASTER;
  forgetActiveKey();
  await register([A, B]);
});
afterEach(() => {
  process.env = { ...saved };
  forgetActiveKey();
});

describe('the list of keys', () => {
  test('every key name in the code is on it, and none is built out of sight', async () => {
    const root = join(import.meta.dir, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === 'node_modules' || name.startsWith('.')) continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    for (const dir of ['lib', 'app', 'scripts', 'components']) {
      try {
        walk(join(root, dir));
      } catch {
        // not every checkout has every directory
      }
    }
    // The scan itself is shared with test/storage-boundary.test.ts.
    const found = keyNamesIn(root, files);
    const names = new Set(found.names.keys());
    const { opaque } = found;
    expect(names.size).toBeGreaterThan(20); // the scan found the stores
    // A key name the scan cannot read (a variable, a helper) could be a store
    // this file never hears of. Spell it out at the call, or list it here.
    // lib/move.ts builds keys only from its own lists, which test/move.test.ts
    // checks against every key the code builds; they are classified below.
    // lib/repo.ts builds one key, a declared store's, from its name, which
    // classify() reads from the declaration itself (test/repo.test.ts).
    expect(opaque.filter((o) => !o.startsWith('lib/move.ts: kc(ctx, ') && !o.startsWith('lib/repo.ts: kc(ctx, name)'))).toEqual([]);
    const { MOVED_KEYS, MOVED_PREFIXES } = await import('@/lib/move');
    for (const key of [...MOVED_KEYS, ...MOVED_PREFIXES.map((p) => `${p}x`)]) names.add(key);
    const missing = [...names].filter((n) => n !== '' && classify(n) === null);
    expect(missing).toEqual([]);
  });

  test('a prefix does not swallow its neighbours', () => {
    expect(classify('txns:abc')).toBe('string');
    expect(classify('txns-blocked:abc')).toBe('plain');
    expect(classify('invtxns:abc')).toBe('string');
    expect(classify('invtxns-lock:abc')).toBe('plain');
    expect(classify('c:0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b:snapshot:runs')).toBe('plain');
    expect(classify('history:accounts')).toBe('hash');
    expect(classify('history:accounts:est:flat')).toBe('string');
    expect(classify('cache:net-worth')).toBe('cipher');
    expect(classify('crypto:keys')).toBe('plain');
    expect(classify('containers')).toBe('plain');
    const c = 'c:0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b:';
    expect(classify(`${c}goals`)).toBe('string');
    expect(classify(`${c}history:accounts`)).toBe('hash');
    expect(classify(`${c}brand-new`)).toBeNull();
    expect(classify(`${c}${c}goals`)).toBeNull(); // never nested
    expect(classify('c:not-a-uuid:goals')).toBeNull();
    // Environment-wide stores never belong inside a container.
    for (const envWide of ['crypto:keys', 'crypto:active', 'containers', 'ratelimit:login:1.2.3.4']) {
      expect(classify(envWide)).toBe('plain');
      expect(classify(`${c}${envWide}`)).toBeNull();
    }
    expect(classify('something-new')).toBeNull();
    expect(classify('__proto__')).toBeNull();
  });
});

describe('the pass', () => {
  test('a check counts what each container holds under shared keys, and writes nothing, not even a key', async () => {
    await seed(ctxA, 'a');
    await seed(ctxB, 'b');
    const before = snapshot();
    const report = await check();
    expect(report).toMatchObject({ dry_run: true, walked_all: true, moved: 0, keys_made: [], not_moved: [A, B], complete: false });
    expect(report.to_move).toEqual({ k0: 8, [envKey()]: 2 });
    expect(report.unreadable).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  test('a run gives each container a key of its own and moves its values to it; readers get the same data', async () => {
    await seed(ctxA, 'a');
    await seed(ctxB, 'b');
    const report = await run();
    expect(report).toMatchObject({ walked_all: true, moved: 2 * SEEDED, changed_meanwhile: 0, keys_made: [A, B], marked_moved: [], not_moved: [A, B], complete: false });
    for (const [ctx, tag] of [[ctxA, 'a'], [ctxB, 'b']] as const) {
      const own = entryOf(ctx.container).key;
      expect(JSON.parse(fake.hashes.get(keysHashKey())!.get(own)!).container).toBe(ctx.container);
      expect(keyIdsOf(ctx)).toEqual(Array(SEEDED).fill(own));
      await readsBack(ctx, tag);
    }
    // Only the token of an item is ciphertext: the rest comes through as it was.
    const item = JSON.parse(fake.hashes.get(ctxKey('plaid:items', ctxA))!.get('item-1')!);
    expect(Object.keys(item)).toEqual(['item_id', 'institution_name', 'encrypted_access_token', 'transactions_billed']);
    expect(item).toMatchObject({ item_id: 'item-1', institution_name: 'Bank é', transactions_billed: false });
    // Plaintext is never touched.
    expect(fake.strings.get(ctxKey('history:backfill-done', ctxA))).toBe('3');
    expect(fake.strings.get(ctxKey('txns-blocked:item-1', ctxA))).toBe('{"reason":"size"}');
    expect([...fake.hashes.get(ctxKey('account-links:dismissed', ctxA))!]).toEqual([['a>b', '2026-01-01T00:00:00.000Z']]);

    // Once every instance can have picked the keys up, a walk that finds
    // nothing left records each container as moved, from when it began.
    const t = later();
    const settled = await run({ now: () => t });
    expect(settled).toMatchObject({ moved: 0, marked_moved: [A, B], not_moved: [], complete: true });
    expect(entryOf(A).moved).toBe(new Date(t).toISOString());
    expect(await check()).toMatchObject({ to_move: {}, not_moved: [], complete: true });
  });

  test('a container once moved is not walked again, and nothing changes', async () => {
    await seed(ctxA, 'a');
    await run();
    await run({ now: later });
    const before = snapshot();
    const types = fake.type.bind(fake);
    const walked: string[] = [];
    fake.type = (async (key: string) => (walked.push(key), types(key))) as typeof fake.type;
    try {
      expect(await run({ now: later })).toMatchObject({ moved: 0, keys_made: [], marked_moved: [], complete: true });
    } finally {
      fake.type = types as typeof fake.type;
    }
    expect(walked.filter((k) => k.startsWith(ctxKey('', ctxA)))).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  test('a container born with its key is moved from the start, and never walked', async () => {
    const p = (await prepareContainerKey(B as any, { born: true }))!;
    await claimContainerKey(p);
    await seed(ctxA, 'a');
    const report = await run();
    expect(report.keys_made).toEqual([A]);
    expect(report.not_moved).toEqual([A]);
    expect(entryOf(B)).toEqual(JSON.parse(p.entry));
  });

  test('a string already under its container’s key is not read in full', async () => {
    await seed(ctxA, 'a');
    await run(); // keys made and values moved, not yet recorded as moved
    const gets = fake.get.bind(fake);
    const read: string[] = [];
    fake.get = (async (key: string) => (read.push(key), gets(key))) as typeof fake.get;
    try {
      await run();
    } finally {
      fake.get = gets as typeof fake.get;
    }
    expect(read.filter((k) => k.includes('txns:') || k.includes('goals'))).toEqual([]);
  });

  // A seam store's values, compressed ones among them, move like any other's
  // (lib/repo.ts "Not bound to a context"), and read back as they were.
  test('holdings history, compressed months and its index, is moved and reads back the same', async () => {
    const { recordHoldings, observeHoldings, readHoldingsHistory } = await import('@/lib/holdings-history');
    const accounts = [{ account_id: 'acct_1', type: 'investment' }];
    const fetched = (q: number) => ({
      institution_name: 'Broker',
      error: null,
      accounts,
      holdings_observed:
        observeHoldings({ accounts, holdings: [{ account_id: 'acct_1', security_id: 'vti', quantity: q }], securities: [{ security_id: 'vti', ticker_symbol: 'VTI' }] }) ??
        undefined,
    });
    // Written before data keys existed: under k0.
    delete process.env.MASTER_KEY;
    forgetActiveKey();
    for (const [q, at] of [[1, '2026-10-07T13:00:00Z'], [2, '2026-11-07T13:00:00Z']] as const) {
      expect(await recordHoldings(ctxA, [fetched(q)], Date.parse(at))).toEqual({ recorded: 1, failed: 0 });
    }
    const range = { from: '2026-10-01', to: '2026-11-30' };
    const before = await readHoldingsHistory(ctxA, range);
    expect(before.days.map((d) => d.date)).toEqual(['2026-10-07', '2026-11-07']);
    const stored = () => [ctxKey('holdings:history'), ctxKey('holdings:history:index')].flatMap((key) => [...fake.hashes.get(key)!.values()]);
    expect(stored().map((v) => formatOf(v).keyId)).toEqual(['k0', 'k0', 'k0']);

    process.env.MASTER_KEY = MASTER;
    forgetActiveKey();
    expect(await run()).toMatchObject({ moved: 3, keys_made: [A, B] });
    expect(stored().map((v) => formatOf(v).keyId)).toEqual(Array(3).fill(entryOf(A).key));
    expect(await readHoldingsHistory(ctxA, range)).toEqual(before);
  });

  test('caches are moved too, keeping their expiry', async () => {
    fake.strings.set(ctxKey('cache:net-worth', ctxA), await legacy('{"total":1}'));
    fake.ttls.set(ctxKey('cache:net-worth', ctxA), 900);
    fake.hashes.set(ctxKey('cache:inv-activity:v4', ctxA), new Map([['acct', await legacy('[]')]]));
    expect(await run()).toMatchObject({ moved: 2, keys_made: [A, B] });
    expect(await decrypt(ctxA, fake.strings.get(ctxKey('cache:net-worth', ctxA))!)).toBe('{"total":1}');
    expect(fake.ttls.get(ctxKey('cache:net-worth', ctxA))).toBe(900);
  });

  test('stops at its time limit, and each call carries on after the last container the one before finished, however many there are', async () => {
    fake.reset();
    const ids = Array.from({ length: 60 }, () => crypto.randomUUID()).sort();
    await register(ids);
    for (const id of ids) fake.strings.set(ctxKey('goals', { container: id }), await legacy(`[{"id":"${id}"}]`));
    const calls: Report[] = [];
    let after: string | null = null;
    for (let i = 0; i < 200 && !calls.at(-1)?.walked_all; i++) {
      let t = 0;
      const report: Report = await run({ after, budgetMs: 40, now: () => (t += 1) });
      calls.push(report);
      if (report.walked_all) break;
      expect(report.complete).toBe(false);
      if (report.next_after !== null) {
        if (after !== null) expect(report.next_after > after).toBe(true);
        after = report.next_after;
      }
    }
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.at(-1)!.walked_all).toBe(true);
    // Each container was given its key once, in id order, and every value moved.
    expect(calls.flatMap((r) => r.keys_made)).toEqual(ids);
    expect(calls.reduce((n, r) => n + r.moved, 0)).toBe(ids.length);
    for (const id of ids) {
      const v = fake.strings.get(ctxKey('goals', { container: id }))!;
      expect(formatOf(v).keyId).toBe(entryOf(id).key);
      expect(await decrypt({ container: id } as any, v)).toBe(`[{"id":"${id}"}]`);
    }
  });

  test('out of time before it starts, it moves nothing', async () => {
    await seed(ctxA, 'a');
    let t = 0;
    expect(await run({ budgetMs: 1, now: () => (t += 1) })).toMatchObject({ walked_all: false, moved: 0, keys_made: [], complete: false });
  });

  test('without a master a run refuses and writes nothing; a check still answers', async () => {
    await seed(ctxA, 'a');
    delete process.env.MASTER_KEY;
    forgetActiveKey();
    const before = snapshot();
    expect(await run().catch((e) => e)).toBeInstanceOf(MasterKeyError);
    expect(await check()).toMatchObject({ dry_run: true, to_move: { k0: 4 } });
    expect(snapshot()).toBe(before);
  });

  test('values outside every container are counted, never written', async () => {
    fake.strings.set(testKey('goals'), await legacy('[]'));
    const before = fake.strings.get(testKey('goals'));
    const report = await run();
    expect(report.outside_containers).toEqual({ k0: 1 });
    expect(fake.strings.get(testKey('goals'))).toBe(before!);
    // Counted once in a sequence of calls: only by the call from the beginning.
    expect((await run({ after: A })).outside_containers).toEqual({});
  });

  test('a save that lands mid-pass wins, and is left for next time', async () => {
    await seed(ctxA, 'a');
    const report = await runWith(ctxKey('goals', ctxA), async () => {
      fake.strings.set(ctxKey('goals', ctxA), await legacy('[{"id":"newer"}]'));
    });
    expect(report).toMatchObject({ moved: SEEDED - 1, changed_meanwhile: 1, not_moved: [A, B] });
    expect(await decrypt(ctxA, fake.strings.get(ctxKey('goals', ctxA))!)).toBe('[{"id":"newer"}]');
    // Not recorded as moved from that walk, even after the minute.
    expect(entryOf(A).moved).toBeUndefined();
    expect(await run({ now: later })).toMatchObject({ moved: 1, marked_moved: [B] });
    expect(await decrypt(ctxA, fake.strings.get(ctxKey('goals', ctxA))!)).toBe('[{"id":"newer"}]');
    expect(await run({ now: later })).toMatchObject({ moved: 0, marked_moved: [A], complete: true });
  });

  test('an unreadable value is reported and left alone, without quoting it, and its container is never recorded as moved', async () => {
    await seed(ctxA, 'a');
    fake.hashes.get(ctxKey('history:net-worth', ctxA))!.set('2026-01-03', 'secret-plaintext-value');
    for (const report of [await run(), await run({ now: later })]) {
      expect(report.complete).toBe(false);
      expect(report.unreadable_count).toBe(1);
      expect(report.unreadable[0]).toMatchObject({ key: `c:${A}:history:net-worth`, field: '2026-01-03' });
      expect(JSON.stringify(report)).not.toContain('secret-plaintext-value');
      expect(report.not_moved).toContain(A);
      expect(report.marked_moved).not.toContain(A);
    }
    expect(fake.hashes.get(ctxKey('history:net-worth', ctxA))!.get('2026-01-03')).toBe('secret-plaintext-value');
    expect(keyIdsOf(ctxA)).toEqual(Array(SEEDED).fill(entryOf(A).key)); // everything else moved
  });

  test('a key not on the list is reported and left alone', async () => {
    fake.strings.set(ctxKey('brand-new-store', ctxA), await legacy('x'));
    const before = fake.strings.get(ctxKey('brand-new-store', ctxA));
    await run();
    const report = await run({ now: later });
    expect(report.unclassified).toEqual([`c:${A}:brand-new-store`]);
    expect(report.complete).toBe(false);
    expect(report.marked_moved).toEqual([B]); // B, with nothing in it, is moved
    expect(fake.strings.get(ctxKey('brand-new-store', ctxA))).toBe(before!);
  });

  test('a key of the wrong type is reported, not guessed at', async () => {
    fake.hashes.set(ctxKey('goals', ctxA), new Map([['a', await legacy('x')]]));
    const report = await run();
    expect(report.unreadable[0]).toEqual({ key: `c:${A}:goals`, reason: 'expected a string, found a hash' });
  });

  test('an item without a token, or not JSON, is reported', async () => {
    fake.hashes.set(
      ctxKey('plaid:items', ctxA),
      new Map([
        ['a', '{"item_id":"a"}'],
        ['b', 'not json'],
      ])
    );
    const report = await check();
    expect(report.unreadable.map((u) => [u.field, u.reason]).sort()).toEqual([
      ['a', 'has no encrypted_access_token'],
      ['b', 'not valid JSON'],
    ]);
  });

  test('a value bound to a context is left for its owner', async () => {
    await giveKey(A);
    fake.strings.set(ctxKey('goals', ctxA), await encryptV2('x', 'k0', 'some-context'));
    const report = await run();
    expect(report.unreadable[0].reason).toBe('bound to a context; its owner must move it');
  });

  test('ciphertext in a key listed as plaintext is reported, in either format', async () => {
    fake.strings.set(ctxKey('history:backfill-done', ctxA), await legacy('3'));
    fake.strings.set(ctxKey('txns-blocked:item-1', ctxA), await envValue('x'));
    fake.hashes.set(ctxKey('account-links:dismissed', ctxA), new Map([['a>b', await envValue('y')]]));
    fake.strings.set(testKey('crypto:rotation-lock'), crypto.randomUUID());
    const report = await check();
    expect(report.complete).toBe(false);
    expect(report.unreadable.map((u) => [u.key, u.field, u.reason])).toEqual([
      [`c:${A}:account-links:dismissed`, 'a>b', 'listed as plaintext but holds encrypted data'],
      [`c:${A}:history:backfill-done`, undefined, 'listed as plaintext but holds encrypted data'],
      [`c:${A}:txns-blocked:item-1`, undefined, 'listed as plaintext but holds encrypted data'],
    ]);
  });

  test('a value under another container’s key is reported and left as it is', async () => {
    await giveKey(A);
    const keyB = await giveKey(B);
    const theirs = await encrypt(ctxB, 'B’s');
    fake.checkCiphertext = false; // planted on purpose
    fake.strings.set(ctxKey('goals', ctxA), theirs);
    const report = await run({ now: later });
    expect(report.unreadable).toEqual([{ key: `c:${A}:goals`, reason: `under ${keyB}, the key of container ${B}; left as it is` }]);
    expect(report.marked_moved).toEqual([B]);
    expect(fake.strings.get(ctxKey('goals', ctxA))).toBe(theirs);
  });

  /** Runs `during` once, just before the first compare-and-set on `full`. */
  async function runWith(full: string, during: () => Promise<void> | void, o: Parameters<typeof run>[0] = {}) {
    const evals = fake.eval.bind(fake);
    let done = false;
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (!done && keys[0] === full) {
        done = true;
        await during();
      }
      return evals(script, keys, args);
    }) as typeof fake.eval;
    try {
      return await run(o);
    } finally {
      fake.eval = evals as typeof fake.eval;
    }
  }

  test('a hash field deleted mid-pass stays deleted', async () => {
    await seed(ctxA, 'a');
    const report = await runWith(ctxKey('history:net-worth', ctxA), () => {
      fake.hashes.get(ctxKey('history:net-worth', ctxA))!.delete('2026-01-01');
    });
    expect(report).toMatchObject({ deleted_meanwhile: 1, changed_meanwhile: 0 });
    expect(fake.hashes.get(ctxKey('history:net-worth', ctxA))!.has('2026-01-01')).toBe(false);
  });

  test('a string deleted mid-pass stays deleted', async () => {
    await seed(ctxA, 'a');
    const report = await runWith(ctxKey('goals', ctxA), () => {
      fake.strings.delete(ctxKey('goals', ctxA));
    });
    expect(report.deleted_meanwhile).toBe(1);
    expect(fake.strings.has(ctxKey('goals', ctxA))).toBe(false);
  });

  test('an item re-saved mid-pass keeps the new save', async () => {
    await seed(ctxA, 'a');
    const newer = JSON.stringify({ item_id: 'item-1', institution_name: 'Renamed', encrypted_access_token: await legacy('access-2') });
    const report = await runWith(ctxKey('plaid:items', ctxA), () => {
      fake.hashes.get(ctxKey('plaid:items', ctxA))!.set('item-1', newer);
    });
    expect(report.changed_meanwhile).toBe(1);
    expect(fake.hashes.get(ctxKey('plaid:items', ctxA))!.get('item-1')).toBe(newer);
    expect(await run()).toMatchObject({ moved: 1 });
    const item = JSON.parse(fake.hashes.get(ctxKey('plaid:items', ctxA))!.get('item-1')!);
    expect(item.institution_name).toBe('Renamed');
    expect(await decrypt(ctxA, item.encrypted_access_token)).toBe('access-2');
  });

  test('a key deleted between listing and reading is skipped', async () => {
    await seed(ctxA, 'a');
    const types = fake.type.bind(fake);
    fake.type = (async (key: string) => {
      if (key === ctxKey('goals', ctxA)) fake.strings.delete(key);
      return types(key);
    }) as typeof fake.type;
    try {
      expect(await run()).toMatchObject({ moved: SEEDED - 1, unreadable_count: 0 });
    } finally {
      fake.type = types as typeof fake.type;
    }
  });

  test('a value that never compares equal is reported, not retried forever', async () => {
    await seed(ctxA, 'a');
    const evals = fake.eval.bind(fake);
    fake.eval = (async (script: string, keys: string[], args: string[]) =>
      keys[0] === ctxKey('goals', ctxA) ? 0 : evals(script, keys, args)) as typeof fake.eval;
    let report;
    try {
      report = await run();
    } finally {
      fake.eval = evals as typeof fake.eval;
    }
    expect(report.changed_meanwhile).toBe(0);
    expect(report.unreadable).toEqual([
      { key: `c:${A}:goals`, reason: 'could not be compared (it changed and changed back, or is not valid UTF-8 text); tried again next call' },
    ]);
  });

  test('a container deleted during its walk ends that walk, and the pass goes on to the next', async () => {
    await seed(ctxA, 'a');
    await seed(ctxB, 'b');
    const report = await runWith(ctxKey('goals', ctxA), () => {
      fake.hashes.get(containerKeysKey())!.set(A, JSON.stringify({ destroyed: '2026-10-17' }));
    });
    expect(report.skipped).toContainEqual({ container: A, reason: 'its key changed during the walk (deleted meanwhile?)' });
    expect(keyIdsOf(ctxA)).not.toContain(undefined);
    expect(formatOf(fake.strings.get(ctxKey('goals', ctxA))!).keyId).toBe('k0');
    expect(keyIdsOf(ctxB)).toEqual(Array(SEEDED).fill(entryOf(B).key));
  });

  test('if a container’s key leaves the key store mid-walk (a restore), nothing is written under it', async () => {
    await seed(ctxA, 'a');
    const report = await runWith(ctxKey('goals', ctxA), () => {
      fake.hashes.get(keysHashKey())!.delete(entryOf(A).key);
    });
    expect(report.skipped).toContainEqual({ container: A, reason: 'its key changed during the walk (deleted meanwhile?)' });
    expect(keyIdsOf(ctxA).filter((k) => k === entryOf(A).key)).toEqual([]);
  });

  test('with after_rollback, moved containers are walked again from now, and what the release before wrote is moved', async () => {
    await seed(ctxA, 'a');
    await run();
    await run({ now: later });
    expect(entryOf(A).moved).toBeDefined();
    // Rolled back for a while: the release before wrote under the shared key again.
    fake.strings.set(ctxKey('goals', ctxA), await legacy('[{"id":"rolled"}]'));
    expect((await run({ now: later })).moved).toBe(0); // a moved container is skipped
    const t = later();
    const report = await run({ afterRollback: true, now: () => t });
    expect(report.moved).toBe(1);
    expect(report.not_moved).toEqual([A]);
    expect(entryOf(A)).toMatchObject({ shared_in: new Date(t).toISOString() });
    expect(entryOf(A).moved).toBeUndefined();
    expect(await decrypt(ctxA, fake.strings.get(ctxKey('goals', ctxA))!)).toBe('[{"id":"rolled"}]');
    expect(await run({ now: later })).toMatchObject({ marked_moved: [A], complete: true });
    expect(entryOf(A).shared_in).toBe(new Date(t).toISOString());
  });
});

describe('the pass, where something says a key was lost or can’t be had', () => {
  test('a value under a key the store doesn’t hold: the container is damaged, gets no key, and nothing is written in it', async () => {
    await seed(ctxA, 'a');
    await seed(ctxB, 'b');
    fake.strings.set(ctxKey('goals', ctxA), `v2.k9-deadbeef.-.${'A'.repeat(40)}`);
    const before = [...fake.strings].filter(([k]) => k.startsWith(ctxKey('', ctxA)));
    const report = await run();
    expect(report.damaged).toEqual([{ container: A, reason: "a value is under k9-deadbeef, which the key store doesn't hold, so it gets no key" }]);
    expect(entryOf(A)).toBeUndefined();
    expect([...fake.strings].filter(([k]) => k.startsWith(ctxKey('', ctxA)))).toEqual(before);
    expect(report.keys_made).toEqual([B]);
    expect(report.complete).toBe(false);
  });

  test('a value under another container’s key, in one without a key: damaged too', async () => {
    const keyB = await giveKey(B);
    fake.checkCiphertext = false;
    fake.strings.set(ctxKey('goals', ctxA), await encrypt(ctxB, 'x'));
    const report = await run();
    expect(report.damaged).toEqual([{ container: A, reason: `a value is under ${keyB}, the key of container ${B}, so it gets no key` }]);
    expect(entryOf(A)).toBeUndefined();
  });

  test('a lost map entry is put back from the key whose record names the container: said by a check, done by a run', async () => {
    const keyA = await giveKey(A);
    await seed(ctxA, 'a');
    fake.hashes.get(containerKeysKey())!.delete(A);
    const checked = await check();
    expect(checked.damaged).toEqual([{ container: A, reason: `its map entry is missing; ${keyA} names it, and a run restores the entry` }]);
    expect(entryOf(A)).toBeUndefined();
    const report = await run();
    expect(report.maps_restored).toEqual([A]);
    expect(entryOf(A)).toEqual({ key: keyA, since: JSON.parse(fake.hashes.get(keysHashKey())!.get(keyA)!).created_at });
    expect(keyIdsOf(ctxA)).toEqual(Array(SEEDED).fill(keyA));
    await readsBack(ctxA, 'a');
  });

  test('several keys naming a container with no map entry: damaged, and left alone', async () => {
    const one = await plantKey(31, A);
    const two = await plantKey(32, A);
    const report = await run();
    expect(report.damaged).toEqual([{ container: A, reason: `several keys name it (${one}, ${two}) and its map entry is missing` }]);
    expect(entryOf(A)).toBeUndefined();
  });

  test('a map entry that can’t be read: damaged, and left alone', async () => {
    await fake.hset(containerKeysKey(), { [A]: '{nope' });
    const report = await run();
    expect(report.damaged).toEqual([{ container: A, reason: 'its entry in the map of container keys is unreadable' }]);
    expect(fake.hashes.get(containerKeysKey())!.get(A)).toBe('{nope');
  });

  test('only active containers are walked; one whose key was destroyed is skipped too', async () => {
    fake.reset();
    const C = 'c0ffee00-1111-4222-8333-444455556666';
    await register([[A, 'restoring'], [B, 'archived'], C]);
    await fake.hset(containerKeysKey(), { [C]: JSON.stringify({ destroyed: '2026-10-17' }) });
    await seed(ctxA, 'a');
    const report = await run();
    expect(report.skipped).toEqual([
      { container: A, reason: 'the container is restoring' },
      { container: B, reason: 'the container is archived' },
      { container: C, reason: 'its key was destroyed' },
    ]);
    expect(report.keys_made).toEqual([]);
    expect(keyIdsOf(ctxA)).toContain('k0');
  });

  test('values under a container the registry doesn’t list are named once, and never walked', async () => {
    const gone = { container: 'deadbeef-0000-4000-8000-000000000000' };
    fake.strings.set(ctxKey('goals', gone), await legacy('[]'));
    const report = await run();
    expect(report.skipped).toContainEqual({ container: gone.container, reason: 'it holds keys but is not in the registry' });
    expect(formatOf(fake.strings.get(ctxKey('goals', gone))!).keyId).toBe('k0');
    expect((await run({ after: A })).skipped).not.toContainEqual(expect.objectContaining({ container: gone.container }));
  });

  test('while a master rotation is pending no key is made, nor a key number used: said, nothing written, never complete', async () => {
    await seed(ctxA, 'a');
    await fake.set(rotationKey(), JSON.stringify({ from: 'a', next: 'b', prepared_at: '2026-10-01T00:00:00.000Z' }));
    const before = snapshot();
    const report = await run();
    expect(report.skipped).toEqual([
      { container: A, reason: 'no key was made: a master rotation is pending' },
      { container: B, reason: 'no key was made: a master rotation is pending' },
    ]);
    expect(report.complete).toBe(false);
    expect(snapshot()).toBe(before);
  });

  test('past the most key numbers the id format allows, no key is made, and it is said', async () => {
    await fake.set(keySeqKey(), String(MAX_KEY_NUMBER));
    const report = await quietly(() => run());
    expect(report.skipped).toEqual([
      { container: A, reason: 'no key could be made: key numbers are at the most the id format allows' },
      { container: B, reason: 'no key could be made: key numbers are at the most the id format allows' },
    ]);
    expect(report.complete).toBe(false);
  });
});

describe('the pass and the database', () => {
  test('a database without the needed script support is refused before anything, even a key', async () => {
    await seed(ctxA, 'a');
    const evals = fake.eval.bind(fake);
    fake.eval = (async () => {
      // The shape Upstash gives: the error, then the command it ran.
      throw new Error(
        "ERR user_script:1: attempt to call field 'sha1hex' (a nil value), command was: [[\"eval\",\"-- nya:probe\\nreturn redis.sha1hex('nya')\",0]]"
      );
    }) as typeof fake.eval;
    const before = snapshot();
    try {
      for (const attempt of [run, check]) {
        const err = await attempt().catch((e) => e);
        expect(err).toBeInstanceOf(MasterKeyError);
        expect(err.message).toContain('sha1hex');
      }
    } finally {
      fake.eval = evals as typeof fake.eval;
    }
    expect(snapshot()).toBe(before);
  });

  test('an Upstash error about something else is not mistaken for missing support', async () => {
    const evals = fake.eval.bind(fake);
    const upstash = new Error('WRONGPASS invalid or missing auth token, command was: [["eval","-- nya:probe\\nreturn redis.sha1hex(\'nya\')",0]]');
    fake.eval = (async () => {
      throw upstash;
    }) as typeof fake.eval;
    try {
      expect(await run().catch((e) => e)).toBe(upstash);
      expect(await check().catch((e) => e)).toBe(upstash);
    } finally {
      fake.eval = evals as typeof fake.eval;
    }
  });

  test('any other failure of the probe is not mistaken for missing support', async () => {
    const evals = fake.eval.bind(fake);
    fake.eval = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fake.eval;
    try {
      expect(await run().catch((e) => e)).toBeInstanceOf(TypeError);
    } finally {
      fake.eval = evals as typeof fake.eval;
    }
  });
});

describe('the route', () => {
  const post = (body?: string, auth = 'Bearer s3cret') =>
    route.POST(new Request('http://x/api/ops/reencrypt', { method: 'POST', headers: auth ? { authorization: auth } : {}, body }));

  beforeEach(() => {
    process.env.OPS_ENABLED = '1';
    process.env.OPS_SECRET = 's3cret';
  });

  test('does not exist unless OPS_ENABLED is set, and needs the secret', async () => {
    delete process.env.OPS_ENABLED;
    expect((await post()).status).toBe(404);
    process.env.OPS_ENABLED = '1';
    expect((await post(undefined, 'Bearer nope')).status).toBe(401);
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect((await route[method]()).status).toBe(404);
    }
  });

  test('an empty body checks; {"run": true} moves; "after" carries on from a container', async () => {
    await seed(ctxA, 'a');
    await seed(ctxB, 'b');
    const checked = await (await post()).json();
    expect(checked).toMatchObject({ dry_run: true, to_move: { k0: 8 }, not_moved: [A, B] });

    const fromB = await (await post(JSON.stringify({ run: true, after: A }))).json();
    expect(fromB).toMatchObject({ dry_run: false, after: A, keys_made: [B], moved: SEEDED, next_after: B, walked_all: true });
    const ran = await (await post('{"run":true}')).json();
    expect(ran).toMatchObject({ keys_made: [A], moved: SEEDED, next_after: B });
    expect((await (await post('{"run":true,"after_rollback":true}')).json()).dry_run).toBe(false);
  });

  test('anything else is refused', async () => {
    for (const body of ['{"run":"yes"}', '{"run":true,"x":1}', '{"go":true}', '[]', 'nope', '{"after":"nope"}', '{"after_rollback":true}', '{"run":true,"after_rollback":1}']) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await post('x'.repeat(300))).status).toBe(413);
  });

  test('a refusal says why', async () => {
    delete process.env.MASTER_KEY;
    const res = await post('{"run":true}');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('MASTER_KEY');
  });
});

// The scripts and the whole pass, run by a real Redis when one is installed
// (the test double above only imitates them).
const hasRedis = Bun.which('redis-server') !== null;
describe.skipIf(!hasRedis && !process.env.CI)('the scripts, on a real Redis', () => {
  // Started by test/real-redis.ts, which tries another port when one is taken
  // and bounds every wait, so a server that won't start fails here rather
  // than hanging the tests.
  let real: RealRedis | null = null;
  const send = (command: string, args: string[]) => real!.client.send(command, args);
  const sha1 = (s: string) => new Bun.CryptoHasher('sha1').update(s).digest('hex');
  const evalScript = (script: string, keys: string[], args: string[]) => send('EVAL', [script, String(keys.length), ...keys, ...args]);

  beforeEach(async () => {
    real ??= await startRedis();
    await send('FLUSHALL', []);
  });
  afterAll(() => {
    real?.stop();
    real = null;
    client = fake;
    raw = fake;
  });

  test('the probe answers what the pass expects', async () => {
    expect(await evalScript(PROBE, [], [])).toBe(sha1('nya'));
  });

  const GUARD = ['map', 'keys'];
  const setGuard = async (id = 'k1-aaaaaaaa', container = 'c1') => {
    await send('HSET', ['map', container, `{"key":"${id}","since":"2026-01-01T00:00:00.000Z"}`]);
    await send('HSET', ['keys', id, '{}']);
    return id;
  };

  test('a string is replaced only while it still matches, keeping its expiry', async () => {
    const id = await setGuard();
    await send('SET', ['s', 'old é', 'PX', '100000']);
    expect(await evalScript(CAS_STRING, ['s', ...GUARD], [sha1('other'), 'new', id, 'c1'])).toBe(0);
    expect(await send('GET', ['s'])).toBe('old é');
    expect(await evalScript(CAS_STRING, ['s', ...GUARD], [sha1('old é'), 'new', id, 'c1'])).toBe(1);
    expect(await send('GET', ['s'])).toBe('new');
    expect(Number(await send('PTTL', ['s']))).toBeGreaterThan(90000);
    await send('SET', ['plain', 'v']);
    expect(await evalScript(CAS_STRING, ['plain', ...GUARD], [sha1('v'), 'w', id, 'c1'])).toBe(1);
    expect(Number(await send('PTTL', ['plain']))).toBe(-1);
    expect(await evalScript(CAS_STRING, ['missing', ...GUARD], [sha1(''), 'x', id, 'c1'])).toBe(-1);
    expect(await send('EXISTS', ['missing'])).toBe(0);
  });

  test('a hash field is replaced only while it still matches', async () => {
    const id = await setGuard();
    await send('HSET', ['h', 'f', 'old', 'g', 'keep']);
    expect(await evalScript(CAS_HASH, ['h', ...GUARD], ['f', sha1('other'), 'new', id, 'c1'])).toBe(0);
    expect(await send('HGET', ['h', 'f'])).toBe('old');
    expect(await evalScript(CAS_HASH, ['h', ...GUARD], ['f', sha1('old'), 'new', id, 'c1'])).toBe(1);
    expect(await send('HGET', ['h', 'f'])).toBe('new');
    expect(await send('HGET', ['h', 'g'])).toBe('keep');
    expect(await evalScript(CAS_HASH, ['h', ...GUARD], ['gone', sha1(''), 'x', id, 'c1'])).toBe(-1);
    expect(await send('HEXISTS', ['h', 'gone'])).toBe(0);
  });

  test('nothing is written unless the container’s entry still names the key, and the key is still stored', async () => {
    const id = await setGuard();
    await send('SET', ['s', 'old']);
    await send('HSET', ['h', 'f', 'old']);
    const both = async (keyId: string, container: string) => [
      await evalScript(CAS_STRING, ['s', ...GUARD], [sha1('old'), 'new', keyId, container]),
      await evalScript(CAS_HASH, ['h', ...GUARD], ['f', sha1('old'), 'new', keyId, container]),
    ];
    expect(await both('k2-bbbbbbbb', 'c1')).toEqual([-2, -2]); // another key than the entry names
    expect(await both(id, 'c2')).toEqual([-2, -2]); // a container with no entry
    await send('HSET', ['map', 'c1', '{"destroyed":"2026-10-17"}']);
    expect(await both(id, 'c1')).toEqual([-2, -2]); // destroyed
    await setGuard();
    await send('DEL', ['keys']);
    expect(await both(id, 'c1')).toEqual([-2, -2]); // named, but gone from the key store
    expect(await send('GET', ['s'])).toBe('old');
    expect(await send('HGET', ['h', 'f'])).toBe('old');
  });

  test('the whole pass, run against it', async () => {
    client = upstashOn(real!.client); // parsing, as Upstash's default client does
    const rawClient: import('@/lib/reencrypt').ReencryptClient = {
      scan: async (cursor, o) => (await send('SCAN', [String(cursor), 'MATCH', o.match, 'COUNT', String(o.count)])) as [string, string[]],
      hscan: async (key, cursor, o) => (await send('HSCAN', [key, String(cursor), 'COUNT', String(o.count)])) as [string, string[]],
      type: async (key) => String(await send('TYPE', [key])),
      get: (key) => send('GET', [key]),
      hget: (key, field) => send('HGET', [key, field]),
      getrange: (key, a, b) => send('GETRANGE', [key, String(a), String(b)]),
      eval: (script, keys, args) => evalScript(script, keys, args),
    };
    raw = rawClient;
    forgetActiveKey();
    for (const id of [A, B]) await send('HSET', [registryKey(), id, JSON.stringify({ status: 'active', primary: id === A, created_at: '2026-01-01T00:00:00.000Z' })]);
    const put: Put = { set: (k, v) => send('SET', [k, v]), hset: (k, f, v) => send('HSET', [k, f, v]) };
    await seed(ctxA, 'a', put);
    await seed(ctxB, 'b', put);

    const report = await reencrypt({ dryRun: false, budgetMs: 60_000, client: rawClient });
    expect(report).toMatchObject({ moved: 2 * SEEDED, keys_made: [A, B], unreadable_count: 0 });
    const get = async (k: string, f?: string) => String(f === undefined ? await send('GET', [k]) : await send('HGET', [k, f]));
    await readsBack(ctxA, 'a', get);
    await readsBack(ctxB, 'b', get);
    const entryA = JSON.parse(String(await send('HGET', [containerKeysKey(), A])));
    expect(formatOf(await get(ctxKey('goals', ctxA))).keyId).toBe(entryA.key);
    expect(await reencrypt({ dryRun: false, budgetMs: 60_000, client: rawClient, now: later })).toMatchObject({ marked_moved: [A, B], complete: true });
    expect(await reencrypt({ dryRun: true, budgetMs: 60_000, client: rawClient })).toMatchObject({ to_move: {}, complete: true });
  });
});
