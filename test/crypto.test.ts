import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock } from './fake-redis';

// Same k0 as every other test file, so the cached key agrees whichever file
// loads lib/crypto first.
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const {
  encrypt,
  encryptV2,
  decrypt,
  formatOf,
  importMasterKey,
  wrapDataKey,
  keysHashKey,
  UnknownKeyError,
  MalformedCiphertextError,
  DecryptFailedError,
  MasterKeyError,
} = await import('@/lib/crypto');

const MASTER = Buffer.alloc(32, 3).toString('base64');
const OTHER_MASTER = Buffer.alloc(32, 4).toString('base64');
const K1_RAW = new Uint8Array(32).fill(1);
const K2_RAW = new Uint8Array(32).fill(2);

/** Store a data key the way scripts/keys.ts does. */
async function storeKey(id: string, raw: Uint8Array, masterB64 = MASTER) {
  const m = await importMasterKey(masterB64);
  const stored = { created_at: '2026-01-01T00:00:00.000Z', wrapped: { [m.fingerprint]: await wrapDataKey(m, id, raw) } };
  await fake.hset(keysHashKey(), { [id]: JSON.stringify(stored) });
}

const savedMaster = process.env.MASTER_KEY;
beforeEach(async () => {
  fake.reset();
  process.env.MASTER_KEY = MASTER;
  await storeKey('k1', K1_RAW);
  await storeKey('k2', K2_RAW);
});
afterEach(() => {
  if (savedMaster === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = savedMaster;
});

describe('v1, the format every stored value is in today', () => {
  test('round-trips', async () => {
    expect(await decrypt(await encrypt('balance: 1234.56'))).toBe('balance: 1234.56');
  });

  test('encrypt still writes v1: no header, nothing that needs a data key', async () => {
    const out = await encrypt('x');
    expect(out).not.toContain('.');
    expect(formatOf(out)).toEqual({ version: 1, keyId: 'k0', flags: '-' });
  });

  test('a value written by the previous code still decrypts', async () => {
    // Built by hand exactly as the old encrypt() did: base64(iv + ciphertext),
    // no additional data. Pins that the reader never stops accepting it.
    const key = await crypto.subtle.importKey('raw', Buffer.alloc(32, 7), 'AES-GCM', false, ['encrypt']);
    const iv = new Uint8Array(12).fill(9);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('legacy'))
    );
    expect(await decrypt(Buffer.concat([iv, ct]).toString('base64'))).toBe('legacy');
  });

  test('needs neither MASTER_KEY nor Redis, so neither can break it', async () => {
    const v1 = await encrypt('safe');
    delete process.env.MASTER_KEY;
    fake.failNext('hget', 10);
    expect(await decrypt(v1)).toBe('safe');
  });

  test('an altered value is reported as altered', async () => {
    const v1 = await encrypt('x');
    const flipped = v1[20] === 'A' ? 'B' : 'A';
    await expect(decrypt(v1.slice(0, 20) + flipped + v1.slice(21))).rejects.toBeInstanceOf(DecryptFailedError);
  });
});

describe('v2 wire format, pinned', () => {
  // Fixed vectors: iv of twelve 5s, data key k1 of thirty-two 1s. Computed
  // independently of lib/crypto. If a refactor changes how the header or
  // context is bound, these stop decrypting, which is the point: every v2
  // value in production would stop decrypting the same way.
  test('an unbound value', async () => {
    expect(await decrypt('v2.k1.-.BQUFBQUFBQUFBQUFccuPWwfWumQwub/Ph+dbBK2GBDQ8GA==')).toBe('pinned');
  });

  test('a value bound to a context', async () => {
    expect(
      await decrypt('v2.k1.c.BQUFBQUFBQUFBQUFccuPWwfWE/AcbhC8ovyb/gWBZKR+UYK9DwGArot7eAiJW/E=', 'container-7')
    ).toBe('pinned with context');
  });

  test('the same construction built here at run time also decrypts', async () => {
    const key = await crypto.subtle.importKey('raw', K2_RAW, 'AES-GCM', false, ['encrypt']);
    const iv = new Uint8Array(12).fill(8);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('v2.k2.-') },
        key,
        new TextEncoder().encode('built by hand')
      )
    );
    expect(await decrypt(`v2.k2.-.${Buffer.concat([iv, ct]).toString('base64')}`)).toBe('built by hand');
  });
});

describe('v2', () => {
  test('round-trips under each key, including k0', async () => {
    for (const id of ['k0', 'k1', 'k2']) {
      const out = await encryptV2(`under ${id}`, id);
      expect(out.startsWith(`v2.${id}.-.`)).toBe(true);
      expect(formatOf(out)).toEqual({ version: 2, keyId: id, flags: '-' });
      expect(await decrypt(out)).toBe(`under ${id}`);
    }
  });

  test('a value cannot be opened by relabelling it to another key', async () => {
    const out = await encryptV2('secret', 'k1');
    await expect(decrypt(out.replace('v2.k1.', 'v2.k2.'))).rejects.toBeInstanceOf(DecryptFailedError);
  });

  test('the header is authenticated even when two keys hold the same bytes', async () => {
    await storeKey('k3', K1_RAW);
    const out = await encryptV2('secret', 'k1');
    await expect(decrypt(out.replace('v2.k1.', 'v2.k3.'))).rejects.toBeInstanceOf(DecryptFailedError);
  });

  test('flags are authenticated too: an unbound value cannot be relabelled as bound', async () => {
    const out = await encryptV2('secret', 'k1');
    await expect(decrypt(out.replace('v2.k1.-.', 'v2.k1.c.'), 'anything')).rejects.toBeInstanceOf(
      DecryptFailedError
    );
  });

  test('a v2 body cannot be read as v1', async () => {
    const out = await encryptV2('x', 'k0');
    await expect(decrypt(out.slice('v2.k0.-.'.length))).rejects.toBeInstanceOf(DecryptFailedError);
  });

  test('encryption is not deterministic in either format', async () => {
    // lib/hidden.ts and anything else comparing stored ciphertext rely on
    // this; a fixed IV would also be a serious weakness.
    expect(await encrypt('same')).not.toBe(await encrypt('same'));
    expect(await encryptV2('same', 'k1')).not.toBe(await encryptV2('same', 'k1'));
  });
});

describe('context binding', () => {
  test('a bound value needs its context', async () => {
    const out = await encryptV2('mine', 'k1', 'container-a');
    expect(formatOf(out).flags).toBe('c');
    expect(await decrypt(out, 'container-a')).toBe('mine');
    await expect(decrypt(out, 'container-b')).rejects.toBeInstanceOf(DecryptFailedError);
    const missing = await decrypt(out).catch((e) => e);
    expect(missing).toBeInstanceOf(DecryptFailedError);
    expect(missing.message).toContain('none was given');
  });

  test('an unbound value ignores a context, so callers can start passing one early', async () => {
    const out = await encryptV2('shared', 'k1');
    expect(await decrypt(out, 'container-a')).toBe('shared');
  });

  test('an empty context is still a context', async () => {
    const out = await encryptV2('x', 'k1', '');
    expect(await decrypt(out, '')).toBe('x');
    await expect(decrypt(out)).rejects.toBeInstanceOf(DecryptFailedError);
  });
});

describe('data keys fail one at a time', () => {
  test('a key that does not exist is named, and no other key is tried', async () => {
    const out = await encryptV2('secret', 'k2');
    await fake.hdel(keysHashKey(), 'k2');
    // A fresh id, so no key cached by an earlier test can answer.
    const err = await decrypt(out.replace('v2.k2.', 'v2.k9.')).catch((e) => e);
    expect(err).toBeInstanceOf(UnknownKeyError);
    expect(err.keyId).toBe('k9');
  });

  test('a damaged key breaks only its own values', async () => {
    const good = await encryptV2('fine', 'k1');
    await fake.hset(keysHashKey(), { k4: 'not json' });
    const payloadK4 = good.replace('v2.k1.', 'v2.k4.');

    await expect(decrypt(payloadK4)).rejects.toBeInstanceOf(MasterKeyError);
    expect(await decrypt(good)).toBe('fine');
  });

  test('a key not wrapped for this master breaks only its own values', async () => {
    await storeKey('k5', K2_RAW, OTHER_MASTER);
    const good = await encryptV2('fine', 'k1');
    const err = await decrypt(good.replace('v2.k1.', 'v2.k5.')).catch((e) => e);
    expect(err).toBeInstanceOf(MasterKeyError);
    expect(err.message).toContain('not wrapped for master key');
    expect(await decrypt(good)).toBe('fine');
  });

  test('a missing MASTER_KEY breaks data keys only, never v1 or k0', async () => {
    const v1 = await encrypt('a');
    const v2k0 = await encryptV2('b', 'k0');
    const v2k1 = await encryptV2('c', 'k1');
    delete process.env.MASTER_KEY;

    expect(await decrypt(v1)).toBe('a');
    expect(await decrypt(v2k0)).toBe('b');
    await expect(decrypt(v2k1)).rejects.toBeInstanceOf(MasterKeyError);
  });

  test('a Redis failure loading a key is retried, not remembered', async () => {
    await storeKey('k6', K1_RAW);
    // Built by hand, so k6 is not already loaded into memory by encrypting.
    const key = await crypto.subtle.importKey('raw', K1_RAW, 'AES-GCM', false, ['encrypt']);
    const iv = new Uint8Array(12).fill(6);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('v2.k6.-') },
        key,
        new TextEncoder().encode('x')
      )
    );
    const out = `v2.k6.-.${Buffer.concat([iv, ct]).toString('base64')}`;
    fake.failNext('hget');

    await expect(decrypt(out)).rejects.toThrow();
    expect(await decrypt(out)).toBe('x');
  });

  test('a data key is fetched once, then served from memory', async () => {
    await storeKey('k7', K2_RAW);
    const out = await encryptV2('x', 'k7');
    const before = fake.ops;
    await decrypt(out);
    await decrypt(out);
    expect(fake.ops).toBe(before);
  });

  test('a wrapped key cannot be moved to another id', async () => {
    const stored = await fake.hget<string>(keysHashKey(), 'k1');
    await fake.hset(keysHashKey(), { k8: stored! });
    const out = (await encryptV2('x', 'k1')).replace('v2.k1.', 'v2.k8.');
    await expect(decrypt(out)).rejects.toBeInstanceOf(MasterKeyError);
  });
});

describe('malformed values fail loudly and specifically', () => {
  test('a newer format is named as such, not mistaken for damaged v1', async () => {
    const err = await decrypt('v3.k1.-.' + Buffer.alloc(40).toString('base64')).catch((e) => e);
    expect(err).toBeInstanceOf(MalformedCiphertextError);
    expect(err.message).toContain('Unsupported encryption format "v3"');
  });

  const body28 = Buffer.alloc(28).toString('base64');
  const body27 = Buffer.alloc(27).toString('base64');
  for (const [name, payload, pattern] of [
    ['too few parts', 'v2.k1.AAAA', /four parts/],
    ['too many parts', `v2.k1.-.x.${body28}`, /four parts/],
    ['an empty key id', `v2..-.${body28}`, /invalid key id/],
    ['a key id with a leading zero', `v2.k01.-.${body28}`, /invalid key id/],
    ['a doubled zero', `v2.k00.-.${body28}`, /invalid key id/],
    ['an unanchored key id', `v2.xk1.-.${body28}`, /invalid key id/],
    ['empty flags', `v2.k1..${body28}`, /invalid flags/],
    ['an unknown flag', `v2.k1.z.${body28}`, /unknown flag "z"/],
    ['a body that is not base64', 'v2.k1.-.!!!!', /base64/],
    ['a body one byte too short for an IV and tag', `v2.k1.-.${body27}`, /too short/],
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
    await expect(encryptV2('x', 'k01')).rejects.toThrow(/Invalid key id/);
  });
});

describe('the legacy key', () => {
  test('a missing PLAID_ENCRYPTION_KEY is not remembered once it is set again', async () => {
    const saved = process.env.PLAID_ENCRYPTION_KEY;
    // Only reachable if nothing has imported k0 yet in this process, which a
    // shared test run cannot promise; so check the error path in a child.
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
