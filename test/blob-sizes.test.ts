import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, testKey } from './fake-redis';

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { recordBlobSize, forgetBlobSize, readStorageUsage, containerLabel } = await import('@/lib/blob-sizes');
const { registryKey } = await import('@/lib/containers');
const { forgetEpochs } = await import('@/lib/sessions');
const route = await import('@/app/api/storage-usage/route');

const A = crypto.randomUUID();
const saved = { ...process.env };
beforeEach(() => {
  fake.reset();
  forgetEpochs();
  delete process.env.CONTAINER_ID;
});
afterEach(() => {
  process.env = { ...saved };
});

describe('stored blob sizes', () => {
  test('are kept per Item and kind, totalled, largest Item first', async () => {
    await recordBlobSize('txns', 'item_a', 100, 0);
    await recordBlobSize('invtxns', 'item_a', 50, 0);
    await recordBlobSize('txns', 'item_b', 400, 0);
    await recordBlobSize('txns', 'item_a', 120, 0); // a later write replaces
    const at = new Date(0).toISOString();
    expect(await readStorageUsage()).toEqual({
      total_chars: 570,
      items: [
        { item_id: 'item_b', txns: { chars: 400, at } },
        { item_id: 'item_a', txns: { chars: 120, at }, invtxns: { chars: 50, at } },
      ],
    });
  });

  test('forgetting one kind leaves the other', async () => {
    await recordBlobSize('txns', 'item_a', 100);
    await recordBlobSize('invtxns', 'item_a', 50);
    await forgetBlobSize('txns', 'item_a');
    const usage = await readStorageUsage();
    expect(usage.total_chars).toBe(50);
    expect(usage.items[0].txns).toBeUndefined();
  });

  test('an unreadable entry is left out, not counted', async () => {
    await recordBlobSize('txns', 'item_a', 100);
    await fake.hset(testKey('blob-sizes'), {
      'txns:item_b': 'junk',
      'other:item_c': JSON.stringify({ chars: 5, at: 'x' }),
      'invtxns:item_d': JSON.stringify({ chars: -1, at: 'x' }),
      nocolon: JSON.stringify({ chars: 5, at: 'x' }),
    });
    const usage = await readStorageUsage();
    expect(usage.total_chars).toBe(100);
    expect(usage.items.map((i) => i.item_id)).toEqual(['item_a']);
  });

  test('a failed record never throws', async () => {
    fake.failNext('hset');
    const warn = console.warn;
    console.warn = () => {};
    try {
      await recordBlobSize('txns', 'item_a', 100);
      fake.failNext('hdel');
      await forgetBlobSize('txns', 'item_a');
    } finally {
      console.warn = warn;
    }
    expect(await readStorageUsage()).toEqual({ total_chars: 0, items: [] });
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
    expect(await containerLabel()).toBe('an unresolved container');
    fake.failNext('hgetall');
    delete process.env.CONTAINER_ID;
    forgetEpochs();
    expect(await containerLabel()).toBe('an unresolved container');
  });
});

describe('/api/storage-usage', () => {
  test('reports the container, the ceiling and the sizes', async () => {
    await fake.hset(registryKey(), { [A]: JSON.stringify({ status: 'active', primary: true, created_at: 'x' }) });
    await recordBlobSize('txns', 'item_a', 100, 0);
    const body = await (await route.GET()).json();
    expect(body).toEqual({
      container: A,
      ceiling_chars: expect.any(Number),
      total_chars: 100,
      items: [{ item_id: 'item_a', txns: { chars: 100, at: new Date(0).toISOString() } }],
    });
  });

  test('a failed read is a 500', async () => {
    fake.failNext('hgetall', 2);
    const err = console.error;
    console.error = () => {};
    try {
      expect((await route.GET()).status).toBe(500);
    } finally {
      console.error = err;
    }
  });
});
