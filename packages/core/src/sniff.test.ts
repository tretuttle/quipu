import { describe, expect, it } from "@effect/vitest";

import { kindOfMime, looksLikeText, sniffBytes } from "./sniff.ts";
import { gzip, jpegLike, PNG_1X1, SVG_TEXT } from "./testing/decoderSamples.ts";

const utf8 = new TextEncoder();

describe("sniffBytes", () => {
  it("names the formats HAR bodies carry by their first bytes", async () => {
    expect(sniffBytes(PNG_1X1)).toEqual({ kind: "image", mime: "image/png" });
    expect(sniffBytes(jpegLike(64))).toEqual({ kind: "image", mime: "image/jpeg" });
    expect(sniffBytes(utf8.encode("GIF89a\x01\x00"))).toEqual({ kind: "image", mime: "image/gif" });
    expect(sniffBytes(utf8.encode("RIFF\x24\x00\x00\x00WEBPVP8 "))).toEqual({
      kind: "image",
      mime: "image/webp",
    });
    expect(sniffBytes(utf8.encode(SVG_TEXT))).toEqual({ kind: "image", mime: "image/svg+xml" });
    expect(sniffBytes(utf8.encode(`<?xml version="1.0"?>\n${SVG_TEXT}`))).toEqual({
      kind: "image",
      mime: "image/svg+xml",
    });
    expect(sniffBytes(await gzip(utf8.encode("x")))).toEqual({
      kind: "gzip",
      mime: "application/gzip",
    });
    expect(sniffBytes(utf8.encode("%PDF-1.7\n"))).toEqual({
      kind: "binary",
      mime: "application/pdf",
    });
  });

  it("calls UTF-8 text text, and names JSON, HTML and XML within it", () => {
    expect(sniffBytes(utf8.encode("just some words, with ünïcödé"))).toEqual({
      kind: "text",
      mime: "text/plain",
    });
    expect(sniffBytes(utf8.encode('  {"a":1}'))).toEqual({
      kind: "text",
      mime: "application/json",
    });
    expect(sniffBytes(utf8.encode("<!DOCTYPE html><html>"))).toEqual({
      kind: "text",
      mime: "text/html",
    });
    expect(sniffBytes(utf8.encode("<?xml version='1.0'?><a/>"))).toEqual({
      kind: "text",
      mime: "application/xml",
    });
  });

  it("calls bytes that are not UTF-8 binary", () => {
    expect(sniffBytes(Uint8Array.of(0x00, 0xff, 0xfe, 0x80, 0x81, 0x90)).kind).toBe("binary");
    expect(looksLikeText(Uint8Array.of(0xc3))).toBe(true);
    expect(looksLikeText(Uint8Array.of(0xc3, 0x28))).toBe(false);
    expect(looksLikeText(new Uint8Array(0))).toBe(false);
  });

  it("reads a declared type when the bytes have none", () => {
    expect(kindOfMime("image/webp")).toBe("image");
    expect(kindOfMime("text/html; charset=utf-8")).toBe("text");
    expect(kindOfMime("application/vnd.api+json")).toBe("text");
    expect(kindOfMime("video/mp4")).toBe("binary");
  });
});
