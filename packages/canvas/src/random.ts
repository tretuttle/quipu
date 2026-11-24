/**
 * A seeded generator so hand-drawn strokes, ids and seeds are reproducible.
 * This package never reads `Math.random`: the host supplies one seed and
 * everything else derives from it.
 */
export interface Rng {
  /** A float in [0, 1). */
  readonly next: () => number;
  /** A non-zero 31-bit integer, the shape rough.js wants for a seed. */
  readonly nextSeed: () => number;
  /** An id: `prefix` plus 12 base-36 characters. */
  readonly nextId: (prefix?: string) => string;
}

/** Mulberry32: small, fast and good enough for seeds and ids. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    nextSeed: () => 1 + Math.floor(next() * 2147483646),
    nextId: (prefix = "") => {
      let id = prefix;
      for (let i = 0; i < 12; i += 1) id += Math.floor(next() * 36).toString(36);
      return id;
    },
  };
}
