import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { createHash, scryptSync } from 'node:crypto';
import { chacha20, chacha20Block, poly1305, seal, open } from '@/lib/age/chacha20poly1305';
import { scrypt } from '@/lib/age/scrypt';
import {
  AgeError,
  CHUNK_SIZE,
  WORK_FACTOR,
  base64,
  unbase64,
  READ_SIZE,
  blobSource,
  bytesSource,
  decryptWithPassphrase,
  encryptedSize,
  openWithFileKey,
  openWithPassphrase,
  parseHeader,
  type AgeFailure,
  type AgeSource,
} from '@/lib/age/age';
import { protectFile, nativeScrypt } from '@/lib/protected-download';

// The protected download's format (lib/age/age.ts) and its primitives, held
// to: the RFCs' own test vectors (RFC 8439 for ChaCha20-Poly1305, RFC 7914
// for scrypt); answers worked out by other implementations (Node's OpenSSL
// cipher, Python's cryptography); the age project's test vectors, in
// test/fixtures/age (from github.com/C2SP/CCTV, age/testdata, which its
// license lets anyone copy without attribution); and the age command itself,
// where it is installed.

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fromHex = (s: string) => new Uint8Array(Buffer.from(s.replace(/[\s:]/g, ''), 'hex'));
const enc = (s: string) => new TextEncoder().encode(s);
const sha256 = (...parts: Uint8Array[]) => createHash('sha256').update(Buffer.concat(parts)).digest('hex');

/** A deterministic byte source (a linear congruential generator), the same
 *  one the reference answers below were made with. */
function bytesFrom(seed: { n: number }, count: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    seed.n = (Math.imul(seed.n, 1103515245) + 12345) >>> 0;
    out[i] = seed.n >>> 24;
  }
  return out;
}

/** What failed, or 'opened'. */
async function why(p: Promise<unknown>): Promise<AgeFailure | 'opened'> {
  try {
    await p;
    return 'opened';
  } catch (err) {
    if (err instanceof AgeError) return err.kind;
    throw err;
  }
}

describe('ChaCha20-Poly1305 (RFC 8439)', () => {
  const key = Uint8Array.from({ length: 32 }, (_, i) => i);
  const sunscreen = enc("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");

  test('the block function (2.3.2)', () => {
    expect(hex(chacha20Block(key, 1, fromHex('000000090000004a00000000')))).toBe(
      '10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4ed2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e'
    );
  });

  test('encryption (2.4.2), and the same call decrypts', () => {
    const nonce = fromHex('000000000000004a00000000');
    const ct = chacha20(key, nonce, 1, sunscreen);
    expect(hex(ct)).toBe(
      '6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0bf91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d807ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab77937365af90bbf74a35be6b40b8eedf2785e42874d'
    );
    expect(chacha20(key, nonce, 1, ct)).toEqual(sunscreen);
  });

  test('Poly1305 (2.5.2, and A.3 vectors 1, 2 and 5 to 9)', () => {
    expect(hex(poly1305(fromHex('85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b'), enc('Cryptographic Forum Research Group')))).toBe(
      'a8061dc1305136c6c22b8baf0c0127a9'
    );
    const zeros = (n: number) => new Uint8Array(n);
    expect(hex(poly1305(zeros(32), zeros(64)))).toBe('00000000000000000000000000000000');
    const ietf = enc(
      'Any submission to the IETF intended by the Contributor for publication as all or part of an IETF Internet-Draft or RFC and any statement made within the context of an IETF activity is considered an "IETF Contribution". Such statements include oral statements in IETF sessions, as well as written and electronic communications made at any time or place, which are addressed to'
    );
    expect(hex(poly1305(fromHex('0000000000000000000000000000000036e5f6b5c5e06070f0efca96227a863e'), ietf))).toBe('36e5f6b5c5e06070f0efca96227a863e');
    const R = (first: string) => fromHex(first.padEnd(32, '0'));
    const key2 = (r: Uint8Array, s: Uint8Array) => new Uint8Array([...r, ...s]);
    const ff = (n: number) => new Uint8Array(n).fill(0xff);
    // The edge cases: a carry out of the top, h exactly p, h past p.
    expect(hex(poly1305(key2(R('02'), zeros(16)), ff(16)))).toBe('03000000000000000000000000000000');
    expect(hex(poly1305(key2(R('02'), ff(16)), R('02')))).toBe('03000000000000000000000000000000');
    expect(hex(poly1305(key2(R('01'), zeros(16)), fromHex('ffffffffffffffffffffffffffffffff' + 'f0ffffffffffffffffffffffffffffff' + '11000000000000000000000000000000')))).toBe(
      '05000000000000000000000000000000'
    );
    expect(hex(poly1305(key2(R('01'), zeros(16)), fromHex('ffffffffffffffffffffffffffffffff' + 'fbfefefefefefefefefefefefefefefe' + '01010101010101010101010101010101')))).toBe(
      '00000000000000000000000000000000'
    );
    expect(hex(poly1305(key2(R('02'), zeros(16)), fromHex('fdffffffffffffffffffffffffffffff')))).toBe('faffffffffffffffffffffffffffffff');
  });

  // Worked out with Python's cryptography (OpenSSL's Poly1305): keys and
  // messages of all ones, which carry at every limb, and arbitrary ones.
  test('Poly1305 agrees with OpenSSL where every limb carries', () => {
    const cases: [key: string, message: string, tag: string][] = [
      ['ff'.repeat(32), 'ff'.repeat(16), 'fbffff17faffff17faffff17faffff17'],
      ['ff'.repeat(32), 'ff'.repeat(17), '7cfe7ff768f81f2763f8bf565df85f86'],
      ['ff'.repeat(32), 'ff'.repeat(64), '900fe32bc15fa8d7bca8efe4c7e37eb1'],
      ['0f'.repeat(16) + 'ff'.repeat(16), 'dff59c84135c5487374fe421969f0b362bd15cba7754937763ef5a500155947b55', '556c6bc147115595abf7bf80e7600ba6'],
      [
        '35ffa7f08686124a7d5904c0c87fe3eee917337c47dd4d99958ac11633237845',
        'ff0800000000ff00ffffffff00ff00b900bf00ff000083ffa5ffffffba00000000d7ff00000000ff89ff002900ff00ff000000ba000000007d00b00000ff00ff9fff001500009800001200009eff00ff00ffffff0000258200ff000000ff0000ffffff00c00032ffff17ff00ffac0042ff00ffd5',
        '240af24327f01a1336aca41c17c1a8c6',
      ],
      [
        '9195390f104b0344daee21eff65a5d8ab82d235ec9bc405e5d2a85a91cdf3fe8',
        'ff003900ffff3dff0000ffffffffff0075ffffff0000ff0000ffffff0012ff0090ff00ff003d2bff00ffffffc800ffff0047ff00ffff2e02a700ffaf0800ffaa2300ff00ffa82e00ffe6ff00ff00004d50000000',
        'c14542948b0f1cfe916e34b3d42fff63',
      ],
    ];
    for (const [key, message, tag] of cases) expect([message.length, hex(poly1305(fromHex(key), fromHex(message)))]).toEqual([message.length, tag]);
  });

  test('the AEAD (2.8.2), with associated data; a changed byte opens nothing', () => {
    const k = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
    const nonce = fromHex('070000004041424344454647');
    const aad = fromHex('50515253c0c1c2c3c4c5c6c7');
    const sealed = seal(k, nonce, sunscreen, aad);
    expect(hex(sealed)).toBe(
      'd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116' +
        '1ae10b594f09e26a7e902ecbd0600691'
    );
    expect(open(k, nonce, sealed, aad)).toEqual(sunscreen);
    for (const at of [0, 60, sealed.length - 1]) {
      const changed = sealed.slice();
      changed[at] ^= 1;
      expect(open(k, nonce, changed, aad)).toBeNull();
    }
    expect(open(k, nonce, sealed)).toBeNull();
    expect(open(k, nonce, sealed.subarray(0, 15))).toBeNull();
  });

  // Worked out with Node's ChaCha20-Poly1305 (OpenSSL's) on the same
  // generated keys, nonces and texts, drawn in order from one generator: the
  // SHA-256 of each sealed message.
  test('agrees with OpenSSL at every length around a block and a chunk', () => {
    const answers: [length: number, sha256: string][] = [
      [0, 'b8e685c835e9e516f330bf9fc48b71ddfddad2fec8613f33227941cdea9ea89a'],
      [1, '4d5179dd86cc324a1496404475328c986df514193ed617417855076b0c4f542b'],
      [15, 'd6a59072e0aa5abea4dec0fe907a47922eb40622ddf3b3cf63e461ac4a13cf18'],
      [16, 'be91025a51bdd4d79ba59d059cd3500a3df8aabae0909eb3b0639f9522f3cc2d'],
      [17, '563e82764c873810c5042f05a41981b7f33ca1856d32d23baac8447100b8e555'],
      [63, '2da3f06e6ff0e6cbd5e3191c9bc25e745f93dec8772e772d0cda935726801381'],
      [64, '29fb2ce556b1159ce0f9353d14e1a02277df59d2c261a43e3feb23c77ba16485'],
      [65, '371cff1693c9f8a8456fdc9694d90dc6d15a67908d50aa0d93da777032fb136c'],
      [255, 'b10dade7c5f3fe8f1a82dd4c4596df78bf4442abc76a8973fd01ede21173b538'],
      [1000, 'e640f60df2cbd46589220692678fd095f973b9a06b020e855414c730c9327e83'],
      [65536, '005b55eb94f2d678d180d10ee649d8917b277ec1c9a0ac72328b338aaf5c84b3'],
      [65537, 'a0c912223c7cd231161e4e4444ba3fa6c39e427003803371566fe1508dd14378'],
    ];
    const seed = { n: 1 };
    for (const [length, answer] of answers) {
      const key = bytesFrom(seed, 32);
      const nonce = bytesFrom(seed, 12);
      const text = bytesFrom(seed, length);
      const sealed = seal(key, nonce, text);
      expect([length, sha256(sealed)]).toEqual([length, answer]);
      expect(open(key, nonce, sealed)).toEqual(text);
    }
  });
});

describe('scrypt (RFC 7914)', () => {
  test('the RFC’s test vectors (section 12), but the one that needs 1 GB', async () => {
    expect(hex(await scrypt(enc(''), enc(''), 16, 1, 1, 64))).toBe(
      '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906'
    );
    expect(hex(await scrypt(enc('password'), enc('NaCl'), 1024, 8, 16, 64))).toBe(
      'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640'
    );
    expect(hex(await scrypt(enc('pleaseletmein'), enc('SodiumChloride'), 16384, 8, 1, 64))).toBe(
      '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887'
    );
  });

  test('the browser’s scrypt and the server’s give the same key, as age labels its salt', async () => {
    const salt = new Uint8Array([...enc('age-encryption.org/v1/scrypt'), ...Uint8Array.from({ length: 16 }, (_, i) => i * 9)]);
    const pass = enc('a passphrase with ünïcode');
    const js = await scrypt(pass, salt, 2 ** 12, 8, 1, 32);
    expect(hex(js)).toBe(scryptSync(pass, salt, 32, { N: 2 ** 12, r: 8, p: 1 }).toString('hex'));
    expect(hex(await nativeScrypt(pass, salt, 2 ** 12, 8, 1, 32))).toBe(hex(js));
  });

  test('says how far it has got, ending at all of it', async () => {
    const seen: number[] = [];
    await scrypt(enc('x'), enc('y'), 2 ** 14, 8, 1, 32, (done) => seen.push(done));
    expect(seen.at(-1)).toBe(1);
    expect(seen.every((d, i) => d >= 0 && d <= 1 && (i === 0 || d >= seen[i - 1]))).toBe(true);
  });

  test('refuses settings it can’t honour', async () => {
    for (const [N, r, p] of [[3, 8, 1], [1, 8, 1], [2 ** 25, 8, 1], [16, 0, 1], [16, 8, 0]]) {
      await expect(scrypt(enc('x'), enc('y'), N, r, p, 32)).rejects.toThrow();
    }
  });
});

describe('base64 as age writes it', () => {
  test('no padding, and only the canonical spelling reads', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      const text = base64(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64').replace(/=+$/, ''));
      expect(unbase64(text)).toEqual(bytes);
    }
    for (const bad of ['QQ==', 'QR', 'Q', 'QQ=', 'Q-Q_', 'QQ\n', 'QQ ']) expect([bad, unbase64(bad)]).toEqual([bad, null]);
  });
});

// The age project's test vectors (see the top of this file). Each is a short
// text header (expect, payload, passphrase, file key...), an empty line, and
// an age file, compressed with zlib when it says so. A vector locked to an
// X25519 key gives its file key, so its header and payload are checked with
// that; one that can only fail to unwrap with a key ("no match") is left out.
describe('age’s own test vectors', () => {
  const dir = join(import.meta.dir, 'fixtures', 'age');
  const EXPECTED: Record<AgeFailure | 'opened', string> = {
    opened: 'success',
    'not-age': 'header failure',
    unsupported: 'header failure',
    header: 'header failure',
    passphrase: 'no match',
    mac: 'HMAC failure',
    payload: 'payload failure',
  };
  const vectors = readdirSync(dir).sort();

  test('there are vectors for passphrases, headers, MACs and the payload’s chunks', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(70);
    for (const family of ['scrypt', 'stanza_', 'hmac_', 'stream_']) expect(vectors.some((v) => v.startsWith(family))).toBe(true);
  });

  for (const name of vectors) {
    test(name, async () => {
      const raw = readFileSync(join(dir, name));
      const split = raw.indexOf('\n\n');
      const meta = raw.subarray(0, split).toString('utf8');
      const values = (key: string) => [...meta.matchAll(new RegExp(`^${key}: (.*)$`, 'gm'))].map((m) => m[1]);
      let file = new Uint8Array(raw.subarray(split + 2));
      if (values('compressed')[0] === 'zlib') file = new Uint8Array(inflateSync(file));
      const expected = values('expect')[0];
      const [passphrase] = values('passphrase');
      const [fileKey] = values('file key');
      if (passphrase === undefined && expected === 'no match') return; // needs the X25519 key itself
      // Read from memory, and from a Blob as the page reads a file.
      for (const source of [bytesSource(file), blobSource(new Blob([file]))] as AgeSource[]) {
        const released: Uint8Array[] = [];
        const got =
          passphrase !== undefined
            ? await why(openWithPassphrase(source, passphrase, { scrypt }, (part) => void released.push(part)))
            : await why(
                (async () => {
                  for await (const part of openWithFileKey(source, fromHex(fileKey))) released.push(part);
                })()
              );
        expect(EXPECTED[got]).toBe(expected);
        // Everything released, even before a failure, is what the vector says.
        const [payload] = values('payload');
        if (payload) expect(sha256(...released)).toBe(payload);
      }
    });
  }
});

// A file as the route writes one, from pieces of any size.
const PIECES = (text: string, size: number) => () => {
  const bytes = enc(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
};
const PASSPHRASE = 'piano orbit lantern harvest';

async function protect(text: string, opts: { pieces?: number; passphrase?: string } = {}) {
  const bytes = enc(text);
  const made = await protectFile({ filename: 'nya-data-2026-10-10.json', chunks: PIECES(text, opts.pieces ?? 1000) }, bytes.length, opts.passphrase ?? PASSPHRASE, { workFactor: 10 });
  const file = new Uint8Array(Buffer.concat([...made.chunks()]));
  return { made, file };
}

const opened = async (file: Uint8Array, passphrase = PASSPHRASE) => new TextDecoder().decode(Buffer.concat(await decryptWithPassphrase(file, passphrase, { scrypt })));

describe('a protected download', () => {
  // Written by an independent age writer (Python's cryptography and hashlib)
  // from the same file key, salt, nonce and plaintext: two chunks.
  test('is byte for byte what another implementation writes', async () => {
    const seq = [Uint8Array.from({ length: 16 }, (_, i) => i), Uint8Array.from({ length: 16 }, (_, i) => 100 + i), Uint8Array.from({ length: 16 }, (_, i) => 200 + i)];
    let n = 0;
    const text = '{"format":"nya-export"}\n'.repeat(4000);
    const made = await protectFile({ filename: 'x.json', chunks: PIECES(text, 777) }, 96_000, 'correct horse battery staple', { workFactor: 10, random: () => seq[n++] });
    const file = new Uint8Array(Buffer.concat([...made.chunks()]));
    expect(new TextDecoder().decode(file.subarray(0, parseHeader(file).end))).toBe(
      'age-encryption.org/v1\n-> scrypt ZGVmZ2hpamtsbW5vcHFycw 10\nSdG6mtBjc9+lwkXJlS3tMbb+8n2GPGVIzOhCQ+8JGms\n--- JW/xagn4zrLtFX0jKKlZ5kLqFknWYK1ImByGUVzxSA8\n'
    );
    expect([made.bytes, file.length]).toEqual([96_198, 96_198]);
    expect(sha256(file)).toBe('5300abdf211d2adbdb83a0ffca2c68da66122137d16537a620d72b4fb59ff722');
  });

  test('is named for what it holds, and announces its size before the first byte', async () => {
    for (const size of [0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 3 * CHUNK_SIZE]) {
      const text = 'x'.repeat(size);
      const { made, file } = await protect(text, { pieces: 4099 });
      expect(made.filename).toBe('nya-data-2026-10-10.json.age');
      expect(made.contentType).toBe('application/octet-stream');
      expect([size, file.length]).toEqual([size, made.bytes]);
      expect(made.bytes).toBe(encryptedSize(parseHeader(file).end, size));
      expect(await opened(file)).toBe(text);
    }
  });

  test('uses age’s own setting for a passphrase unless told otherwise', async () => {
    expect(WORK_FACTOR).toBe(18);
    const made = await protectFile({ filename: 'f', chunks: () => [enc('hi')] }, 2, PASSPHRASE);
    const header = parseHeader(new Uint8Array(Buffer.concat([...made.chunks()])));
    expect(header.stanzas.map((s) => [s.type, s.args[1]])).toEqual([['scrypt', '18']]);
  });

  test('an empty file opens as an empty file', async () => {
    const { file } = await protect('');
    expect(await opened(file)).toBe('');
  });

  test('a large file, written in small pieces, opens whole', async () => {
    const text = Array.from({ length: 60_000 }, (_, i) => `{"id":"t${i}","amount":${(i % 977) / 4}}\n`).join('');
    const { made, file } = await protect(text, { pieces: 333 });
    expect(file.length).toBe(made.bytes);
    expect(Math.ceil(enc(text).length / CHUNK_SIZE)).toBeGreaterThan(20);
    expect(sha256(enc(await opened(file)))).toBe(sha256(enc(text)));
  });

  test('a wrong passphrase opens nothing', async () => {
    const { file } = await protect('secret');
    expect(await why(decryptWithPassphrase(file, 'piano orbit lantern harvesT', { scrypt }))).toBe('passphrase');
    expect(await why(decryptWithPassphrase(file, '', { scrypt }))).toBe('passphrase');
  });

  /** The header, the nonce and the chunks of a protected file, apart. */
  function chunksOf(file: Uint8Array) {
    const start = parseHeader(file).end + 16;
    const chunks: Uint8Array[] = [];
    for (let at = start; at < file.length; at += CHUNK_SIZE + 16) chunks.push(file.slice(at, Math.min(file.length, at + CHUNK_SIZE + 16)));
    return { head: file.slice(0, start), chunks };
  }
  const join = (head: Uint8Array, chunks: Uint8Array[]) => new Uint8Array(Buffer.concat([head, ...chunks]));
  const THREE_CHUNKS = 'abcdefghij'.repeat(15_000);

  test('a file cut short opens nothing: at a chunk’s edge, inside one, or inside the header', async () => {
    const { file } = await protect(THREE_CHUNKS);
    const { head, chunks } = chunksOf(file);
    expect(chunks.length).toBe(3);
    expect(await why(decryptWithPassphrase(join(head, chunks.slice(0, 2)), PASSPHRASE, { scrypt }))).toBe('payload');
    expect(await why(decryptWithPassphrase(file.subarray(0, file.length - 1), PASSPHRASE, { scrypt }))).toBe('payload');
    expect(await why(decryptWithPassphrase(file.subarray(0, head.length + 100), PASSPHRASE, { scrypt }))).toBe('payload');
    expect(await why(decryptWithPassphrase(file.subarray(0, head.length), PASSPHRASE, { scrypt }))).toBe('payload');
    expect(await why(decryptWithPassphrase(file.subarray(0, 60), PASSPHRASE, { scrypt }))).toBe('header');
  });

  test('chunks reordered, repeated, or swapped in from another file open nothing', async () => {
    const { file } = await protect(THREE_CHUNKS);
    const { head, chunks } = chunksOf(file);
    const [a, b, c] = chunks;
    expect(await why(decryptWithPassphrase(join(head, [b, a, c]), PASSPHRASE, { scrypt }))).toBe('payload');
    expect(await why(decryptWithPassphrase(join(head, [a, a, c]), PASSPHRASE, { scrypt }))).toBe('payload');
    expect(await why(decryptWithPassphrase(join(head, [a, b, c, c]), PASSPHRASE, { scrypt }))).toBe('payload');
    // The same text, the same passphrase, made again: another key, so none
    // of its chunks belongs in the first.
    const other = chunksOf((await protect(THREE_CHUNKS)).file).chunks;
    expect(await why(decryptWithPassphrase(join(head, [a, other[1], c]), PASSPHRASE, { scrypt }))).toBe('payload');
    // Nor its header with the first's chunks.
    const otherHead = chunksOf((await protect(THREE_CHUNKS)).file).head;
    expect(await why(decryptWithPassphrase(join(otherHead, [a, b, c]), PASSPHRASE, { scrypt }))).toBe('payload');
  });

  test('a changed byte anywhere opens nothing', async () => {
    const { file } = await protect(THREE_CHUNKS);
    const at = (i: number) => {
      const copy = file.slice();
      copy[i] ^= 0x01;
      return decryptWithPassphrase(copy, PASSPHRASE, { scrypt });
    };
    const head = parseHeader(file).end;
    // In the header: whatever the changed character now spells (another
    // version line, another salt, another sealed key, another MAC, or no
    // base64 at all), nothing opens.
    for (let i = 0; i < head; i++) expect(['not-age', 'unsupported', 'header', 'passphrase', 'mac']).toContain(await why(at(i)));
    expect(await why(at(head - 5))).not.toBe('passphrase'); // the MAC: the key still opens
    expect(await why(at(head + 3))).toBe('payload'); // the nonce: another payload key
    expect(await why(at(file.length - 3))).toBe('payload');
    expect(await why(at(head + 16 + CHUNK_SIZE + 20))).toBe('payload');
  });

  test('something that isn’t an age file is said to be so', async () => {
    expect(await why(decryptWithPassphrase(enc('{"format":"nya-export"}'), PASSPHRASE, { scrypt }))).toBe('not-age');
    expect(await why(decryptWithPassphrase(new Uint8Array(0), PASSPHRASE, { scrypt }))).toBe('not-age');
    expect(await why(decryptWithPassphrase(enc('-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----\n'), PASSPHRASE, { scrypt }))).toBe('unsupported');
  });

  test('a work factor past what a browser can spare is refused before any work', async () => {
    const made = await protectFile({ filename: 'f', chunks: () => [enc('hi')] }, 2, PASSPHRASE, { workFactor: 12 });
    const file = new Uint8Array(Buffer.concat([...made.chunks()]));
    let ran = false;
    const watching = async (...args: Parameters<typeof scrypt>) => ((ran = true), scrypt(...args));
    expect(await why(decryptWithPassphrase(file, PASSPHRASE, { scrypt: watching, maxWorkFactor: 11 }))).toBe('unsupported');
    expect(ran).toBe(false);
    expect(await why(decryptWithPassphrase(file, PASSPHRASE, { scrypt, maxWorkFactor: 12 }))).toBe('opened');
  });

  test('a Blob is read a few megabytes at a time, never whole, across the edge of a read', async () => {
    for (const size of [64 * CHUNK_SIZE - 1, 64 * CHUNK_SIZE, 64 * CHUNK_SIZE + 1, 128 * CHUNK_SIZE + 5]) {
      const text = 'nya '.repeat(Math.ceil(size / 4)).slice(0, size);
      const { file } = await protect(text, { pieces: 50_000 });
      const blob = new Blob([file]);
      const slice = blob.slice.bind(blob);
      const asked: number[] = [];
      blob.slice = ((start = 0, end = blob.size) => (asked.push(end - start), slice(start, end))) as Blob['slice'];
      const parts: Uint8Array[] = [];
      await openWithPassphrase(blobSource(blob), PASSPHRASE, { scrypt }, (part) => void parts.push(part));
      expect(new TextDecoder().decode(Buffer.concat(parts))).toBe(text);
      // The header, the nonce, then the chunks a read at a time.
      const chunks = file.length - parseHeader(file).end - 16;
      expect(Math.max(...asked)).toBe(Math.min(READ_SIZE, chunks));
      expect(asked.length).toBe(2 + Math.ceil(chunks / READ_SIZE));
      // Cut short where a read ends: no chunk marked last, nothing opened.
      if (size > 64 * CHUNK_SIZE) {
        const cut = file.subarray(0, parseHeader(file).end + 16 + READ_SIZE);
        expect(await why(openWithPassphrase(blobSource(new Blob([cut])), PASSPHRASE, { scrypt }, () => {}))).toBe('payload');
      }
    }
  }, 30_000);
});

// The age command, where it is installed, through a pseudo-terminal (`script`):
// it reads a passphrase only from a terminal.
const hasTool = (name: string) => Bun.spawnSync(['sh', '-c', `command -v ${name}`]).exitCode === 0;
const CLI = hasTool('age') && hasTool('script');

describe.skipIf(!CLI)('the age command', () => {
  const run = (command: string, input: string, cwd: string) =>
    Bun.spawnSync(['script', '-q', '-e', '-c', command, '/dev/null'], { cwd, stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' });

  test('opens a protected download as Nya writes it, at the real setting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nya-age-'));
    try {
      const text = '{"format":"nya-export","version":2}\n' + 'café, 東京, "quotes"\n'.repeat(5000);
      const made = await protectFile({ filename: 'nya-data.json', chunks: PIECES(text, 4096) }, enc(text).length, PASSPHRASE);
      writeFileSync(join(dir, 'in.age'), Buffer.concat([...made.chunks()]));
      const res = run('age -d -o out.json in.age', `${PASSPHRASE}\n`, dir);
      expect(res.exitCode).toBe(0);
      expect(readFileSync(join(dir, 'out.json'), 'utf8')).toBe(text);
      // And the wrong passphrase is refused, writing nothing.
      expect(run('age -d -o wrong.json in.age', 'not the passphrase\n', dir).exitCode).not.toBe(0);
      expect(() => readFileSync(join(dir, 'wrong.json'))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('what the age command protects with a passphrase opens here', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nya-age-'));
    try {
      const text = 'line one\nline two\n'.repeat(9000);
      writeFileSync(join(dir, 'plain.txt'), text);
      const res = run('age -p -o made.age plain.txt', `${PASSPHRASE}\n${PASSPHRASE}\n`, dir);
      expect(res.exitCode).toBe(0);
      const file = new Uint8Array(readFileSync(join(dir, 'made.age')));
      expect(parseHeader(file).stanzas[0].type).toBe('scrypt');
      expect(await opened(file)).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
