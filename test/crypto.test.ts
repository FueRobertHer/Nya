import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { FakeRedis, storageMock } from './fake-redis';

// Same k0 as every other test file, so the cached key agrees whichever file
// loads lib/crypto first.
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Deserializing, like Upstash's default client: stored data keys come back as
// parsed objects, which is the path production takes.
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const {
  encrypt,
  encryptV2,
  decrypt,
  formatOf,
  importMasterKey,
  masterFingerprint,
  keyCommitment,
  dataKeyId,
  unwrapDataKey,
  keysHashKey,
  UnknownKeyError,
  MalformedCiphertextError,
  DecryptFailedError,
  MasterKeyError,
  RotationError,
  prepareMasterRotation,
  finishMasterRotation,
  rotationStatus,
  rotationPending,
  rotationKey,
  autoFinishSettled,
  ROTATION_GRACE_MS,
  forgetActiveKey,
  activeKeyName,
  activeKeyStatus,
  currentMasterKeyName,
} = await import('@/lib/crypto');

const MASTER = Buffer.alloc(32, 3).toString('base64');
const OTHER_MASTER = Buffer.alloc(32, 4).toString('base64');
const K1_RAW = new Uint8Array(32).fill(1);
const K2_RAW = new Uint8Array(32).fill(2);
const K1 = 'k1-012df8cb'; // pinned below; computed independently

/** Store a data key as the app does, returning its id. */
async function storeKey(n: number, raw: Uint8Array, masterB64 = MASTER, id?: string): Promise<string> {
  const m = await importMasterKey(masterB64);
  const keyId = id ?? (await dataKeyId(n, raw));
  const stored = { created_at: '2026-01-01T00:00:00.000Z', wrapped: { [m.fingerprint]: await m.wrap(keyId, raw) } };
  await fake.hset(keysHashKey(), { [keyId]: JSON.stringify(stored) });
  return keyId;
}

/** A v2 value built by hand with WebCrypto, so no key is loaded into memory
 *  by encrypting it first. */
async function handBuilt(keyId: string, raw: Uint8Array, text: string, fill = 6): Promise<string> {
  const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt']);
  const iv = new Uint8Array(12).fill(fill);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`v2.${keyId}.-`) },
      key,
      new TextEncoder().encode(text)
    )
  );
  return `v2.${keyId}.-.${Buffer.concat([iv, ct]).toString('base64')}`;
}

let K2 = '';
const savedMaster = process.env.MASTER_KEY;
beforeEach(async () => {
  fake.reset();
  forgetActiveKey();
  process.env.MASTER_KEY = MASTER;
  await storeKey(1, K1_RAW);
  K2 = await storeKey(2, K2_RAW);
});
afterEach(() => {
  if (savedMaster === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = savedMaster;
});

describe('v1, the format every stored value is in today', () => {
  test('round-trips', async () => {
    expect(await decrypt(await encrypt('balance: 1234.56'))).toBe('balance: 1234.56');
  });

  test('without a master, encrypt writes v1: no header, nothing that needs a data key', async () => {
    delete process.env.MASTER_KEY;
    const out = await encrypt('x');
    expect(out).not.toContain('.');
    expect(formatOf(out)).toEqual({ version: 1, keyId: 'k0', flags: '-' });
  });

  test('a value written by the previous code still decrypts', async () => {
    const key = await crypto.subtle.importKey('raw', Buffer.alloc(32, 7), 'AES-GCM', false, ['encrypt']);
    const iv = new Uint8Array(12).fill(9);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('legacy'))
    );
    expect(await decrypt(Buffer.concat([iv, ct]).toString('base64'))).toBe('legacy');
  });

  test('needs neither MASTER_KEY nor Redis, so neither can break it', async () => {
    delete process.env.MASTER_KEY;
    const v1 = await encrypt('safe');
    delete process.env.MASTER_KEY;
    fake.failNext('hget', 10);
    fake.failNext('hset', 10);
    expect(await decrypt(v1)).toBe('safe');
  });

  test('an altered value is reported as altered', async () => {
    const v1 = await encrypt('x');
    const flipped = v1[20] === 'A' ? 'B' : 'A';
    await expect(decrypt(v1.slice(0, 20) + flipped + v1.slice(21))).rejects.toBeInstanceOf(DecryptFailedError);
  });
});

describe('stored layout, pinned', () => {
  // All computed independently of lib/crypto. Each is part of what is stored:
  // the id names the key in every value, the fingerprint keys every wrapping,
  // and the vectors are values as they will sit in production. If a refactor
  // changes any of them, existing data stops decrypting.
  test('a data key id commits to its key', async () => {
    expect(await keyCommitment(K1_RAW)).toBe('012df8cb');
    expect(await dataKeyId(1, K1_RAW)).toBe(K1);
  });

  test('a master fingerprint', async () => {
    expect(await masterFingerprint(new Uint8Array(32).fill(3))).toBe('b55ea684e4a937e8');
  });

  test('an unbound value', async () => {
    expect(await decrypt(`v2.${K1}.-.BQUFBQUFBQUFBQUFccuPWwfWPFtc1JlbKA3XOpURREpGdg==`)).toBe('pinned');
  });

  test('a value bound to a context', async () => {
    expect(
      await decrypt(`v2.${K1}.c.BQUFBQUFBQUFBQUFccuPWwfWE/AcbhC8ovyb/gWBZGUhSQHz2IrPp8wOOLrO6Z8=`, 'container-7')
    ).toBe('pinned with context');
  });
});

describe('v2', () => {
  test('round-trips under k0 and under data keys', async () => {
    for (const id of ['k0', K1, K2]) {
      const out = await encryptV2(`under ${id}`, id);
      expect(out.startsWith(`v2.${id}.-.`)).toBe(true);
      expect(formatOf(out)).toEqual({ version: 2, keyId: id, flags: '-' });
      expect(await decrypt(out)).toBe(`under ${id}`);
    }
  });

  test('a value cannot be opened by relabelling it to another key', async () => {
    const out = await encryptV2('secret', K1);
    await expect(decrypt(out.replace(`v2.${K1}.`, `v2.${K2}.`))).rejects.toBeInstanceOf(DecryptFailedError);
  });

  test('flags are authenticated: an unbound value cannot be relabelled as bound', async () => {
    const out = await encryptV2('secret', K1);
    await expect(decrypt(out.replace(`v2.${K1}.-.`, `v2.${K1}.c.`), 'anything')).rejects.toBeInstanceOf(
      DecryptFailedError
    );
  });

  test('a v2 body cannot be read as v1', async () => {
    const out = await encryptV2('x', 'k0');
    await expect(decrypt(out.slice('v2.k0.-.'.length))).rejects.toBeInstanceOf(DecryptFailedError);
  });

  test('encryption is not deterministic in either format', async () => {
    expect(await encrypt('same')).not.toBe(await encrypt('same'));
    expect(await encryptV2('same', K1)).not.toBe(await encryptV2('same', K1));
  });
});

describe('context binding', () => {
  test('a bound value needs its context', async () => {
    const out = await encryptV2('mine', K1, 'container-a');
    expect(formatOf(out).flags).toBe('c');
    expect(await decrypt(out, 'container-a')).toBe('mine');
    await expect(decrypt(out, 'container-b')).rejects.toBeInstanceOf(DecryptFailedError);
    const missing = await decrypt(out).catch((e) => e);
    expect(missing).toBeInstanceOf(DecryptFailedError);
    expect(missing.message).toContain('none was given');
  });

  test('an unbound value ignores a context, so callers can start passing one early', async () => {
    const out = await encryptV2('shared', K1);
    expect(await decrypt(out, 'container-a')).toBe('shared');
  });

  test('an empty context is still a context', async () => {
    const out = await encryptV2('x', K1, '');
    expect(await decrypt(out, '')).toBe('x');
    await expect(decrypt(out)).rejects.toBeInstanceOf(DecryptFailedError);
  });

  test('a context that cannot be encoded exactly is refused', async () => {
    // Two different lone surrogates both encode to U+FFFD, so they would bind
    // identically; refusing them keeps one context to one binding.
    await expect(encryptV2('x', K1, 'a\uD800')).rejects.toThrow(/unpaired surrogate/);
    const out = await encryptV2('x', K1, 'a');
    await expect(decrypt(out, 'a\uDC00')).rejects.toThrow(/unpaired surrogate/);
  });
});

describe('data keys', () => {
  test('a key that does not exist is named, and no other key is tried', async () => {
    const out = await encryptV2('secret', K2);
    const missing = 'k9-00000000';
    const err = await decrypt(out.replace(`v2.${K2}.`, `v2.${missing}.`)).catch((e) => e);
    expect(err).toBeInstanceOf(UnknownKeyError);
    expect(err.keyId).toBe(missing);
  });

  test('a stored key that is not the key its id names is refused', async () => {
    // What a reused id would look like: same number, different key. With the
    // commitment in the id this can only arise from tampering or a bug, and it
    // is caught when the key is loaded rather than used.
    const liar = 'k3-012df8cb'; // K1's commitment
    await storeKey(3, K2_RAW, MASTER, liar);
    const err = await decrypt(await handBuilt(liar, K2_RAW, 'x')).catch((e) => e);
    expect(err).toBeInstanceOf(MasterKeyError);
    expect(err.message).toContain('not the key its id names');
  });

  test('a damaged key breaks only its own values', async () => {
    const good = await encryptV2('fine', K1);
    const broken = await dataKeyId(4, K2_RAW);
    await fake.hset(keysHashKey(), { [broken]: 'not json' });

    await expect(decrypt(await handBuilt(broken, K2_RAW, 'x'))).rejects.toBeInstanceOf(MasterKeyError);
    expect(await decrypt(good)).toBe('fine');
  });

  test('a key not wrapped for this master breaks only its own values', async () => {
    const other = await storeKey(5, new Uint8Array(32).fill(5), OTHER_MASTER);
    const good = await encryptV2('fine', K1);
    const err = await decrypt(await handBuilt(other, new Uint8Array(32).fill(5), 'x')).catch((e) => e);
    expect(err).toBeInstanceOf(MasterKeyError);
    expect(err.message).toContain('not wrapped for master key');
    expect(await decrypt(good)).toBe('fine');
  });

  test('a wrapped key of the wrong length is refused', async () => {
    const m = await importMasterKey(MASTER);
    const id = 'k6-00000000';
    const stored = { created_at: 'x', wrapped: { [m.fingerprint]: await m.wrap(id, new Uint8Array(16).fill(1)) } };
    await expect(unwrapDataKey(m, id, stored)).rejects.toThrow(/not 32 bytes/);
  });

  test('a missing MASTER_KEY breaks data keys only, never v1 or k0', async () => {
    delete process.env.MASTER_KEY;
    const v1 = await encrypt('a');
    process.env.MASTER_KEY = MASTER;
    const v2k0 = await encryptV2('b', 'k0');
    const v2k1 = await encryptV2('c', K1);
    delete process.env.MASTER_KEY;

    expect(await decrypt(v1)).toBe('a');
    expect(await decrypt(v2k0)).toBe('b');
    await expect(decrypt(v2k1)).rejects.toBeInstanceOf(MasterKeyError);
  });

  test('a Redis failure loading a key is retried, not remembered', async () => {
    const raw = new Uint8Array(32).fill(7);
    const id = await storeKey(7, raw);
    const out = await handBuilt(id, raw, 'x');
    fake.failNext('hget');

    await expect(decrypt(out)).rejects.toThrow();
    expect(await decrypt(out)).toBe('x');
  });

  test('concurrent first uses share one load, and later uses none', async () => {
    const raw = new Uint8Array(32).fill(8);
    const id = await storeKey(8, raw);
    const out = await handBuilt(id, raw, 'x');
    let hgets = 0;
    const realHget = fake.hget.bind(fake);
    fake.hget = (async (key: string, field: string) => {
      hgets++;
      return realHget(key, field);
    }) as typeof fake.hget;
    try {
      await Promise.all(Array.from({ length: 10 }, () => decrypt(out)));
      await decrypt(out);
      expect(hgets).toBe(1);
    } finally {
      fake.hget = realHget as typeof fake.hget;
    }
  });

  test('a wrapping cannot be moved to another id', async () => {
    const raw = await fake.hget<object>(keysHashKey(), K1);
    const moved = 'k10-012df8cb';
    await fake.hset(keysHashKey(), { [moved]: JSON.stringify(raw) });
    await expect(decrypt(await handBuilt(moved, K1_RAW, 'x'))).rejects.toBeInstanceOf(MasterKeyError);
  });
});

describe('master rotation', () => {
  // Distinct masters per test, so data keys cached in memory under one master
  // cannot answer for another.
  const master = (n: number) => Buffer.alloc(32, n).toString('base64');
  const fpOf = async (b64: string) => (await importMasterKey(b64)).fingerprint;
  const T0 = Date.parse('2026-09-24T00:00:00.000Z');
  const AFTER_GRACE = T0 + ROTATION_GRACE_MS + 1;

  /** Checked against the store itself, never through decrypt(), which keeps
   *  opened keys in memory. */
  async function opens(b64: string, id: string): Promise<boolean> {
    const stored = await fake.hget<any>(keysHashKey(), id);
    return unwrapDataKey(await importMasterKey(b64), id, stored).then(
      () => true,
      () => false
    );
  }
  const stored = async (id: string) => (await fake.hget<any>(keysHashKey(), id))!;
  const snapshot = async () => JSON.stringify([await fake.hgetall(keysHashKey()), await fake.get(rotationKey())]);

  describe('prepare', () => {
    test('adds the new lock, keeps the current one, and records the rotation last', async () => {
      const NEW = master(21);
      const { prepared, fingerprint } = await prepareMasterRotation(NEW, T0);

      expect(prepared).toBe(2);
      expect(fingerprint).toBe(await fpOf(NEW));
      for (const id of [K1, K2]) {
        expect(await opens(MASTER, id)).toBe(true);
        expect(await opens(NEW, id)).toBe(true);
        expect(Object.keys((await stored(id)).wrapped)).toHaveLength(2);
      }
      expect(await rotationPending()).toBe(true);
      expect(await rotationStatus(T0)).toMatchObject({ state: 'prepared', next: fingerprint });
    });

    test('keeps every other field of a stored key', async () => {
      const s = await stored(K1);
      await fake.hset(keysHashKey(), { [K1]: JSON.stringify({ ...s, note: 'kept' }) });
      await prepareMasterRotation(master(22), T0);
      expect((await stored(K1)).note).toBe('kept');
      expect((await stored(K1)).created_at).toBe('2026-01-01T00:00:00.000Z');
    });

    test('interrupted, it leaves no record, every key openable, and runs again cleanly', async () => {
      const NEW = master(23);
      // Fails on the second key's write, after the first key was prepared.
      const realHset = fake.hset.bind(fake);
      let n = 0;
      fake.hset = (async (key: string, fields: Record<string, string>) => {
        if (++n === 2) throw new Error('upstash hiccup');
        return realHset(key, fields);
      }) as typeof fake.hset;
      try {
        await expect(prepareMasterRotation(NEW, T0)).rejects.toThrow('upstash hiccup');
      } finally {
        fake.hset = realHset as typeof fake.hset;
      }
      expect(await rotationPending()).toBe(false);
      expect(await opens(MASTER, K1)).toBe(true);
      expect(await opens(MASTER, K2)).toBe(true);

      await prepareMasterRotation(NEW, T0);
      expect(await opens(NEW, K1)).toBe(true);
      expect(await opens(NEW, K2)).toBe(true);
      expect(await rotationPending()).toBe(true);
    });

    test('a new rotation replaces an unfinished one, dropping the abandoned key', async () => {
      // The mistyped-or-unsaved key case: prepare A, then prepare B instead.
      const A = master(24);
      const B = master(25);
      await prepareMasterRotation(A, T0);
      await prepareMasterRotation(B, T0);

      for (const id of [K1, K2]) {
        expect(await opens(MASTER, id)).toBe(true);
        expect(await opens(B, id)).toBe(true);
        expect(await opens(A, id)).toBe(false);
        expect((await stored(id)).next).toBe(await fpOf(B));
      }
      expect(await rotationStatus(T0)).toMatchObject({ state: 'prepared', next: await fpOf(B) });
    });

    test('refuses the same key, writing nothing', async () => {
      const before = await snapshot();
      await expect(prepareMasterRotation(MASTER, T0)).rejects.toBeInstanceOf(RotationError);
      expect(await snapshot()).toBe(before);
    });

    test('refuses a malformed new key, writing nothing, and never echoes it', async () => {
      const before = await snapshot();
      for (const bad of ['not base64!', Buffer.alloc(16).toString('base64'), '']) {
        const err = await prepareMasterRotation(bad, T0).catch((e) => e);
        expect(err).toBeInstanceOf(RotationError);
        if (bad) expect(err.message).not.toContain(bad);
      }
      expect(await snapshot()).toBe(before);
    });

    test('refuses when the running master cannot open every key, writing nothing', async () => {
      await storeKey(26, new Uint8Array(32).fill(26), OTHER_MASTER);
      const before = await snapshot();
      await expect(prepareMasterRotation(master(27), T0)).rejects.toThrow(/running master cannot open/);
      expect(await snapshot()).toBe(before);
    });

    test('a lock that silently fails to save is caught by reading back, and no record is written', async () => {
      const realHset = fake.hset.bind(fake);
      fake.hset = (async () => undefined) as typeof fake.hset;
      try {
        await expect(prepareMasterRotation(master(28), T0)).rejects.toBeInstanceOf(MasterKeyError);
      } finally {
        fake.hset = realHset as typeof fake.hset;
      }
      expect(await rotationPending()).toBe(false);
    });

    test('the read-back also checks the current master still opens every key', async () => {
      // A write that lands the new lock but loses the current one.
      const realHset = fake.hset.bind(fake);
      fake.hset = (async (key: string, fields: Record<string, string>) => {
        const [[id, v]] = Object.entries(fields);
        const parsed = JSON.parse(v);
        const cur = await fpOf(MASTER);
        delete parsed.wrapped[cur];
        return realHset(key, { [id]: JSON.stringify(parsed) });
      }) as typeof fake.hset;
      try {
        await expect(prepareMasterRotation(master(29), T0)).rejects.toBeInstanceOf(MasterKeyError);
      } finally {
        fake.hset = realHset as typeof fake.hset;
      }
      expect(await rotationPending()).toBe(false);
    });

    test('only one rotation step runs at a time', async () => {
      await fake.set(`test:crypto:rotation-lock`, 'someone else', { nx: true, px: 60000 });
      await expect(prepareMasterRotation(master(30), T0)).rejects.toThrow(/Another rotation step is running/);
      await fake.del('test:crypto:rotation-lock');
      await prepareMasterRotation(master(30), T0);
      expect(await fake.get('test:crypto:rotation-lock')).toBeNull();
    });

    test('with no data keys yet it records the rotation and nothing else', async () => {
      fake.reset();
      expect(await prepareMasterRotation(master(31), T0)).toEqual({ prepared: 0, fingerprint: await fpOf(master(31)) });
    });
  });

  describe('finish', () => {
    test('does nothing on the old deployment', async () => {
      const NEW = master(32);
      await prepareMasterRotation(NEW, T0);
      expect(await finishMasterRotation({ now: AFTER_GRACE, force: true })).toMatchObject({ state: 'prepared' });
      expect(await opens(MASTER, K1)).toBe(true);
    });

    test('waits out the 24-hour rollback window on the new deployment', async () => {
      const NEW = master(33);
      await prepareMasterRotation(NEW, T0);
      process.env.MASTER_KEY = NEW;

      expect(await finishMasterRotation({ now: T0 + 60 * 60 * 1000 })).toMatchObject({ state: 'grace' });
      expect(await opens(MASTER, K1)).toBe(true); // rollback still works
    });

    test('after the window it removes the old locks and the record; the data is untouched', async () => {
      const NEW = master(34);
      const value = await encryptV2('balance 100', K1);
      await prepareMasterRotation(NEW, T0);
      process.env.MASTER_KEY = NEW;

      expect(await finishMasterRotation({ now: AFTER_GRACE })).toEqual({ state: 'finished', finished: 2 });
      for (const id of [K1, K2]) {
        expect(await opens(MASTER, id)).toBe(false);
        expect(await opens(NEW, id)).toBe(true);
        expect((await stored(id)).next).toBeUndefined();
        expect((await stored(id)).created_at).toBe('2026-01-01T00:00:00.000Z');
      }
      expect(await rotationPending()).toBe(false);
      expect(await decrypt(value)).toBe('balance 100');
    });

    test('keeps every other field of a stored key', async () => {
      const NEW = master(46);
      await prepareMasterRotation(NEW, T0);
      const s = await stored(K1);
      await fake.hset(keysHashKey(), { [K1]: JSON.stringify({ ...s, note: 'kept' }) });
      process.env.MASTER_KEY = NEW;
      await finishMasterRotation({ now: AFTER_GRACE });
      expect((await stored(K1)).note).toBe('kept');
    });

    test('finish_now skips the window', async () => {
      const NEW = master(35);
      await prepareMasterRotation(NEW, T0);
      process.env.MASTER_KEY = NEW;
      expect(await finishMasterRotation({ now: T0 + 1000, force: true })).toEqual({ state: 'finished', finished: 2 });
    });

    test('all or nothing: one unprepared key and no lock is removed anywhere', async () => {
      const NEW = master(36);
      await prepareMasterRotation(NEW, T0);
      // A key created after the prepare (what 7b must not do): old lock only.
      const late = await storeKey(37, new Uint8Array(32).fill(37));
      process.env.MASTER_KEY = NEW;
      const before = await snapshot();

      await expect(finishMasterRotation({ now: AFTER_GRACE })).rejects.toThrow(/was not prepared for this master/);
      expect(await snapshot()).toBe(before);
      expect(await opens(MASTER, K1)).toBe(true);
      expect(await opens(MASTER, late)).toBe(true);
    });

    test('all or nothing: a key whose new lock does not open stops it before any write', async () => {
      const NEW = master(38);
      await prepareMasterRotation(NEW, T0);
      const s = await stored(K2);
      const fp = await fpOf(NEW);
      s.wrapped[fp] = s.wrapped[await fpOf(MASTER)]; // a lock that is not NEW's
      await fake.hset(keysHashKey(), { [K2]: JSON.stringify(s) });
      process.env.MASTER_KEY = NEW;
      const before = await snapshot();

      await expect(finishMasterRotation({ now: AFTER_GRACE })).rejects.toBeInstanceOf(MasterKeyError);
      expect(await snapshot()).toBe(before);
    });

    test('a partial prepare followed by the redeploy removes nothing', async () => {
      // The reviewed failure: prepare dies after one key, the owner redeploys
      // anyway. With no record, finish must leave every lock in place.
      const NEW = master(39);
      const realHset = fake.hset.bind(fake);
      let n = 0;
      fake.hset = (async (key: string, fields: Record<string, string>) => {
        if (++n === 2) throw new Error('killed');
        return realHset(key, fields);
      }) as typeof fake.hset;
      await prepareMasterRotation(NEW, T0).catch(() => {});
      fake.hset = realHset as typeof fake.hset;
      process.env.MASTER_KEY = NEW;

      expect(await finishMasterRotation({ now: AFTER_GRACE, force: true })).toEqual({ state: 'none' });
      expect(await opens(MASTER, K1)).toBe(true);
      expect(await opens(MASTER, K2)).toBe(true);
    });

    test('without a master it does nothing at all', async () => {
      await prepareMasterRotation(master(40), T0);
      delete process.env.MASTER_KEY;
      const before = fake.ops;
      expect(await finishMasterRotation({ now: AFTER_GRACE, force: true })).toEqual({ state: 'none' });
      expect(fake.ops).toBe(before);
    });

    test('the key store only accepts key ids', async () => {
      await fake.hset(keysHashKey(), { active: 'x' });
      await expect(prepareMasterRotation(master(41), T0)).rejects.toThrow(/Unexpected entry "active"/);
    });
  });

  describe('automatic finish', () => {
    test('happens on first use of a data key once the window has passed', async () => {
      const NEW = master(42);
      await prepareMasterRotation(NEW, Date.now() - ROTATION_GRACE_MS - 1000);
      process.env.MASTER_KEY = NEW;

      const raw = new Uint8Array(32).fill(42);
      const id = await storeKey(42, raw, NEW);
      // storeKey's fresh key has no "next"; mark it as prepared like the rest.
      const s = await stored(id);
      await fake.hset(keysHashKey(), { [id]: JSON.stringify({ ...s, next: await fpOf(NEW) }) });

      expect(await decrypt(await handBuilt(id, raw, 'x'))).toBe('x');
      await autoFinishSettled();
      expect(await opens(MASTER, K1)).toBe(false);
      expect(await opens(NEW, K1)).toBe(true);
    });

    test('is throttled, logs failures, and tries again later', async () => {
      const NEW = master(43);
      await prepareMasterRotation(NEW, Date.now() - ROTATION_GRACE_MS - 1000);
      process.env.MASTER_KEY = NEW;
      const late = await storeKey(44, new Uint8Array(32).fill(44)); // blocks finishing
      const raw = new Uint8Array(32).fill(45);
      const id = await storeKey(45, raw, NEW);

      const errors: unknown[] = [];
      const origError = console.error;
      console.error = (...a: unknown[]) => errors.push(a.join(' '));
      try {
        const value = await handBuilt(id, raw, 'x');
        await decrypt(value);
        await autoFinishSettled();
        const ops = fake.ops;
        for (let i = 0; i < 20; i++) await decrypt(value);
        await autoFinishSettled();
        expect(fake.ops).toBe(ops); // throttled: no repeated attempts
        expect(errors.join('\n')).toContain('was not prepared for this master');
      } finally {
        console.error = origError;
      }
      expect(await opens(MASTER, late)).toBe(true);
    });
  });
});

describe('7b: writes go to the active data key', () => {
  const activeId = async () => (await fake.get<string>(activeKeyName())) as string;
  const keyIds = async () => Object.keys((await fake.hgetall(keysHashKey())) ?? {}).sort();
  const opens = async (b64: string, id: string) =>
    unwrapDataKey(await importMasterKey(b64), id, (await fake.hget<any>(keysHashKey(), id))!).then(
      () => true,
      () => false
    );

  beforeEach(() => {
    // Start from no data keys, as production does before the first write.
    fake.reset();
    forgetActiveKey();
  });

  test('the first write with a master creates k1, makes it active, and uses it', async () => {
    const out = await encrypt('balance 100');
    const id = await activeId();

    expect(id).toMatch(/^k1-[0-9a-f]{8}$/);
    expect(await keyIds()).toEqual([id]);
    expect(formatOf(out)).toEqual({ version: 2, keyId: id, flags: '-' });
    expect(await decrypt(out)).toBe('balance 100');
  });

  test('later writes reuse it; no second key appears', async () => {
    await encrypt('a');
    forgetActiveKey(); // even after the process forgets, the stored pointer wins
    await encrypt('b');
    expect(await keyIds()).toHaveLength(1);
  });

  test('concurrent first writes in one process create one key, once', async () => {
    const realHset = fake.hset.bind(fake);
    let keyWrites = 0;
    fake.hset = (async (key: string, fields: Record<string, string>) => {
      if (key === keysHashKey()) keyWrites++;
      return realHset(key, fields);
    }) as typeof fake.hset;
    let outs: string[];
    try {
      outs = await Promise.all(Array.from({ length: 8 }, (_, i) => encrypt(`v${i}`)));
    } finally {
      fake.hset = realHset as typeof fake.hset;
    }
    const id = await activeId();
    expect(keyWrites).toBe(1);
    expect(await keyIds()).toEqual([id]);
    for (const [i, out] of outs.entries()) {
      expect(formatOf(out).keyId).toBe(id);
      expect(await decrypt(out)).toBe(`v${i}`);
    }
  });

  test('the first key is created under the rotation lock; while it is held, writes use k0', async () => {
    await fake.set('test:crypto:rotation-lock', 'someone else');
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => logged.push(a.join(' '));
    try {
      expect(formatOf(await encrypt('x')).keyId).toBe('k0');
    } finally {
      console.error = orig;
    }
    expect(await keyIds()).toEqual([]);
    expect(logged).toEqual([]); // expected and brief, not a fault

    await fake.del('test:crypto:rotation-lock');
    expect(formatOf(await encrypt('y')).version).toBe(2);
  });

  test('a rotation cannot be prepared while the first key is being created', async () => {
    const realHset = fake.hset.bind(fake);
    let refused: unknown = null;
    fake.hset = (async (key: string, fields: Record<string, string>) => {
      await realHset(key, fields);
      refused ??= await prepareMasterRotation(Buffer.alloc(32, 75).toString('base64')).catch((e) => e);
    }) as typeof fake.hset;
    try {
      await encrypt('x');
    } finally {
      fake.hset = realHset as typeof fake.hset;
    }
    expect(refused).toBeInstanceOf(RotationError);
    expect(await rotationPending()).toBe(false);
  });

  test('a key is never claimed if a rotation appears before the claim', async () => {
    // As if the lock had expired under a very slow step and a rotation was
    // prepared meanwhile, seeing no keys.
    const realHset = fake.hset.bind(fake);
    fake.hset = (async (key: string, fields: Record<string, string>) => {
      await realHset(key, fields);
      await fake.set(rotationKey(), JSON.stringify({ from: 'a', next: 'b', prepared_at: new Date().toISOString() }));
    }) as typeof fake.hset;
    let out: string;
    try {
      out = await encrypt('x');
    } finally {
      fake.hset = realHset as typeof fake.hset;
    }
    expect(formatOf(out).keyId).toBe('k0');
    expect(await keyIds()).toEqual([]);
    expect(await activeId()).toBeNull();
  });

  test('if the active key is set by something else mid-create, that one is used and ours removed', async () => {
    const theirs = await storeKey(7, new Uint8Array(32).fill(98));
    const realHset = fake.hset.bind(fake);
    fake.hset = (async (key: string, fields: Record<string, string>) => {
      await realHset(key, fields);
      if (!Object.keys(fields).includes(theirs)) await fake.set(activeKeyName(), theirs);
    }) as typeof fake.hset;
    let out: string;
    try {
      out = await encrypt('x');
    } finally {
      fake.hset = realHset as typeof fake.hset;
    }
    expect(formatOf(out).keyId).toBe(theirs);
    expect(await keyIds()).toEqual([theirs]);
  });

  test('an existing active key is used as is', async () => {
    const id = await storeKey(5, new Uint8Array(32).fill(96));
    await fake.set(activeKeyName(), id);
    expect(formatOf(await encrypt('x')).keyId).toBe(id);
    expect(await keyIds()).toEqual([id]);
  });

  test('while a master rotation is pending and no key exists, writes stay on k0', async () => {
    await prepareMasterRotation(Buffer.alloc(32, 71).toString('base64'));
    const out = await encrypt('x');
    expect(formatOf(out).keyId).toBe('k0');
    expect(await keyIds()).toEqual([]);
    expect(await activeId()).toBeNull();
  });

  test('a pending rotation does not stop an existing active key being used', async () => {
    await encrypt('first');
    const id = await activeId();
    await prepareMasterRotation(Buffer.alloc(32, 72).toString('base64'));
    forgetActiveKey();
    expect(formatOf(await encrypt('x')).keyId).toBe(id);
  });

  test('values written under the data key survive a full master rotation', async () => {
    const out = await encrypt('balance 100');
    const NEW = Buffer.alloc(32, 73).toString('base64');
    await prepareMasterRotation(NEW, Date.now() - ROTATION_GRACE_MS - 1000);
    process.env.MASTER_KEY = NEW;
    expect(await finishMasterRotation({ now: Date.now() })).toEqual({ state: 'finished', finished: 1 });
    forgetActiveKey();
    const id = formatOf(out).keyId;
    expect(await opens(MASTER, id)).toBe(false); // the old lock is gone
    expect(await opens(NEW, id)).toBe(true);

    expect(await decrypt(out)).toBe('balance 100');
    // And new writes still use the same data key, now under the new master.
    expect(formatOf(await encrypt('y')).keyId).toBe(formatOf(out).keyId);
  });

  test('the first key records which master is current', async () => {
    await encrypt('x');
    expect(await fake.get<unknown>(currentMasterKeyName())).toEqual({ fingerprint: (await importMasterKey(MASTER)).fingerprint });
  });

  test('a deployment on an old master never creates a key after a rotation finished', async () => {
    // Rotated before any data key existed, so nothing else marks the change.
    const NEW = Buffer.alloc(32, 76).toString('base64');
    await prepareMasterRotation(NEW, Date.now() - ROTATION_GRACE_MS - 1000);
    process.env.MASTER_KEY = NEW;
    await finishMasterRotation({ now: Date.now() });
    expect(await rotationPending()).toBe(false);

    // An instance still holding the old master (warm, or an instant rollback).
    process.env.MASTER_KEY = MASTER;
    forgetActiveKey();
    const orig = console.error;
    const logged: string[] = [];
    console.error = (...a: unknown[]) => logged.push(a.join(' '));
    try {
      expect(formatOf(await encrypt('x')).keyId).toBe('k0');
    } finally {
      console.error = orig;
    }
    expect(await keyIds()).toEqual([]);
    expect(logged.join(' ')).toContain('is not the current one');

    // The current master creates it as usual.
    process.env.MASTER_KEY = NEW;
    forgetActiveKey();
    const out = await encrypt('y');
    expect(formatOf(out).version).toBe(2);
    expect(await opens(NEW, formatOf(out).keyId)).toBe(true);
  });

  test('a deployment on an old master cannot prepare a rotation', async () => {
    await fake.set(currentMasterKeyName(), JSON.stringify({ fingerprint: (await importMasterKey(OTHER_MASTER)).fingerprint }));
    const err = await prepareMasterRotation(Buffer.alloc(32, 77).toString('base64')).catch((e) => e);
    expect(err).toBeInstanceOf(RotationError);
    expect(err.message).toContain('is not the current one');
    expect(await rotationPending()).toBe(false);
  });

  describe('the active key is re-checked at most a minute later', () => {
    afterEach(() => {
      setSystemTime();
    });

    test('a key that has gone from the store stops being written', async () => {
      const t0 = Date.now();
      setSystemTime(t0);
      const first = await encrypt('x');
      const id = formatOf(first).keyId;
      // A restore replaces the key store with one that has no such key.
      await fake.hdel(keysHashKey(), id);

      setSystemTime(t0 + 30 * 1000);
      expect(formatOf(await encrypt('y')).keyId).toBe(id); // still within the minute

      setSystemTime(t0 + 61 * 1000);
      const orig = console.error;
      console.error = () => {};
      try {
        expect(formatOf(await encrypt('z')).keyId).toBe('k0');
      } finally {
        console.error = orig;
      }
    });

    test('a changed active key is picked up', async () => {
      const t0 = Date.now();
      setSystemTime(t0);
      await encrypt('x');
      const next = await storeKey(8, new Uint8Array(32).fill(99));
      await fake.set(activeKeyName(), next);

      setSystemTime(t0 + 61 * 1000);
      expect(formatOf(await encrypt('y')).keyId).toBe(next);
    });

    test('an ongoing fallback is logged again every hour', async () => {
      await fake.set(activeKeyName(), 'nonsense');
      const t0 = Date.now();
      const logged: string[] = [];
      const orig = console.error;
      console.error = (...a: unknown[]) => logged.push(a.join(' '));
      try {
        setSystemTime(t0);
        await encrypt('a');
        setSystemTime(t0 + 30 * 60 * 1000);
        await encrypt('b');
        setSystemTime(t0 + 61 * 60 * 1000);
        await encrypt('c');
      } finally {
        console.error = orig;
      }
      expect(logged).toHaveLength(2);
      expect(logged[1]).toContain(`since ${new Date(t0).toISOString()}`);
    });
  });

  describe('status', () => {
    test('reports no active key before the first write', async () => {
      expect(await activeKeyStatus()).toEqual({ active_key: null });
    });

    test('reports a usable active key', async () => {
      await encrypt('x');
      expect(await activeKeyStatus()).toEqual({ active_key: await activeId() });
    });

    test('names a record that is not a data key id as a problem, k0 included', async () => {
      for (const bad of ['k0', 'nonsense']) {
        await fake.set(activeKeyName(), bad);
        const st = await activeKeyStatus();
        expect(st.active_key).toBeNull();
        expect(st.active_key_problem).toContain('not a data key id');
      }
    });

    test('names an active key this master cannot open, or that is missing', async () => {
      const id = await storeKey(6, new Uint8Array(32).fill(97), OTHER_MASTER);
      await fake.set(activeKeyName(), id);
      expect(await activeKeyStatus()).toMatchObject({ active_key: id, active_key_problem: expect.stringContaining('not wrapped for master') });

      await fake.hdel(keysHashKey(), id);
      expect((await activeKeyStatus()).active_key_problem).toContain(id);
    });

    test('says when this instance has been falling back, and stops once it recovers', async () => {
      await fake.set(activeKeyName(), 'nonsense');
      const orig = console.error;
      console.error = () => {};
      try {
        await encrypt('x');
      } finally {
        console.error = orig;
      }
      expect((await activeKeyStatus()).this_instance_fallback_since).toBeString();

      await fake.del(activeKeyName());
      await encrypt('y'); // creates a key and writes v2 again
      expect((await activeKeyStatus()).this_instance_fallback_since).toBeUndefined();
    });
  });

  test('without a master nothing is created and nothing is logged', async () => {
    delete process.env.MASTER_KEY;
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => logged.push(a.join(' '));
    try {
      expect(formatOf(await encrypt('x')).keyId).toBe('k0');
    } finally {
      console.error = orig;
    }
    expect(logged).toEqual([]);
    expect(await keyIds()).toEqual([]);
  });

  test('a new key is numbered after the keys that exist', async () => {
    await storeKey(5, new Uint8Array(32).fill(95));
    await encrypt('x');
    expect(await activeId()).toMatch(/^k6-/);
  });

  test('a key that does not read back intact is never made active', async () => {
    const realHset = fake.hset.bind(fake);
    fake.hset = (async () => undefined) as typeof fake.hset; // the write is lost
    const orig = console.error;
    console.error = () => {};
    try {
      expect(formatOf(await encrypt('x')).keyId).toBe('k0');
    } finally {
      fake.hset = realHset as typeof fake.hset;
      console.error = orig;
    }
    expect(await activeId()).toBeNull();
  });

  test('the legacy key is never taken as the active data key', async () => {
    await fake.set(activeKeyName(), 'k0');
    const orig = console.error;
    console.error = () => {};
    try {
      expect(formatOf(await encrypt('x')).version).toBe(1);
    } finally {
      console.error = orig;
    }
  });

  test('a cached active key is re-read when the master changes', async () => {
    const A = MASTER;
    const B = Buffer.alloc(32, 74).toString('base64');
    const id1 = await storeKey(1, new Uint8Array(32).fill(81), A);
    await fake.set(activeKeyName(), id1);
    expect(formatOf(await encrypt('x')).keyId).toBe(id1); // cached under A

    const id2 = await storeKey(2, new Uint8Array(32).fill(82), B);
    await fake.set(activeKeyName(), id2);
    process.env.MASTER_KEY = B;
    expect(formatOf(await encrypt('y')).keyId).toBe(id2);
  });

  describe('falls back to k0 rather than failing a write', () => {
    const quiet = async <T>(fn: () => Promise<T>) => {
      const logged: string[] = [];
      const orig = console.error;
      console.error = (...a: unknown[]) => logged.push(a.join(' '));
      try {
        return { result: await fn(), logged };
      } finally {
        console.error = orig;
      }
    };

    test('when Redis fails, and it retries next time', async () => {
      fake.failNext('get');
      const { result, logged } = await quiet(() => encrypt('x'));
      expect(formatOf(result).keyId).toBe('k0');
      expect(await decrypt(result)).toBe('x');
      expect(logged.join(' ')).toContain('Writing with the legacy key');

      expect(formatOf(await encrypt('y')).version).toBe(2);
    });

    test('when the active record is not a key id', async () => {
      await fake.set(activeKeyName(), 'nonsense');
      const { result } = await quiet(() => encrypt('x'));
      expect(formatOf(result).keyId).toBe('k0');
    });

    test('when the active key cannot be opened with this master', async () => {
      const id = await storeKey(6, new Uint8Array(32).fill(97), OTHER_MASTER);
      await fake.set(activeKeyName(), id);
      const { result } = await quiet(() => encrypt('x'));
      expect(formatOf(result).keyId).toBe('k0');
      expect(await decrypt(result)).toBe('x');
    });

    test('logs once, not on every write', async () => {
      await fake.set(activeKeyName(), 'nonsense');
      const { logged } = await quiet(async () => {
        for (let i = 0; i < 5; i++) await encrypt('x');
      });
      expect(logged).toHaveLength(1);
    });
  });
});

describe('malformed values fail loudly and specifically', () => {
  test('a newer format is named as such, not mistaken for damaged v1', async () => {
    const err = await decrypt('v3.k1.-.' + Buffer.alloc(40).toString('base64')).catch((e) => e);
    expect(err).toBeInstanceOf(MalformedCiphertextError);
    expect(err.message).toContain('Unsupported encryption format "v3"');
  });

  test('anything that is not a version tag is never quoted back', async () => {
    // A mis-stored plaintext would otherwise land in the logs.
    const err = await decrypt('secret@example.com').catch((e) => e);
    expect(err).toBeInstanceOf(MalformedCiphertextError);
    expect(err.message).not.toContain('secret');
  });

  const body28 = Buffer.alloc(28).toString('base64');
  const body27 = Buffer.alloc(27).toString('base64');
  for (const [name, payload, pattern] of [
    ['too few parts', `v2.${K1}.AAAA`, /four parts/],
    ['too many parts', `v2.${K1}.-.x.${body28}`, /four parts/],
    ['an empty key id', `v2..-.${body28}`, /invalid key id/],
    ['a data key id without its commitment', `v2.k1.-.${body28}`, /invalid key id/],
    ['a key id with a leading zero', `v2.k01-012df8cb.-.${body28}`, /invalid key id/],
    ['k0 with a commitment', `v2.k0-012df8cb.-.${body28}`, /invalid key id/],
    ['a commitment in capitals', `v2.k1-012DF8CB.-.${body28}`, /invalid key id/],
    ['an unanchored key id', `v2.x${K1}.-.${body28}`, /invalid key id/],
    ['empty flags', `v2.${K1}..${body28}`, /invalid flags/],
    ['an unknown flag', `v2.${K1}.z.${body28}`, /unknown flag "z"/],
    ['a repeated flag', `v2.${K1}.cc.${body28}`, /out of order or repeated/],
    ['a body that is not base64', `v2.${K1}.-.!!!!`, /base64/],
    ['a body one byte too short for an IV and tag', `v2.${K1}.-.${body27}`, /too short/],
    ['v1 that is not base64', '@@@@', /base64/],
    ['v1 one byte too short', body27, /too short/],
  ] as const) {
    test(name, async () => {
      const err = await decrypt(payload).catch((e) => e);
      expect(err).toBeInstanceOf(MalformedCiphertextError);
      expect(err.message).toMatch(pattern);
    });
  }

  test('an invalid key id is refused when encrypting too', async () => {
    await expect(encryptV2('x', 'k1')).rejects.toThrow(/Invalid key id/);
  });
});

describe('the legacy key', () => {
  test('a missing PLAID_ENCRYPTION_KEY is not remembered once it is set again', async () => {
    const saved = process.env.PLAID_ENCRYPTION_KEY;
    const res = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `delete process.env.PLAID_ENCRYPTION_KEY;
         const c = await import('./lib/crypto.ts');
         let first = 'none';
         try { await c.encrypt('x'); } catch (e) { first = e.message; }
         process.env.PLAID_ENCRYPTION_KEY = ${JSON.stringify(saved)};
         const out = await c.decrypt(await c.encrypt('back'));
         console.log(first.includes('is not set') && out === 'back' ? 'ok' : 'bad:' + first);`,
      ],
      { cwd: `${import.meta.dir}/..`, env: { ...process.env, REDIS_PREFIX: 'test' } }
    );
    expect(res.stdout.toString().trim()).toBe('ok');
  });
});
