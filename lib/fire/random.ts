// lib/fire/random.ts
//
// A small seeded random number generator, so a Monte Carlo run can be
// repeated exactly: the same seed draws the same months, and gives the same
// answer on every device and every visit.
//
// Mulberry32 (Tommy Ettinger's public-domain generator): 32 bits of state, a
// period of 2^32, and good enough statistical quality for drawing a few
// hundred thousand block starts. Not for anything secret.

/** A function returning uniform numbers in [0, 1), the same sequence for the same seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
