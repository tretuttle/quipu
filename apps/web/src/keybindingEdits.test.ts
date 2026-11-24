import type { KeybindingsConfig } from "@quipu/contracts";
import { describe, expect, it } from "vite-plus/test";

import { removeRule, upsertRule } from "./keybindingEdits";

const SIDEBAR_DEFAULT = { key: "mod+b", command: "sidebar.toggle" } as const;

describe("what the editor writes to keybindings.json", () => {
  it("writes only the changed rule when a default key is rebound", () => {
    const saved = upsertRule(
      [],
      { key: "mod+shift+y", command: "sidebar.toggle" },
      SIDEBAR_DEFAULT,
    );
    expect(saved).toEqual([{ key: "mod+shift+y", command: "sidebar.toggle" }]);
  });

  it("keeps a command's default beside a binding that is added for it", () => {
    const saved = upsertRule([], { key: "mod+shift+y", command: "sidebar.toggle" });
    expect(saved).toEqual([SIDEBAR_DEFAULT, { key: "mod+shift+y", command: "sidebar.toggle" }]);
  });

  it("writes a when clause with the rule", () => {
    const saved = upsertRule(
      [],
      { key: "mod+b", command: "sidebar.toggle", when: "!editableFocus" },
      SIDEBAR_DEFAULT,
    );
    expect(saved).toEqual([{ key: "mod+b", command: "sidebar.toggle", when: "!editableFocus" }]);
  });

  it("replaces the edited rule instead of leaving it beside the new one", () => {
    const first: KeybindingsConfig = upsertRule(
      [],
      { key: "mod+shift+y", command: "sidebar.toggle" },
      SIDEBAR_DEFAULT,
    );
    const second = upsertRule(
      first,
      { key: "mod+shift+u", command: "sidebar.toggle" },
      { key: "mod+shift+y", command: "sidebar.toggle" },
    );
    expect(second).toEqual([{ key: "mod+shift+u", command: "sidebar.toggle" }]);
  });

  it("leaves the file without the command once its rules are the defaults again", () => {
    const rebound = upsertRule(
      [{ key: "mod+shift+k", command: "commandPalette.toggle" }],
      { key: "mod+shift+y", command: "sidebar.toggle" },
      SIDEBAR_DEFAULT,
    );
    const restored = upsertRule(rebound, SIDEBAR_DEFAULT, {
      key: "mod+shift+y",
      command: "sidebar.toggle",
    });
    expect(restored).toEqual([{ key: "mod+shift+k", command: "commandPalette.toggle" }]);
  });

  it("gives a command its defaults back when its last saved rule is removed", () => {
    const removed = removeRule([{ key: "mod+shift+y", command: "sidebar.toggle" }], {
      key: "mod+shift+y",
      command: "sidebar.toggle",
    });
    expect(removed).toEqual([]);
  });

  it("drops the command from the file when removing an added binding leaves only its default", () => {
    const saved = upsertRule([], { key: "mod+shift+y", command: "sidebar.toggle" });
    const removed = removeRule(saved, { key: "mod+shift+y", command: "sidebar.toggle" });
    expect(removed).toEqual([]);
  });
});
