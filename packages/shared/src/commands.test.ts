import { STATIC_KEYBINDING_COMMANDS } from "@quipu/contracts";
import { describe, expect, it } from "vite-plus/test";

import { COMMAND_GROUPS, COMMANDS, commandsByGroup, commandTitle } from "./commands.ts";
import { DEFAULT_KEYBINDINGS, parseKeybindingShortcut } from "./keybindings.ts";

/** Names that keep their capital letter inside a sentence-case title. */
const PROPER_WORDS = new Set(["Inspector", "Source", "A", "Z"]);

describe("command titles", () => {
  it("name every command once, in the order the contracts list them", () => {
    expect(Object.keys(COMMANDS)).toEqual([...STATIC_KEYBINDING_COMMANDS]);
    const titles = STATIC_KEYBINDING_COMMANDS.map(commandTitle);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("are sentence case", () => {
    for (const command of STATIC_KEYBINDING_COMMANDS) {
      const [first = "", ...rest] = commandTitle(command).split(" ");
      // "jq" is the tool's own lower-case name.
      expect(first === "jq" || /^[A-Z]/.test(first), command).toBe(true);
      for (const word of rest) {
        expect(PROPER_WORDS.has(word) || !/^[A-Z]/.test(word), `${command}: ${word}`).toBe(true);
      }
    }
  });

  it("list each group's commands together, in group order", () => {
    const grouped = commandsByGroup();
    expect(grouped.map((group) => group.title)).toEqual(COMMAND_GROUPS.map((group) => group.title));
    expect(grouped.flatMap((group) => group.commands)).toEqual([...STATIC_KEYBINDING_COMMANDS]);
  });
});

describe("default keybindings", () => {
  it("number the view shortcuts in the order of the view toggle", () => {
    const keyOf = (command: string) =>
      DEFAULT_KEYBINDINGS.find((rule) => rule.command === command)?.key;
    expect(["view.map", "view.tree", "view.source"].map(keyOf)).toEqual([
      "mod+alt+1",
      "mod+alt+2",
      "mod+alt+3",
    ]);
  });

  it("open the keyboard shortcuts on ?, outside text fields", () => {
    const rule = DEFAULT_KEYBINDINGS.find((candidate) => candidate.command === "keybindings.show");
    expect(rule?.when).toBe("!editableFocus");
    expect(parseKeybindingShortcut(rule?.key ?? "")).toMatchObject({ key: "?", shiftKey: true });
  });
});
