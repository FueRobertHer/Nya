import { describe, expect, test, beforeEach, afterEach } from 'bun:test';

// Same k0 as every other test file, so the cached key agrees whichever file
// loads lib/crypto first.
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const {
  encrypt,
  encryptV2,
  decrypt,
  keyIdOf,
  UnknownKeyError,
  MalformedCiphertextError,
  DecryptFailedError,
} = await import('@/lib/crypto');

const K1 = Buffer.alloc(32, 1).toString('base64');
const K2 = Buffer.alloc(32, 2).toString('base64');

const saved = process.env.ENCRYPTION_KEYS;
beforeEach(() => {
  process.env.ENCRYPTION_KEYS = `k1:${K1},k2:${K2}`;
});
afterEach(() => {
  if (saved === undefined) delete process.env.ENCRYPTION_KEYS;
  else process.env.ENCRYPTION_KEYS = saved;
});

describe('v1, the format every stored value is in today', () => {
  test('round-trips', async () => {
    expect(await decrypt(await encrypt('balance: 1234.56'))).toBe('balance: 1234.56');
  });

  test('encrypt still writes v1: no header, nothing that needs a new key', async () => {
    const out = await encrypt('x');
    expect(out).not.toContain('.');
    expect(keyIdOf(out)).toBe('k0');
  });

  test('a value written by the previous code still decrypts', async () => {
    // Built by hand exactly as the old encrypt() did: base64(iv + ciphertext),
    // no additional data. Pins that the reader never stops accepting it.
    const key = await crypto.subtle.importKey(
      'raw',
      Buffer.alloc(32, 7),
      'AES-GCM',
      false,
      ['encrypt']
    );
    const iv = new Uint8Array(12).fill(9);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('legacy')));
    const payload = Buffer.concat([iv, ct]).toString('base64');

    expect(await decrypt(payload)).toBe('legacy');
  });

  test('does not depend on ENCRYPTION_KEYS, so a typo there cannot break it', async () => {
    const v1 = await encrypt('safe');
    process.env.ENCRYPTION_KEYS = 'this is not a keyring';
    expect(await decrypt(v1)).toBe('safe');
  });

  test('a damaged value is reported as damaged', async () => {
    const v1 = await encrypt('x');
    const flipped = (v1[20] === 'A' ? 'B' : 'A');
    await expect(decrypt(v1.slice(0, 20) + flipped + v1.slice(21))).rejects.toBeInstanceOf(DecryptFailedError);
  });
});

describe('v2', () => {
  test('round-trips under each configured key', async () => {
    for (const id of ['k0', 'k1', 'k2']) {
      const out = await encryptV2(`under ${id}`, id);
      expect(out.startsWith(`v2.${id}.`)).toBe(true);
      expect(keyIdOf(out)).toBe(id);
      expect(await decrypt(out)).toBe(`under ${id}`);
    }
  });

  test('each key really is different: a value cannot be opened by relabelling it', async () => {
    const out = await encryptV2('secret', 'k1');
    const relabelled = out.replace('v2.k1.', 'v2.k2.');
    await expect(decrypt(relabelled)).rejects.toBeInstanceOf(DecryptFailedError);
  });

  test('the header is authenticated even when both keys are the same bytes', async () => {
    // Same key material under two ids: only the additional data can tell them
    // apart, so this fails only if the header is really bound in.
    process.env.ENCRYPTION_KEYS = `k1:${K1},k3:${K1}`;
    const out = await encryptV2('secret', 'k1');
    await expect(decrypt(out.replace('v2.k1.', 'v2.k3.'))).rejects.toBeInstanceOf(DecryptFailedError);
  });

  test('a key the deployment does not have is named, and no other key is tried', async () => {
    const out = await encryptV2('secret', 'k2');
    process.env.ENCRYPTION_KEYS = `k1:${K1}`;

    const err = await decrypt(out).catch((e) => e);
    expect(err).toBeInstanceOf(UnknownKeyError);
    expect(err.keyId).toBe('k2');
  });

  test('a v2 value cannot be read as v1, and never reaches the v1 path', async () => {
    const out = await encryptV2('x', 'k0');
    // k0 wrote it, but with the header as additional data; opening the body
    // without it must fail rather than decode.
    await expect(decrypt(out.slice('v2.k0.'.length))).rejects.toBeInstanceOf(DecryptFailedError);
  });

  test('encryption is not deterministic in either format', async () => {
    // lib/hidden.ts and anything else that compares stored ciphertext rely on
    // this staying true; a fixed IV would also be a serious weakness.
    expect(await encrypt('same')).not.toBe(await encrypt('same'));
    expect(await encryptV2('same', 'k1')).not.toBe(await encryptV2('same', 'k1'));
  });
});

describe('malformed values fail loudly and specifically', () => {
  test('a newer format is named as such, not mistaken for damaged v1', async () => {
    // What a rolled-back deployment would see if a future format had been
    // written. The message has to say so, or the cause is a mystery.
    const err = await decrypt('v3.k1.' + Buffer.alloc(40).toString('base64')).catch((e) => e);
    expect(err).toBeInstanceOf(MalformedCiphertextError);
    expect(err.message).toContain('Unsupported encryption format "v3"');
  });

  for (const [name, payload] of [
    ['an unknown version', 'v9.k1.AAAA'],
    ['a version with no key id', 'v2.'],
    ['a v2 value with no body separator', 'v2.k1'],
    ['an invalid key id', 'v2.key-one.AAAA'],
    ['a body that is not base64', 'v2.k1.!!!!'],
    ['a body too short to hold an IV and tag', 'v2.k1.AAAA'],
    ['v1 that is not base64', '@@@@'],
  ] as const) {
    test(name, async () => {
      await expect(decrypt(payload)).rejects.toBeInstanceOf(MalformedCiphertextError);
    });
  }
});

describe('ENCRYPTION_KEYS is validated', () => {
  for (const [name, value, pattern] of [
    ['an entry with no id', K1, /valid key id/],
    ['a bad id', `key1:${K1}`, /valid key id/],
    ['redefining k0', `k0:${K1}`, /may not define k0/],
    ['a duplicate id', `k1:${K1},k1:${K2}`, /twice/],
    ['a key of the wrong length', `k1:${Buffer.alloc(16).toString('base64')}`, /32 bytes/],
    ['a key that is not base64', 'k1:not base64!', /base64/],
  ] as const) {
    test(name, async () => {
      process.env.ENCRYPTION_KEYS = value;
      await expect(encryptV2('x', 'k1')).rejects.toThrow(pattern);
    });
  }

  test('spaces around entries and an empty trailing entry are tolerated', async () => {
    process.env.ENCRYPTION_KEYS = ` k1:${K1} , `;
    expect(await decrypt(await encryptV2('x', 'k1'))).toBe('x');
  });

  test('an unset ENCRYPTION_KEYS still reads k0 values in both formats', async () => {
    delete process.env.ENCRYPTION_KEYS;
    expect(await decrypt(await encrypt('a'))).toBe('a');
    expect(await decrypt(await encryptV2('b', 'k0'))).toBe('b');
    await expect(encryptV2('c', 'k1')).rejects.toBeInstanceOf(UnknownKeyError);
  });
});
