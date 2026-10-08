import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Redis } from '@upstash/redis';
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

const {
  defineValueStore,
  defineMapStore,
  forgetDeclaredStore,
  StoredDataUnreadableError,
  UnreadableEntriesError,
  UpdateConflictError,
  StoredValueTooLargeError,
  READ_ENTRIES,
} = await import('@/lib/repo');
const { declaredStores, declaredStore } = await import('@/lib/stores');
const { classify, reencrypt } = await import('@/lib/reencrypt');
const { listedKind } = await import('@/lib/key-families');
const { isExcluded } = await import('@/lib/export');
const {
  encrypt,
  encryptV2,
  importMasterKey,
  dataKeyId,
  keysHashKey,
  forgetActiveKey,
  autoFinishSettled,
  MasterKeyError,
  UnknownKeyError,
  DecryptFailedError,
} = await import('@/lib/crypto');

const saved = { ...process.env };
beforeEach(() => {
  // k0 only, unless a test sets a master: encryption then never touches
  // storage, so every command a test sees is the seam's own.
  delete process.env.MASTER_KEY;
  forgetActiveKey();
});
afterEach(async () => {
  await autoFinishSettled();
  process.env = { ...saved };
  forgetActiveKey();
});

/** Masters of these tests' own, distinct from other files'. */
const MASTER = Buffer.alloc(32, 101).toString('base64');
const OTHER_MASTER = Buffer.alloc(32, 102).toString('base64');

type Note = { text: string; amount: number };
const isNote = (v: unknown): v is Note =>
  typeof v === 'object' && v !== null && typeof (v as Note).text === 'string' && Number.isFinite((v as Note).amount);
const isNotes = (v: unknown): v is Note[] => Array.isArray(v) && v.every(isNote);

// Declared the way the app declares its stores, and forgotten at the end, so
// the test files after this one see only the app's own.
const list = defineValueStore<Note[]>('seam-contract-list', { what: 'test notes', isValid: isNotes, exportable: true });
const notes = defineMapStore<Note>('seam-contract-notes', { what: 'test notes', isValid: isNote, exportable: false });
const bigList = defineValueStore<Note[]>('seam-contract-big-list', { what: 'test notes', isValid: isNotes, exportable: true, compress: true });
const bigNotes = defineMapStore<Note>('seam-contract-big-notes', { what: 'test notes', isValid: isNote, exportable: true, compress: true });
afterAll(() => {
  for (const s of [list, notes, bigList, bigNotes]) forgetDeclaredStore(s.name);
  client = recordedFake;
});

const A = TEST_CTX;
const B = { container: '3f0b8c1e-6d2a-4b5c-9e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const listKey = (ctx = A) => ctxKey('seam-contract-list', ctx);
const notesKey = (ctx = A) => ctxKey('seam-contract-notes', ctx);
const NOTE: Note = { text: 'groceries', amount: 82.13 };
const RENT: Note = { text: 'rent', amount: 1200 };

/** Stored values whose own content is damaged, each in a different way. */
const DAMAGED: [string, () => Promise<string>][] = [
  ['not ciphertext', async () => 'not-ciphertext-but-long-enough-to-be-tried'],
  ['not JSON once decrypted', () => encrypt('not json')],
  ['the wrong shape once decrypted', () => encrypt('{"not":"the shape"}')],
  ['plaintext JSON, never encrypted', async () => '{"text":"plain","amount":1}'],
  ['a bare number', async () => '12345'],
];

/** A ciphertext with one character of its body changed, still valid base64:
 *  authentic no more, so it fails to decrypt. */
const tampered = (blob: string) => {
  const at = blob.length - 12;
  return blob.slice(0, at) + (blob[at] === 'A' ? 'B' : 'A') + blob.slice(at + 1);
};

/** Runs `fn` with console.error and console.warn collected instead of printed. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T | Error; logged: string }> {
  const [error, warn] = [console.error, console.warn];
  const lines: string[] = [];
  console.error = console.warn = (...a: unknown[]) => lines.push(a.join(' '));
  try {
    return { result: await fn().catch((e: Error) => e), logged: lines.join('\n') };
  } finally {
    [console.error, console.warn] = [error, warn];
  }
}

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
  /** The error `run` rejects with, which must not be one blaming the data. */
  const notBlamed = async (run: () => Promise<unknown>) => {
    const err = await run().then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(StoredDataUnreadableError);
    return err as Error;
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

    for (const [how, make] of DAMAGED) {
      test(`${how}: an error, never null, and a save over it is refused, leaving it as it was`, async () => {
        const stored = await make();
        await b.raw.set(listKey(), stored);
        await expect(list.get(A)).rejects.toBeInstanceOf(StoredDataUnreadableError);
        await expect(list.set(A, [NOTE])).rejects.toBeInstanceOf(StoredDataUnreadableError);
        expect(await b.raw.get(listKey())).toBe(stored);
      });
    }

    test('text that reads as nothing (empty, or the JSON literal null) is never saved, and a save replaces it', async () => {
      for (const nothing of ['', 'null', '""']) {
        await b.raw.set(listKey(), nothing);
        expect(await list.get(A)).toBeNull();
        await list.set(A, [NOTE]);
        expect(await list.get(A)).toEqual([NOTE]);
      }
    });

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

    test('what is written is exactly what was checked', async () => {
      // A value that serializes differently the second time: only the first,
      // checked serialization may be stored.
      let calls = 0;
      const shifty = { toJSON: () => (++calls === 1 ? NOTE : { not: 'a note' }) };
      await list.set(A, [shifty as never]);
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
      await notBlamed(() => list.get(A));
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
      expect(await notes.getAllReport(A)).toEqual({ entries: new Map(), unreadable: [] });
      expect(await notes.get(A, 'n1')).toBeNull();
      expect((await notes.getMany(A, ['n1', 'n2'])).size).toBe(0);
      expect(await notes.count(A)).toBe(0);
      expect(await notes.has(A, 'n1')).toBe(false);
    });

    test('round trip, in id order', async () => {
      await notes.set(A, 'n2', RENT);
      await notes.set(A, 'n1', NOTE);
      const both: [string, Note][] = [
        ['n1', NOTE],
        ['n2', RENT],
      ];
      expect([...(await notes.getAll(A))]).toEqual(both);
      expect([...(await notes.getAllLenient(A))]).toEqual(both);
      expect([...(await notes.getAllReport(A)).entries]).toEqual(both);
      expect(await notes.get(A, 'n2')).toEqual(RENT);
      expect(await notes.count(A)).toBe(2);
      expect(await notes.has(A, 'n1')).toBe(true);
    });

    test('getMany: the entries there are for the ids asked, in that order, each once, in one request', async () => {
      await notes.setMany(A, [
        ['n1', NOTE],
        ['n2', RENT],
        ['n3', NOTE],
      ]);
      let found = new Map<string, Note>();
      const sent = await sentBy(async () => {
        found = await notes.getMany(A, ['n3', 'missing', 'n1', 'n3']);
      });
      expect([...found]).toEqual([
        ['n3', NOTE],
        ['n1', NOTE],
      ]);
      expect(sent).toEqual(['eval']);
      expect(await sentBy(() => notes.getMany(A, []))).toEqual([]);
    });

    test('getMany reads a thousand ids per request', async () => {
      const ids = Array.from({ length: 1001 }, (_, i) => `n${String(i).padStart(4, '0')}`);
      await notes.setMany(
        A,
        ids.map((id) => [id, NOTE] as const)
      );
      let found = new Map<string, Note>();
      const sent = await sentBy(async () => {
        found = await notes.getMany(A, [...ids, 'missing']);
      });
      expect(found.size).toBe(1001);
      expect([...found.keys()]).toEqual(ids);
      expect(sent).toEqual(['eval', 'eval']);
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

    const damagedEntries: [string, () => Promise<string>][] = [
      ...DAMAGED,
      ['empty', async () => ''],
      // The client reads this text as null: a get() that took it for "no
      // entry" would disagree with has() and count().
      ['the JSON literal null', async () => 'null'],
    ];
    for (const [how, make] of damagedEntries) {
      test(`one entry ${how}: strict reads name it, the report lists it, the lenient read leaves out only it`, async () => {
        const stored = await make();
        await notes.setMany(A, [
          ['n1', NOTE],
          ['n3', RENT],
        ]);
        await b.raw.hset(notesKey(), 'n2', stored);
        for (const read of [() => notes.getAll(A), () => notes.get(A, 'n2'), () => notes.getMany(A, ['n1', 'n2'])]) {
          const err = await read().catch((e) => e);
          expect(err).toBeInstanceOf(UnreadableEntriesError);
          expect(err).toBeInstanceOf(StoredDataUnreadableError); // routes answer it as they do today
          expect(err.ids).toEqual(['n2']);
          expect(err.message).not.toContain('n2'); // ids stay out of logs
        }
        expect(await notes.get(A, 'n1')).toEqual(NOTE);
        expect([...(await notes.getMany(A, ['n1', 'n3']))]).toEqual([
          ['n1', NOTE],
          ['n3', RENT],
        ]);
        const report = await notes.getAllReport(A);
        expect([...report.entries]).toEqual([
          ['n1', NOTE],
          ['n3', RENT],
        ]);
        expect(report.unreadable).toEqual(['n2']);
        expect([...(await notes.getAllLenient(A))]).toEqual([
          ['n1', NOTE],
          ['n3', RENT],
        ]);
        // Unreadable is not absent: it is still there, and counted.
        expect(await notes.count(A)).toBe(3);
        expect(await notes.has(A, 'n2')).toBe(true);
        // Writes beside it leave it be, and update() will not build on it.
        await notes.set(A, 'n1', RENT);
        await notes.setMany(A, [['n4', NOTE]]);
        let ran = false;
        const err = await notes
          .update(A, 'n2', () => {
            ran = true;
            return NOTE;
          })
          .catch((e) => e);
        expect(err).toBeInstanceOf(UnreadableEntriesError);
        expect(ran).toBe(false);
        expect(await b.raw.hget(notesKey(), 'n2')).toBe(stored);
      });
    }

    test('every damaged entry is named, so they can be removed once the person agrees', async () => {
      await notes.setMany(A, [
        ['n1', NOTE],
        ['n3', RENT],
      ]);
      await b.raw.hset(notesKey(), 'n4', 'damaged');
      await b.raw.hset(notesKey(), 'n2', await encrypt('{"not":"the shape"}'));
      const err = await notes.getAll(A).catch((e) => e);
      expect(err.ids).toEqual(['n2', 'n4']);
      const { unreadable } = await notes.getAllReport(A);
      expect(unreadable).toEqual(['n2', 'n4']);
      await notes.remove(A, ...unreadable);
      expect([...(await notes.getAll(A)).keys()]).toEqual(['n1', 'n3']);
    });

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
          await expect(notes.getMany(A, ['n1', id])).rejects.toBeInstanceOf(TypeError);
          await expect(notes.update(A, id, () => NOTE)).rejects.toBeInstanceOf(TypeError);
          await expect(notes.has(A, id)).rejects.toBeInstanceOf(TypeError);
          await expect(notes.remove(A, 'n1', id)).rejects.toBeInstanceOf(TypeError);
        }
      });
      expect(sent).toEqual([]);
      // Random ids, a provider's own, and composite ids are fine.
      const ids = [crypto.randomUUID(), `manual_${crypto.randomUUID()}`, 'lPNjeW1nR6CDn5okmGQ6hEpMo4lLNoSrzqDje', 'acct_1:holding.2', 'x'.repeat(200)];
      await notes.setMany(
        A,
        ids.map((id) => [id, NOTE] as const)
      );
      expect([...(await notes.getAll(A)).keys()]).toEqual([...ids].sort());
    });

    test('a storage failure is an error, never empty, the lenient read included', async () => {
      await notes.setMany(A, [
        ['n1', NOTE],
        ['n2', RENT],
      ]);
      for (const [command, run] of [
        ['hgetall', () => notes.getAll(A)],
        ['hgetall', () => notes.getAllLenient(A)],
        ['hgetall', () => notes.getAllReport(A)],
        ['eval', () => notes.get(A, 'n1')],
        ['eval', () => notes.getMany(A, ['n1'])],
        ['eval', () => notes.update(A, 'n1', () => RENT)],
        ['hlen', () => notes.count(A)],
        ['hexists', () => notes.has(A, 'n1')],
        ['hset', () => notes.set(A, 'n3', NOTE)],
        ['hdel', () => notes.remove(A, 'n1')],
      ] as const) {
        b.failNext(command);
        await notBlamed(run);
      }
      expect([...(await notes.getAll(A))]).toEqual([
        ['n1', NOTE],
        ['n2', RENT],
      ]);
    });

    test("two containers never see each other's entries", async () => {
      await notes.set(A, 'n1', NOTE);
      expect((await notes.getAll(B)).size).toBe(0);
      expect(await notes.get(B, 'n1')).toBeNull();
      expect((await notes.getMany(B, ['n1'])).size).toBe(0);
      expect(await notes.has(B, 'n1')).toBe(false);
      await notes.set(B, 'n1', RENT);
      await notes.update(B, 'n1', (cur) => ({ ...cur!, amount: 1 }));
      await notes.remove(B, 'n1');
      expect(await notes.get(A, 'n1')).toEqual(NOTE);
      expect(await notes.count(A)).toBe(1);
      expect(await notes.count(B)).toBe(0);
      // One container's unreadable entry is no part of another's reads.
      await b.raw.hset(notesKey(B), 'n9', 'unreadable');
      expect([...(await notes.getAll(A))]).toEqual([['n1', NOTE]]);
    });
  });

  describe('update', () => {
    const bump = (cur: Note | null): Note => ({ text: 'count', amount: (cur?.amount ?? 0) + 1 });

    test('creates, changes and deletes an entry, returning what it wrote', async () => {
      expect(await notes.update(A, 'n1', (cur) => (cur === null ? NOTE : null))).toEqual(NOTE);
      expect(await notes.update(A, 'n1', (cur) => ({ ...cur!, amount: cur!.amount + 1 }))).toEqual({ ...NOTE, amount: 83.13 });
      expect(await notes.get(A, 'n1')).toEqual({ ...NOTE, amount: 83.13 });
      expect(await notes.update(A, 'n1', () => null)).toBeNull();
      expect(await notes.has(A, 'n1')).toBe(false);
      // Nothing there and nothing to write: only the read is sent.
      expect(await sentBy(() => notes.update(A, 'n1', () => null))).toEqual(['eval']);
    });

    test('a value that would not read back is refused, and nothing is written', async () => {
      await notes.set(A, 'n1', NOTE);
      await expect(notes.update(A, 'n1', () => ({ text: 'x', amount: NaN }))).rejects.toThrow('Refusing to save test notes');
      expect(await notes.get(A, 'n1')).toEqual(NOTE);
    });

    test('a write landing between its read and its write is never lost: fn runs again on it', async () => {
      await notes.set(A, 'n1', NOTE);
      const seen: Note[] = [];
      const written = await notes.update(A, 'n1', async (cur) => {
        seen.push(cur!);
        if (seen.length === 1) await notes.set(A, 'n1', RENT); // someone else's save, mid-update
        return { ...cur!, text: `${cur!.text}!` };
      });
      expect(seen).toEqual([NOTE, RENT]);
      expect(written).toEqual({ text: 'rent!', amount: 1200 });
      expect(await notes.get(A, 'n1')).toEqual({ text: 'rent!', amount: 1200 });
    });

    test('concurrent updates of one entry all land, where get then set would lose some', async () => {
      await Promise.all(Array.from({ length: 4 }, () => notes.update(A, 'c', bump)));
      expect(await notes.get(A, 'c')).toEqual({ text: 'count', amount: 4 });
      // The same increments as reads then writes: last write wins.
      await notes.set(A, 'c', { text: 'count', amount: 0 });
      await Promise.all(Array.from({ length: 4 }, async () => notes.set(A, 'c', bump(await notes.get(A, 'c')))));
      expect((await notes.get(A, 'c'))!.amount).toBeLessThan(4);
    });

    test('it gives up when the entry keeps changing, and leaves the other writes standing', async () => {
      await notes.set(A, 'n1', NOTE);
      let runs = 0;
      const err = await notes
        .update(A, 'n1', async (cur) => {
          runs++;
          await notes.set(A, 'n1', { text: 'theirs', amount: runs });
          return { ...cur!, text: 'mine' };
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(UpdateConflictError);
      expect(err.message).toBe('Your saved test notes kept changing while this change was being saved, so it was not made. Try again.');
      expect(runs).toBe(5);
      expect(await notes.get(A, 'n1')).toEqual({ text: 'theirs', amount: 5 });
    });

    test('a storage failure on its write is an error, and nothing changes', async () => {
      await notes.set(A, 'n1', NOTE);
      b.failNext('eval'); // the read
      await expect(notes.update(A, 'n1', bump)).rejects.toThrow(/armed failure/);
      expect(await notes.get(A, 'n1')).toEqual(NOTE);
    });
  });

  describe('compressed stores, and the size ceiling', () => {
    const long: Note = { text: 'all work and no play '.repeat(500), amount: 1 };

    test('a compressed store round-trips, stored much smaller than its JSON', async () => {
      await bigList.set(A, [long, NOTE]);
      expect(await bigList.get(A)).toEqual([long, NOTE]);
      await bigNotes.setMany(A, [
        ['n1', long],
        ['n2', NOTE],
      ]);
      expect([...(await bigNotes.getAll(A))]).toEqual([
        ['n1', long],
        ['n2', NOTE],
      ]);
      expect(await bigNotes.update(A, 'n2', (cur) => ({ ...cur!, amount: 2 }))).toEqual({ ...NOTE, amount: 2 });
      const stored = (await b.raw.hget(ctxKey('seam-contract-big-notes'), 'n1'))!;
      expect(stored.length).toBeLessThan(JSON.stringify(long).length / 10);
      expect((await b.raw.get(ctxKey('seam-contract-big-list')))!.length).toBeLessThan(JSON.stringify(long).length / 10);
    });

    test('compression can be switched on or off later: either form reads', async () => {
      try {
        const plain = defineMapStore<Note>('seam-contract-switch', { what: 'test notes', isValid: isNote, exportable: false });
        await plain.set(A, 'n1', long);
        const packed = defineMapStore<Note>('seam-contract-switch', { what: 'test notes', isValid: isNote, exportable: false, compress: true });
        expect(await packed.get(A, 'n1')).toEqual(long);
        await packed.set(A, 'n2', long);
        const plainAgain = defineMapStore<Note>('seam-contract-switch', { what: 'test notes', isValid: isNote, exportable: false });
        expect([...(await plainAgain.getAll(A))]).toEqual([
          ['n1', long],
          ['n2', long],
        ]);
      } finally {
        forgetDeclaredStore('seam-contract-switch');
      }
    });

    test('a write too large for one request is refused whole and loudly, and nothing is trimmed', async () => {
      await list.set(A, [NOTE]);
      await notes.set(A, 'n1', NOTE);
      process.env.MAX_TXN_BLOB_CHARS = '600';
      const huge: Note = { text: 'x'.repeat(1000), amount: 1 };
      const writes: (() => Promise<unknown>)[] = [
        () => list.set(A, [huge]),
        () => notes.set(A, 'n2', huge),
        // Each entry fits; together, in one request, they do not.
        () => notes.setMany(A, Array.from({ length: 12 }, (_, i) => [`n${i + 2}`, RENT] as const)),
        () => notes.update(A, 'n1', () => huge),
      ];
      for (const write of writes) {
        const { result, logged } = await quietly(write);
        expect(result).toBeInstanceOf(StoredValueTooLargeError);
        expect((result as Error).message).toMatch(/^Your test notes are too large to save \(\d+ characters stored, over the limit of 600\), so nothing was changed\.$/);
        expect(logged).toContain('repo: refusing to save seam-contract-');
        expect(logged).not.toContain('groceries');
      }
      expect(await list.get(A)).toEqual([NOTE]);
      expect([...(await notes.getAll(A))]).toEqual([['n1', NOTE]]);
      // What counts is what is stored: compressed, the same text fits.
      await bigNotes.set(A, 'n1', huge);
      expect(await bigNotes.get(A, 'n1')).toEqual(huge);
    });
  });

  describe('a deployment that cannot read the data', () => {
    test('with no master key, or another one, every read throws that, never blaming or dropping the data', async () => {
      process.env.MASTER_KEY = MASTER;
      forgetActiveKey();
      await notes.setMany(A, [
        ['n1', NOTE],
        ['n2', RENT],
      ]);
      await list.set(A, [NOTE]);
      expect(await b.raw.hget(notesKey(), 'n1')).toStartWith('v2.k1-'); // under a data key
      for (const master of [undefined, OTHER_MASTER]) {
        if (master === undefined) delete process.env.MASTER_KEY;
        else process.env.MASTER_KEY = master;
        forgetActiveKey();
        for (const read of [
          () => notes.getAll(A),
          () => notes.getAllLenient(A),
          () => notes.getAllReport(A),
          () => notes.get(A, 'n1'),
          () => notes.getMany(A, ['n1', 'n2']),
          () => notes.update(A, 'n1', () => RENT),
          () => list.get(A),
          () => list.set(A, []),
        ]) {
          expect(await notBlamed(read)).toBeInstanceOf(MasterKeyError);
        }
      }
      // Nothing was changed: with the right master everything reads.
      process.env.MASTER_KEY = MASTER;
      forgetActiveKey();
      expect([...(await notes.getAll(A))]).toEqual([
        ['n1', NOTE],
        ['n2', RENT],
      ]);
      expect(await list.get(A)).toEqual([NOTE]);
    });

    test('a key the key store lacks is thrown as UnknownKeyError, not blamed on the entry', async () => {
      process.env.MASTER_KEY = MASTER;
      forgetActiveKey();
      await notes.set(A, 'n1', NOTE);
      const missing = 'v2.k9-0badc0de.-.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      await b.raw.hset(notesKey(), 'n2', missing);
      await b.raw.set(listKey(), missing);
      for (const read of [
        () => notes.getAll(A),
        () => notes.getAllLenient(A),
        () => notes.getAllReport(A),
        () => notes.get(A, 'n2'),
        () => notes.update(A, 'n2', () => RENT),
        () => list.get(A),
      ]) {
        expect(await notBlamed(read)).toBeInstanceOf(UnknownKeyError);
      }
      expect(await notes.get(A, 'n1')).toEqual(NOTE);
    });

    test('a failed decrypt is damage under a data key, but not under k0, whose key could have changed', async () => {
      // Under k0 (no master), one tampered value: it could equally be a changed
      // PLAID_ENCRYPTION_KEY, so it is thrown, never reported or dropped.
      await notes.set(A, 'n1', NOTE);
      await b.raw.hset(notesKey(), 'n2', tampered(await encrypt(JSON.stringify(RENT))));
      for (const read of [() => notes.getAll(A), () => notes.getAllLenient(A), () => notes.getAllReport(A)]) {
        expect(await notBlamed(read)).toBeInstanceOf(DecryptFailedError);
      }
      // Under a data key, whose id commits to the key, it can only be damage.
      process.env.MASTER_KEY = MASTER;
      forgetActiveKey();
      await b.raw.hset(notesKey(), 'n2', tampered(await encrypt(JSON.stringify(RENT))));
      expect(await b.raw.hget(notesKey(), 'n2')).toStartWith('v2.k1-');
      expect((await notes.getAllReport(A)).unreadable).toEqual(['n2']);
      expect([...(await notes.getAllLenient(A)).keys()]).toEqual(['n1']);
    });
  });

  describe("evolving a store's shape", () => {
    type V1 = { name: string };
    type V2 = { name: string; color: string };
    const isV1 = (v: unknown): v is V1 => typeof v === 'object' && v !== null && typeof (v as V1).name === 'string';
    const isV2 = (v: unknown): v is V2 => isV1(v) && typeof (v as V2).color === 'string';
    const upgradeTag = (v: unknown) => (isV1(v) && !('color' in v) ? { ...v, color: 'gray' } : v);
    const names = ['seam-contract-tags', 'seam-contract-cats'];
    afterEach(() => names.forEach(forgetDeclaredStore));

    test('upgrade reads what an earlier version stored, and writes store the current shape', async () => {
      // The first release.
      const tags1 = defineMapStore<V1>('seam-contract-tags', { what: 'tags', isValid: isV1, exportable: true });
      const cats1 = defineValueStore<V1[]>('seam-contract-cats', { what: 'categories', isValid: (v): v is V1[] => Array.isArray(v) && v.every(isV1), exportable: true });
      await tags1.setMany(A, [
        ['t1', { name: 'a' }],
        ['t2', { name: 'b' }],
      ]);
      await cats1.set(A, [{ name: 'Food' }]);

      // The next requires a color, and fills one in for what came before it.
      const tags2 = defineMapStore<V2>('seam-contract-tags', { what: 'tags', isValid: isV2, exportable: true, upgrade: upgradeTag });
      const cats2 = defineValueStore<V2[]>('seam-contract-cats', {
        what: 'categories',
        isValid: (v): v is V2[] => Array.isArray(v) && v.every(isV2),
        exportable: true,
        upgrade: (v) => (Array.isArray(v) ? v.map(upgradeTag) : v),
      });
      expect([...(await tags2.getAll(A))]).toEqual([
        ['t1', { name: 'a', color: 'gray' }],
        ['t2', { name: 'b', color: 'gray' }],
      ]);
      expect(await cats2.get(A)).toEqual([{ name: 'Food', color: 'gray' }]);
      // An old value is saved over like any readable one...
      await cats2.set(A, [{ name: 'Food', color: 'red' }]);
      expect(await cats2.get(A)).toEqual([{ name: 'Food', color: 'red' }]);
      expect(await tags2.update(A, 't1', (cur) => ({ ...cur!, color: 'blue' }))).toEqual({ name: 'a', color: 'blue' });
      // ...and a write is always the current shape, even one upgrade would fix.
      await expect(tags2.set(A, 't3', { name: 'c' } as V2)).rejects.toBeInstanceOf(TypeError);
      // Neither shape is still damage.
      await b.raw.hset(ctxKey('seam-contract-tags'), 't9', await encrypt('{"other":1}'));
      expect((await tags2.getAllReport(A)).unreadable).toEqual(['t9']);
    });

    test('without an upgrade, a stricter isValid makes every older value damaged', async () => {
      const tags1 = defineMapStore<V1>('seam-contract-tags', { what: 'tags', isValid: isV1, exportable: true });
      await tags1.set(A, 't1', { name: 'a' });
      const tags2 = defineMapStore<V2>('seam-contract-tags', { what: 'tags', isValid: isV2, exportable: true });
      expect((await tags2.getAllReport(A)).unreadable).toEqual(['t1']);
    });

    test('an upgrade that throws is a bug, raised as it is, never blamed on the data', async () => {
      const tags1 = defineMapStore<V1>('seam-contract-tags', { what: 'tags', isValid: isV1, exportable: true });
      await tags1.set(A, 't1', { name: 'a' });
      const broken = defineMapStore<V1>('seam-contract-tags', {
        what: 'tags',
        isValid: isV1,
        exportable: true,
        upgrade: () => {
          throw new Error('a bug in upgrade');
        },
      });
      for (const run of [() => broken.getAll(A), () => broken.getAllLenient(A), () => broken.getAllReport(A), () => broken.set(A, 't2', { name: 'b' })]) {
        expect((await notBlamed(run)).message).toBe('a bug in upgrade');
      }
      expect(await tags1.get(A, 't1')).toEqual({ name: 'a' });
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
    const master = Buffer.alloc(32, 103).toString('base64');
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
    for (const read of [
      () => notes.getAll(A),
      () => notes.getAllLenient(A),
      () => notes.getAllReport(A),
      () => notes.get(A, 'n2'),
      () => notes.getMany(A, ['n1', 'n2']),
      () => list.get(A),
    ]) {
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
    await bigNotes.set(A, 'n1', NOTE);
    process.env.MASTER_KEY = Buffer.alloc(32, 104).toString('base64');
    forgetActiveKey();
    const report = await reencrypt({ dryRun: false, budgetMs: 60_000 });
    expect(report).toMatchObject({ walked_all: true, moved: 4, unclassified: [], unreadable_count: 0, complete: true });
    expect(fake.strings.get(listKey())).toStartWith(`v2.${report.active_key}.`);
    expect(await list.get(A)).toEqual([NOTE]);
    expect([...(await notes.getAll(A))]).toEqual([
      ['n1', NOTE],
      ['n2', RENT],
    ]);
    expect(await bigNotes.get(A, 'n1')).toEqual(NOTE);
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
    // Nothing outside a container but the key store, as on the double.
    const keys = (await send('KEYS', ['*'])) as string[];
    expect(keys.filter((key) => !key.startsWith('test:c:') && !key.startsWith('test:crypto:'))).toEqual([]);
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
      () => notes.getAllReport(A),
      () => notes.get(A, 'n1'),
      () => notes.getMany(A, ['n1']),
      () => notes.update(A, 'n1', () => NOTE),
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
    for (const read of [
      () => list.get(A),
      () => notes.getAll(A),
      () => notes.getAllLenient(A),
      () => notes.getAllReport(A),
      () => notes.get(A, 'n1'),
      () => notes.getMany(A, ['n1']),
      () => notes.update(A, 'n1', () => RENT),
      () => notes.count(A),
    ]) {
      const err = await read().catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(StoredDataUnreadableError);
    }
  });

  test('the adapter decodes every answer the seam reads exactly as the real Upstash client does', async () => {
    // The real client, over a requester that hands each command to the same
    // server and shapes the answer as the REST API does (HGETALL as a flat list).
    const r = real!.client;
    const viaRest = new Redis({
      request: async (req: { body?: unknown }) => {
        const [command, ...args] = req.body as unknown[];
        let result: unknown = await r.send(String(command).toUpperCase(), args.map(String));
        if (String(command).toLowerCase() === 'hgetall' && result && !Array.isArray(result)) result = Object.entries(result).flat();
        return { result };
      },
    } as never);
    const adapter = upstashOn(r);
    const values = ['', 'null', '""', '"x"', '12345', '1e5', '12345678901234567890', '0.1', '-0', ' 12', '007', 'true', '{"a":1}', '[1,2]',
      'v2.k1-34d15802.-.QUJD', 'A'.repeat(40), '9007199254740993', '1.0', 'NaN', 'Infinity'];
    for (const v of values) {
      await r.send('SET', ['k', v]);
      await r.send('DEL', ['h']);
      await r.send('HSET', ['h', 'f', v, 'g', 'x']);
      const ours = {
        get: await adapter.get('k'),
        hget: await adapter.hget('h', 'f'),
        hgetall: await adapter.hgetall('h'),
        read: await adapter.eval(READ_ENTRIES, ['h'], ['f', 'missing']),
      };
      const theirs = {
        get: await viaRest.get('k'),
        hget: await viaRest.hget('h', 'f'),
        hgetall: await viaRest.hgetall('h'),
        read: await viaRest.eval(READ_ENTRIES, ['h'], ['f', 'missing']),
      };
      expect([v, ours]).toEqual([v, theirs]);
    }
    await r.send('DEL', ['h']);
    expect(await adapter.hgetall('h')).toEqual(await viaRest.hgetall('h'));
    await r.send('DEL', ['k']);
  });
});

describe('the key inventory', () => {
  const c = `c:${TEST_CTX.container}:`;

  test('a declared store is in it by its declaration, inside a container only', () => {
    expect(classify(`${c}seam-contract-list`)).toBe('string');
    expect(classify(`${c}seam-contract-notes`)).toBe('hash');
    // The seam keeps nothing outside a container, so the same name outside one
    // was built wrongly, and is reported.
    expect(classify('seam-contract-notes')).toBeNull();
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

  test('the lists are unchanged, and no declared store is on them or left out of backups', () => {
    expect(classify(`${c}goals`)).toBe('string');
    expect(classify('goals')).toBe('string');
    expect(classify(`${c}manual:accounts`)).toBe('hash');
    expect(classify(`${c}cache:net-worth`)).toBe('cipher');
    expect(classify(`${c}txns:item-1`)).toBe('string');
    expect(classify(`${c}plaid:items`)).toBe('items');
    expect(classify(`${c}snapshot:runs`)).toBe('plain');
    for (const store of declaredStores()) {
      expect([store.name, listedKind(store.name), isExcluded(store.name)]).toEqual([store.name, null, false]);
      expect(classify(`${c}${store.name}`)).toBe(store.kind === 'value' ? 'string' : 'hash');
    }
  });

  test('a name that is not a plain key family, or that something else claims, is refused, and nothing is declared', () => {
    const refused: [string, string][] = [
      ['', 'lowercase words'],
      ['Rules', 'lowercase words'],
      ['my rules', 'lowercase words'],
      ['rules*', 'lowercase words'],
      ['rules:', 'lowercase words'],
      [':rules', 'lowercase words'],
      ['x'.repeat(65), 'lowercase words'],
      ['c:rules', 'a container'],
      ['owners', 'an environment-wide store'],
      ['containers', 'an environment-wide store'],
      ['crypto:rules', 'an environment-wide store'],
      ['ratelimit:x', 'an environment-wide store'],
      ['invites:x', 'an environment-wide store'],
      ['goals', 'a key family stored the old way'],
      ['history:accounts', 'a key family stored the old way'],
      ['txns:item-1', 'a key family stored the old way'],
      ['cache:rules', 'a key family stored the old way'],
      ['sessions:rules', 'a key family stored the old way'],
      ['account-links:lockout', 'a key that backups leave out'],
    ];
    for (const [name, why] of refused) {
      expect(() => defineMapStore(name, { what: 'test notes', isValid: isNote, exportable: false })).toThrow(why);
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
      ['seam-contract-big-list', 'value', 'test notes', true],
      ['seam-contract-big-notes', 'map', 'test notes', true],
      ['seam-contract-list', 'value', 'test notes', true],
      ['seam-contract-notes', 'map', 'test notes', false],
    ]);
    expect(declaredStore('seam-contract-notes')).toBe(notes);
    const names = declaredStores().map((s) => s.name);
    expect(names).toEqual([...names].sort());
  });

  // Read from the source, so a store whose module nothing has loaded yet is
  // still found: every source file but tests and dependencies.
  const root = join(import.meta.dir, '..');
  const rel = (path: string) => relative(root, path).replaceAll('\\', '/');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === 'node_modules' || name === 'test' || name.startsWith('.')) continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(?:[cm]?[jt]sx?)$/.test(name) && !name.endsWith('.d.ts')) files.push(path);
    }
  };
  walk(root);

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
  /** Renaming defineMapStore on import would hide its declarations from the scan. */
  const aliases = (src: string) => [...src.matchAll(/\bdefine(?:Value|Map)Store\s+as\b/g)].length;

  const sources = files.filter((f) => rel(f) !== 'lib/repo.ts').map((f) => ({ file: rel(f), src: code(f) }));
  const declarations = sources.flatMap(({ file, src }) => declarationsIn(src).map((name) => ({ file, name })));

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
    expect(aliases(`import { defineMapStore as declareMap } from './repo';`)).toBe(1);
    expect(aliases(sample)).toBe(0);
    expect(files.some((f) => rel(f) === 'proxy.ts')).toBe(true); // the walk reaches the root
  });

  test('every declaration spells out its name under its own name, and no two share one', () => {
    expect(
      sources.filter(({ src }) => aliases(src) > 0).map(({ file }) => file),
      'Import defineValueStore and defineMapStore under their own names, so the scan sees each store.'
    ).toEqual([]);
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
        rel(resolve(dirname(catalogue), m[2])).replace(/\.[cm]?[jt]sx?$/, '')
      )
    );
    expect(
      declaring.filter((f) => !imported.has(f.replace(/\.[cm]?[jt]sx?$/, ''))),
      'Add `import \'./<module>\';` to lib/stores.ts for each module listed, so the key inventory and the data download see its store.'
    ).toEqual([]);
  });
});
