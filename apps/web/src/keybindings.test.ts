import { assert, describe, it } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeWithDefaultKeybindings,
  parseKeybindingShortcut,
} from "@quipu/shared/keybindings";

import {
  effectiveShortcutsForCommand,
  formatShortcutLabel,
  formatShortcutParts,
  resolveShortcutCommand,
  shortcutLabelForCommand,
  type ShortcutEventLike,
} from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "k",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

const LINUX = "Linux x86_64";
const MAC = "MacIntel";

describe("resolveShortcutCommand", () => {
  it("resolves the default chords", () => {
    const ctrl = { platform: LINUX };
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "k", ctrlKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        ctrl,
      ),
      "commandPalette.toggle",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "b", ctrlKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        ctrl,
      ),
      "sidebar.toggle",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "2", ctrlKey: true, altKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        ctrl,
      ),
      "view.tree",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "3", ctrlKey: true, altKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        ctrl,
      ),
      "view.source",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "4", ctrlKey: true, altKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        ctrl,
      ),
      null,
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "o", ctrlKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        ctrl,
      ),
      "document.open",
    );
    // The panel's tabs take shift, and only answer while the panel shows.
    const source = event({ key: "@", code: "Digit2", ctrlKey: true, altKey: true, shiftKey: true });
    assert.strictEqual(resolveShortcutCommand(source, DEFAULT_RESOLVED_KEYBINDINGS, ctrl), null);
    assert.strictEqual(
      resolveShortcutCommand(source, DEFAULT_RESOLVED_KEYBINDINGS, {
        ...ctrl,
        context: { rightPanelOpen: true },
      }),
      "rightPanel.source",
    );
  });

  it("uses Command as mod on macOS", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ metaKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: MAC,
      }),
      "commandPalette.toggle",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: MAC,
      }),
      null,
    );
  });

  it("resolves the theme chords, and keeps typing from triggering the two that would hijack it", () => {
    const options = { platform: LINUX };
    const select = event({ key: "a", ctrlKey: true, altKey: true });
    const cycle = event({ key: "a", ctrlKey: true, altKey: true, shiftKey: true });
    const editor = event({ key: "t", ctrlKey: true, altKey: true, shiftKey: true });
    const typing = { ...options, context: { editableFocus: true } };

    assert.strictEqual(
      resolveShortcutCommand(select, DEFAULT_RESOLVED_KEYBINDINGS, options),
      "theme.select",
    );
    assert.strictEqual(
      resolveShortcutCommand(cycle, DEFAULT_RESOLVED_KEYBINDINGS, options),
      "appearance.cycle",
    );
    assert.strictEqual(
      resolveShortcutCommand(editor, DEFAULT_RESOLVED_KEYBINDINGS, options),
      "themeEditor.toggle",
    );

    assert.strictEqual(resolveShortcutCommand(select, DEFAULT_RESOLVED_KEYBINDINGS, typing), null);
    assert.strictEqual(resolveShortcutCommand(cycle, DEFAULT_RESOLVED_KEYBINDINGS, typing), null);
    assert.strictEqual(
      resolveShortcutCommand(editor, DEFAULT_RESOLVED_KEYBINDINGS, typing),
      "themeEditor.toggle",
    );
  });

  it("gates a rule on its when expression", () => {
    const back = event({ key: "[", ctrlKey: true });
    assert.strictEqual(
      resolveShortcutCommand(back, DEFAULT_RESOLVED_KEYBINDINGS, { platform: LINUX }),
      "navigation.back",
    );
    assert.strictEqual(
      resolveShortcutCommand(back, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: LINUX,
        context: { editableFocus: true },
      }),
      null,
    );
  });

  it("lets the last matching rule win", () => {
    const keybindings = compileResolvedKeybindingsConfig([
      { key: "mod+j", command: "sidebar.toggle" },
      { key: "mod+j", command: "rightPanel.toggle" },
    ]);
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "j", ctrlKey: true }), keybindings, {
        platform: LINUX,
      }),
      "rightPanel.toggle",
    );
  });

  it("falls through to an earlier rule when the later rule's when is false", () => {
    const keybindings = compileResolvedKeybindingsConfig([
      { key: "mod+j", command: "sidebar.toggle" },
      { key: "mod+j", command: "rightPanel.toggle", when: "isDesktop && rightPanelOpen" },
    ]);
    const press = event({ key: "j", ctrlKey: true });
    assert.strictEqual(
      resolveShortcutCommand(press, keybindings, { platform: LINUX }),
      "sidebar.toggle",
    );
    assert.strictEqual(
      resolveShortcutCommand(press, keybindings, {
        platform: LINUX,
        context: { isDesktop: true, rightPanelOpen: true },
      }),
      "rightPanel.toggle",
    );
  });

  it("treats identifiers it does not know as false and honors the true and false literals", () => {
    const keybindings = compileResolvedKeybindingsConfig([
      { key: "mod+j", command: "sidebar.toggle", when: "somethingElse" },
      { key: "mod+l", command: "sidebar.toggle", when: "true && !false" },
    ]);
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "j", ctrlKey: true }), keybindings, { platform: LINUX }),
      null,
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "l", ctrlKey: true }), keybindings, { platform: LINUX }),
      "sidebar.toggle",
    );
  });

  it("replaces the defaults of a command a custom file mentions", () => {
    const keybindings = mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig([{ key: "mod+shift+b", command: "sidebar.toggle" }]),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "b", ctrlKey: true }), keybindings, { platform: LINUX }),
      null,
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "b", ctrlKey: true, shiftKey: true }), keybindings, {
        platform: LINUX,
      }),
      "sidebar.toggle",
    );
  });
});

describe("shortcut labels", () => {
  it("formats the mod key per platform", () => {
    const [shortcut] = effectiveShortcutsForCommand(
      DEFAULT_RESOLVED_KEYBINDINGS,
      "commandPalette.toggle",
      { platform: LINUX },
    );
    assert.ok(shortcut);
    assert.strictEqual(formatShortcutLabel(shortcut, LINUX), "Ctrl+K");
    assert.strictEqual(formatShortcutLabel(shortcut, MAC), "⌘K");
  });

  it("labels alt and shift in the platform's order", () => {
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "rightPanel.toggle", LINUX),
      "Ctrl+Alt+B",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "rightPanel.toggle", MAC),
      "⌥⌘B",
    );
  });

  it("names keys the way each platform writes them, never as raw tokens", () => {
    const parts = (key: string, platform: string) =>
      formatShortcutParts(parseKeybindingShortcut(key)!, platform);
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>, ReadonlyArray<string>]> = [
      ["arrowleft", ["←"], ["←"]],
      ["mod+shift+arrowdown", ["Ctrl", "Shift", "↓"], ["⇧", "⌘", "↓"]],
      ["f3", ["F3"], ["F3"]],
      ["shift+f3", ["Shift", "F3"], ["⇧", "F3"]],
      ["backspace", ["Backspace"], ["⌫"]],
      ["delete", ["Delete"], ["⌦"]],
      ["enter", ["Enter"], ["Return"]],
      ["escape", ["Esc"], ["Esc"]],
      ["shift+pageup", ["Shift", "Page Up"], ["⇧", "Page Up"]],
      ["space", ["Space"], ["Space"]],
      ["mod+alt+shift+t", ["Ctrl", "Alt", "Shift", "T"], ["⌥", "⇧", "⌘", "T"]],
      ["ctrl+meta+k", ["Ctrl", "Meta", "K"], ["⌃", "⌘", "K"]],
    ];
    for (const [key, linux, mac] of cases) {
      assert.deepStrictEqual(parts(key, LINUX), linux, key);
      assert.deepStrictEqual(parts(key, MAC), mac, key);
    }
    // Every key a default binding uses has a proper name.
    for (const binding of DEFAULT_RESOLVED_KEYBINDINGS) {
      const key = formatShortcutParts(binding.shortcut, LINUX).at(-1)!;
      assert.notMatch(key, /^[a-z]{2,}/, `${binding.command} shows ${key}`);
    }
  });

  it("does not show a shadowed binding as a shortcut for its command", () => {
    const keybindings = compileResolvedKeybindingsConfig([
      { key: "mod+j", command: "sidebar.toggle" },
      { key: "mod+j", command: "rightPanel.toggle" },
    ]);
    assert.strictEqual(shortcutLabelForCommand(keybindings, "sidebar.toggle", LINUX), null);
    assert.strictEqual(shortcutLabelForCommand(keybindings, "rightPanel.toggle", LINUX), "Ctrl+J");
  });

  it("labels every command that has a default binding, whatever its condition", () => {
    for (const binding of DEFAULT_RESOLVED_KEYBINDINGS) {
      assert.ok(
        shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, binding.command, LINUX),
        `${binding.command} has no label`,
      );
    }
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "search.next", LINUX),
      "Ctrl+G",
    );
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "tree.expandAll", LINUX),
      "Ctrl+Shift+→",
    );
  });

  it("names only a chord that runs the command when given the app's state", () => {
    assert.strictEqual(
      shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "search.next", {
        platform: LINUX,
        context: { searchOpen: false },
      }),
      null,
    );
  });

  it("returns null for a command with no binding", () => {
    assert.strictEqual(shortcutLabelForCommand([], "sidebar.toggle", LINUX), null);
    assert.strictEqual(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, null, LINUX), null);
  });
});
