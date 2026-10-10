import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, testKey, TEST_CTX, ctxKey, registerTestContainer, TEST_CONTAINER, unscopedDataKeys } from './fake-redis';

const ctx = TEST_CTX;

// The stores on the seam encrypt what they hold (for the tests that measure them).
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
// Nothing may be written outside a container (#53).
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { readStorageUsage } = await import('@/lib/blob-sizes');
const { registryKey } = await import('@/lib/containers');
const { forgetEpochs, deploymentContainer } = await import('@/lib/sessions');
const { saveItem } = await import('@/lib/storage');
const route = await import('@/app/api/storage-usage/route');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { txnAnnotationStore } = await import('@/lib/txn-annotations');
const { firePlanStore } = await import('@/lib/fire-plan');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');

const A = crypto.randomUUID();
const saved = { ...process.env };
const link = (item_id: string) => saveItem(ctx, { item_id, institution_name: 'Bank', encrypted_access_token: 'x' } as any);
beforeEach(() => {
  fake.reset();
  forgetEpochs();
  delete process.env.CONTAINER_ID;
});
afterEach(() => {
  process.env = { ...saved };
});

describe('stored blob sizes, measured', () => {
  test('are the stored lengths, per Item and kind, totalled, largest Item first', async () => {
    await link('item_a');
    await link('item_b');
    await fake.set(ctxKey('txns:item_a'), 'x'.repeat(120));
    await fake.set(ctxKey('invtxns:item_a'), 'x'.repeat(50));
    await fake.set(ctxKey('txns:item_b'), 'x'.repeat(400));
    expect(await readStorageUsage(ctx)).toEqual({
      total_chars: 570,
      items: [
        { item_id: 'item_b', orphaned: false, txns: 400 },
        { item_id: 'item_a', orphaned: false, txns: 120, invtxns: 50 },
      ],
      stores_chars: 0,
      stores: [],
    });
  });

  test('a blob whose Item is no longer linked is counted, and marked', async () => {
    await link('item_a');
    await fake.set(ctxKey('txns:item_a'), 'x'.repeat(10));
    await fake.set(ctxKey('txns:gone'), 'x'.repeat(30));
    const usage = await readStorageUsage(ctx);
    expect(usage.total_chars).toBe(40);
    expect(usage.items).toEqual([
      { item_id: 'gone', orphaned: true, txns: 30 },
      { item_id: 'item_a', orphaned: false, txns: 10 },
    ]);
  });

  test('a blocked Item carries the size its write was refused at', async () => {
    await link('item_a');
    await fake.set(ctxKey('txns:item_a'), 'x'.repeat(10));
    await fake.set(ctxKey('txns-blocked:item_a'), JSON.stringify({ at: 'x', chars: 9_000_000 }));
    await fake.set(ctxKey('txns-blocked:item_b'), 'junk');
    const usage = await readStorageUsage(ctx);
    expect(usage.items).toEqual([{ item_id: 'item_a', orphaned: false, txns: 10, blocked_at: 9_000_000, blocked: true }]);
    expect(usage.total_chars).toBe(10); // what is stored, not what was refused
  });

  test('a marker under a raised ceiling no longer reads as blocked', async () => {
    await link('item_a');
    await fake.set(ctxKey('txns-blocked:item_a'), JSON.stringify({ at: 'x', chars: 9_000_000 }));
    process.env.MAX_TXN_BLOB_CHARS = '10000000';
    try {
      expect((await readStorageUsage(ctx)).items).toEqual([{ item_id: 'item_a', orphaned: false, blocked_at: 9_000_000, blocked: false }]);
    } finally {
      delete process.env.MAX_TXN_BLOB_CHARS;
    }
  });

  test('a blob deleted between the walk and the measure is left out', async () => {
    await link('item_a');
    await fake.set(ctxKey('txns:item_a'), 'x'.repeat(10));
    await fake.set(ctxKey('txns:item_b'), 'x'.repeat(10));
    const strlen = fake.strlen.bind(fake);
    fake.strlen = (async (key: string) => (key === ctxKey('txns:item_b') ? 0 : strlen(key))) as typeof fake.strlen;
    try {
      expect(await readStorageUsage(ctx)).toEqual({ total_chars: 10, items: [{ item_id: 'item_a', orphaned: false, txns: 10 }], stores_chars: 0, stores: [] });
    } finally {
      fake.strlen = strlen;
    }
  });

  test('an Item linked while the walk ran is not called orphaned', async () => {
    await fake.set(ctxKey('txns:item_new'), 'x'.repeat(10));
    const strlen = fake.strlen.bind(fake);
    // The link lands after the keyspace walk began.
    fake.strlen = (async (key: string) => {
      await link('item_new');
      return strlen(key);
    }) as typeof fake.strlen;
    try {
      expect((await readStorageUsage(ctx)).items).toEqual([{ item_id: 'item_new', orphaned: false, txns: 10 }]);
    } finally {
      fake.strlen = strlen;
    }
  });

  test('only the blobs themselves are counted: not markers, locks, caches or another environment', async () => {
    await link('item_a');
    await fake.set(ctxKey('txns:item_a'), 'x'.repeat(10));
    await fake.set(ctxKey('invtxns-lock:item_a'), 'lock');
    await fake.set(ctxKey('cache:net-worth'), 'x'.repeat(99));
    await fake.set('other-env:txns:item_a', 'x'.repeat(99));
    expect((await readStorageUsage(ctx)).total_chars).toBe(10);
  });

  test('every page of the keyspace walk is read', async () => {
    for (let i = 0; i < 450; i++) await fake.set(ctxKey(`txns:item_${i}`), 'xx');
    const usage = await readStorageUsage(ctx);
    expect(usage.items).toHaveLength(450);
    expect(usage.total_chars).toBe(900);
  });

  test('nothing stored is an empty report', async () => {
    await link('item_a');
    expect(await readStorageUsage(ctx)).toEqual({ total_chars: 0, items: [], stores_chars: 0, stores: [] });
  });
});

describe('the stores on the storage seam, measured', () => {
  const at = '2026-09-30T10:00:00.000Z';
  const row = (n: number) => ({
    id: `manual-txn:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    account_id: 'manual_a',
    date: '2026-09-01',
    amount: n,
    currency: 'USD',
    name: `Payee ${n}`,
    category: null,
    note: null,
    source: 'manual',
    source_id: null,
    created_at: at,
    updated_at: at,
  });
  /** What a store holds, counted from the stored bytes themselves. */
  const storedChars = (name: string) => [...(fake.hashes.get(ctxKey(name)) ?? new Map())].reduce((n, [id, v]) => n + id.length + v.length, 0);

  test('every one that holds something, largest first, with its largest value, the one nearest the ceiling', async () => {
    // Two books of manual transactions, one much larger.
    await manualTxnStore.set(ctx, 'manual_a', { version: 1, rows: Array.from({ length: 200 }, (_, i) => row(i + 1)) } as any);
    await manualTxnStore.set(ctx, 'manual_b', { version: 1, rows: [{ ...row(1), account_id: 'manual_b' }] } as any);
    await txnAnnotationStore.set(ctx, 't1', { excluded: true, updated_at: at });
    // A record that can't be read takes room all the same.
    await fake.hset(ctxKey('transaction-annotations'), { t2: 'damaged-but-stored' });
    await firePlanStore.set(ctx, DEFAULT_PLAN);
    // A counter is bookkeeping, never listed.
    await fake.set(ctxKey('download-count'), '3');
    // Another container's stores are its own.
    await manualTxnStore.set({ container: A } as any, 'manual_z', { version: 1, rows: [{ ...row(9), account_id: 'manual_z' }] } as any);

    const usage = await readStorageUsage(ctx);
    const plan = (fake.strings.get(ctxKey('fire-plan')) ?? '').length;
    const books = fake.hashes.get(ctxKey('manual-transactions'))!;
    expect(usage.stores).toEqual(
      [
        {
          store: 'manual-transactions',
          what: 'manual transactions',
          entries: 2,
          chars: storedChars('manual-transactions'),
          largest_id: 'manual_a',
          largest_chars: books.get('manual_a')!.length,
        },
        {
          store: 'transaction-annotations',
          what: 'transaction exclusions',
          entries: 2,
          chars: storedChars('transaction-annotations'),
          largest_id: 't1',
          largest_chars: fake.hashes.get(ctxKey('transaction-annotations'))!.get('t1')!.length,
        },
        { store: 'fire-plan', what: 'plan assumptions', entries: 1, chars: plan, largest_id: null, largest_chars: plan },
      ].sort((x, y) => y.chars - x.chars)
    );
    expect(usage.stores_chars).toBe(usage.stores.reduce((n, s) => n + s.chars, 0));
    // The Items' blobs are counted apart, as before.
    expect(usage.total_chars).toBe(0);
  });

  test('a store that can’t be measured fails the report, never reads as empty', async () => {
    await txnAnnotationStore.set(ctx, 't1', { excluded: true, updated_at: at });
    fake.failNext('eval');
    await expect(readStorageUsage(ctx)).rejects.toThrow('armed failure');
  });
});

describe('/api/storage-usage', () => {
  test('reports the container, the ceiling and the sizes', async () => {
    await registerTestContainer(fake);
    await link('item_a');
    await fake.set(ctxKey('txns:item_a'), 'x'.repeat(100));
    expect(await (await route.GET()).json()).toEqual({
      container: TEST_CONTAINER,
      ceiling_chars: expect.any(Number),
      total_chars: 100,
      items: [{ item_id: 'item_a', orphaned: false, txns: 100 }],
      stores_chars: 0,
      stores: [],
    });
    // With the stores on the seam beside them.
    await txnAnnotationStore.set(ctx, 't1', { excluded: true, updated_at: '2026-09-30T10:00:00.000Z' });
    const body = await (await route.GET()).json();
    expect(body.stores).toEqual([{ store: 'transaction-annotations', what: 'transaction exclusions', entries: 1, chars: expect.any(Number), largest_id: 't1', largest_chars: expect.any(Number) }]);
    expect(body.stores_chars).toBe(body.stores[0].chars);
  });

  test('with no usable container, refuses with the reason (503)', async () => {
    const err = console.error;
    console.error = () => {};
    try {
      const res = await route.GET();
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('No container exists yet.');
    } finally {
      console.error = err;
    }
  });

  test('measures only this container: another container\'s blobs are not counted', async () => {
    await registerTestContainer(fake);
    await link('item_a');
    await fake.set(ctxKey('txns:item_a'), 'x'.repeat(100));
    await fake.set(ctxKey('txns:item_z', { container: A }), 'x'.repeat(999));
    expect((await (await route.GET()).json()).total_chars).toBe(100);
  });

  test('a failed measurement is a 500', async () => {
    await registerTestContainer(fake);
    await deploymentContainer(); // warm, so the failure below is the measurement's
    fake.failNext('scan');
    const err = console.error;
    console.error = () => {};
    try {
      expect((await route.GET()).status).toBe(500);
    } finally {
      console.error = err;
    }
  });
});
