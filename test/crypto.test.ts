import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
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
  attestMasterKey,
  keysHashKey,
  mastersSeenKey,
  UnknownKeyError,
  MalformedCiphertextError,
  DecryptFailedError,
  MasterKeyError,
} = await import('@/lib/crypto');

const MASTER = Buffer.alloc(32, 3).toString('base64');
const OTHER_MASTER = Buffer.alloc(32, 4).toString('base64');
const K1_RAW = new Uint8Array(32).fill(1);
const K2_RAW = new Uint8Array(32).fill(2);
const K1 = 'k1-012df8cb'; // pinned below; computed independently

/** Store a data key the way scripts/keys.ts does, returning its id. */
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

  test('encrypt still writes v1: no header, nothing that needs a data key', async () => {
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
    const v1 = await encrypt('a');
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

describe('deployments report their master', () => {
  test('using a data key records this master', async () => {
    const raw = new Uint8Array(32).fill(11);
    const id = await storeKey(11, raw);
    await fake.hdel(mastersSeenKey(), (await importMasterKey(MASTER)).fingerprint);
    // Far in the future, so the throttle from earlier tests does not apply.
    await attestMasterKey(Date.now() + 10 * 60 * 60 * 1000);
    const seen = await fake.hgetall<Record<string, string>>(mastersSeenKey());
    expect(Object.keys(seen ?? {})).toEqual([(await importMasterKey(MASTER)).fingerprint]);
    expect(await decrypt(await handBuilt(id, raw, 'x'))).toBe('x');
  });

  test('is throttled, and never throws', async () => {
    const later = Date.now() + 20 * 60 * 60 * 1000;
    await attestMasterKey(later);
    const before = fake.ops;
    await attestMasterKey(later + 1000);
    expect(fake.ops).toBe(before);

    fake.failNext('hset');
    await expect(attestMasterKey(later + 10 * 60 * 1000)).resolves.toBeUndefined();
  });

  test('does nothing without a master', async () => {
    delete process.env.MASTER_KEY;
    const before = fake.ops;
    await attestMasterKey(Date.now() + 30 * 60 * 60 * 1000);
    expect(fake.ops).toBe(before);
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
