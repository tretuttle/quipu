import { describe, expect, it } from "@effect/vitest";

import { detectFormat } from "./detect.ts";

const utf8 = new TextEncoder();
const detect = (text: string) => detectFormat(utf8.encode(text));

describe("detectFormat", () => {
  it("calls a HAR envelope a HAR, whatever the whitespace around its first member", () => {
    expect(detect('{"log":{"version":"1.2"}}')).toBe("har");
    expect(detect('  \n{ "log" : {\n  "version": "1.2"')).toBe("har");
  });

  it("looks past a byte order mark", () => {
    expect(detectFormat(Uint8Array.of(0xef, 0xbb, 0xbf, ...utf8.encode('{"log":{}}')))).toBe("har");
    expect(detectFormat(Uint8Array.of(0xef, 0xbb, 0xbf, ...utf8.encode("[1]")))).toBe("json");
  });

  it("calls any other object or array JSON", () => {
    expect(detect('{"logs":{}}')).toBe("json");
    expect(detect('{"log":[1]}')).toBe("json");
    expect(detect('{"a":1,"log":{}}')).toBe("json");
    expect(detect("{}")).toBe("json");
    expect(detect("[1,2,3]")).toBe("json");
    expect(detect('{"log"')).toBe("json");
  });

  it("opens everything else as text, including an empty file", () => {
    for (const sample of ["", "   \n", "hello", "name,size\n1,2", "<a/>", "42", '"quoted"']) {
      expect(detect(sample)).toBe("text");
    }
  });
});
