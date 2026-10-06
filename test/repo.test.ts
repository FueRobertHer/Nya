import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, unscopedDataKeys, type FakeCommand } from './fake-redis';
import { startRedis, upstashOn, type RealRedis } from './real-redis';

// The storage seam (lib/repo.ts). One contract, run twice: against the test
// double, and against a real Redis where redis-server is installed (as in CI).
// Then the checks only one of the two can make, the key inventory, and the
// catalogue.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Deserializing like Upstash: what production reads back.
const fake = new FakeRedis({ deserialize: true });
/** Every command sent through redis() to the double, by name. */
const fakeSent: string[] = [];
const recordedFake = new Proxy(fake, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== 'function' || typeof prop !== 'string') return value;
    return (...args: unknown[]) => {
      fakeSent.push(prop);
      return value.apply(target, args);
    };
  },
});
/** What redis() returns for the test running: the double, or a real server. */
let client: unknown = recordedFake;
mock.module('@/lib/storage', () => ({ ...storageMock(fake), redis: () => client, rawRedis: () => client }));

const { defineValueStore, defineMapStore, forgetDeclaredStore, StoredDataUnreadableError } = await import('@/lib/repo');
const { declaredStores, declaredStore } = await import('@/lib/stores');
const { classify, reencrypt } = await import('@/lib/reencrypt');
const { encrypt, encryptV2, importMasterKey, dataKeyId, keysHashKey, forgetActiveKey, autoFinishSettled } = await import(
  '@/lib/crypto'
);

const saved = { ...process.env };
beforeEach(() => {
  // k0 only: encryption then never touches storage, so every command a test
  // sees is the seam's own.
  delete process.env.MASTER_KEY;
  forgetActiveKey();
});
afterEach(async () => {
  await autoFinishSettled();
  process.env = { ...saved };
  forgetActiveKey();
});

type Note = { text: string; amount: number };
const isNote = (v: unknown): v is Note =>
  typeof v === 'object' && v !== null && typeof (v as Note).text === 'string' && Number.isFinite((v as Note).amount);
const isNotes = (v: unknown): v is Note[] => Array.isArray(v) && v.every(isNote);

// Declared the way the app declares its stores, and forgotten at the end, so
// the test files after this one see only the app's own.
const list = defineValueStore<Note[]>('seam-contract-list', { what: 'test notes', isValid: isNotes, exportable: true });
const notes = defineMapStore<Note>('seam-contract-notes', { what: 'test notes', isValid: isNote, exportable: false });
afterAll(() => {
  forgetDeclaredStore(list.name);
  forgetDeclaredStore(notes.name);
  client = recordedFake;
});

const A = TEST_CTX;
const B = { container: '3f0b8c1e-6d2a-4b5c-9e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const listKey = (ctx = A) => ctxKey('seam-contract-list', ctx);
const notesKey = (ctx = A) => ctxKey('seam-contract-notes', ctx);
const NOTE: Note = { text: 'groceries', amount: 82.13 };
const RENT: Note = { text: 'rent', amount: 1200 };

/** Stored values that cannot be read, each in a different way. */
const UNREADABLE: [string, () => Promise<string>][] = [
  ['not ciphertext', async () => 'not-ciphertext-but-long-enough-to-be-tried'],
  ['under a key this deployment does not have', async () => 'v2.k9-0badc0de.-.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ['not JSON once decrypted', () => encrypt('not json')],
  ['the wrong shape once decrypted', () => encrypt('{"not":"the shape"}')],
  ['plaintext JSON, never encrypted', async () => '{"text":"plain","amount":1}'],
  ['a bare number', async () => '12345'],
];

/** One backend: the stored bytes as the database holds them, and its failures. */
type Backend = {
  raw: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    hget(key: string, field: string): Promise<string | null>;
    hset(key: string, field: string, value: string): Promise<void>;
    hgetall(key: string): Promise<Record<string, string>>;
    type(key: string): Promise<string>;
  };
  /** Makes the next command of this name fail, as an unreachable server would. */
  failNext(command: string): void;
  /** Every command sent through redis() so far, by name. */
  sent(): string[];
};

/** The same assertions, whichever backend answers them. */
function contract(b: Backend) {
  /** The commands `run` sends. */
  const sentBy = async (run: () => Promise<unknown>): Promise<string[]> => {
    const before = b.sent().length;
    await run();
    return b.sent().slice(before);
  };

  describe('a value store', () => {
    test('never saved reads as null, and an empty value is a value', async () => {
      expect(await list.get(A)).toBeNull();
      await list.set(A, []);
      expect(await list.get(A)).toEqual([]);
    });

    test('round trip, each save replacing the whole value', async () => {
      await list.set(A, [NOTE, RENT]);
      expect(await list.get(A)).toEqual([NOTE, RENT]);
      await list.set(A, [RENT]);
      expect(await list.get(A)).toEqual([RENT]);
    });

    test("kept encrypted, as one string at the store's key in the container", async () => {
      await list.set(A, [NOTE]);
      expect(await b.raw.type(listKey())).toBe('string');
      expect(await b.raw.get(listKey())).not.toContain('groceries');
    });

    for (const [how, make] of UNREADABLE) {
      test(`${how}: an error, never null, and a save over it is refused, leaving it as it was`, async () => {
        const stored = await make();
        await b.raw.set(listKey(), stored);
        await expect(list.get(A)).rejects.toBeInstanceOf(StoredDataUnreadableError);
        await expect(list.set(A, [NOTE])).rejects.toBeInstanceOf(StoredDataUnreadableError);
        expect(await b.raw.get(listKey())).toBe(stored);
      });
    }

    test('a value that would not read back is refused before anything is sent', async () => {
      await list.set(A, [NOTE]);
      const sent = await sentBy(async () => {
        // NaN is stored as null, which isValid rejects.
        await expect(list.set(A, [{ text: 'x', amount: NaN }])).rejects.toThrow('Refusing to save test notes');
        await expect(list.set(A, { not: 'a list' } as never)).rejects.toBeInstanceOf(TypeError);
      });
      expect(sent).toEqual([]);
      expect(await list.get(A)).toEqual([NOTE]);
    });

    test('remove deletes it, readable or not', async () => {
      await list.set(A, [NOTE]);
      await list.remove(A);
      expect(await list.get(A)).toBeNull();
      await b.raw.set(listKey(), 'unreadable-and-unwanted');
      await list.remove(A);
      expect(await b.raw.type(listKey())).toBe('none');
      expect(await list.get(A)).toBeNull();
    });

    test('a storage failure is an error, never null, and a save it interrupts changes nothing', async () => {
      await list.set(A, [NOTE]);
      b.failNext('get');
      const err = await list.get(A).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(StoredDataUnreadableError);
      b.failNext('get'); // the check before the write
      await expect(list.set(A, [])).rejects.toThrow(/armed failure/);
      b.failNext('set');
      await expect(list.set(A, [])).rejects.toThrow(/armed failure/);
      b.failNext('del');
      await expect(list.remove(A)).rejects.toThrow(/armed failure/);
      expect(await list.get(A)).toEqual([NOTE]);
    });

    test("two containers never see each other's value", async () => {
      await list.set(A, [NOTE]);
      expect(await list.get(B)).toBeNull();
      await list.set(B, [RENT]);
      expect(await list.get(A)).toEqual([NOTE]);
      await list.remove(B);
      expect(await list.get(A)).toEqual([NOTE]);
      // One container's unreadable value stops nothing in another.
      await b.raw.set(listKey(B), 'unreadable');
      await list.set(A, [RENT]);
      expect(await list.get(A)).toEqual([RENT]);
    });
  });

  describe('a map store', () => {
    test('never saved: an empty map, no entry, none counted', async () => {
      expect((await notes.getAll(A)).size).toBe(0);
      expect((await notes.getAllLenient(A)).size).toBe(0);
      expect(await notes.get(A, 'n1')).toBeNull();
      expect(await notes.count(A)).toBe(0);
      expect(await notes.has(A, 'n1')).toBe(false);
    });

    test('round trip, in id order', async () => {
      await notes.set(A, 'n2', RENT);
      await notes.set(A, 'n1', NOTE);
      expect([...(await notes.getAll(A))]).toEqual([
        ['n1', NOTE],
        ['n2', RENT],
      ]);
      expect([...(await notes.getAllLenient(A))]).toEqual([
        ['n1', NOTE],
        ['n2', RENT],
      ]);
      expect(await notes.get(A, 'n2')).toEqual(RENT);
      expect(await notes.count(A)).toBe(2);
      expect(await notes.has(A, 'n1')).toBe(true);
    });

    test('set replaces one entry and leaves the rest', async () => {
      await notes.setMany(A, [
        ['n1', NOTE],
        ['n2', RENT],
      ]);
      await notes.set(A, 'n1', { text: 'groceries', amount: 90 });
      expect([...(await notes.getAll(A))]).toEqual([
        ['n1', { text: 'groceries', amount: 90 }],
        ['n2', RENT],
      ]);
    });

    test('setMany writes every entry in one HSET, a repeated id keeping its last value', async () => {
      const sent = await sentBy(() =>
        notes.setMany(
          A,
          new Map([
            ['n1', NOTE],
            ['n2', RENT],
          ])
        )
      );
      expect(sent).toEqual(['hset']);
      await notes.setMany(A, [
        ['n3', NOTE],
        ['n3', RENT],
      ]);
      expect(await notes.get(A, 'n3')).toEqual(RENT);
      expect(await notes.count(A)).toBe(3);
    });

    test('nothing to write or remove sends nothing', async () => {
      expect(await sentBy(() => notes.setMany(A, []))).toEqual([]);
      expect(await sentBy(() => notes.remove(A))).toEqual([]);
    });

    test('remove deletes the entries named, readable or not, and ignores ids with none', async () => {
      await notes.setMany(A, [
        ['n1', NOTE],
        ['n2', RENT],
        ['n3', NOTE],
      ]);
      await b.raw.hset(notesKey(), 'bad', 'unreadable');
      await notes.remove(A, 'n1', 'bad', 'missing');
      expect([...(await notes.getAll(A)).keys()]).toEqual(['n2', 'n3']);
      expect(await notes.count(A)).toBe(2);
    });

    test('kept as one hash: ids in plaintext as its fields, values encrypted', async () => {
      await notes.set(A, 'n1', NOTE);
      expect(await b.raw.type(notesKey())).toBe('hash');
      const stored = await b.raw.hgetall(notesKey());
      expect(Object.keys(stored)).toEqual(['n1']);
      expect(stored.n1).not.toContain('groceries');
    });

    const unreadableEntries: [string, () => Promise<string>][] = [...UNREADABLE, ['empty', async () => '']];
    for (const [how, make] of unreadableEntries) {
      test(`one entry ${how}: strict reads throw, the lenient one leaves out only it, and writes beside it leave it be`, async () => {
        const stored = await make();
        await notes.setMany(A, [
          ['n1', NOTE],
          ['n3', RENT],
        ]);
        await b.raw.hset(notesKey(), 'n2', stored);
        await expect(notes.getAll(A)).rejects.toBeInstanceOf(StoredDataUnreadableError);
        await expect(notes.get(A, 'n2')).rejects.toBeInstanceOf(StoredDataUnreadableError);
        expect(await notes.get(A, 'n1')).toEqual(NOTE);
        expect([...(await notes.getAllLenient(A))]).toEqual([
          ['n1', NOTE],
          ['n3', RENT],
        ]);
        // Unreadable is not absent: it is still there, and counted.
        expect(await notes.count(A)).toBe(3);
        expect(await notes.has(A, 'n2')).toBe(true);
        await notes.set(A, 'n1', RENT);
        await notes.setMany(A, [['n4', NOTE]]);
        expect(await b.raw.hget(notesKey(), 'n2')).toBe(stored);
      });
    }

    test('a value that would not read back is refused, and a batch holding one is written not at all', async () => {
      const sent = await sentBy(async () => {
        // Infinity is stored as null, which isValid rejects.
        await expect(notes.set(A, 'n1', { text: 'x', amount: Infinity })).rejects.toThrow('Refusing to save test notes');
        await expect(notes.setMany(A, [['n1', NOTE], ['n2', { text: 'x' } as Note]])).rejects.toBeInstanceOf(TypeError);
      });
      expect(sent).toEqual([]);
      expect(await notes.count(A)).toBe(0);
    });

    test('ids are opaque: content, and what a field name could lose, is refused before anything is sent', async () => {
      const sent = await sentBy(async () => {
        for (const id of ['', 'Whole Foods', 'Food & Drink', 'café', 'a/b', 'a*', '__proto__', 'x'.repeat(201), 7 as never]) {
          await expect(notes.set(A, id, NOTE)).rejects.toThrow('Invalid id for test notes');
          await expect(notes.setMany(A, [['n1', NOTE], [id, NOTE]])).rejects.toBeInstanceOf(TypeError);
          await expect(notes.get(A, id)).rejects.toBeInstanceOf(TypeError);
          await expect(notes.has(A, id)).rejects.toBeInstanceOf(TypeError);
          await expect(notes.remove(A, 'n1', id)).rejects.toBeInstanceOf(TypeError);
        }
      });
      expect(sent).toEqual([]);
      // Random, hashed, a provider's own, and composite ids are fine.
      const ids = [crypto.randomUUID(), `manual_${crypto.randomUUID()}`, 'f'.repeat(64), 'lPNjeW1nR6CDn5okmGQ6hEpMo4lLNoSrzqDje', 'acct_1:holding.2', 'x'.repeat(200)];
      await notes.setMany(A, ids.map((id) => [id, NOTE] as const));
      expect([...(await notes.getAll(A)).keys()]).toEqual([...ids].sort());
    });

    test('a storage failure is an error, never empty, the lenient read included', async () => {
      await notes.setMany(A, [
        ['n1', NOTE],
        ['n2', RENT],
      ]);
      b.failNext('hgetall');
      const strict = await notes.getAll(A).catch((e) => e);
      expect(strict).toBeInstanceOf(Error);
      expect(strict).not.toBeInstanceOf(StoredDataUnreadableError);
      b.failNext('hgetall');
      await expect(notes.getAllLenient(A)).rejects.toThrow(/armed failure/);
      b.failNext('hget');
      await expect(notes.get(A, 'n1')).rejects.toThrow(/armed failure/);
      b.failNext('hlen');
      await expect(notes.count(A)).rejects.toThrow(/armed failure/);
      b.failNext('hexists');
      await expect(notes.has(A, 'n1')).rejects.toThrow(/armed failure/);
      b.failNext('hset');
      await expect(notes.set(A, 'n3', NOTE)).rejects.toThrow(/armed failure/);
      b.failNext('hdel');
      await expect(notes.remove(A, 'n1')).rejects.toThrow(/armed failure/);
      expect([...(await notes.getAll(A))]).toEqual([
        ['n1', NOTE],
        ['n2', RENT],
      ]);
    });

    test("two containers never see each other's entries", async () => {
      await notes.set(A, 'n1', NOTE);
      expect((await notes.getAll(B)).size).toBe(0);
      expect(await notes.get(B, 'n1')).toBeNull();
      expect(await notes.has(B, 'n1')).toBe(false);
      await notes.set(B, 'n1', RENT);
      await notes.remove(B, 'n1');
      expect(await notes.get(A, 'n1')).toEqual(NOTE);
      expect(await notes.count(A)).toBe(1);
      expect(await notes.count(B)).toBe(0);
      // One container's unreadable entry is no part of another's reads.
      await b.raw.hset(notesKey(B), 'n9', 'unreadable');
      expect([...(await notes.getAll(A))]).toEqual([['n1', NOTE]]);
    });
  });
}

describe('the seam, on the test double', () => {
  beforeEach(() => {
    fake.reset();
    client = recordedFake;
  });
  // Nothing may be written outside a container (#53).
  afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

  contract({
    raw: {
      get: async (key) => fake.strings.get(key) ?? null,
      set: async (key, value) => void fake.strings.set(key, value),
      hget: async (key, field) => fake.hashes.get(key)?.get(field) ?? null,
      hset: async (key, field, value) => void fake.hashes.set(key, new Map(fake.hashes.get(key)).set(field, value)),
      hgetall: async (key) => Object.fromEntries(fake.hashes.get(key) ?? []),
      type: async (key) => (fake.strings.has(key) ? 'string' : fake.hashes.has(key) ? 'hash' : 'none'),
    },
    failNext: (command) => fake.failNext(command as FakeCommand),
    sent: () => fakeSent,
  });

  test('a data key that cannot be loaded is a problem with the deployment: thrown as it is, even by the lenient read', async () => {
    // As in test/stored-json.test.ts: values under a data key whose id is not
    // cached, so reading one must fetch the key, and the key store cannot be
    // read. That says nothing about whether the data is readable.
    const master = Buffer.alloc(32, 91).toString('base64');
    process.env.MASTER_KEY = master;
    const m = await importMasterKey(master);
    const raw = new Uint8Array(32).fill(91);
    const id = await dataKeyId(91, raw);
    await fake.hset(keysHashKey(), {
      [id]: JSON.stringify({ created_at: 'x', wrapped: { [m.fingerprint]: await m.wrap(id, raw) } }),
    });
    const fresh = await dataKeyId(92, raw);
    const underFresh = async (plain: string) => (await encryptV2(plain, id)).replace(`v2.${id}.`, `v2.${fresh}.`);
    await fake.hset(notesKey(), { n1: await encrypt(JSON.stringify(RENT)), n2: await underFresh(JSON.stringify(NOTE)) });
    await fake.set(listKey(), await underFresh(JSON.stringify([NOTE])));

    client = new Proxy(fake, {
      get(target, prop, receiver) {
        if (prop === 'hget') {
          return async (key: string, field: string) => {
            if (key === keysHashKey()) throw new Error('the key store cannot be reached');
            return target.hget(key, field);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    for (const read of [() => notes.getAll(A), () => notes.getAllLenient(A), () => notes.get(A, 'n2'), () => list.get(A)]) {
      const err = await read().catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(StoredDataUnreadableError);
      expect(err.message).toBe('the key store cannot be reached');
    }
  });

  test('the re-encryption pass knows the stores by their declarations, and moves their values', async () => {
    // Saved before any data key exists, so under k0.
    await list.set(A, [NOTE]);
    await notes.setMany(A, [
      ['n1', NOTE],
      ['n2', RENT],
    ]);
    process.env.MASTER_KEY = Buffer.alloc(32, 93).toString('base64');
    forgetActiveKey();
    const report = await reencrypt({ dryRun: false, budgetMs: 60_000 });
    expect(report).toMatchObject({ walked_all: true, moved: 3, unclassified: [], unreadable_count: 0, complete: true });
    expect(fake.strings.get(listKey())).toStartWith(`v2.${report.active_key}.`);
    expect(await list.get(A)).toEqual([NOTE]);
    expect([...(await notes.getAll(A))]).toEqual([
      ['n1', NOTE],
      ['n2', RENT],
    ]);
  });
});

const hasRedis = Bun.which('redis-server') !== null;
describe.skipIf(!hasRedis && !process.env.CI)('the seam, on a real Redis', () => {
  let real: RealRedis | null = null;
  let upstash: ReturnType<typeof upstashOn>;
  const send = (command: string, args: string[]) => real!.client.send(command, args);

  beforeEach(async () => {
    real ??= await startRedis();
    await send('FLUSHALL', []);
    upstash = upstashOn(real.client);
    client = upstash;
  });
  afterEach(async () => {
    // Nothing outside a container, as on the double.
    const keys = (await send('KEYS', ['*'])) as string[];
    expect(keys.filter((key) => !key.startsWith('test:c:'))).toEqual([]);
  });
  afterAll(() => {
    real?.stop();
    real = null;
  });

  contract({
    raw: {
      get: async (key) => (await send('GET', [key])) as string | null,
      set: async (key, value) => void (await send('SET', [key, value])),
      hget: async (key, field) => (await send('HGET', [key, field])) as string | null,
      hset: async (key, field, value) => void (await send('HSET', [key, field, value])),
      hgetall: async (key) => (await send('HGETALL', [key])) as Record<string, string>,
      type: async (key) => String(await send('TYPE', [key])),
    },
    failNext: (command) => upstash.failNext(command),
    sent: () => upstash.sent,
  });

  test('a key of the wrong type is an error, never empty, and is left as it is', async () => {
    await send('SET', [notesKey(), 'a string where the hash should be']);
    for (const op of [
      () => notes.getAll(A),
      () => notes.getAllLenient(A),
      () => notes.get(A, 'n1'),
      () => notes.count(A),
      () => notes.has(A, 'n1'),
      () => notes.set(A, 'n1', NOTE),
      () => notes.remove(A, 'n1'),
    ]) {
      await expect(op()).rejects.toThrow('WRONGTYPE');
    }
    expect(await send('GET', [notesKey()])).toBe('a string where the hash should be');

    await send('HSET', [listKey(), 'f', 'a hash where the string should be']);
    await expect(list.get(A)).rejects.toThrow('WRONGTYPE');
    await expect(list.set(A, [NOTE])).rejects.toThrow('WRONGTYPE');
    expect(await send('HGET', [listKey(), 'f'])).toBe('a hash where the string should be');
  });

  test('a lost connection is an error, never empty', async () => {
    await list.set(A, [NOTE]);
    await notes.set(A, 'n1', NOTE);
    const lost = new Bun.RedisClient(real!.url);
    await lost.send('PING', []); // closed before its first command, it would reconnect
    lost.close();
    client = upstashOn(lost);
    for (const read of [() => list.get(A), () => notes.getAll(A), () => notes.getAllLenient(A), () => notes.get(A, 'n1'), () => notes.count(A)]) {
      const err = await read().catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(StoredDataUnreadableError);
    }
  });
});

describe('the key inventory', () => {
  const c = `c:${TEST_CTX.container}:`;

  test('a declared store is in it by its declaration', () => {
    expect(classify(`${c}seam-contract-list`)).toBe('string');
    expect(classify(`${c}seam-contract-notes`)).toBe('hash');
    // Like a listed key, the same name outside a container.
    expect(classify('seam-contract-notes')).toBe('hash');
    expect(classify(`${c}seam-contract-undeclared`)).toBeNull();
    // Read from the registry each time, so a forgotten store is unknown again.
    try {
      defineMapStore('seam-contract-temp', { what: 'test notes', isValid: isNote, exportable: false });
      expect(classify(`${c}seam-contract-temp`)).toBe('hash');
    } finally {
      forgetDeclaredStore('seam-contract-temp');
    }
    expect(classify(`${c}seam-contract-temp`)).toBeNull();
  });

  test('the lists are unchanged, and no declared store collides with them', () => {
    expect(classify(`${c}goals`)).toBe('string');
    expect(classify(`${c}manual:accounts`)).toBe('hash');
    expect(classify(`${c}cache:net-worth`)).toBe('cipher');
    expect(classify(`${c}txns:item-1`)).toBe('string');
    expect(classify(`${c}plaid:items`)).toBe('items');
    expect(classify(`${c}snapshot:runs`)).toBe('plain');
    // Each declared name classifies as its declaration says, so no listed key
    // family claims it as something else.
    for (const store of declaredStores()) {
      expect(classify(`${c}${store.name}`), `${store.name} collides with a key family listed in lib/reencrypt.ts`).toBe(
        store.kind === 'value' ? 'string' : 'hash'
      );
    }
  });

  test('a name that is not a plain key family is refused, and nothing is declared', () => {
    for (const name of ['', 'Rules', 'my rules', 'rules*', 'rules:', ':rules', 'c:rules', 'owners', 'containers', 'crypto:rules', 'ratelimit:x', 'invites:x', 'x'.repeat(65)]) {
      expect(() => defineMapStore(name, { what: 'test notes', isValid: isNote, exportable: false })).toThrow('cannot name a store');
      expect(declaredStore(name)).toBeNull();
    }
  });

  test('declaring a name again replaces the store, unless it is another kind', () => {
    try {
      defineMapStore('seam-contract-again', { what: 'test notes', isValid: isNote, exportable: false });
      const second = defineMapStore('seam-contract-again', { what: 'test notes', isValid: isNote, exportable: true });
      expect(declaredStore('seam-contract-again')).toBe(second);
      expect(() => defineValueStore('seam-contract-again', { what: 'test notes', isValid: isNotes, exportable: false })).toThrow(
        'already declared, as a map store'
      );
      expect(declaredStore('seam-contract-again')).toBe(second);
    } finally {
      forgetDeclaredStore('seam-contract-again');
    }
  });
});

describe('the catalogue', () => {
  test('lists every declared store, in name order, with what it is', () => {
    const ours = declaredStores().filter((s) => s.name.startsWith('seam-contract-'));
    expect(ours.map((s) => [s.name, s.kind, s.what, s.exportable])).toEqual([
      ['seam-contract-list', 'value', 'test notes', true],
      ['seam-contract-notes', 'map', 'test notes', false],
    ]);
    expect(declaredStore('seam-contract-notes')).toBe(notes);
    const names = declaredStores().map((s) => s.name);
    expect(names).toEqual([...names].sort());
  });

  // Read from the source, so a store whose module nothing has loaded yet is
  // still found.
  const root = join(import.meta.dir, '..');
  const rel = (path: string) => relative(root, path).replaceAll('\\', '/');
  const files: string[] = [join(root, 'proxy.ts')];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === 'node_modules' || name.startsWith('.')) continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) files.push(path);
    }
  };
  for (const dir of ['lib', 'app', 'components', 'scripts']) walk(join(root, dir));

  /** The source with comments blanked (offsets kept) and strings kept, as in
   *  test/reencrypt.test.ts. */
  const code = (path: string) =>
    readFileSync(path, 'utf8').replace(
      /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      (m) => (m[0] === '/' ? m.replace(/[^\n]/g, ' ') : m)
    );

  /** The name each call of defineValueStore or defineMapStore declares, or
   *  null where it is not spelled out as a string. Imports, types and other
   *  mentions are not calls. */
  function declarationsIn(src: string): (string | null)[] {
    const out: (string | null)[] = [];
    for (const m of src.matchAll(/\bdefine(?:Value|Map)Store\b/g)) {
      let i = m.index! + m[0].length;
      const skipSpace = () => {
        while (/\s/.test(src[i] ?? '')) i++;
      };
      skipSpace();
      if (src[i] === '<') {
        // Type arguments, nested or not; "=>" is not a closing bracket.
        for (let depth = 0; i < src.length; i++) {
          if (src[i] === '<') depth++;
          else if (src[i] === '>' && src[i - 1] !== '=' && --depth === 0) {
            i++;
            break;
          }
        }
        skipSpace();
      }
      if (src[i] !== '(') continue;
      i++;
      skipSpace();
      const literal = /^(['"])([^'"\\\n]*)\1/.exec(src.slice(i));
      out.push(literal ? literal[2] : null);
    }
    return out;
  }

  const declarations = files
    .filter((f) => rel(f) !== 'lib/repo.ts')
    .flatMap((f) => declarationsIn(code(f)).map((name) => ({ file: rel(f), name })));

  test('the scan finds a declaration however it is written, and nothing else', () => {
    const sample = `
      import { defineMapStore, defineValueStore, type MapStore } from './repo';
      // defineMapStore('in-a-comment', opts)
      export const a = defineMapStore<Rule>('rules', { what: 'rules', isValid: isRule, exportable: true });
      export const b = defineValueStore<Record<string, { n: (x: number) => string }>>(
        "settings",
        opts
      );
      const c = defineMapStore(name, opts);
      type T = ReturnType<typeof defineMapStore>;
    `.replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
    expect(declarationsIn(sample)).toEqual(['rules', 'settings', null]);
  });

  test('every declaration spells out its name, and no two share one', () => {
    expect(
      declarations.filter((d) => d.name === null),
      'Declare a store with its name written out: defineMapStore(\'rules\', {...}).'
    ).toEqual([]);
    const names = declarations.map((d) => d.name);
    expect(
      declarations.filter((d, i) => names.indexOf(d.name) !== i),
      'Two stores declared under one name would share one key family.'
    ).toEqual([]);
  });

  test('every module that declares a store is under lib/ and imported by lib/stores.ts', () => {
    const declaring = [...new Set(declarations.map((d) => d.file))];
    expect(declaring.filter((f) => !f.startsWith('lib/')), 'Declare stores in a module under lib/, not in a route or component.').toEqual([]);
    const catalogue = join(root, 'lib', 'stores.ts');
    const imported = new Set(
      [...code(catalogue).matchAll(/\bimport\s+(?:[^;'"]*?\bfrom\s*)?(['"])(\.[^'"]+)\1/g)].map((m) =>
        rel(resolve(dirname(catalogue), m[2])).replace(/\.tsx?$/, '')
      )
    );
    expect(
      declaring.filter((f) => !imported.has(f.replace(/\.tsx?$/, ''))),
      'Add `import \'./<module>\';` to lib/stores.ts for each module listed, so the key inventory and the data download see its store.'
    ).toEqual([]);
  });
});
