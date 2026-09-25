import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, testKey, TEST_CTX, ctxKey, registerTestContainer, TEST_CONTAINER } from './fake-redis';

const ctx = TEST_CTX;

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { readStorageUsage, containerLabel } = await import('@/lib/blob-sizes');
const { registryKey } = await import('@/lib/containers');
const { forgetEpochs, deploymentContainer } = await import('@/lib/sessions');
const { saveItem } = await import('@/lib/storage');
const route = await import('@/app/api/storage-usage/route');

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
      expect(await readStorageUsage(ctx)).toEqual({ total_chars: 10, items: [{ item_id: 'item_a', orphaned: false, txns: 10 }] });
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
    await fake.set(testKey('cache:net-worth'), 'x'.repeat(99));
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
    expect(await readStorageUsage(ctx)).toEqual({ total_chars: 0, items: [] });
  });
});

describe('the container a ceiling error names', () => {
  test('is the deployment container, or says why there is none', async () => {
    expect(await containerLabel()).toBe('no container');
    await fake.hset(registryKey(), { [A]: JSON.stringify({ status: 'active', primary: true, created_at: 'x' }) });
    forgetEpochs();
    expect(await containerLabel()).toBe(`container ${A}`);
    process.env.CONTAINER_ID = 'nope';
    forgetEpochs();
    expect(await containerLabel()).toBe('an unresolved container (CONTAINER_ID is not a container id.)');
    fake.failNext('hgetall');
    delete process.env.CONTAINER_ID;
    forgetEpochs();
    expect(await containerLabel()).toBe('an unresolved container (Error)');
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
    });
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
