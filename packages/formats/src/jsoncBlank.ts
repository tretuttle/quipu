/**
 * JSONC to JSON at the same byte offsets: comments and trailing commas become
 * spaces (line breaks inside a comment stay), and every other byte is copied.
 * The engine indexes the result as JSON, and because no byte moved, the index's
 * offsets are offsets in the JSONC file: the Source view paints and selects the
 * file's own text. Fed in chunks; a comma is held back until the next
 * significant byte says whether it is trailing.
 */
const SPACE = 0x20;
const LF = 0x0a;
const CR = 0x0d;
const TAB = 0x09;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const SLASH = 0x2f;
const STAR = 0x2a;
const COMMA = 0x2c;
const CLOSE_OBJECT = 0x7d;
const CLOSE_ARRAY = 0x5d;

const NORMAL = 0;
const STRING = 1;
const STRING_ESCAPE = 2;
/** After a `/` outside a string: the next byte says which comment it opens. */
const SLASH_SEEN = 3;
const LINE_COMMENT = 4;
const BLOCK_COMMENT = 5;
const BLOCK_STAR = 6;

const isWhitespace = (b: number) => b === SPACE || b === LF || b === CR || b === TAB;

export class JsoncBlanker {
  private readonly onOutput: (chunk: Uint8Array) => void;
  private state = NORMAL;
  /** A comma is waiting for the next significant byte; its byte is `held[0][0]` or in the chunk being read. */
  private pending = false;
  private held: Uint8Array[] = [];

  constructor(onOutput: (chunk: Uint8Array) => void) {
    this.onOutput = onOutput;
  }

  push(chunk: Uint8Array) {
    const buf = chunk.slice();
    let emitFrom = 0;
    let comma = -1;
    const resolve = (trailing: boolean) => {
      if (!this.pending) return;
      this.pending = false;
      if (trailing) {
        if (comma >= 0) buf[comma] = SPACE;
        else (this.held[0] as Uint8Array)[0] = SPACE;
      }
      for (const part of this.held) this.onOutput(part);
      this.held = [];
      comma = -1;
    };
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i] as number;
      switch (this.state) {
        case STRING:
          if (b === BACKSLASH) this.state = STRING_ESCAPE;
          else if (b === QUOTE) this.state = NORMAL;
          continue;
        case STRING_ESCAPE:
          this.state = STRING;
          continue;
        case LINE_COMMENT:
          if (b === LF) this.state = NORMAL;
          else if (b !== CR) buf[i] = SPACE;
          continue;
        case BLOCK_COMMENT:
        case BLOCK_STAR:
          if (this.state === BLOCK_STAR && b === SLASH) this.state = NORMAL;
          else this.state = b === STAR ? BLOCK_STAR : BLOCK_COMMENT;
          if (b !== LF && b !== CR) buf[i] = SPACE;
          continue;
        case SLASH_SEEN:
          if (b === SLASH) {
            buf[i] = SPACE;
            this.state = LINE_COMMENT;
            continue;
          }
          if (b === STAR) {
            buf[i] = SPACE;
            this.state = BLOCK_COMMENT;
            continue;
          }
          // A lone slash is not JSONC either; the blank it left makes the index report the byte after it.
          this.state = NORMAL;
          break;
      }
      if (isWhitespace(b)) continue;
      if (b === SLASH) {
        buf[i] = SPACE;
        this.state = SLASH_SEEN;
        continue;
      }
      resolve(b === CLOSE_OBJECT || b === CLOSE_ARRAY);
      if (b === QUOTE) this.state = STRING;
      else if (b === COMMA) {
        if (i > emitFrom) this.onOutput(buf.subarray(emitFrom, i));
        emitFrom = i;
        comma = i;
        this.pending = true;
      }
    }
    const rest = buf.subarray(emitFrom);
    if (rest.length === 0) return;
    if (this.pending) this.held.push(rest);
    else this.onOutput(rest);
  }

  /** The input ended: a comma still waiting was not trailing. */
  end() {
    this.pending = false;
    for (const part of this.held) this.onOutput(part);
    this.held = [];
  }
}
