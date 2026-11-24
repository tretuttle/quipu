import { MAX_SLICE_BYTES, SliceTooLargeError } from "@quipu/contracts/engine";
import { describe, expect, it } from "@effect/vitest";

import { decodeUtf8, parseJsonSlice, readBlobSlice } from "./boundedSlice.ts";

const utf8 = new TextEncoder();

describe("boundedSlice", () => {
  it("decodes text up to the limit and refuses one byte more", () => {
    const text = "quipu 🧵 knots";
    const bytes = utf8.encode(text);
    expect(decodeUtf8(bytes, bytes.byteLength)).toBe(text);
    expect(() => decodeUtf8(bytes, bytes.byteLength - 1)).toThrow(SliceTooLargeError);
    expect(() => decodeUtf8(new Uint8Array(MAX_SLICE_BYTES + 1))).toThrow(SliceTooLargeError);
    expect(decodeUtf8(new Uint8Array(MAX_SLICE_BYTES)).length).toBe(MAX_SLICE_BYTES);
  });

  it("decodes bytes that live in a shared buffer, which TextDecoder alone refuses", () => {
    const shared = new SharedArrayBuffer(16);
    const view = new Uint8Array(shared);
    view.set(utf8.encode("knots 🧵"));
    expect(decodeUtf8(view.subarray(0, 6))).toBe("knots ");
    expect(() => decodeUtf8(view, 4)).toThrow(SliceTooLargeError);
  });

  it("never accepts a limit above MAX_SLICE_BYTES", () => {
    expect(() => decodeUtf8(new Uint8Array(4), MAX_SLICE_BYTES + 1)).toThrow(SliceTooLargeError);
    expect(() => decodeUtf8(new Uint8Array(4), 0)).toThrow(SliceTooLargeError);
    expect(() => decodeUtf8(new Uint8Array(4), Number.POSITIVE_INFINITY)).toThrow(
      SliceTooLargeError,
    );
  });

  it("parses JSON within the limit only", () => {
    const bytes = utf8.encode('{"a":[1,2,{"b":"c"}]}');
    expect(parseJsonSlice(bytes)).toEqual({ a: [1, 2, { b: "c" }] });
    expect(() => parseJsonSlice(bytes, 8)).toThrow(SliceTooLargeError);
    const error = (() => {
      try {
        parseJsonSlice(bytes, 8);
      } catch (e) {
        return e as SliceTooLargeError;
      }
      return undefined;
    })();
    expect(error?.bytes).toBe(bytes.byteLength);
    expect(error?.limit).toBe(8);
  });

  it("reads a bounded Blob slice and refuses a larger one", async () => {
    const blob = new Blob([utf8.encode("0123456789")]);
    expect(Array.from(await readBlobSlice(blob, 2, 5))).toEqual([0x32, 0x33, 0x34]);
    expect(Array.from(await readBlobSlice(blob, 8, 100, 4))).toEqual([0x38, 0x39]);
    await expect(readBlobSlice(blob, 0, 10, 9)).rejects.toBeInstanceOf(SliceTooLargeError);
  });
});
