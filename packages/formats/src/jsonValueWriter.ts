// @effect-diagnostics preferSchemaOverJson:off - JSON.stringify of a single string or finite number is the JSON text of that scalar; nothing here round-trips an untyped document.
/**
 * Writes a JS value as JSON bytes in bounded chunks. Sources that can only be
 * read whole (YAML, TOML, at most 256 MiB of text) come through here on their way
 * to every target, so the rest of the converters see one thing: JSON bytes.
 * Nothing recurses; a value as deep as the parser allowed costs a typed-array
 * stack, and the first thing JSON cannot hold is an error with its pointer.
 */
import { UnrepresentableError } from "./errors.ts";
import type { ConvertFormat } from "./formatIds.ts";
import { ByteWriter } from "./byteWriter.ts";

const escapePointer = (s: string) => s.replaceAll("~", "~0").replaceAll("/", "~1");

interface Frame {
  readonly value: unknown;
  readonly keys: string[] | undefined;
  index: number;
  readonly isArray: boolean;
}

export interface JsonWriteOptions {
  readonly from: ConvertFormat;
  readonly flushBytes?: number;
}

/** What a source value turns into: Dates as ISO text, big integers as numbers. */
const normalize = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  return value;
};

export const writeJsonValue = (
  value: unknown,
  write: (chunk: Uint8Array) => void,
  options: JsonWriteOptions,
) => {
  const out = new ByteWriter(1 << 16);
  const flushAt = options.flushBytes ?? 1 << 20;
  const path: string[] = [];
  const fail = (reason: "non-finite-number" | "invalid-input", detail: string): never => {
    throw new UnrepresentableError({
      from: options.from,
      to: "json",
      reason,
      pointer: path.map((p) => `/${escapePointer(p)}`).join(""),
      detail,
    });
  };
  const scalar = (v: unknown) => {
    if (v === null || v === undefined) out.ascii("null");
    else if (typeof v === "boolean") out.ascii(v ? "true" : "false");
    else if (typeof v === "number") {
      if (!Number.isFinite(v)) fail("non-finite-number", `${String(v)} has no JSON form`);
      out.ascii(JSON.stringify(v));
    } else if (typeof v === "bigint") out.ascii(v.toString());
    else if (typeof v === "string") out.text(JSON.stringify(v));
    else fail("invalid-input", `a ${typeof v} value has no JSON form`);
  };
  const open = (v: unknown): Frame | undefined => {
    const n = normalize(v);
    if (Array.isArray(n)) {
      out.byte(0x5b);
      return { value: n, keys: undefined, index: 0, isArray: true };
    }
    if (n !== null && typeof n === "object" && !(n instanceof Uint8Array)) {
      out.byte(0x7b);
      return { value: n, keys: Object.keys(n), index: 0, isArray: false };
    }
    scalar(n);
    return undefined;
  };

  const root = open(value);
  if (root) {
    const stack: Frame[] = [root];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as Frame;
      const size = frame.isArray
        ? (frame.value as unknown[]).length
        : (frame.keys as string[]).length;
      if (frame.index >= size) {
        out.byte(frame.isArray ? 0x5d : 0x7d);
        stack.pop();
        path.pop();
        if (out.length >= flushAt) write(out.take());
        continue;
      }
      if (frame.index > 0) out.byte(0x2c);
      let child: unknown;
      if (frame.isArray) {
        child = (frame.value as unknown[])[frame.index];
        path[stack.length - 1] = String(frame.index);
      } else {
        const key = (frame.keys as string[])[frame.index] as string;
        out.text(JSON.stringify(key));
        out.byte(0x3a);
        child = (frame.value as Record<string, unknown>)[key];
        path[stack.length - 1] = key;
      }
      frame.index++;
      const next = open(child);
      if (next) {
        stack.push(next);
        path.length = stack.length - 1 + 1;
      }
      if (out.length >= flushAt) write(out.take());
    }
  }
  if (out.length > 0) write(out.take());
};
