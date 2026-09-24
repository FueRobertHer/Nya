import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { FakeRedis, storageMock, testKey } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Deserializing like Upstash: what production reads back.
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt, encryptV2, importMasterKey, dataKeyId, keysHashKey } = await import('@/lib/crypto');
const { StoredDataUnreadableError } = await import('@/lib/stored-json');
const { getGoals, setGoals } = await import('@/lib/goals');
const { getBudgets, setBudgets } = await import('@/lib/budgets');
const goalsRoute = await import('@/app/api/goals/route');
const budgetsRoute = await import('@/app/api/budgets/route');

beforeEach(() => fake.reset());

const GOAL = { id: 'g1', name: 'Emergency fund', target: 5000, account_id: null };

describe('goals', () => {
  test('never saved reads as none', async () => {
    expect(await getGoals()).toEqual([]);
  });

  test('round-trip', async () => {
    await setGoals([GOAL]);
    expect(await getGoals()).toEqual([GOAL]);
  });

  for (const [name, stored] of [
    ['a value that does not decrypt', 'not-ciphertext-at-all-but-long-enough-to-try'],
    ['a value that decrypts to something other than JSON', null],
    ['a value that decrypts to the wrong shape', '{"not":"a list"}'],
  ] as const) {
    test(`${name} is reported, never read as none`, async () => {
      const blob = stored === null ? await encrypt('not json') : stored.startsWith('{') ? await encrypt(stored) : stored;
      await fake.set(testKey('goals'), blob);
      await expect(getGoals()).rejects.toBeInstanceOf(StoredDataUnreadableError);
    });
  }

  test('saving over an unreadable value is refused, and it is left exactly as it was', async () => {
    // The reported bug: unreadable read as empty, then the next save wrote a
    // one-goal list over it.
    await fake.set(testKey('goals'), 'unreadable-but-recoverable-blob');
    await expect(setGoals([GOAL])).rejects.toBeInstanceOf(StoredDataUnreadableError);
    expect(await fake.get<string>(testKey('goals'))).toBe('unreadable-but-recoverable-blob');
  });

  test('a Redis failure is an error, never none', async () => {
    fake.failNext('get');
    await expect(getGoals()).rejects.toThrow(/armed failure/);
  });

  test('a Redis failure while checking stops the save', async () => {
    await setGoals([GOAL]);
    fake.failNext('get');
    await expect(setGoals([])).rejects.toThrow(/armed failure/);
    expect(await getGoals()).toEqual([GOAL]);
  });
});

describe('empty is a real value, not unreadable', () => {
  test('an empty goal list saves and reads back', async () => {
    await setGoals([GOAL]);
    await setGoals([]);
    expect(await getGoals()).toEqual([]);
    await setGoals([GOAL]); // and can be saved over again
    expect(await getGoals()).toEqual([GOAL]);
  });

  test('an empty budget set saves and reads back', async () => {
    await setBudgets({ Groceries: 400 });
    await setBudgets({});
    expect(await getBudgets()).toEqual({});
    await setBudgets({ Rent: 1000 });
    expect(await getBudgets()).toEqual({ Rent: 1000 });
  });

  test('a stored empty string reads as never saved', async () => {
    await fake.set(testKey('goals'), '');
    expect(await getGoals()).toEqual([]);
    await setGoals([GOAL]);
    expect(await getGoals()).toEqual([GOAL]);
  });
});

describe('budgets', () => {
  test('never saved reads as none, and round-trips', async () => {
    expect(await getBudgets()).toEqual({});
    await setBudgets({ Groceries: 400 });
    expect(await getBudgets()).toEqual({ Groceries: 400 });
  });

  test('the wrong shape is unreadable', async () => {
    await fake.set(testKey('budgets'), await encrypt('[1,2]'));
    await expect(getBudgets()).rejects.toBeInstanceOf(StoredDataUnreadableError);
  });

  test('saving over an unreadable value is refused, and it is left alone', async () => {
    await fake.set(testKey('budgets'), 'unreadable-blob');
    await expect(setBudgets({ Groceries: 400 })).rejects.toBeInstanceOf(StoredDataUnreadableError);
    expect(await fake.get<string>(testKey('budgets'))).toBe('unreadable-blob');
  });
});

describe('the routes tell the dashboard, so it never shows "none"', () => {
  const put = (route: any, body: unknown) =>
    route.PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }));

  test('goals: an unreadable store is a flagged 409 on load and on save', async () => {
    await fake.set(testKey('goals'), 'unreadable');
    const get = await goalsRoute.GET();
    expect(get.status).toBe(409);
    expect(await get.json()).toMatchObject({ unreadable: true });

    const res = await put(goalsRoute, { goals: [GOAL] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ unreadable: true });
    expect(await fake.get<string>(testKey('goals'))).toBe('unreadable');
  });

  test('budgets: the same', async () => {
    await fake.set(testKey('budgets'), 'unreadable');
    const get = await budgetsRoute.GET();
    expect(get.status).toBe(409);
    expect(await get.json()).toMatchObject({ unreadable: true });
    const res = await put(budgetsRoute, { budgets: { Groceries: 400 } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ unreadable: true });
    expect(await fake.get<string>(testKey('budgets'))).toBe('unreadable');
  });

  test('the log says why, and never shows stored data', async () => {
    const secret = 'enc-secret-looking-value-that-must-not-be-logged';
    await fake.set(testKey('goals'), secret);
    const logged: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => logged.push(a.join(' '));
    try {
      await goalsRoute.GET();
    } finally {
      console.error = origError;
    }
    const line = logged.join(' ');
    expect(line).toContain('Stored goals unreadable');
    expect(line).toContain('MalformedCiphertextError');
    expect(line).not.toContain(secret);
  });

  test('a problem with the deployment, not the data, is a 500 without the flag', async () => {
    // A v2 value under a data key: loading that key needs Redis, and a Redis
    // failure there says nothing about whether the data is readable.
    const master = Buffer.alloc(32, 61).toString('base64');
    const saved = process.env.MASTER_KEY;
    process.env.MASTER_KEY = master;
    try {
      const m = await importMasterKey(master);
      const raw = new Uint8Array(32).fill(61);
      const id = await dataKeyId(61, raw);
      await fake.hset(keysHashKey(), {
        [id]: JSON.stringify({ created_at: 'x', wrapped: { [m.fingerprint]: await m.wrap(id, raw) } }),
      });
      const value = await encryptV2(JSON.stringify([GOAL]), id);
      await fake.set(testKey('goals'), value);
      // A fresh id is not cached, so decrypting it must fetch the key.
      const id2 = await dataKeyId(62, raw);
      await fake.set(testKey('goals'), value.replace(`v2.${id}.`, `v2.${id2}.`));
      fake.failNext('hget');

      const origError = console.error;
      console.error = () => {};
      try {
        const res = await goalsRoute.GET();
        expect(res.status).toBe(500);
        expect((await res.json()).unreadable).toBeUndefined();
      } finally {
        console.error = origError;
      }
    } finally {
      if (saved === undefined) delete process.env.MASTER_KEY;
      else process.env.MASTER_KEY = saved;
    }
  });

  test('a readable store still loads and saves normally', async () => {
    expect(await (await goalsRoute.GET()).json()).toEqual({ goals: [] });
    expect((await put(goalsRoute, { goals: [GOAL] })).status).toBe(200);
    expect(await (await goalsRoute.GET()).json()).toEqual({ goals: [GOAL] });
  });

  test('an unexpected failure is a 500 without the flag', async () => {
    fake.failNext('get');
    const origError = console.error;
    console.error = () => {};
    try {
      const res = await goalsRoute.GET();
      expect(res.status).toBe(500);
      expect((await res.json()).unreadable).toBeUndefined();
    } finally {
      console.error = origError;
    }
  });
});
