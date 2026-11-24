import { describe, expect, it } from "vite-plus/test";

import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  isMacPlatform,
  isWindowsPlatform,
  matchesKeybindingShortcut,
  mergeWithDefaultKeybindings,
  parseKeybindingShortcut,
  parseKeybindingWhenExpression,
  type ShortcutEventLike,
} from "./keybindings.ts";

describe("platform detection", () => {
  it.each([
    ["MacIntel", true],
    ["macOS", true],
    ["iPhone", true],
    ["iPad", true],
    ["Win32", false],
    ["Linux x86_64", false],
    ["", false],
  ])("isMacPlatform(%j) is %s", (platform, expected) => {
    expect(isMacPlatform(platform)).toBe(expected);
  });

  it.each([
    ["Win32", true],
    ["Windows", true],
    ["win64", true],
    ["Darwin", false],
    ["MacIntel", false],
    ["Linux x86_64", false],
    ["", false],
  ])("isWindowsPlatform(%j) is %s", (platform, expected) => {
    expect(isWindowsPlatform(platform)).toBe(expected);
  });
});

describe("parseKeybindingShortcut", () => {
  it("reads modifiers and the key", () => {
    expect(parseKeybindingShortcut("mod+shift+k")).toEqual({
      key: "k",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      modKey: true,
    });
    expect(parseKeybindingShortcut("cmd+option+ctrl+]")).toEqual({
      key: "]",
      metaKey: true,
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
      modKey: false,
    });
  });

  it("reads a trailing plus as the plus key", () => {
    expect(parseKeybindingShortcut("mod++")?.key).toBe("+");
  });

  it("normalizes space and esc", () => {
    expect(parseKeybindingShortcut("space")?.key).toBe(" ");
    expect(parseKeybindingShortcut("mod+esc")?.key).toBe("escape");
  });

  it.each(["a+b", "mod+shift", "mod+a+", "+a"])("rejects %j", (value) => {
    expect(parseKeybindingShortcut(value)).toBeNull();
  });
});

describe("parseKeybindingWhenExpression", () => {
  it("binds ! tighter than &&, and && tighter than ||", () => {
    expect(parseKeybindingWhenExpression("!a && b || c")).toEqual({
      type: "or",
      left: {
        type: "and",
        left: { type: "not", node: { type: "identifier", name: "a" } },
        right: { type: "identifier", name: "b" },
      },
      right: { type: "identifier", name: "c" },
    });
  });

  it("honors parentheses", () => {
    expect(parseKeybindingWhenExpression("a && (b || c)")).toEqual({
      type: "and",
      left: { type: "identifier", name: "a" },
      right: {
        type: "or",
        left: { type: "identifier", name: "b" },
        right: { type: "identifier", name: "c" },
      },
    });
  });

  it.each(["", "a &&", "(a", "a b", "a & b", "&& a"])("rejects %j", (value) => {
    expect(parseKeybindingWhenExpression(value)).toBeNull();
  });

  it("refuses expressions nested deeper than the limit", () => {
    const tooDeep = `${"(".repeat(70)}a${")".repeat(70)}`;
    expect(parseKeybindingWhenExpression(tooDeep)).toBeNull();
    const fine = `${"(".repeat(10)}a${")".repeat(10)}`;
    expect(parseKeybindingWhenExpression(fine)).toEqual({ type: "identifier", name: "a" });
  });
});

describe("compileResolvedKeybindingsConfig", () => {
  it("skips rules whose key or when cannot be parsed", () => {
    const compiled = compileResolvedKeybindingsConfig([
      { key: "mod+b", command: "sidebar.toggle" },
      { key: "a+b", command: "rightPanel.toggle" },
      { key: "mod+k", command: "commandPalette.toggle", when: "&&" },
    ]);
    expect(compiled.map((rule) => rule.command)).toEqual(["sidebar.toggle"]);
  });

  it("keeps the last 256 rules", () => {
    const rules = Array.from({ length: 300 }, (_, index) => ({
      key: `mod+${index % 10}`,
      command: index === 299 ? ("commandPalette.toggle" as const) : ("sidebar.toggle" as const),
    }));
    const compiled = compileResolvedKeybindingsConfig(rules);
    expect(compiled).toHaveLength(256);
    expect(compiled.at(-1)?.command).toBe("commandPalette.toggle");
  });
});

describe("mergeWithDefaultKeybindings", () => {
  it("uses the defaults when the custom file is empty", () => {
    expect(mergeWithDefaultKeybindings([])).toEqual(DEFAULT_RESOLVED_KEYBINDINGS);
  });

  it("replaces every default of a command the custom file mentions", () => {
    const custom = compileResolvedKeybindingsConfig([
      { key: "mod+shift+b", command: "sidebar.toggle" },
    ]);
    const merged = mergeWithDefaultKeybindings(custom);
    const sidebar = merged.filter((rule) => rule.command === "sidebar.toggle");
    expect(sidebar).toHaveLength(1);
    expect(sidebar[0]?.shortcut.key).toBe("b");
    expect(sidebar[0]?.shortcut.shiftKey).toBe(true);
    expect(merged.filter((rule) => rule.command === "commandPalette.toggle")).toHaveLength(1);
  });
});

describe("matchesKeybindingShortcut", () => {
  const event = (overrides: Partial<ShortcutEventLike>): ShortcutEventLike => ({
    key: "k",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  });
  const modK = parseKeybindingShortcut("mod+k")!;

  it("treats mod as Command on macOS and Control elsewhere", () => {
    expect(matchesKeybindingShortcut(event({ metaKey: true }), modK, "MacIntel")).toBe(true);
    expect(matchesKeybindingShortcut(event({ ctrlKey: true }), modK, "MacIntel")).toBe(false);
    expect(matchesKeybindingShortcut(event({ ctrlKey: true }), modK, "Linux x86_64")).toBe(true);
    expect(matchesKeybindingShortcut(event({ metaKey: true }), modK, "Linux x86_64")).toBe(false);
  });

  it("matches the physical key when the layout produces another character", () => {
    const modB = parseKeybindingShortcut("mod+[")!;
    expect(
      matchesKeybindingShortcut(
        event({ key: "ü", code: "BracketLeft", ctrlKey: true }),
        modB,
        "Linux x86_64",
      ),
    ).toBe(true);
  });

  it("requires exactly the modifiers the shortcut names", () => {
    expect(
      matchesKeybindingShortcut(event({ ctrlKey: true, shiftKey: true }), modK, "Linux x86_64"),
    ).toBe(false);
  });
});
