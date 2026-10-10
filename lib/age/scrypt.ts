// lib/age/scrypt.ts
//
// scrypt (RFC 7914), the slow key derivation of age's passphrase files
// (lib/age/age.ts), in JavaScript, for the page that opens a protected
// download in the browser (app/open-download), where Web Crypto has none. The
// server derives its keys with node:crypto's own scrypt instead
// (lib/protected-download.ts); test/age.test.ts holds this one to the RFC's
// test vectors and to node:crypto's answers. Pure, safe to import from client
// code: PBKDF2-HMAC-SHA256, the step before and after the memory-hard part,
// is Web Crypto's.
//
// MEMORY AND TIME. The memory-hard part (ROMix) keeps N blocks of 128r bytes:
// age's usual setting (N = 2^18, r = 8) is 256 MB, held for a few seconds.
// Long enough to freeze a page, so the work stops every so often to let the
// browser draw (and says how far it has got), rather than running in one go.

/** What a derivation reports as it goes: how much of it is done, 0 to 1. */
export type Progress = (done: number) => void;

/** How long the work runs before it lets the page draw, in milliseconds. */
const SLICE_MS = 40;

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function pbkdf2(password: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1 }, key, length * 8));
}

/** The Salsa20/8 core, on 16 words of `b` from `at`, in place. */
function salsa8(b: Uint32Array, at: number): void {
  const j0 = b[at], j1 = b[at + 1], j2 = b[at + 2], j3 = b[at + 3], j4 = b[at + 4], j5 = b[at + 5], j6 = b[at + 6], j7 = b[at + 7];
  const j8 = b[at + 8], j9 = b[at + 9], j10 = b[at + 10], j11 = b[at + 11], j12 = b[at + 12], j13 = b[at + 13], j14 = b[at + 14], j15 = b[at + 15];
  let x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7;
  let x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14, x15 = j15;
  let u: number;
  for (let i = 0; i < 8; i += 2) {
    u = (x0 + x12) | 0; x4 ^= (u << 7) | (u >>> 25);
    u = (x4 + x0) | 0; x8 ^= (u << 9) | (u >>> 23);
    u = (x8 + x4) | 0; x12 ^= (u << 13) | (u >>> 19);
    u = (x12 + x8) | 0; x0 ^= (u << 18) | (u >>> 14);
    u = (x5 + x1) | 0; x9 ^= (u << 7) | (u >>> 25);
    u = (x9 + x5) | 0; x13 ^= (u << 9) | (u >>> 23);
    u = (x13 + x9) | 0; x1 ^= (u << 13) | (u >>> 19);
    u = (x1 + x13) | 0; x5 ^= (u << 18) | (u >>> 14);
    u = (x10 + x6) | 0; x14 ^= (u << 7) | (u >>> 25);
    u = (x14 + x10) | 0; x2 ^= (u << 9) | (u >>> 23);
    u = (x2 + x14) | 0; x6 ^= (u << 13) | (u >>> 19);
    u = (x6 + x2) | 0; x10 ^= (u << 18) | (u >>> 14);
    u = (x15 + x11) | 0; x3 ^= (u << 7) | (u >>> 25);
    u = (x3 + x15) | 0; x7 ^= (u << 9) | (u >>> 23);
    u = (x7 + x3) | 0; x11 ^= (u << 13) | (u >>> 19);
    u = (x11 + x7) | 0; x15 ^= (u << 18) | (u >>> 14);
    u = (x0 + x3) | 0; x1 ^= (u << 7) | (u >>> 25);
    u = (x1 + x0) | 0; x2 ^= (u << 9) | (u >>> 23);
    u = (x2 + x1) | 0; x3 ^= (u << 13) | (u >>> 19);
    u = (x3 + x2) | 0; x0 ^= (u << 18) | (u >>> 14);
    u = (x5 + x4) | 0; x6 ^= (u << 7) | (u >>> 25);
    u = (x6 + x5) | 0; x7 ^= (u << 9) | (u >>> 23);
    u = (x7 + x6) | 0; x4 ^= (u << 13) | (u >>> 19);
    u = (x4 + x7) | 0; x5 ^= (u << 18) | (u >>> 14);
    u = (x10 + x9) | 0; x11 ^= (u << 7) | (u >>> 25);
    u = (x11 + x10) | 0; x8 ^= (u << 9) | (u >>> 23);
    u = (x8 + x11) | 0; x9 ^= (u << 13) | (u >>> 19);
    u = (x9 + x8) | 0; x10 ^= (u << 18) | (u >>> 14);
    u = (x15 + x14) | 0; x12 ^= (u << 7) | (u >>> 25);
    u = (x12 + x15) | 0; x13 ^= (u << 9) | (u >>> 23);
    u = (x13 + x12) | 0; x14 ^= (u << 13) | (u >>> 19);
    u = (x14 + x13) | 0; x15 ^= (u << 18) | (u >>> 14);
  }
  b[at] = x0 + j0; b[at + 1] = x1 + j1; b[at + 2] = x2 + j2; b[at + 3] = x3 + j3;
  b[at + 4] = x4 + j4; b[at + 5] = x5 + j5; b[at + 6] = x6 + j6; b[at + 7] = x7 + j7;
  b[at + 8] = x8 + j8; b[at + 9] = x9 + j9; b[at + 10] = x10 + j10; b[at + 11] = x11 + j11;
  b[at + 12] = x12 + j12; b[at + 13] = x13 + j13; b[at + 14] = x14 + j14; b[at + 15] = x15 + j15;
}

/**
 * BlockMix with Salsa20/8 (RFC 7914, 4): the 2r blocks of 16 words in `xy`
 * from 0, mixed into `xy` from 32r, then put back at 0 in the order the RFC
 * gives (the even blocks, then the odd). `t` is 16 words of scratch.
 */
function blockMix(xy: Uint32Array, r: number, t: Uint32Array): void {
  const y = 32 * r;
  const last = (2 * r - 1) * 16;
  for (let w = 0; w < 16; w++) t[w] = xy[last + w];
  for (let i = 0; i < 2 * r; i++) {
    const at = i * 16;
    for (let w = 0; w < 16; w++) t[w] ^= xy[at + w];
    salsa8(t, 0);
    xy.set(t, y + at);
  }
  for (let i = 0; i < r; i++) {
    xy.copyWithin(i * 16, y + i * 32, y + i * 32 + 16);
    xy.copyWithin((i + r) * 16, y + i * 32 + 16, y + i * 32 + 32);
  }
}

/**
 * scrypt(password, salt, N, r, p, dkLen) as RFC 7914 defines it. N must be a
 * power of two above 1. Throws on parameters it can't honour.
 */
export async function scrypt(
  password: Uint8Array,
  salt: Uint8Array,
  N: number,
  r: number,
  p: number,
  dkLen: number,
  onProgress?: Progress
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0 || N > 2 ** 24) throw new Error('scrypt: N must be a power of two from 2 to 2^24');
  if (!Number.isInteger(r) || r < 1 || r > 64 || !Number.isInteger(p) || p < 1 || p > 64) throw new Error('scrypt: r and p must be whole numbers from 1 to 64');
  const pass = new Uint8Array(password);
  const B = await pbkdf2(pass, new Uint8Array(salt), p * 128 * r);
  const words = 32 * r;
  const xy = new Uint32Array(2 * words);
  const V = new Uint32Array(words * N);
  const t = new Uint32Array(16);
  const total = 2 * N * p;
  let done = 0;
  let sliceStart = Date.now();
  // Lets the page draw now and then (see the header).
  const breathe = async () => {
    if (Date.now() - sliceStart < SLICE_MS) return;
    onProgress?.(done / total);
    await pause();
    sliceStart = Date.now();
  };
  for (let block = 0; block < p; block++) {
    const base = block * 128 * r;
    for (let w = 0; w < words; w++) {
      const at = base + w * 4;
      xy[w] = (B[at] | (B[at + 1] << 8) | (B[at + 2] << 16) | (B[at + 3] << 24)) >>> 0;
    }
    // ROMix (RFC 7914, 5).
    for (let i = 0; i < N; i++) {
      const into = i * words;
      for (let w = 0; w < words; w++) V[into + w] = xy[w];
      blockMix(xy, r, t);
      done++;
      if ((i & 255) === 255) await breathe();
    }
    for (let i = 0; i < N; i++) {
      // Integerify: the first word of the last 64-byte block, mod N.
      const j = xy[(2 * r - 1) * 16] & (N - 1);
      const from = j * words;
      for (let w = 0; w < words; w++) xy[w] ^= V[from + w];
      blockMix(xy, r, t);
      done++;
      if ((i & 255) === 255) await breathe();
    }
    for (let w = 0; w < words; w++) {
      const at = base + w * 4;
      const v = xy[w];
      B[at] = v & 0xff;
      B[at + 1] = (v >>> 8) & 0xff;
      B[at + 2] = (v >>> 16) & 0xff;
      B[at + 3] = v >>> 24;
    }
  }
  onProgress?.(1);
  return pbkdf2(pass, B, dkLen);
}
