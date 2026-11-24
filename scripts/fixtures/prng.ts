/**
 * Seeded PRNG for the fixture generator: xoshiro128** on 32-bit words, seeded
 * through splitmix32, so one seed yields the same bytes on every platform.
 * Streams fork per entry, so an entry's randomness does not depend on how many
 * bytes the entries before it took. Nothing here uses Math.random.
 */
export interface Prng {
  readonly nextU32: () => number;
  /** Uniform float in [0, 1). */
  readonly float: () => number;
  /** Uniform integer in [0, n). */
  readonly int: (n: number) => number;
  /** Uniform integer in [lo, hi]. */
  readonly range: (lo: number, hi: number) => number;
  readonly pick: <T>(items: ReadonlyArray<T>) => T;
  readonly chance: (p: number) => boolean;
  /** Log-normal positive integer with the given median and spread. */
  readonly logNormal: (median: number, sigma: number) => number;
  /** A value drawn from measured quantiles, piecewise-linear in log space between them. */
  readonly quantile: (quantiles: Quantiles) => number;
  readonly fillWords: (target: Uint32Array) => void;
  readonly fork: (label: string) => Prng;
}

/** Measured quantiles of a positive size, as the HAR distributions report them. */
export interface Quantiles {
  readonly p10: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
  readonly p99: number;
}

const splitmix32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
};

const hashLabel = (label: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

const rotl = (x: number, k: number) => (x << k) | (x >>> (32 - k));

const QUANTILE_POINTS: ReadonlyArray<readonly [number, keyof Quantiles]> = [
  [0.1, "p10"],
  [0.25, "p25"],
  [0.5, "p50"],
  [0.75, "p75"],
  [0.9, "p90"],
  [0.99, "p99"],
];

export const createPrng = (seed: number): Prng => {
  const mix = splitmix32(seed);
  let s0 = mix();
  let s1 = mix();
  let s2 = mix();
  let s3 = mix();
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;

  const nextU32 = () => {
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);
    return result;
  };
  const float = () => nextU32() / 4294967296;
  const int = (n: number) => Math.floor(float() * n);
  const range = (lo: number, hi: number) => lo + int(hi - lo + 1);
  const pick = <T>(items: ReadonlyArray<T>): T => {
    const item = items[int(items.length)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  };
  const chance = (p: number) => float() < p;
  const gaussian = () => {
    const u = 1 - float();
    const v = float();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const logNormal = (median: number, sigma: number) =>
    Math.max(1, Math.round(median * Math.exp(sigma * gaussian())));
  const quantile = (q: Quantiles) => {
    const u = float();
    let [lowP, lowKey] = QUANTILE_POINTS[0] as readonly [number, keyof Quantiles];
    if (u <= lowP) return Math.max(1, Math.round(q[lowKey] * (u / lowP)));
    for (let k = 1; k < QUANTILE_POINTS.length; k++) {
      const [p, key] = QUANTILE_POINTS[k] as readonly [number, keyof Quantiles];
      if (u <= p) {
        const a = Math.log(Math.max(1, q[lowKey]));
        const b = Math.log(Math.max(1, q[key]));
        const t = (u - lowP) / (p - lowP);
        return Math.max(1, Math.round(Math.exp(a + (b - a) * t)));
      }
      lowP = p;
      lowKey = key;
    }
    return Math.max(1, Math.round(q.p99));
  };
  const fillWords = (target: Uint32Array) => {
    for (let i = 0; i < target.length; i++) target[i] = nextU32();
  };
  const fork = (label: string) => createPrng((nextU32() ^ hashLabel(label)) >>> 0);
  return { nextU32, float, int, range, pick, chance, logNormal, quantile, fillWords, fork };
};
