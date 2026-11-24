import { describe, expect, it } from "vite-plus/test";

import { pointerToPath } from "./jsonPointer.ts";

describe("a JSON Pointer as a path", () => {
  it("reads the root, names, indexes and escapes", () => {
    expect(pointerToPath("")).toBe("$");
    expect(pointerToPath("/a/b/1")).toBe("$.a.b[1]");
    expect(pointerToPath("/rows/0/first name")).toBe('$.rows[0]["first name"]');
    expect(pointerToPath("/a~1b/c~0d")).toBe('$["a/b"]["c~d"]');
    expect(pointerToPath("/")).toBe('$[""]');
    expect(pointerToPath("/007")).toBe('$["007"]');
  });
});
