export type Rng = () => number;

/** Small fast seeded PRNG (mulberry32). Returns floats in [0, 1). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Unpredictable seed from the platform's cryptographic RNG. */
export function randomSeed(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0];
}

/** Uniform shuffle using the platform's cryptographic RNG; used for real deals. */
export function cryptoRng(): Rng {
  const buf = new Uint32Array(64);
  let i = buf.length;
  return () => {
    if (i === buf.length) {
      globalThis.crypto.getRandomValues(buf);
      i = 0;
    }
    return buf[i++] / 4294967296;
  };
}
