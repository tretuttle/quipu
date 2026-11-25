/**
 * 64-bit hashing primitives for structural and HAR diffing.
 * Uses fast zero-allocation 32-bit `Math.imul` FNV-1a and SplitMix64 mixing
 * producing bit-exact 64-bit digests; zero external deps.
 */

const MASK_64 = 0xffff_ffff_ffff_ffffn;
const FNV_OFFSET_LO = 0x8422_2325 | 0;
const FNV_OFFSET_HI = 0xcbf2_9ce4 | 0;
const FNV_PRIME_LO = 0x1b3;

const FLOAT_BUF = new ArrayBuffer(8);
const FLOAT_VIEW = new DataView(FLOAT_BUF);
const FLOAT_BYTES = new Uint8Array(FLOAT_BUF);

/** Packs `(lo, hi)` 32-bit unsigned limbs into an unsigned 64-bit `bigint`. */
export const toBigInt64 = (lo: number, hi: number): bigint =>
  (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);

/** Writes SplitMix64(`hi:lo`) as `(lo, hi)` 32-bit uints into `out[outIdx], out[outIdx + 1]`. */
export function mix64Into(vLoIn: number, vHiIn: number, out: Uint32Array, outIdx: number): void {
  let vLo = ((vLoIn >>> 0) ^ ((vLoIn >>> 30) | (vHiIn << 2))) >>> 0;
  let vHi = ((vHiIn >>> 0) ^ (vHiIn >>> 30)) >>> 0;

  let x0 = vLo & 0xffff;
  let x1 = vLo >>> 16;
  let x2 = vHi & 0xffff;
  let x3 = vHi >>> 16;
  let p = x0 * 0xe5b9;
  const a0 = p & 0xffff;
  p = ((p / 65536) | 0) + x0 * 0x1ce4 + x1 * 0xe5b9;
  const a1 = p & 0xffff;
  p = ((p / 65536) | 0) + x0 * 0x476d + x1 * 0x1ce4 + x2 * 0xe5b9;
  const a2 = p & 0xffff;
  p = ((p / 65536) | 0) + x0 * 0xbf58 + x1 * 0x476d + x2 * 0x1ce4 + x3 * 0xe5b9;
  vLo = (a0 | (a1 << 16)) >>> 0;
  vHi = (a2 | ((p & 0xffff) << 16)) >>> 0;

  vLo = (vLo ^ ((vLo >>> 27) | (vHi << 5))) >>> 0;
  vHi = (vHi ^ (vHi >>> 27)) >>> 0;

  x0 = vLo & 0xffff;
  x1 = vLo >>> 16;
  x2 = vHi & 0xffff;
  x3 = vHi >>> 16;
  p = x0 * 0x11eb;
  const b0 = p & 0xffff;
  p = ((p / 65536) | 0) + x0 * 0x1331 + x1 * 0x11eb;
  const b1 = p & 0xffff;
  p = ((p / 65536) | 0) + x0 * 0x49bb + x1 * 0x1331 + x2 * 0x11eb;
  const b2 = p & 0xffff;
  p = ((p / 65536) | 0) + x0 * 0x94d0 + x1 * 0x49bb + x2 * 0x1331 + x3 * 0x11eb;
  vLo = (b0 | (b1 << 16)) >>> 0;
  vHi = (b2 | ((p & 0xffff) << 16)) >>> 0;

  out[outIdx] = (vLo ^ ((vLo >>> 31) | (vHi << 1))) >>> 0;
  out[outIdx + 1] = (vHi ^ (vHi >>> 31)) >>> 0;
}

/** Strong 64-bit finalizer (SplitMix64) so order-free sums do not collide on structure. */
export function mix64(x: bigint): bigint {
  let v = x & MASK_64;
  v = ((v ^ (v >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK_64;
  v = ((v ^ (v >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK_64;
  return (v ^ (v >> 31n)) & MASK_64;
}

/** 64-bit FNV-1a over a byte slice, seeded with `seed`. */
export function fnv1a64(bytes: Uint8Array, seed?: bigint): bigint {
  let lo = seed === undefined ? FNV_OFFSET_LO : Number(seed & 0xffff_ffffn) | 0;
  let hi = seed === undefined ? FNV_OFFSET_HI : Number((seed >> 32n) & 0xffff_ffffn) | 0;
  for (let i = 0; i < bytes.length; i++) {
    const uLo = (lo ^ (bytes[i] as number)) >>> 0;
    const t0 = (uLo & 0xffff) * FNV_PRIME_LO;
    const t1 = (uLo >>> 16) * FNV_PRIME_LO + (t0 >>> 16);
    lo = Math.imul(uLo, FNV_PRIME_LO) | 0;
    hi = ((t1 >>> 16) + ((uLo & 0xff_ffff) << 8) + Math.imul(hi, FNV_PRIME_LO)) | 0;
  }
  return toBigInt64(lo, hi);
}

/** Returns exact UTF-8 byte length of a JS string without allocating a `Uint8Array`. */
export function utf8ByteLength(text: string): number {
  let len = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) len += 1;
    else if (c < 0x800) len += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const c2 = text.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i++;
        len += 4;
      } else {
        len += 3;
      }
    } else len += 3;
  }
  return len;
}

/**
 * 64-bit FNV-1a over the UTF-8 encoding of a JS string without allocating an
 * intermediate `Uint8Array`. Matches `fnv1a64(new TextEncoder().encode(text), seed)` bit-for-bit.
 */
export function fnv1a64Utf8String(text: string, seed?: bigint): bigint {
  const hasher = new Hasher64(seed);
  hasher.writeUtf8String(text);
  return hasher.finish();
}

const FNV_PAIR = new Uint32Array(2);

function fnvUtf8IntoPair(loIn: number, hiIn: number, text: string): void {
  let lo = loIn | 0;
  let hi = hiIn | 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      const uLo = (lo ^ c) >>> 0;
      const t0 = (uLo & 0xffff) * FNV_PRIME_LO;
      const t1 = (uLo >>> 16) * FNV_PRIME_LO + (t0 >>> 16);
      lo = Math.imul(uLo, FNV_PRIME_LO) | 0;
      hi = ((t1 >>> 16) + ((uLo & 0xff_ffff) << 8) + Math.imul(hi, FNV_PRIME_LO)) | 0;
    } else if (c < 0x800) {
      const b0 = 0xc0 | (c >> 6);
      let uLo = (lo ^ b0) >>> 0;
      let t0 = (uLo & 0xffff) * FNV_PRIME_LO;
      let t1 = (uLo >>> 16) * FNV_PRIME_LO + (t0 >>> 16);
      lo = Math.imul(uLo, FNV_PRIME_LO) | 0;
      hi = ((t1 >>> 16) + ((uLo & 0xff_ffff) << 8) + Math.imul(hi, FNV_PRIME_LO)) | 0;
      const b1 = 0x80 | (c & 0x3f);
      uLo = (lo ^ b1) >>> 0;
      t0 = (uLo & 0xffff) * FNV_PRIME_LO;
      t1 = (uLo >>> 16) * FNV_PRIME_LO + (t0 >>> 16);
      lo = Math.imul(uLo, FNV_PRIME_LO) | 0;
      hi = ((t1 >>> 16) + ((uLo & 0xff_ffff) << 8) + Math.imul(hi, FNV_PRIME_LO)) | 0;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const c2 = text.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i++;
        const cp = 0x10000 + (((c - 0xd800) << 10) | (c2 - 0xdc00));
        const b0 = 0xf0 | (cp >> 18);
        const b1 = 0x80 | ((cp >> 12) & 0x3f);
        const b2 = 0x80 | ((cp >> 6) & 0x3f);
        const b3 = 0x80 | (cp & 0x3f);
        for (const b of [b0, b1, b2, b3]) {
          const uLo = (lo ^ b) >>> 0;
          const t0 = (uLo & 0xffff) * FNV_PRIME_LO;
          const t1 = (uLo >>> 16) * FNV_PRIME_LO + (t0 >>> 16);
          lo = Math.imul(uLo, FNV_PRIME_LO) | 0;
          hi = ((t1 >>> 16) + ((uLo & 0xff_ffff) << 8) + Math.imul(hi, FNV_PRIME_LO)) | 0;
        }
        continue;
      }
      for (const b of [0xef, 0xbf, 0xbd]) {
        const uLo = (lo ^ b) >>> 0;
        const t0 = (uLo & 0xffff) * FNV_PRIME_LO;
        const t1 = (uLo >>> 16) * FNV_PRIME_LO + (t0 >>> 16);
        lo = Math.imul(uLo, FNV_PRIME_LO) | 0;
        hi = ((t1 >>> 16) + ((uLo & 0xff_ffff) << 8) + Math.imul(hi, FNV_PRIME_LO)) | 0;
      }
    } else if (c >= 0xd800 && c <= 0xdfff) {
      for (const b of [0xef, 0xbf, 0xbd]) {
        const uLo = (lo ^ b) >>> 0;
        const t0 = (uLo & 0xffff) * FNV_PRIME_LO;
        const t1 = (uLo >>> 16) * FNV_PRIME_LO + (t0 >>> 16);
        lo = Math.imul(uLo, FNV_PRIME_LO) | 0;
        hi = ((t1 >>> 16) + ((uLo & 0xff_ffff) << 8) + Math.imul(hi, FNV_PRIME_LO)) | 0;
      }
    } else {
      const b0 = 0xe0 | (c >> 12);
      const b1 = 0x80 | ((c >> 6) & 0x3f);
      const b2 = 0x80 | (c & 0x3f);
      for (const b of [b0, b1, b2]) {
        const uLo = (lo ^ b) >>> 0;
        const t0 = (uLo & 0xffff) * FNV_PRIME_LO;
        const t1 = (uLo >>> 16) * FNV_PRIME_LO + (t0 >>> 16);
        lo = Math.imul(uLo, FNV_PRIME_LO) | 0;
        hi = ((t1 >>> 16) + ((uLo & 0xff_ffff) << 8) + Math.imul(hi, FNV_PRIME_LO)) | 0;
      }
    }
  }
  FNV_PAIR[0] = lo >>> 0;
  FNV_PAIR[1] = hi >>> 0;
}

/** Canonical mixed hash for a JSON string scalar into `out[outIdx], out[outIdx + 1]`. */
export function hashJsonStringMixedInto(text: string, out: Uint32Array, outIdx: number): void {
  const uLo0 = (FNV_OFFSET_LO ^ 3) >>> 0;
  const t00 = (uLo0 & 0xffff) * FNV_PRIME_LO;
  const t10 = (uLo0 >>> 16) * FNV_PRIME_LO + (t00 >>> 16);
  const lo0 = Math.imul(uLo0, FNV_PRIME_LO) | 0;
  const hi0 =
    ((t10 >>> 16) + ((uLo0 & 0xff_ffff) << 8) + Math.imul(FNV_OFFSET_HI, FNV_PRIME_LO)) | 0;
  fnvUtf8IntoPair(lo0, hi0, text);
  mix64Into(FNV_PAIR[0] as number, FNV_PAIR[1] as number, out, outIdx);
}

/** Canonical mixed hash for a JSON number scalar into `out[outIdx], out[outIdx + 1]`. */
export function hashJsonNumberMixedInto(value: number, out: Uint32Array, outIdx: number): void {
  const uLo0 = (FNV_OFFSET_LO ^ 4) >>> 0;
  const t00 = (uLo0 & 0xffff) * FNV_PRIME_LO;
  const t10 = (uLo0 >>> 16) * FNV_PRIME_LO + (t00 >>> 16);
  let lo = Math.imul(uLo0, FNV_PRIME_LO) | 0;
  let hi = ((t10 >>> 16) + ((uLo0 & 0xff_ffff) << 8) + Math.imul(FNV_OFFSET_HI, FNV_PRIME_LO)) | 0;
  if (Number.isFinite(value)) {
    FLOAT_VIEW.setFloat64(0, value === 0 ? 0 : value, true);
    for (let i = 0; i < 8; i++) {
      const uLo = (lo ^ (FLOAT_BYTES[i] as number)) >>> 0;
      const t0 = (uLo & 0xffff) * FNV_PRIME_LO;
      const t1 = (uLo >>> 16) * FNV_PRIME_LO + (t0 >>> 16);
      lo = Math.imul(uLo, FNV_PRIME_LO) | 0;
      hi = ((t1 >>> 16) + ((uLo & 0xff_ffff) << 8) + Math.imul(hi, FNV_PRIME_LO)) | 0;
    }
  }
  mix64Into(lo, hi, out, outIdx);
}

/** Canonical mixed hash for an object `(key, childHash)` member into `out[outIdx], out[outIdx + 1]`. */
export function hashObjectMemberMixedInto(
  key: string,
  childLo: number,
  childHi: number,
  out: Uint32Array,
  outIdx: number,
): void {
  fnvUtf8IntoPair(FNV_OFFSET_LO, FNV_OFFSET_HI, key);
  let lo = (FNV_PAIR[0] as number) | 0;
  let hi = (FNV_PAIR[1] as number) | 0;
  let w = childLo >>> 0;
  for (let i = 0; i < 4; i++) {
    const uLo = (lo ^ (w & 0xff)) >>> 0;
    const t0 = (uLo & 0xffff) * FNV_PRIME_LO;
    const t1 = (uLo >>> 16) * FNV_PRIME_LO + (t0 >>> 16);
    lo = Math.imul(uLo, FNV_PRIME_LO) | 0;
    hi = ((t1 >>> 16) + ((uLo & 0xff_ffff) << 8) + Math.imul(hi, FNV_PRIME_LO)) | 0;
    w >>>= 8;
  }
  w = childHi >>> 0;
  for (let i = 0; i < 4; i++) {
    const uLo = (lo ^ (w & 0xff)) >>> 0;
    const t0 = (uLo & 0xffff) * FNV_PRIME_LO;
    const t1 = (uLo >>> 16) * FNV_PRIME_LO + (t0 >>> 16);
    lo = Math.imul(uLo, FNV_PRIME_LO) | 0;
    hi = ((t1 >>> 16) + ((uLo & 0xff_ffff) << 8) + Math.imul(hi, FNV_PRIME_LO)) | 0;
    w >>>= 8;
  }
  mix64Into(lo, hi, out, outIdx);
}

/** Canonical mixed hash for container tag + 64-bit `(sumLo, sumHi)` into `out[outIdx], out[outIdx + 1]`. */
export function hashContainerSumMixedInto(
  tag: number,
  sumLo: number,
  sumHi: number,
  out: Uint32Array,
  outIdx: number,
): void {
  const uLo0 = (FNV_OFFSET_LO ^ (tag & 0xff)) >>> 0;
  const t00 = (uLo0 & 0xffff) * FNV_PRIME_LO;
  const t10 = (uLo0 >>> 16) * FNV_PRIME_LO + (t00 >>> 16);
  let lo = Math.imul(uLo0, FNV_PRIME_LO) | 0;
  let hi = ((t10 >>> 16) + ((uLo0 & 0xff_ffff) << 8) + Math.imul(FNV_OFFSET_HI, FNV_PRIME_LO)) | 0;
  let w = sumLo >>> 0;
  for (let i = 0; i < 4; i++) {
    const uLo = (lo ^ (w & 0xff)) >>> 0;
    const t0 = (uLo & 0xffff) * FNV_PRIME_LO;
    const t1 = (uLo >>> 16) * FNV_PRIME_LO + (t0 >>> 16);
    lo = Math.imul(uLo, FNV_PRIME_LO) | 0;
    hi = ((t1 >>> 16) + ((uLo & 0xff_ffff) << 8) + Math.imul(hi, FNV_PRIME_LO)) | 0;
    w >>>= 8;
  }
  w = sumHi >>> 0;
  for (let i = 0; i < 4; i++) {
    const uLo = (lo ^ (w & 0xff)) >>> 0;
    const t0 = (uLo & 0xffff) * FNV_PRIME_LO;
    const t1 = (uLo >>> 16) * FNV_PRIME_LO + (t0 >>> 16);
    lo = Math.imul(uLo, FNV_PRIME_LO) | 0;
    hi = ((t1 >>> 16) + ((uLo & 0xff_ffff) << 8) + Math.imul(hi, FNV_PRIME_LO)) | 0;
    w >>>= 8;
  }
  mix64Into(lo, hi, out, outIdx);
}

/** Canonical mixed hash for array tag `2` + `childCount` `(lo, hi)` word pairs at `words[startWord ..]`. */
export function hashArrayPairsMixedInto(
  words: Uint32Array,
  startWord: number,
  childCount: number,
  out: Uint32Array,
  outIdx: number,
): void {
  const uLo0 = (FNV_OFFSET_LO ^ 2) >>> 0;
  const t00 = (uLo0 & 0xffff) * FNV_PRIME_LO;
  const t10 = (uLo0 >>> 16) * FNV_PRIME_LO + (t00 >>> 16);
  let lo = Math.imul(uLo0, FNV_PRIME_LO) | 0;
  let hi = ((t10 >>> 16) + ((uLo0 & 0xff_ffff) << 8) + Math.imul(FNV_OFFSET_HI, FNV_PRIME_LO)) | 0;
  const endWord = startWord + childCount * 2;
  for (let idx = startWord; idx < endWord; idx++) {
    let w = (words[idx] as number) >>> 0;
    for (let k = 0; k < 4; k++) {
      const uLo = (lo ^ (w & 0xff)) >>> 0;
      const t0 = (uLo & 0xffff) * FNV_PRIME_LO;
      const t1 = (uLo >>> 16) * FNV_PRIME_LO + (t0 >>> 16);
      lo = Math.imul(uLo, FNV_PRIME_LO) | 0;
      hi = ((t1 >>> 16) + ((uLo & 0xff_ffff) << 8) + Math.imul(hi, FNV_PRIME_LO)) | 0;
      w >>>= 8;
    }
  }
  mix64Into(lo, hi, out, outIdx);
}

/** Incremental reusable 64-bit FNV-1a hasher (call `reset()` to reuse without allocation). */
export class Hasher64 {
  private lo: number;
  private hi: number;

  constructor(seed?: bigint) {
    this.lo = seed === undefined ? FNV_OFFSET_LO : Number(seed & 0xffff_ffffn) | 0;
    this.hi = seed === undefined ? FNV_OFFSET_HI : Number((seed >> 32n) & 0xffff_ffffn) | 0;
  }

  reset(seed?: bigint): this {
    this.lo = seed === undefined ? FNV_OFFSET_LO : Number(seed & 0xffff_ffffn) | 0;
    this.hi = seed === undefined ? FNV_OFFSET_HI : Number((seed >> 32n) & 0xffff_ffffn) | 0;
    return this;
  }

  private step(byte: number): void {
    const uLo = (this.lo ^ (byte & 0xff)) >>> 0;
    const t0 = (uLo & 0xffff) * FNV_PRIME_LO;
    const t1 = (uLo >>> 16) * FNV_PRIME_LO + (t0 >>> 16);
    this.lo = Math.imul(uLo, FNV_PRIME_LO) | 0;
    this.hi = ((t1 >>> 16) + ((uLo & 0xff_ffff) << 8) + Math.imul(this.hi, FNV_PRIME_LO)) | 0;
  }

  writeU8(byte: number): this {
    this.step(byte);
    return this;
  }

  writeU32(value: number): this {
    let v = value >>> 0;
    for (let i = 0; i < 4; i++) {
      this.step(v & 0xff);
      v >>>= 8;
    }
    return this;
  }

  writeU64(value: bigint): this {
    let lo = Number(value & 0xffff_ffffn) >>> 0;
    let hi = Number((value >> 32n) & 0xffff_ffffn) >>> 0;
    for (let i = 0; i < 4; i++) {
      this.step(lo & 0xff);
      lo >>>= 8;
    }
    for (let i = 0; i < 4; i++) {
      this.step(hi & 0xff);
      hi >>>= 8;
    }
    return this;
  }

  writeFloat64(value: number): this {
    FLOAT_VIEW.setFloat64(0, value === 0 ? 0 : value, true);
    return this.writeBytes(FLOAT_BYTES);
  }

  writeBytes(bytes: Uint8Array): this {
    let lo = this.lo;
    let hi = this.hi;
    for (let i = 0; i < bytes.length; i++) {
      const uLo = (lo ^ (bytes[i] as number)) >>> 0;
      const t0 = (uLo & 0xffff) * FNV_PRIME_LO;
      const t1 = (uLo >>> 16) * FNV_PRIME_LO + (t0 >>> 16);
      lo = Math.imul(uLo, FNV_PRIME_LO) | 0;
      hi = ((t1 >>> 16) + ((uLo & 0xff_ffff) << 8) + Math.imul(hi, FNV_PRIME_LO)) | 0;
    }
    this.lo = lo;
    this.hi = hi;
    return this;
  }

  writeUtf8String(text: string): this {
    fnvUtf8IntoPair(this.lo, this.hi, text);
    this.lo = (FNV_PAIR[0] as number) | 0;
    this.hi = (FNV_PAIR[1] as number) | 0;
    return this;
  }

  finish(): bigint {
    return toBigInt64(this.lo, this.hi);
  }

  finishMixed(): bigint {
    mix64Into(this.lo >>> 0, this.hi >>> 0, FNV_PAIR, 0);
    return toBigInt64(FNV_PAIR[0] as number, FNV_PAIR[1] as number);
  }
}

/** Canonical IEEE-754 64-bit pattern of a finite JS number (`-0` normalized to `+0`). */
export function float64Bits(value: number): bigint {
  FLOAT_VIEW.setFloat64(0, value === 0 ? 0 : value, true);
  return FLOAT_VIEW.getBigUint64(0, true);
}

/** 16-char lowercase hex representation of a 64-bit hash. */
export function hashToHex(hash: bigint): string {
  return (hash & MASK_64).toString(16).padStart(16, "0");
}

/** Modular 64-bit addition for order-free object member hashing. */
export function add64(a: bigint, b: bigint): bigint {
  return (a + b) & MASK_64;
}
