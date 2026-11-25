import { MAX_SLICE_BYTES } from "@quipu/contracts/engine";

import { decodeUtf8, parseJsonStringSlice } from "./boundedSlice.ts";
import type { ByteSource } from "./source.ts";

const isWsByte = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
const STREAM_WINDOW_BYTES = 8 * 1024 * 1024;
const SMALL_TOKEN_LIMIT = 1024 * 1024;

/**
 * Streams a byte window `[start, end)` belonging to the interior of a JSON array
 * (such as one BucketAnchor span of `.log.entries`), splitting top-level elements
 * in order using bounded `stepBytes <= MAX_SLICE_BYTES` reads via `readStep`.
 */
export async function scanArrayWindowElements<T>(
  src: ByteSource,
  start: number,
  end: number,
  baseIndex: number,
  stepBytes: number,
  readStep: (src: ByteSource, from: number, to: number) => Promise<Uint8Array>,
  onElement: (
    index: number,
    elemStart: number,
    elemEnd: number,
    bytes: Uint8Array | null,
  ) => T | Promise<T>,
): Promise<{ readonly items: T[]; readonly count: number }> {
  const items: T[] = [];
  if (end <= start) return { items, count: 0 };

  const clampedStep = Math.max(64 * 1024, Math.min(stepBytes, MAX_SLICE_BYTES));
  let elemIndex = baseIndex;
  let inString = false;
  let trailingBackslashOdd = false;
  let depth = 0;
  let elemStart = -1;
  let elemIsScalar = false;

  const emit = async (
    s: number,
    e: number,
    chunkStart: number,
    chunkBuf: Uint8Array,
  ): Promise<void> => {
    const len = e - s;
    let slice: Uint8Array | null;
    if (len > MAX_SLICE_BYTES) {
      slice = null;
    } else if (s >= chunkStart) {
      slice = chunkBuf.subarray(s - chunkStart, e - chunkStart);
    } else {
      slice = await src.read(s, e);
    }
    items.push(await onElement(elemIndex++, s, e, slice));
  };

  for (let offset = start; offset < end; offset += clampedStep) {
    const chunkEnd = Math.min(end, offset + clampedStep);
    const buf = await readStep(src, offset, chunkEnd);
    const len = buf.length;
    let i = 0;

    while (i < len) {
      if (inString) {
        const q = buf.indexOf(0x22, i);
        if (q < 0) {
          let bs = 0;
          let k = len - 1;
          while (k >= i && buf[k] === 0x5c) {
            bs++;
            k--;
          }
          if (k < i && i === 0) {
            trailingBackslashOdd = trailingBackslashOdd ? (bs & 1) === 0 : (bs & 1) === 1;
          } else {
            trailingBackslashOdd = (bs & 1) === 1;
          }
          i = len;
          break;
        }
        let bs = 0;
        let k = q - 1;
        while (k >= i && buf[k] === 0x5c) {
          bs++;
          k--;
        }
        const escaped =
          k < i && i === 0
            ? trailingBackslashOdd
              ? (bs & 1) === 0
              : (bs & 1) === 1
            : (bs & 1) === 1;
        trailingBackslashOdd = false;
        i = q + 1;
        if (!escaped) {
          inString = false;
          if (depth === 0 && elemStart >= 0) {
            await emit(elemStart, offset + q + 1, offset, buf);
            elemStart = -1;
            elemIsScalar = false;
          }
        }
        continue;
      }

      const b = buf[i] as number;

      if (elemIsScalar && depth === 0) {
        if (isWsByte(b) || b === 0x2c || b === 0x5d) {
          await emit(elemStart, offset + i, offset, buf);
          elemStart = -1;
          elemIsScalar = false;
          if (b === 0x5d) return { items, count: items.length };
          i++;
          continue;
        }
        i++;
        continue;
      }

      if (b === 0x22) {
        if (depth === 0 && elemStart < 0) {
          elemStart = offset + i;
          elemIsScalar = false;
        }
        inString = true;
        trailingBackslashOdd = false;
        i++;
        continue;
      }

      if (b === 0x7b || b === 0x5b) {
        if (depth === 0 && elemStart < 0) {
          elemStart = offset + i;
          elemIsScalar = false;
        }
        depth++;
        i++;
        continue;
      }

      if (b === 0x7d || b === 0x5d) {
        if (depth === 0) {
          return { items, count: items.length };
        }
        depth--;
        i++;
        if (depth === 0 && elemStart >= 0) {
          await emit(elemStart, offset + i, offset, buf);
          elemStart = -1;
          elemIsScalar = false;
        }
        continue;
      }

      if (depth === 0 && !isWsByte(b) && b !== 0x2c) {
        elemStart = offset + i;
        elemIsScalar = true;
      }
      i++;
    }
  }

  if (elemIsScalar && depth === 0 && elemStart >= 0 && !inString) {
    const s = elemStart;
    const len = end - s;
    const slice = len > MAX_SLICE_BYTES ? null : await src.read(s, end);
    items.push(await onElement(elemIndex++, s, end, slice));
  }

  return { items, count: items.length };
}

/**
 * Bounded `<= 4 MiB` window cursor over a `ByteSource` `[rangeStart, rangeEnd)`,
 * owning its own private `ArrayBuffer` so callers inside `scanArrayWindowElements`
 * never clobber the outer worker `stepBuffer`.
 */
export class SourceJsonCursor {
  private readonly src: ByteSource;
  readonly rangeEnd: number;
  private cursorBuf = new ArrayBuffer(0);
  private buf: Uint8Array = new Uint8Array(0);
  private winStart = 0;
  private winEnd = 0;

  constructor(src: ByteSource, rangeStart: number, rangeEnd: number) {
    this.src = src;
    this.winStart = rangeStart;
    this.rangeEnd = rangeEnd;
  }

  async readChunk(from: number, to: number): Promise<Uint8Array> {
    const res = await this.src.readInto(from, to, this.cursorBuf);
    this.cursorBuf = res.buffer;
    this.winStart = from;
    this.winEnd = from + res.bytes.length;
    this.buf = res.bytes;
    return res.bytes;
  }

  private async ensure(pos: number): Promise<boolean> {
    if (pos >= this.rangeEnd) return false;
    if (pos >= this.winStart && pos < this.winEnd) return true;
    const to = Math.min(this.rangeEnd, pos + STREAM_WINDOW_BYTES);
    await this.readChunk(pos, to);
    return this.buf.length > 0;
  }

  async byteAt(pos: number): Promise<number> {
    if (!(await this.ensure(pos))) return -1;
    return this.buf[pos - this.winStart] as number;
  }

  async skipWs(pos: number): Promise<number> {
    let p = pos;
    while (p < this.rangeEnd) {
      if (!(await this.ensure(p))) return p;
      const localEnd = this.winEnd - this.winStart;
      let li = p - this.winStart;
      while (li < localEnd && isWsByte(this.buf[li] as number)) li++;
      p = this.winStart + li;
      if (li < localEnd) return p;
    }
    return p;
  }

  async skipString(
    quoteStart: number,
  ): Promise<{ readonly end: number; readonly hasEscape: boolean } | null> {
    let p = quoteStart + 1;
    let hasEscape = false;
    let trailingBackslashOdd = false;
    while (p < this.rangeEnd) {
      if (!(await this.ensure(p))) return null;
      const localStart = p - this.winStart;
      const q = this.buf.indexOf(0x22, localStart);
      if (q < 0) {
        let bs = 0;
        let k = this.buf.length - 1;
        while (k >= localStart && this.buf[k] === 0x5c) {
          bs++;
          k--;
        }
        if (bs > 0) hasEscape = true;
        if (k < localStart && localStart === 0) {
          trailingBackslashOdd = trailingBackslashOdd ? (bs & 1) === 0 : (bs & 1) === 1;
        } else {
          trailingBackslashOdd = (bs & 1) === 1;
        }
        p = this.winEnd;
        continue;
      }
      let bs = 0;
      let k = q - 1;
      while (k >= localStart && this.buf[k] === 0x5c) {
        bs++;
        k--;
      }
      if (bs > 0 || (!hasEscape && this.buf.subarray(localStart, q).includes(0x5c))) {
        hasEscape = true;
      }
      const escaped =
        k < localStart && localStart === 0
          ? trailingBackslashOdd
            ? (bs & 1) === 0
            : (bs & 1) === 1
          : (bs & 1) === 1;
      trailingBackslashOdd = false;
      const absQ = this.winStart + q;
      if (!escaped) return { end: absQ + 1, hasEscape };
      hasEscape = true;
      p = absQ + 1;
    }
    return null;
  }

  async skipValue(pos: number): Promise<number> {
    const first = await this.byteAt(pos);
    if (first < 0) return -1;
    if (first === 0x22) {
      const s = await this.skipString(pos);
      return s === null ? -1 : s.end;
    }
    if (first !== 0x7b && first !== 0x5b) {
      let p = pos;
      while (p < this.rangeEnd) {
        if (!(await this.ensure(p))) return p;
        const localEnd = this.winEnd - this.winStart;
        let li = p - this.winStart;
        while (li < localEnd) {
          const b = this.buf[li] as number;
          if (b === 0x2c || b === 0x7d || b === 0x5d || isWsByte(b)) {
            return this.winStart + li;
          }
          li++;
        }
        p = this.winEnd;
      }
      return p;
    }
    let depth = 1;
    let p = pos + 1;
    while (p < this.rangeEnd && depth > 0) {
      if (!(await this.ensure(p))) return -1;
      let li = p - this.winStart;
      const localEnd = this.winEnd - this.winStart;
      while (li < localEnd && depth > 0) {
        const b = this.buf[li] as number;
        if (b === 0x22) {
          const s = await this.skipString(this.winStart + li);
          if (s === null) return -1;
          p = s.end;
          if (!(await this.ensure(p))) return depth === 0 ? p : -1;
          li = p - this.winStart;
          continue;
        }
        if (b === 0x7b || b === 0x5b) depth++;
        else if (b === 0x7d || b === 0x5d) depth--;
        li++;
        if (depth === 0) return this.winStart + li;
      }
      p = this.winStart + li;
    }
    return depth === 0 ? p : -1;
  }

  async readBounded(
    start: number,
    end: number,
    limit = MAX_SLICE_BYTES,
  ): Promise<Uint8Array | null> {
    const len = end - start;
    if (len < 0 || len > limit) return null;
    if (start >= this.winStart && end <= this.winEnd) {
      return this.buf.subarray(start - this.winStart, end - this.winStart).slice();
    }
    return this.src.read(start, end);
  }

  async readStringScalar(
    pos: number,
  ): Promise<{ readonly value: string | null; readonly nextPos: number } | null> {
    const b = await this.byteAt(pos);
    if (b < 0) return null;
    if (b !== 0x22) {
      const end = await this.skipValue(pos);
      return end < 0 ? null : { value: null, nextPos: end };
    }
    const str = await this.skipString(pos);
    if (str === null) return null;
    const len = str.end - pos;
    if (len > SMALL_TOKEN_LIMIT) return { value: null, nextPos: str.end };
    const slice = await this.readBounded(pos, str.end, SMALL_TOKEN_LIMIT);
    if (slice === null) return { value: null, nextPos: str.end };
    try {
      const value = str.hasEscape
        ? parseJsonStringSlice(slice, SMALL_TOKEN_LIMIT)
        : decodeUtf8(slice.subarray(1, slice.length - 1), SMALL_TOKEN_LIMIT);
      return { value, nextPos: str.end };
    } catch {
      return null;
    }
  }

  async readNumberScalar(
    pos: number,
  ): Promise<{ readonly value: number | null; readonly nextPos: number } | null> {
    const after = await this.skipValue(pos);
    if (after < 0) return null;
    const len = after - pos;
    if (len <= 0 || len > 128) return { value: null, nextPos: after };
    const first = await this.byteAt(pos);
    if (first !== 0x2d && (first < 0x30 || first > 0x39)) {
      return { value: null, nextPos: after };
    }
    const slice = await this.readBounded(pos, after, 128);
    if (slice === null) return { value: null, nextPos: after };
    const n = Number(decodeUtf8(slice, 128));
    return { value: Number.isFinite(n) ? n : null, nextPos: after };
  }

  async walkObject(
    objPos: number,
    onField: (key: string, valPos: number) => Promise<number | null>,
  ): Promise<number> {
    if ((await this.byteAt(objPos)) !== 0x7b) return -1;
    let cur = await this.skipWs(objPos + 1);
    if ((await this.byteAt(cur)) === 0x7d) return cur + 1;
    while (cur < this.rangeEnd) {
      if ((await this.byteAt(cur)) !== 0x22) return -1;
      const ks = await this.skipString(cur);
      if (ks === null) return -1;
      const kLen = ks.end - cur;
      let key = "";
      if (kLen <= 256) {
        const kBytes = await this.readBounded(cur, ks.end, 256);
        if (kBytes) {
          key = ks.hasEscape
            ? parseJsonStringSlice(kBytes, 256)
            : decodeUtf8(kBytes.subarray(1, kBytes.length - 1), 256);
        }
      }
      cur = await this.skipWs(ks.end);
      if ((await this.byteAt(cur)) !== 0x3a) return -1;
      cur = await this.skipWs(cur + 1);
      const next = await onField(key, cur);
      if (next === null || next < 0) return -1;
      cur = await this.skipWs(next);
      const sep = await this.byteAt(cur);
      if (sep === 0x7d) return cur + 1;
      if (sep !== 0x2c) return -1;
      cur = await this.skipWs(cur + 1);
    }
    return -1;
  }
}
