import { describe, expect, it } from "vite-plus/test";

import {
  buildCommandPaletteRows,
  filterCommandPaletteGroups,
  findHighlightedCommandPaletteItem,
  getCommandPaletteEmptyMessage,
  getCommandPaletteInputPlaceholder,
  reduceCommandPaletteUiState,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

function item(
  value: string,
  title: string,
  extra: Partial<CommandPaletteActionItem> = {},
): CommandPaletteActionItem {
  return {
    kind: "action",
    value,
    title,
    searchTerms: [title],
    icon: null,
    run: async () => undefined,
    ...extra,
  };
}

describe("reduceCommandPaletteUiState", () => {
  it("toggles open and closed", () => {
    const opened = reduceCommandPaletteUiState(
      { open: false, openIntent: null },
      { _tag: "Toggle" },
    );
    expect(opened).toEqual({ open: true, openIntent: null });
    expect(reduceCommandPaletteUiState(opened, { _tag: "Toggle" })).toEqual({
      open: false,
      openIntent: null,
    });
  });

  it("sets the state it is told to, whatever it was", () => {
    expect(
      reduceCommandPaletteUiState(
        { open: true, openIntent: null },
        { _tag: "SetOpen", open: true },
      ),
    ).toEqual({ open: true, openIntent: null });
    expect(
      reduceCommandPaletteUiState(
        { open: true, openIntent: null },
        { _tag: "SetOpen", open: false },
      ),
    ).toEqual({ open: false, openIntent: null });
  });

  it("opens on the theme list and forgets that request once it is handled or dismissed", () => {
    const opened = reduceCommandPaletteUiState(
      { open: false, openIntent: null },
      { _tag: "OpenChangeTheme" },
    );
    expect(opened).toEqual({ open: true, openIntent: "change-theme" });
    expect(reduceCommandPaletteUiState(opened, { _tag: "ClearOpenIntent" })).toEqual({
      open: true,
      openIntent: null,
    });
    expect(reduceCommandPaletteUiState(opened, { _tag: "SetOpen", open: false })).toEqual({
      open: false,
      openIntent: null,
    });
  });
});

describe("filterCommandPaletteGroups", () => {
  const groups: CommandPaletteGroup[] = [
    {
      value: "actions",
      label: "Actions",
      items: [
        item("a", "Toggle sidebar", { searchTerms: ["Toggle sidebar", "hide sidebar"] }),
        item("b", "Go back"),
        item("c", "Open Keybindings", { searchTerms: ["Open Keybindings", "shortcuts"] }),
      ],
    },
    {
      value: "settings",
      label: "Settings",
      items: [
        item("d", "Open Storage settings", { searchTerms: ["Open Storage settings", "disk"] }),
      ],
    },
  ];

  it("keeps every group in order for an empty query", () => {
    expect(
      filterCommandPaletteGroups({ activeGroups: groups, query: "" }).map((group) => group.value),
    ).toEqual(["actions", "settings"]);
  });

  it("limits the palette to actions when the query starts with >", () => {
    const filtered = filterCommandPaletteGroups({ activeGroups: groups, query: ">" });
    expect(filtered.map((group) => group.value)).toEqual(["actions"]);
    const narrowed = filterCommandPaletteGroups({ activeGroups: groups, query: ">open" });
    expect(narrowed.flatMap((group) => group.items.map((entry) => entry.value))).toEqual(["c"]);
  });

  it("matches every word, in any order, ignoring case and accents", () => {
    const values = (query: string) =>
      filterCommandPaletteGroups({ activeGroups: groups, query }).flatMap((group) =>
        group.items.map((entry) => entry.value),
      );
    expect(values("SIDEBAR toggle")).toEqual(["a"]);
    expect(values("shortcüts")).toEqual(["c"]);
    expect(values("toggle zebra")).toEqual([]);
  });

  it("matches a command by its group's name as well", () => {
    const filtered = filterCommandPaletteGroups({
      activeGroups: [
        { value: "view", label: "View", items: [item("tree", "Collapse all in tree")] },
        { value: "map", label: "Map", items: [item("map", "Collapse all on map")] },
        { value: "draw", label: "Draw", items: [item("rect", "Rectangle tool")] },
      ],
      query: "Map: Collapse all",
    });
    expect(filtered.flatMap((group) => group.items.map((entry) => entry.value))).toEqual(["map"]);
    const drawing = filterCommandPaletteGroups({
      activeGroups: [{ value: "draw", label: "Draw", items: [item("rect", "Rectangle tool")] }],
      query: "draw rectangle",
    });
    expect(drawing.flatMap((group) => group.items.map((entry) => entry.value))).toEqual(["rect"]);
  });

  it("ranks a title match above a match in a later search term", () => {
    const filtered = filterCommandPaletteGroups({
      activeGroups: [
        {
          value: "actions",
          label: "Actions",
          items: [
            item("later", "Go forward", { searchTerms: ["Go forward", "back and forth"] }),
            item("title", "Go back"),
          ],
        },
      ],
      query: "back",
    });
    expect(filtered[0]?.items.map((entry) => entry.value)).toEqual(["title", "later"]);
  });

  it("sorts secondary items after every other match in their group", () => {
    const filtered = filterCommandPaletteGroups({
      activeGroups: [
        {
          value: "actions",
          label: "Actions",
          items: [
            item("secondary", "Open sidebar", { secondary: true }),
            item("other", "Toggle sidebar"),
          ],
        },
      ],
      query: "sidebar",
    });
    expect(filtered[0]?.items.map((entry) => entry.value)).toEqual(["other", "secondary"]);
  });

  it("drops a group with no matches", () => {
    const filtered = filterCommandPaletteGroups({ activeGroups: groups, query: "disk" });
    expect(filtered.map((group) => group.value)).toEqual(["settings"]);
  });
});

describe("virtualized command palette rows", () => {
  const groups: CommandPaletteGroup[] = [
    {
      value: "actions",
      label: "Actions",
      items: [item("a", "Toggle sidebar"), item("b", "Go back", { disabled: true })],
    },
    { value: "settings", label: "Settings", items: [item("c", "Open Storage settings")] },
  ];

  it("keeps group order and headings while indexing only enabled items", () => {
    const rows = buildCommandPaletteRows(groups);
    expect(
      rows.rows.map((row) => (row.kind === "label" ? `# ${row.label}` : row.item.value)),
    ).toEqual(["# Actions", "a", "b", "# Settings", "c"]);
    expect(rows.itemValues).toEqual(["a", "c"]);
    expect(rows.rowIndexByItemIndex).toEqual([1, 4]);
  });

  it("resolves Enter to the highlighted item without needing its row mounted", () => {
    expect(findHighlightedCommandPaletteItem(groups, "c")?.value).toBe("c");
    expect(findHighlightedCommandPaletteItem(groups, "b")).toBeNull();
    expect(findHighlightedCommandPaletteItem(groups, null)).toBeNull();
  });
});

describe("palette copy", () => {
  it("words the empty state and placeholder for the current view", () => {
    expect(getCommandPaletteEmptyMessage(true)).toBe("No matching actions.");
    expect(getCommandPaletteEmptyMessage(false)).toBe("No matching commands or settings.");
    expect(getCommandPaletteInputPlaceholder(false)).toBe("Search commands and settings...");
    expect(getCommandPaletteInputPlaceholder(true)).toBe("Search...");
  });
});
