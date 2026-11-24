import { describe, expect, it } from "vite-plus/test";
import { STATIC_KEYBINDING_COMMANDS, type ResolvedKeybindingsConfig } from "@quipu/contracts";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeWithDefaultKeybindings,
  parseKeybindingWhenExpression,
} from "@quipu/shared/keybindings";

import {
  buildKeybindingCommandOptions,
  buildKeybindingRows,
  buildWhenVariableOptions,
  commandLabel,
  describeWhen,
  groupKeybindingRows,
  keybindingConflictLabels,
  keybindingFromKeyboardEvent,
  parseWhenExpressionDraft,
  shortcutToKeybindingInput,
  unknownWhenVariables,
  whenAstToExpression,
  whenNodeRemoveLabel,
} from "./KeybindingsSettings.logic";

const noModifiers = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

describe("KeybindingsSettings.logic", () => {
  it("lists every shell command with its default", () => {
    const rows = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "");
    expect(rows.map((row) => row.command)).toEqual(
      expect.arrayContaining([
        "appearance.cycle",
        "commandPalette.toggle",
        "decode.toggle",
        "document.open",
        "navigation.back",
        "navigation.forward",
        "rightPanel.inspector",
        "keybindings.show",
        "document.close",
        "rightPanel.source",
        "rightPanel.toggle",
        "search.jq",
        "search.next",
        "search.next",
        "search.open",
        "search.path",
        "search.previous",
        "search.previous",
        "sidebar.toggle",
        "theme.select",
        "themeEditor.toggle",
        "tree.collapseAll",
        "tree.expandAll",
        "view.map",
        "view.source",
        "view.tree",
        "board.new",
        "edit.undo",
        "draw.tool.rectangle",
        "map.fit",
      ]),
    );
    expect(rows).toHaveLength(DEFAULT_RESOLVED_KEYBINDINGS.length);
    for (const row of rows) {
      expect(row).toMatchObject({ source: "Default", conflicts: [] });
    }
  });

  it("lists rows in the palette's order, whatever order the bindings arrive in", () => {
    const forward = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "");
    const reversed = buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS.toReversed(), "");
    const commands = [...new Set(forward.map((row) => row.command))];
    expect(commands).toEqual(
      STATIC_KEYBINDING_COMMANDS.filter((command) => commands.includes(command)),
    );
    expect(reversed.map((row) => row.command)).toEqual(forward.map((row) => row.command));
  });

  it("labels commands with the titles the palette shows", () => {
    expect(commandLabel("sidebar.toggle")).toBe("Toggle sidebar");
    expect(commandLabel("map.collapseAll")).toBe("Collapse all on map");
    expect(commandLabel("draw.tool.rectangle")).toBe("Rectangle tool");
  });

  it("groups rows the way the palette does and drops empty groups", () => {
    const groups = groupKeybindingRows(buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, ""));
    expect(groups.map((group) => group.title)).toEqual([
      "General",
      "Document",
      "View",
      "Search",
      "Edit",
      "Decode",
      "Map",
      "Canvas",
      "Board",
      "Draw",
      "Appearance",
    ]);
    expect(groups[0]?.rows.map((row) => row.command)).toEqual(
      expect.arrayContaining(["rightPanel.toggle", "rightPanel.inspector"]),
    );
  });

  it.each([
    ["sidebar", "sidebar.toggle"],
    ["all commands", "commandPalette.toggle"],
    ["map", "map.collapseAll"],
    ["mod+alt+shift+2", "rightPanel.source"],
    ["!editableFocus", "navigation.back"],
    ["default", "sidebar.toggle"],
  ])("finds a row by searching %j", (query, command) => {
    expect(buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, query)).toContainEqual(
      expect.objectContaining({ command }),
    );
  });

  it("finds nothing for a query that matches no row", () => {
    expect(buildKeybindingRows(DEFAULT_RESOLVED_KEYBINDINGS, "no such binding")).toEqual([]);
  });

  it("marks a rule that differs from its default as custom and keeps the default beside it", () => {
    const merged = mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig([{ key: "mod+shift+b", command: "sidebar.toggle" }]),
    );
    const rows = buildKeybindingRows(merged, "sidebar");
    expect(rows).toEqual([
      expect.objectContaining({
        command: "sidebar.toggle",
        key: "mod+shift+b",
        source: "Custom",
        defaultKey: "mod+b",
      }),
    ]);
  });

  it("builds readable key and when values", () => {
    const rows = buildKeybindingRows(
      [
        {
          command: "navigation.back",
          shortcut: {
            key: "[",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
          },
          whenAst: { type: "not", node: { type: "identifier", name: "editableFocus" } },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "back",
    );

    expect(rows).toEqual([
      expect.objectContaining({
        command: "navigation.back",
        key: "mod+[",
        when: "!editableFocus",
        defaultKey: "mod+[",
        defaultWhen: "!editableFocus",
        source: "Default",
      }),
    ]);
  });

  it("captures platform-specific mod shortcuts", () => {
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", code: "KeyK", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
        "MacIntel",
      ),
    ).toBe("mod+shift+k");
    expect(
      keybindingFromKeyboardEvent(
        { key: "K", code: "KeyK", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        "Win32",
      ),
    ).toBe("mod+shift+k");
  });

  it.each([
    ["k", "KeyK", "k"],
    ["Tab", "Tab", "tab"],
    ["F5", "F5", "f5"],
  ])("captures %s without a modifier", (key, code, expected) => {
    expect(keybindingFromKeyboardEvent({ key, code, ...noModifiers }, "MacIntel")).toBe(expected);
  });

  it("waits for a key when only a modifier is pressed", () => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key: "Meta",
          code: "MetaLeft",
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        "MacIntel",
      ),
    ).toBeNull();
  });

  it.each([
    ["@", "Digit2", "mod+shift+2"],
    ['"', "Digit2", "mod+shift+2"],
    ["@", "Quote", "mod+shift+'"],
  ])("captures %s at %s by physical key", (key, code, expected) => {
    expect(
      keybindingFromKeyboardEvent(
        { key, code, metaKey: true, ctrlKey: false, altKey: false, shiftKey: true },
        "MacIntel",
      ),
    ).toBe(expected);
  });

  it("serializes shortcuts and when expressions for saving", () => {
    expect(
      shortcutToKeybindingInput({
        key: " ",
        modKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
      }),
    ).toBe("mod+alt+space");

    expect(
      whenAstToExpression({
        type: "and",
        left: { type: "identifier", name: "isDesktop" },
        right: { type: "not", node: { type: "identifier", name: "editableFocus" } },
      }),
    ).toBe("isDesktop && !editableFocus");

    expect(parseWhenExpressionDraft("isDesktop && (!editableFocus || rightPanelOpen)")).toEqual({
      ok: true,
      value: {
        type: "and",
        left: { type: "identifier", name: "isDesktop" },
        right: {
          type: "or",
          left: { type: "not", node: { type: "identifier", name: "editableFocus" } },
          right: { type: "identifier", name: "rightPanelOpen" },
        },
      },
    });
    expect(parseWhenExpressionDraft("isDesktop &&")).toEqual({
      ok: false,
      message: "Use variables with !, &&, ||, and parentheses.",
    });
    expect(parseWhenExpressionDraft("   ")).toEqual({ ok: true, value: undefined });
  });

  it("offers the core when variables first, then the ones the defaults use", () => {
    const options = buildWhenVariableOptions();
    expect(options.slice(0, 6)).toEqual([
      "editableFocus",
      "rightPanelOpen",
      "isWeb",
      "isDesktop",
      "true",
      "false",
    ]);
  });

  it("reports unknown when variables without rejecting parseable expressions", () => {
    const parsed = parseWhenExpressionDraft("!editableFocus && editableFoc");
    expect(parsed.ok).toBe(true);
    expect(unknownWhenVariables(parsed.ok ? parsed.value : undefined)).toEqual(["editableFoc"]);
  });

  it("flags rules that share a key while their when expressions could both be true", () => {
    const shortcut = {
      key: "j",
      modKey: true,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    const rows = buildKeybindingRows(
      [
        { command: "sidebar.toggle", shortcut },
        { command: "rightPanel.toggle", shortcut, whenAst: { type: "identifier", name: "isWeb" } },
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );

    // An empty when matches everywhere, so it conflicts with any when on that key.
    expect(rows.find((row) => row.command === "sidebar.toggle")?.conflicts).toEqual([
      "Toggle right panel",
    ]);
    // A new rule on that key with its own when still collides with the unconditional one.
    expect(
      keybindingConflictLabels(rows, { rowId: "none", key: "mod+j", when: "isDesktop" }),
    ).toEqual(["Toggle sidebar"]);
  });

  it("does not flag different when expressions on one key, and ignores an empty key", () => {
    const shortcut = {
      key: "j",
      modKey: true,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    const rows = buildKeybindingRows(
      [
        {
          command: "sidebar.toggle",
          shortcut,
          whenAst: { type: "identifier", name: "isWeb" },
        },
        {
          command: "rightPanel.toggle",
          shortcut,
          whenAst: { type: "identifier", name: "isDesktop" },
        },
      ] satisfies ResolvedKeybindingsConfig,
      "",
    );
    expect(rows.every((row) => row.conflicts.length === 0)).toBe(true);
    expect(keybindingConflictLabels(rows, { rowId: "x", key: "", when: "" })).toEqual([]);
  });

  it("offers every command for a new binding, alphabetical by label", () => {
    const options = buildKeybindingCommandOptions(DEFAULT_RESOLVED_KEYBINDINGS);
    const labels = options.map((command) => commandLabel(command));
    expect(labels).toEqual(labels.toSorted((a, b) => a.localeCompare(b)));
    expect(options).toContain("sidebar.toggle");
    expect(options).toContain("rightPanel.toggle");
  });

  it("names what a builder node's remove button removes", () => {
    const condition = { type: "identifier", name: "editableFocus" } as const;
    expect(whenNodeRemoveLabel(condition, 0)).toBe("Clear all conditions");
    expect(whenNodeRemoveLabel(condition, 1)).toBe("Remove condition");
    expect(whenNodeRemoveLabel({ type: "not", node: condition }, 2)).toBe("Remove condition");
    expect(whenNodeRemoveLabel({ type: "and", left: condition, right: condition }, 1)).toBe(
      "Remove group and its conditions",
    );
  });
});

describe("describeWhen", () => {
  const describe_ = (expression: string) =>
    describeWhen(parseKeybindingWhenExpression(expression) ?? undefined);

  it("reads the default conditions as sentences", () => {
    expect(describeWhen(undefined)).toBe("Anywhere");
    expect(describe_("!editableFocus")).toBe("Anywhere except text fields");
    expect(describe_("canvasFocus && drawSelection && !editableFocus")).toBe(
      "On the map or a board, with a drawing selected, not while typing",
    );
    expect(describe_("(canvasFocus && drawSelection) && !editableFocus")).toBe(
      "On the map or a board, with a drawing selected, not while typing",
    );
    // A board has no map nodes: only the map's own shortcuts mention them.
    expect(describe_("canvasFocus && mapNodeActive && !drawSelection && !editableFocus")).toBe(
      "On a map node, with no drawing selected, not while typing",
    );
    expect(describe_("canvasFocus && !mapNodeActive && !drawSelection && !editableFocus")).toBe(
      "On a board, or the map with no node focused, with no drawing selected, not while typing",
    );
    expect(describe_("mapNodeActive && !editableFocus")).toBe("On a map node, not while typing");
    expect(describe_("searchOpen")).toBe("While Find is open");
    expect(describe_("documentOpen")).toBe("With a document open");
    expect(describe_("treeFocus && !editableFocus")).toBe("In the tree, not while typing");
    expect(describe_("isDesktop")).toBe("In the desktop app");
  });

  it("puts every default condition in words, with no expression syntax", () => {
    for (const binding of DEFAULT_RESOLVED_KEYBINDINGS) {
      const text = describeWhen(binding.whenAst);
      expect(text, whenAstToExpression(binding.whenAst)).not.toMatch(/[!&|()]|[a-z][A-Z]/);
    }
  });

  it("describes alternatives, negated groups and conditions it does not know", () => {
    expect(describe_("treeFocus || canvasFocus")).toBe("In the tree, or on the map or a board");
    expect(describe_("!(searchOpen && rightPanelOpen)")).toBe(
      "Except while Find is open, while the right panel is open",
    );
    expect(describe_("myFlag && !otherFlag")).toBe("When myFlag is on, when otherFlag is off");
  });
});
