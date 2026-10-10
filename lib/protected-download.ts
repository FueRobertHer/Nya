// lib/protected-download.ts
//
// A download of my data protected with a passphrase (app/api/my-data): the
// file, whatever its format, encrypted as it streams, in the age format
// (lib/age/age.ts). Anyone can open it with the age tool (`age -d`) or on
// Nya's own page (app/open-download), which opens it in the browser without
// sending it anywhere; docs/data-export.md says how.
//
// THE PASSPHRASE is used for one thing: the scrypt derivation that locks the
// file's random key. It is never stored, logged or sent anywhere else, and
// nothing here keeps it once the key is derived. Lose it and the file can't
// be opened, by the person or by anyone running Nya: the derivation is the
// only way back to the key.
//
// SLOW ON PURPOSE. scrypt runs at age's own setting for a passphrase (N =
// 2^18, r = 8: about a second and 256 MB on the server, once per download),
// so each guess at a lost or stolen file's passphrase costs the same. Here it
// is node:crypto's native scrypt, which runs off the main thread; the browser
// page uses lib/age/scrypt.ts, which test/age.test.ts holds to the same
// answers.
//
// STILL STREAMED. The plaintext is the same file the route already counts
// and streams (lib/user-export.ts fileChunks), sealed a 64 KiB chunk at a
// time as it goes out, so nothing is written down and the whole file is never
// held. Its size is known before the first byte (encryptedSize), so the page
// can still tell a whole file from one cut short.

import { randomBytes, scrypt as nodeScrypt } from 'node:crypto';
import { encryptedSize, passphraseHeader, payloadKey, sealPayload, FILE_KEY_SIZE, NONCE_SIZE, type ScryptFn } from './age/age';

/** node:crypto's scrypt, with room for the memory the setting needs (its
 *  default allowance is 32 MB). */
export const nativeScrypt: ScryptFn = (password, salt, N, r, p, dkLen) =>
  new Promise((resolve, reject) => {
    nodeScrypt(password, salt, dkLen, { N, r, p, maxmem: 128 * r * N * p + 32 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(new Uint8Array(key))));
  });

/** A protected file, ready to stream: its name and type, its size in bytes,
 *  and its bytes a chunk at a time (call `chunks` once). */
export type ProtectedFile = { filename: string; contentType: string; bytes: number; chunks: () => Generator<Uint8Array> };

/** A file to protect: its name, and its bytes a piece at a time (the route's
 *  fileChunks, lib/user-export.ts). */
export type PlainFile = { filename: string; chunks: () => Iterable<Uint8Array> };

/**
 * The file, protected with the passphrase. `plainBytes` is its size as the
 * route counted it (fileByteLength). The options are for tests: a smaller
 * work factor, and fixed randomness.
 */
export async function protectFile(
  file: PlainFile,
  plainBytes: number,
  passphrase: string,
  opts: { workFactor?: number; random?: (n: number) => Uint8Array } = {}
): Promise<ProtectedFile> {
  const random = opts.random ?? ((n: number) => new Uint8Array(randomBytes(n)));
  const fileKey = random(FILE_KEY_SIZE);
  const salt = random(16);
  const nonce = random(NONCE_SIZE);
  const header = await passphraseHeader(fileKey, passphrase, { salt, workFactor: opts.workFactor, scrypt: nativeScrypt });
  const key = await payloadKey(fileKey, nonce);
  return {
    filename: `${file.filename}.age`,
    contentType: 'application/octet-stream',
    bytes: encryptedSize(header.length, plainBytes),
    chunks: function* () {
      yield header;
      yield nonce;
      yield* sealPayload(key, file.chunks());
    },
  };
}
