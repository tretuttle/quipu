/**
 * A growable byte buffer the emitters write into. Converters never build a JS
 * string for output: bytes are copied from the source, ASCII punctuation is
 * written byte by byte, and decoded text is encoded in place. `take` hands the
 * bytes out and keeps the buffer, so a worker reuses one writer for every region.
 */
const encoder = new TextEncoder();

export class ByteWriter {
  private buffer: Uint8Array;
  private used = 0;

  constructor(initial = 1 << 16) {
    this.buffer = new Uint8Array(Math.max(16, initial));
  }

  get length() {
    return this.used;
  }

  private ensure(extra: number) {
    const needed = this.used + extra;
    if (needed <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < needed) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.used));
    this.buffer = next;
  }

  byte(b: number) {
    if (this.used === this.buffer.length) this.ensure(1);
    this.buffer[this.used++] = b;
  }

  bytes(src: Uint8Array, from: number, to: number) {
    const n = to - from;
    if (n <= 0) return;
    this.ensure(n);
    this.buffer.set(src.subarray(from, to), this.used);
    this.used += n;
  }

  /** ASCII-only text: punctuation, indentation, numbers. */
  ascii(text: string) {
    this.ensure(text.length);
    for (let i = 0; i < text.length; i++) this.buffer[this.used++] = text.charCodeAt(i);
  }

  /** Any text, UTF-8 encoded in place. */
  text(text: string) {
    this.ensure(text.length * 3);
    const { written } = encoder.encodeInto(text, this.buffer.subarray(this.used));
    this.used += written;
  }

  spaces(n: number) {
    this.ensure(n);
    this.buffer.fill(0x20, this.used, this.used + n);
    this.used += n;
  }

  /** A view of what was written. Valid until the next write or `reset`. */
  view(): Uint8Array {
    return this.buffer.subarray(0, this.used);
  }

  /** An exact-size copy that can be transferred; the writer is emptied. */
  take(): Uint8Array {
    const out = this.buffer.slice(0, this.used);
    this.used = 0;
    return out;
  }

  reset() {
    this.used = 0;
  }

  /** Removes the last `n` bytes (a speculative separator that turned out not to be needed). */
  truncate(n: number) {
    this.used = Math.max(0, this.used - n);
  }
}
