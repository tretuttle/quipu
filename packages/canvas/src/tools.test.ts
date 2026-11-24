import { describe, expect, it } from "@effect/vitest";

import { HANDLES, isTool, TOOL_KEYS, TOOL_LABELS, TOOLS } from "./tools.ts";

describe("tools", () => {
  it("every tool has a distinct single-letter key and a label", () => {
    const keys = TOOLS.map((tool) => TOOL_KEYS[tool]);
    expect(new Set(keys).size).toBe(TOOLS.length);
    for (const key of keys) expect(key).toMatch(/^[a-z]$/);
    for (const tool of TOOLS) expect(TOOL_LABELS[tool].length).toBeGreaterThan(0);
    expect(TOOLS).toHaveLength(13);
  });

  it("recognizes tool names and rejects anything else", () => {
    expect(isTool("rectangle")).toBe(true);
    expect(isTool("laser")).toBe(false);
    expect(isTool(3)).toBe(false);
  });

  it("offers eight resize handles and one rotation handle", () => {
    expect(HANDLES).toHaveLength(9);
    expect(HANDLES.filter((handle) => handle === "rotate")).toHaveLength(1);
  });
});
