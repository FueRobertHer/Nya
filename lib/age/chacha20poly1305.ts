// lib/age/chacha20poly1305.ts
//
// ChaCha20-Poly1305 (RFC 8439), the authenticated cipher of the age file
// format (lib/age/age.ts), which protects a download of my data with a
// passphrase. Hand-written because Web Crypto has no ChaCha20, and Bun's
// node:crypto doesn't either, while the page that opens a protected file
// (app/open-download) runs in a browser. Pure, safe to import from client
// code, with no dependencies. test/age.test.ts holds it to the RFC's own test
// vectors, and to the age command-line tool.
//
// CHACHA20 is the 20-round stream cipher on 32-bit words: a 256-bit key, a
// 96-bit nonce and a 32-bit block counter make each 64-byte block of
// keystream, which is XORed with the text.
//
// POLY1305 is the one-time authenticator over 2^130 - 5. The accumulator and
// the key are kept in ten limbs of 13 bits (the layout of poly1305-donna-16,
// as TweetNaCl writes it). Before each multiplication every limb of the
// accumulator is carried back to 13 bits (the second at most 2^13), so each
// limb of the product, a sum of ten products of two limbs plus the carry
// before it, stays below 2^32: the largest possible is 2,415,452,816, about
// 2^31.17, from the clamped key's largest limbs. That is what makes every
// carry exact as a 32-bit shift (>>> 13), and the sums exact as doubles. A
// change that let a limb grow past 13 bits before the product would break
// this, silently, so test/age.test.ts runs the key at its largest clamped
// value with every message byte at 0xff.
//
// THE AEAD seals with no associated data, as age does: the first block of
// keystream (counter 0) keys Poly1305, the text is encrypted from counter 1,
// and the tag covers the ciphertext padded to 16 bytes and both lengths. A
// tag is compared in constant time, and nothing is decrypted unless it
// matches.

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

/** A little-endian 32-bit word of `b` at `i`. */
const word = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

/** One 64-byte block of ChaCha20 keystream, as 16 words, into `out`. `key` is
 *  8 words, `nonce` 3. */
function chachaBlock(key: Uint32Array, counter: number, nonce: Uint32Array, out: Uint32Array): void {
  const j0 = SIGMA[0], j1 = SIGMA[1], j2 = SIGMA[2], j3 = SIGMA[3];
  const j4 = key[0], j5 = key[1], j6 = key[2], j7 = key[3], j8 = key[4], j9 = key[5], j10 = key[6], j11 = key[7];
  const j12 = counter >>> 0, j13 = nonce[0], j14 = nonce[1], j15 = nonce[2];
  let x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7;
  let x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14, x15 = j15;
  for (let i = 0; i < 20; i += 2) {
    // Column round.
    x0 = (x0 + x4) | 0; x12 ^= x0; x12 = (x12 << 16) | (x12 >>> 16);
    x8 = (x8 + x12) | 0; x4 ^= x8; x4 = (x4 << 12) | (x4 >>> 20);
    x0 = (x0 + x4) | 0; x12 ^= x0; x12 = (x12 << 8) | (x12 >>> 24);
    x8 = (x8 + x12) | 0; x4 ^= x8; x4 = (x4 << 7) | (x4 >>> 25);
    x1 = (x1 + x5) | 0; x13 ^= x1; x13 = (x13 << 16) | (x13 >>> 16);
    x9 = (x9 + x13) | 0; x5 ^= x9; x5 = (x5 << 12) | (x5 >>> 20);
    x1 = (x1 + x5) | 0; x13 ^= x1; x13 = (x13 << 8) | (x13 >>> 24);
    x9 = (x9 + x13) | 0; x5 ^= x9; x5 = (x5 << 7) | (x5 >>> 25);
    x2 = (x2 + x6) | 0; x14 ^= x2; x14 = (x14 << 16) | (x14 >>> 16);
    x10 = (x10 + x14) | 0; x6 ^= x10; x6 = (x6 << 12) | (x6 >>> 20);
    x2 = (x2 + x6) | 0; x14 ^= x2; x14 = (x14 << 8) | (x14 >>> 24);
    x10 = (x10 + x14) | 0; x6 ^= x10; x6 = (x6 << 7) | (x6 >>> 25);
    x3 = (x3 + x7) | 0; x15 ^= x3; x15 = (x15 << 16) | (x15 >>> 16);
    x11 = (x11 + x15) | 0; x7 ^= x11; x7 = (x7 << 12) | (x7 >>> 20);
    x3 = (x3 + x7) | 0; x15 ^= x3; x15 = (x15 << 8) | (x15 >>> 24);
    x11 = (x11 + x15) | 0; x7 ^= x11; x7 = (x7 << 7) | (x7 >>> 25);
    // Diagonal round.
    x0 = (x0 + x5) | 0; x15 ^= x0; x15 = (x15 << 16) | (x15 >>> 16);
    x10 = (x10 + x15) | 0; x5 ^= x10; x5 = (x5 << 12) | (x5 >>> 20);
    x0 = (x0 + x5) | 0; x15 ^= x0; x15 = (x15 << 8) | (x15 >>> 24);
    x10 = (x10 + x15) | 0; x5 ^= x10; x5 = (x5 << 7) | (x5 >>> 25);
    x1 = (x1 + x6) | 0; x12 ^= x1; x12 = (x12 << 16) | (x12 >>> 16);
    x11 = (x11 + x12) | 0; x6 ^= x11; x6 = (x6 << 12) | (x6 >>> 20);
    x1 = (x1 + x6) | 0; x12 ^= x1; x12 = (x12 << 8) | (x12 >>> 24);
    x11 = (x11 + x12) | 0; x6 ^= x11; x6 = (x6 << 7) | (x6 >>> 25);
    x2 = (x2 + x7) | 0; x13 ^= x2; x13 = (x13 << 16) | (x13 >>> 16);
    x8 = (x8 + x13) | 0; x7 ^= x8; x7 = (x7 << 12) | (x7 >>> 20);
    x2 = (x2 + x7) | 0; x13 ^= x2; x13 = (x13 << 8) | (x13 >>> 24);
    x8 = (x8 + x13) | 0; x7 ^= x8; x7 = (x7 << 7) | (x7 >>> 25);
    x3 = (x3 + x4) | 0; x14 ^= x3; x14 = (x14 << 16) | (x14 >>> 16);
    x9 = (x9 + x14) | 0; x4 ^= x9; x4 = (x4 << 12) | (x4 >>> 20);
    x3 = (x3 + x4) | 0; x14 ^= x3; x14 = (x14 << 8) | (x14 >>> 24);
    x9 = (x9 + x14) | 0; x4 ^= x9; x4 = (x4 << 7) | (x4 >>> 25);
  }
  out[0] = x0 + j0; out[1] = x1 + j1; out[2] = x2 + j2; out[3] = x3 + j3;
  out[4] = x4 + j4; out[5] = x5 + j5; out[6] = x6 + j6; out[7] = x7 + j7;
  out[8] = x8 + j8; out[9] = x9 + j9; out[10] = x10 + j10; out[11] = x11 + j11;
  out[12] = x12 + j12; out[13] = x13 + j13; out[14] = x14 + j14; out[15] = x15 + j15;
}

function keyWords(key: Uint8Array): Uint32Array {
  if (key.length !== 32) throw new Error('A ChaCha20 key is 32 bytes');
  const w = new Uint32Array(8);
  for (let i = 0; i < 8; i++) w[i] = word(key, i * 4);
  return w;
}

function nonceWords(nonce: Uint8Array): Uint32Array {
  if (nonce.length !== 12) throw new Error('A ChaCha20 nonce is 12 bytes');
  return new Uint32Array([word(nonce, 0), word(nonce, 4), word(nonce, 8)]);
}

/** The block of keystream at `counter`, as 64 bytes (RFC 8439, 2.3). */
export function chacha20Block(key: Uint8Array, counter: number, nonce: Uint8Array): Uint8Array {
  const out = new Uint32Array(16);
  chachaBlock(keyWords(key), counter, nonceWords(nonce), out);
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    const w = out[i];
    bytes[i * 4] = w & 0xff;
    bytes[i * 4 + 1] = (w >>> 8) & 0xff;
    bytes[i * 4 + 2] = (w >>> 16) & 0xff;
    bytes[i * 4 + 3] = (w >>> 24) & 0xff;
  }
  return bytes;
}

/** `input` XORed with the keystream from block `counter` on (RFC 8439,
 *  2.4): encryption and decryption alike. */
export function chacha20(key: Uint8Array, nonce: Uint8Array, counter: number, input: Uint8Array): Uint8Array {
  const k = keyWords(key);
  const n = nonceWords(nonce);
  const block = new Uint32Array(16);
  const out = new Uint8Array(input.length);
  for (let pos = 0; pos < input.length; pos += 64, counter++) {
    chachaBlock(k, counter, n, block);
    const end = Math.min(64, input.length - pos);
    if (end === 64) {
      // A whole block, a word at a time.
      for (let i = 0; i < 16; i++) {
        const w = block[i];
        const at = pos + i * 4;
        out[at] = input[at] ^ (w & 0xff);
        out[at + 1] = input[at + 1] ^ ((w >>> 8) & 0xff);
        out[at + 2] = input[at + 2] ^ ((w >>> 16) & 0xff);
        out[at + 3] = input[at + 3] ^ (w >>> 24);
      }
    } else {
      for (let i = 0; i < end; i++) out[pos + i] = input[pos + i] ^ ((block[i >>> 2] >>> ((i & 3) * 8)) & 0xff);
    }
  }
  return out;
}

/** Poly1305 (RFC 8439, 2.5), fed a piece at a time. One key, one message. */
export class Poly1305 {
  private readonly r = new Int32Array(10);
  /** The accumulator, as doubles: a limb holds 13 bits between blocks, a
   *  little more while a block is added in. */
  private readonly h = new Float64Array(10);
  private readonly pad = new Uint16Array(8);
  private readonly buffer = new Uint8Array(16);
  private leftover = 0;

  constructor(key: Uint8Array) {
    if (key.length !== 32) throw new Error('A Poly1305 key is 32 bytes');
    const t = (i: number) => key[i] | (key[i + 1] << 8);
    const t0 = t(0), t1 = t(2), t2 = t(4), t3 = t(6), t4 = t(8), t5 = t(10), t6 = t(12), t7 = t(14);
    // The 13-bit limbs of r, clamped as the RFC says (r &= 0x0ffffffc0ffffffc0ffffffc0fffffff).
    const r = this.r;
    r[0] = t0 & 0x1fff;
    r[1] = ((t0 >>> 13) | (t1 << 3)) & 0x1fff;
    r[2] = ((t1 >>> 10) | (t2 << 6)) & 0x1f03;
    r[3] = ((t2 >>> 7) | (t3 << 9)) & 0x1fff;
    r[4] = ((t3 >>> 4) | (t4 << 12)) & 0x00ff;
    r[5] = (t4 >>> 1) & 0x1ffe;
    r[6] = ((t4 >>> 14) | (t5 << 2)) & 0x1fff;
    r[7] = ((t5 >>> 11) | (t6 << 5)) & 0x1f81;
    r[8] = ((t6 >>> 8) | (t7 << 8)) & 0x1fff;
    r[9] = (t7 >>> 5) & 0x007f;
    for (let i = 0; i < 8; i++) this.pad[i] = t(16 + i * 2);
  }

  /** Whole 16-byte blocks of `m` from `pos`, each with 2^128 added, or with
   *  `hibit` 0 for the padded last block of a message whose length isn't a
   *  multiple of 16. */
  private blocks(m: Uint8Array, pos: number, count: number, hibit: number): void {
    const h = this.h, r = this.r;
    const r0 = r[0], r1 = r[1], r2 = r[2], r3 = r[3], r4 = r[4], r5 = r[5], r6 = r[6], r7 = r[7], r8 = r[8], r9 = r[9];
    // 5r, for the products that wrap past 2^130, which is 5 modulo p.
    const s1 = 5 * r1, s2 = 5 * r2, s3 = 5 * r3, s4 = 5 * r4, s5 = 5 * r5, s6 = 5 * r6, s7 = 5 * r7, s8 = 5 * r8, s9 = 5 * r9;
    let h0 = h[0], h1 = h[1], h2 = h[2], h3 = h[3], h4 = h[4], h5 = h[5], h6 = h[6], h7 = h[7], h8 = h[8], h9 = h[9];
    for (let b = 0; b < count; b++, pos += 16) {
      const t0 = m[pos] | (m[pos + 1] << 8), t1 = m[pos + 2] | (m[pos + 3] << 8);
      const t2 = m[pos + 4] | (m[pos + 5] << 8), t3 = m[pos + 6] | (m[pos + 7] << 8);
      const t4 = m[pos + 8] | (m[pos + 9] << 8), t5 = m[pos + 10] | (m[pos + 11] << 8);
      const t6 = m[pos + 12] | (m[pos + 13] << 8), t7 = m[pos + 14] | (m[pos + 15] << 8);
      h0 += t0 & 0x1fff;
      h1 += ((t0 >>> 13) | (t1 << 3)) & 0x1fff;
      h2 += ((t1 >>> 10) | (t2 << 6)) & 0x1fff;
      h3 += ((t2 >>> 7) | (t3 << 9)) & 0x1fff;
      h4 += ((t3 >>> 4) | (t4 << 12)) & 0x1fff;
      h5 += (t4 >>> 1) & 0x1fff;
      h6 += ((t4 >>> 14) | (t5 << 2)) & 0x1fff;
      h7 += ((t5 >>> 11) | (t6 << 5)) & 0x1fff;
      h8 += ((t6 >>> 8) | (t7 << 8)) & 0x1fff;
      h9 += (t7 >>> 5) | hibit;
      // Each limb back to 13 bits before the product (h1 at most 2^13), so
      // that no sum of products below can reach 2^32 (the largest is
      // 2,415,452,816, about 2^31.17), and its carry can be taken with a
      // 32-bit shift.
      let c = h0 >>> 13;
      h0 &= 0x1fff;
      h1 += c; c = h1 >>> 13; h1 &= 0x1fff;
      h2 += c; c = h2 >>> 13; h2 &= 0x1fff;
      h3 += c; c = h3 >>> 13; h3 &= 0x1fff;
      h4 += c; c = h4 >>> 13; h4 &= 0x1fff;
      h5 += c; c = h5 >>> 13; h5 &= 0x1fff;
      h6 += c; c = h6 >>> 13; h6 &= 0x1fff;
      h7 += c; c = h7 >>> 13; h7 &= 0x1fff;
      h8 += c; c = h8 >>> 13; h8 &= 0x1fff;
      h9 += c; c = h9 >>> 13; h9 &= 0x1fff;
      h0 += c * 5; c = h0 >>> 13; h0 &= 0x1fff;
      h1 += c;
      // h * r mod 2^130 - 5, limb by limb (d_i is every product landing at
      // limb i), each carried on as it is made.
      let d0 = h0 * r0 + h1 * s9 + h2 * s8 + h3 * s7 + h4 * s6 + h5 * s5 + h6 * s4 + h7 * s3 + h8 * s2 + h9 * s1;
      c = d0 >>> 13;
      d0 &= 0x1fff;
      let d1 = c + h0 * r1 + h1 * r0 + h2 * s9 + h3 * s8 + h4 * s7 + h5 * s6 + h6 * s5 + h7 * s4 + h8 * s3 + h9 * s2;
      c = d1 >>> 13;
      d1 &= 0x1fff;
      let d2 = c + h0 * r2 + h1 * r1 + h2 * r0 + h3 * s9 + h4 * s8 + h5 * s7 + h6 * s6 + h7 * s5 + h8 * s4 + h9 * s3;
      c = d2 >>> 13;
      d2 &= 0x1fff;
      let d3 = c + h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * s9 + h5 * s8 + h6 * s7 + h7 * s6 + h8 * s5 + h9 * s4;
      c = d3 >>> 13;
      d3 &= 0x1fff;
      let d4 = c + h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0 + h5 * s9 + h6 * s8 + h7 * s7 + h8 * s6 + h9 * s5;
      c = d4 >>> 13;
      d4 &= 0x1fff;
      let d5 = c + h0 * r5 + h1 * r4 + h2 * r3 + h3 * r2 + h4 * r1 + h5 * r0 + h6 * s9 + h7 * s8 + h8 * s7 + h9 * s6;
      c = d5 >>> 13;
      d5 &= 0x1fff;
      let d6 = c + h0 * r6 + h1 * r5 + h2 * r4 + h3 * r3 + h4 * r2 + h5 * r1 + h6 * r0 + h7 * s9 + h8 * s8 + h9 * s7;
      c = d6 >>> 13;
      d6 &= 0x1fff;
      let d7 = c + h0 * r7 + h1 * r6 + h2 * r5 + h3 * r4 + h4 * r3 + h5 * r2 + h6 * r1 + h7 * r0 + h8 * s9 + h9 * s8;
      c = d7 >>> 13;
      d7 &= 0x1fff;
      let d8 = c + h0 * r8 + h1 * r7 + h2 * r6 + h3 * r5 + h4 * r4 + h5 * r3 + h6 * r2 + h7 * r1 + h8 * r0 + h9 * s9;
      c = d8 >>> 13;
      d8 &= 0x1fff;
      let d9 = c + h0 * r9 + h1 * r8 + h2 * r7 + h3 * r6 + h4 * r5 + h5 * r4 + h6 * r3 + h7 * r2 + h8 * r1 + h9 * r0;
      c = d9 >>> 13;
      d9 &= 0x1fff;
      c = c * 5 + d0;
      h0 = c & 0x1fff;
      h1 = d1 + (c >>> 13);
      h2 = d2; h3 = d3; h4 = d4; h5 = d5; h6 = d6; h7 = d7; h8 = d8; h9 = d9;
    }
    h[0] = h0; h[1] = h1; h[2] = h2; h[3] = h3; h[4] = h4; h[5] = h5; h[6] = h6; h[7] = h7; h[8] = h8; h[9] = h9;
  }

  /** Feeds `m` from `start` to `end`. */
  update(m: Uint8Array, start = 0, end = m.length): this {
    let pos = start;
    if (this.leftover > 0) {
      const take = Math.min(16 - this.leftover, end - pos);
      this.buffer.set(m.subarray(pos, pos + take), this.leftover);
      this.leftover += take;
      pos += take;
      if (this.leftover < 16) return this;
      this.blocks(this.buffer, 0, 1, 1 << 11);
      this.leftover = 0;
    }
    const whole = Math.floor((end - pos) / 16);
    if (whole > 0) {
      this.blocks(m, pos, whole, 1 << 11);
      pos += whole * 16;
    }
    if (pos < end) {
      this.buffer.set(m.subarray(pos, end), 0);
      this.leftover = end - pos;
    }
    return this;
  }

  /** The 16-byte tag. */
  finish(): Uint8Array {
    if (this.leftover > 0) {
      // The last, short block: a 1 after its bytes, then zeros, and no 2^128.
      this.buffer[this.leftover] = 1;
      this.buffer.fill(0, this.leftover + 1);
      this.blocks(this.buffer, 0, 1, 0);
      this.leftover = 0;
    }
    const h = Int32Array.from(this.h);
    const g = new Int32Array(10);
    // A full carry, then h - p where h >= p (p = 2^130 - 5).
    let c = h[1] >>> 13;
    h[1] &= 0x1fff;
    for (let i = 2; i < 10; i++) {
      h[i] += c;
      c = h[i] >>> 13;
      h[i] &= 0x1fff;
    }
    h[0] += c * 5;
    c = h[0] >>> 13;
    h[0] &= 0x1fff;
    h[1] += c;
    c = h[1] >>> 13;
    h[1] &= 0x1fff;
    h[2] += c;
    g[0] = h[0] + 5;
    c = g[0] >>> 13;
    g[0] &= 0x1fff;
    for (let i = 1; i < 10; i++) {
      g[i] = h[i] + c;
      c = g[i] >>> 13;
      g[i] &= 0x1fff;
    }
    g[9] -= 1 << 13;
    // c is 1 when h + 5 reached 2^130, that is when h >= p: take g then.
    let mask = (c ^ 1) - 1;
    for (let i = 0; i < 10; i++) g[i] &= mask;
    mask = ~mask;
    for (let i = 0; i < 10; i++) h[i] = (h[i] & mask) | g[i];
    // The low 128 bits, as eight 16-bit words, plus s.
    const w = [
      (h[0] | (h[1] << 13)) & 0xffff,
      ((h[1] >>> 3) | (h[2] << 10)) & 0xffff,
      ((h[2] >>> 6) | (h[3] << 7)) & 0xffff,
      ((h[3] >>> 9) | (h[4] << 4)) & 0xffff,
      ((h[4] >>> 12) | (h[5] << 1) | (h[6] << 14)) & 0xffff,
      ((h[6] >>> 2) | (h[7] << 11)) & 0xffff,
      ((h[7] >>> 5) | (h[8] << 8)) & 0xffff,
      ((h[8] >>> 8) | (h[9] << 5)) & 0xffff,
    ];
    const tag = new Uint8Array(16);
    let f = 0;
    for (let i = 0; i < 8; i++) {
      f = w[i] + this.pad[i] + (f >>> 16);
      tag[i * 2] = f & 0xff;
      tag[i * 2 + 1] = (f >>> 8) & 0xff;
    }
    return tag;
  }
}

/** Poly1305 of one whole message. */
export function poly1305(key: Uint8Array, message: Uint8Array): Uint8Array {
  return new Poly1305(key).update(message).finish();
}

const ZEROS = new Uint8Array(16);

/** The tag of a ciphertext and its associated data (RFC 8439, 2.8). */
function aeadTag(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array, end: number): Uint8Array {
  const otk = chacha20Block(key, 0, nonce).subarray(0, 32);
  const mac = new Poly1305(otk);
  mac.update(aad);
  if (aad.length % 16 !== 0) mac.update(ZEROS, 0, 16 - (aad.length % 16));
  mac.update(ciphertext, 0, end);
  if (end % 16 !== 0) mac.update(ZEROS, 0, 16 - (end % 16));
  // Both lengths, 64 bits each, little-endian.
  const lengths = new Uint8Array(16);
  let a = aad.length;
  let n = end;
  for (let i = 0; i < 8; i++) {
    lengths[i] = a % 256;
    a = Math.floor(a / 256);
    lengths[i + 8] = n % 256;
    n = Math.floor(n / 256);
  }
  mac.update(lengths);
  return mac.finish();
}

const NO_AAD = new Uint8Array(0);

/** Encrypts and authenticates: the ciphertext, then its 16-byte tag. age
 *  uses no associated data; the RFC's own test vector does. */
export function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array = NO_AAD): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(plaintext.length + 16);
  out.set(chacha20(key, nonce, 1, plaintext), 0);
  out.set(aeadTag(key, nonce, aad, out, plaintext.length), plaintext.length);
  return out;
}

/** The plaintext of a sealed message, or null when its tag doesn't match:
 *  the wrong key, or a message that was changed. Nothing is decrypted then. */
export function open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array = NO_AAD): Uint8Array<ArrayBuffer> | null {
  if (sealed.length < 16) return null;
  const end = sealed.length - 16;
  const tag = aeadTag(key, nonce, aad, sealed, end);
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= tag[i] ^ sealed[end + i];
  if (diff !== 0) return null;
  return chacha20(key, nonce, 1, sealed.subarray(0, end)) as Uint8Array<ArrayBuffer>;
}
