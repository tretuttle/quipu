import { type KeybindingCommand } from "@quipu/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BracesIcon,
  ArrowRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  FileIcon,
  FileUpIcon,
  HistoryIcon,
  InfoIcon,
  FileCodeIcon,
  FilterIcon,
  ListTreeIcon,
  RouteIcon,
  SearchIcon,
  KeyboardIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PanelsTopLeftIcon,
  Settings2Icon,
  HardDriveIcon,
  SunIcon,
  LayoutDashboardIcon,
  MaximizeIcon,
  PencilRulerIcon,
  RedoIcon,
  UndoIcon,
  WaypointsIcon,
  ZoomInIcon,
  ZoomOutIcon,
  PencilIcon,
  Trash2Icon,
  ArrowDownUpIcon,
  FileOutputIcon,
  SaveAllIcon,
  SaveIcon,
  TextCursorInputIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  type CommandGroupId,
  COMMANDS,
  commandsByGroup,
  commandTitle,
} from "@quipu/shared/commands";
import { BUILT_IN_THEMES } from "@quipu/shared/themePalettes";

import {
  onOpenChangeThemePalette,
  onToggleCommandPalette,
  reportCommandPaletteOpen,
} from "../commandPaletteBus";
import { useCustomThemes } from "../hooks/useCustomThemes";
import { useTheme } from "../hooks/useTheme";
import { openRecent } from "../documents/openDocument";
import { type RecentDocument, useRecentDocuments } from "../documents/recents";
import { useResolvedKeybindings } from "../keybindingsStore";
import { cn } from "../lib/utils";
import {
  type CommandAvailability,
  type CommandState,
  commandAvailability,
  readCommandState,
} from "../commandAvailability";
import { runShellCommand } from "../shellCommands";
import {
  buildCommandPaletteRows,
  filterCommandPaletteGroups,
  findHighlightedCommandPaletteItem,
  getCommandPaletteInputPlaceholder,
  reduceCommandPaletteUiState,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
} from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import {
  CommandPaletteVirtualizedResults,
  scrollCommandPaletteRowIntoView,
} from "./CommandPaletteResults";
import { getThemeDefinition } from "../themePalette";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  ThemePreviewCircle,
} from "./settings/ThemePreviewCircles";
import { toastManager, stackedToast } from "./ui/toast";
import { CommandDialog, CommandDialogPopup } from "./ui/command";
import { TRANSFORM_MENU } from "./edit/DocumentEditControls";

const ITEM_ICON_CLASS = "size-4 text-icon-muted";

function icon(Icon: LucideIcon) {
  return <Icon className={ITEM_ICON_CLASS} />;
}

function commandAction(input: {
  value: string;
  title: string;
  command: KeybindingCommand;
  Icon: LucideIcon;
  searchTerms?: ReadonlyArray<string>;
}): CommandPaletteActionItem {
  return {
    kind: "action",
    value: input.value,
    title: input.title,
    searchTerms: [input.title, ...(input.searchTerms ?? [])],
    icon: icon(input.Icon),
    shortcutCommand: input.command,
    run: async () => {
      runShellCommand(input.command);
    },
  };
}

function settingsAction(input: {
  value: string;
  title: string;
  to: "/settings/general" | "/settings/appearance" | "/settings/keybindings" | "/settings/storage";
  /** The row to scroll to, when it is not the page's top. */
  hash?: string;
  Icon: LucideIcon;
  navigate: (to: string, hash?: string) => void;
  searchTerms?: ReadonlyArray<string>;
}): CommandPaletteActionItem {
  return {
    kind: "action",
    value: input.value,
    title: input.title,
    searchTerms: [input.title, "settings", ...(input.searchTerms ?? [])],
    icon: icon(input.Icon),
    run: async () => {
      input.navigate(input.to, input.hash);
    },
  };
}

const APPEARANCE_OPTIONS = [
  { mode: "system", label: "System", icon: MonitorIcon },
  { mode: "light", label: "Light", icon: SunIcon },
  { mode: "dark", label: "Dark", icon: MoonIcon },
] as const;

function notifyThemeSaveFailure(): void {
  toastManager.add(
    stackedToast({
      type: "error",
      title: "Couldn't save theme selection",
      description: "Try again.",
    }),
  );
}

/**
 * The palette's theme commands: pick a theme, pick light, dark or system, and
 * open the editor. They run the same `useTheme` setters the Appearance page
 * does, so a pick here and a click there cannot disagree.
 */
interface ThemePaletteItems {
  readonly changeTheme: CommandPaletteSubmenuItem;
  readonly changeAppearance: CommandPaletteSubmenuItem;
}

function useThemePaletteItems(): ThemePaletteItems {
  const {
    theme,
    themeHalves,
    resolvedTheme,
    appearanceMode,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
  } = useTheme();
  const customThemes = useCustomThemes();
  return useMemo(() => {
    const seen = new Set<string>();
    const themeCards = [
      ...STANDARD_THEME_CARDS.map((card) => ({ ...card, id: null })),
      ...[...BUILT_IN_THEMES, ...customThemes]
        .filter((definition) => {
          if (seen.has(definition.id)) return false;
          seen.add(definition.id);
          return true;
        })
        .map(getThemeCardDefinition),
    ];
    const currentThemeId = themeHalves?.[resolvedTheme] ?? getThemeDefinition(theme)?.id ?? null;

    const changeTheme: CommandPaletteSubmenuItem = {
      kind: "submenu",
      value: "action:change-theme",
      searchTerms: [commandTitle("theme.select"), "appearance", "colors", "palette"],
      title: commandTitle("theme.select"),
      icon: icon(PaletteIcon),
      addonIcon: icon(PaletteIcon),
      shortcutCommand: "theme.select",
      groups: [
        {
          value: "themes",
          label: "Change theme",
          items: themeCards.map(({ id, label, previews }) => ({
            kind: "action",
            value: id === null ? "theme:standard" : `theme:palette:${id}`,
            title: label,
            description: previews.length === 1 ? `For ${previews[0]!.mode} mode` : undefined,
            searchTerms: [label, "theme", "appearance"],
            icon: icon(PaletteIcon),
            titleTrailingContent: (
              <span className="flex shrink-0 items-center gap-2">
                {currentThemeId === id ? (
                  <span className="text-xs text-muted-foreground/70">Current</span>
                ) : null}
                <span className="flex items-center gap-1" aria-hidden>
                  {previews.map((preview) => (
                    <ThemePreviewCircle
                      key={preview.mode}
                      colors={preview.colors}
                      mode={preview.mode}
                      className="size-3 border-0"
                    />
                  ))}
                </span>
              </span>
            ),
            run: async () => {
              const saved =
                previews.length === 1 && id !== null
                  ? setThemeHalf(previews[0]!.mode, id)
                  : setTheme(id ?? appearanceMode);
              if (!saved) notifyThemeSaveFailure();
            },
          })),
        },
      ],
    };

    const changeAppearance: CommandPaletteSubmenuItem = {
      kind: "submenu",
      value: "action:change-appearance",
      searchTerms: ["change appearance", "light", "dark", "system", "mode", "toggle"],
      title: "Change appearance",
      icon: icon(MonitorIcon),
      addonIcon: icon(MonitorIcon),
      groups: [
        {
          value: "appearance",
          label: "Change appearance",
          items: APPEARANCE_OPTIONS.map(({ mode, label, icon: Icon }) => ({
            kind: "action",
            value: `appearance:${mode}`,
            title: label,
            searchTerms: [label, "appearance", "mode"],
            icon: icon(Icon),
            titleTrailingContent:
              appearanceMode === mode ? (
                <span className="text-xs text-muted-foreground/70">Current</span>
              ) : undefined,
            run: async () => {
              if (!setAppearanceMode(mode)) notifyThemeSaveFailure();
            },
          })),
        },
      ],
    };

    return { changeTheme, changeAppearance };
  }, [
    appearanceMode,
    customThemes,
    resolvedTheme,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
  ]);
}

/** Icons by command; a command not listed takes its group's. */
const GROUP_ICONS: Readonly<Record<CommandGroupId, LucideIcon>> = {
  general: PanelsTopLeftIcon,
  document: FileIcon,
  view: ListTreeIcon,
  search: SearchIcon,
  edit: ArrowDownUpIcon,
  decode: BracesIcon,
  map: WaypointsIcon,
  canvas: MaximizeIcon,
  board: LayoutDashboardIcon,
  draw: PencilRulerIcon,
  appearance: PaletteIcon,
};

const COMMAND_ICONS: Partial<Record<KeybindingCommand, LucideIcon>> = {
  "commandPalette.toggle": SearchIcon,
  "keybindings.show": KeyboardIcon,
  "sidebar.toggle": PanelLeftIcon,
  "rightPanel.toggle": PanelRightIcon,
  "rightPanel.inspector": PanelRightIcon,
  "rightPanel.source": PanelRightIcon,
  "navigation.back": ArrowLeftIcon,
  "navigation.forward": ArrowRightIcon,
  "document.open": FileUpIcon,
  "document.close": XIcon,
  "document.save": SaveIcon,
  "document.saveAs": SaveAllIcon,
  "document.export": FileOutputIcon,
  "document.undo": UndoIcon,
  "document.redo": RedoIcon,
  "view.map": WaypointsIcon,
  "view.source": FileCodeIcon,
  "tree.expandAll": ChevronsUpDownIcon,
  "tree.collapseAll": ChevronsDownUpIcon,
  "search.next": ArrowRightIcon,
  "search.previous": ArrowLeftIcon,
  "search.path": RouteIcon,
  "search.jq": FilterIcon,
  "node.editValue": PencilIcon,
  "node.renameKey": TextCursorInputIcon,
  "map.expandAll": ChevronsUpDownIcon,
  "map.collapseAll": ChevronsDownUpIcon,
  "map.expandUnder": ChevronsUpDownIcon,
  "map.collapseUnder": ChevronsDownUpIcon,
  "map.zoomIn": ZoomInIcon,
  "map.zoomOut": ZoomOutIcon,
  "board.rename": PencilIcon,
  "board.delete": Trash2Icon,
  "edit.undo": UndoIcon,
  "edit.redo": RedoIcon,
  "appearance.cycle": MonitorIcon,
};

/** Words a command is also found by, beyond its title and group. */
const COMMAND_SEARCH_TERMS: Partial<Record<KeybindingCommand, ReadonlyArray<string>>> = {
  "commandPalette.toggle": ["command palette"],
  "keybindings.show": ["keybindings", "hotkeys", "help", "settings"],
  "sidebar.toggle": ["hide sidebar", "show sidebar"],
  "rightPanel.toggle": ["hide right panel", "show right panel"],
  "rightPanel.inspector": ["right panel", "tab"],
  "rightPanel.source": ["right panel", "tab", "text"],
  "navigation.back": ["history", "previous"],
  "navigation.forward": ["history", "next"],
  "document.open": ["open document", "browse", "import"],
  "document.close": ["close file"],
  "document.save": ["write", "file"],
  "document.saveAs": ["save copy", "write", "file"],
  "document.export": ["convert", "json", "yaml", "toml", "xml", "csv", "tsv", "ndjson", "download"],
  "document.undo": ["revert"],
  "view.map": ["canvas", "nodes"],
  "view.tree": ["outline"],
  "view.source": ["text", "raw", "bytes"],
  "tree.expandAll": ["open all", "outline"],
  "tree.collapseAll": ["close all", "outline"],
  "search.open": ["search", "regex", "regular expression", "match"],
  "search.next": ["find next"],
  "search.previous": ["find previous"],
  "search.path": ["jsonpath", "query", "select"],
  "search.jq": ["jq", "filter", "transform", "query"],
  "node.editValue": ["change", "set", "replace"],
  "node.renameKey": ["member", "property"],
  "decode.toggle": [
    "expand nested json",
    "base64",
    "jwt",
    "graphql",
    "form",
    "ndjson",
    "websocket frames",
    "inspector",
  ],
  "decode.expandAll": ["expand nested json", "bulk", "subtree"],
  "decode.collapseAll": ["raw", "bulk", "subtree"],
  "decode.auto": ["auto decode", "automatic", "preference"],
  "board.new": ["create board", "blank canvas", "drawing"],
  "board.rename": ["board name", "title"],
  "board.delete": ["remove board", "discard"],
  "theme.select": ["appearance", "colors", "palette"],
  "appearance.cycle": ["light", "dark", "system", "mode", "toggle"],
  "themeEditor.toggle": ["theme", "colors", "palette", "customize"],
};

for (const entry of TRANSFORM_MENU.flat()) {
  COMMAND_SEARCH_TERMS[entry.command] = ["transform", "sort", "order", "pretty print", "compact"];
}

function commandItem(
  command: KeybindingCommand,
  availability: CommandAvailability,
): CommandPaletteActionItem | null {
  if (availability.kind === "hidden") return null;
  const Icon = COMMAND_ICONS[command] ?? GROUP_ICONS[COMMANDS[command].group];
  return {
    ...commandAction({
      value: command,
      title: commandTitle(command),
      command,
      Icon,
      searchTerms: COMMAND_SEARCH_TERMS[command] ?? [],
    }),
    ...(availability.kind === "disabled"
      ? { disabled: true, description: availability.reason }
      : {}),
  };
}

function buildRootGroups(
  navigate: (to: string, hash?: string) => void,
  themeItems: ThemePaletteItems,
  recents: ReadonlyArray<RecentDocument>,
  state: CommandState,
): CommandPaletteGroup[] {
  const openRecentMenu: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "open-recent",
    title: "Open recent document",
    searchTerms: ["Open recent document", "recents", "history", "reopen"],
    icon: icon(HistoryIcon),
    addonIcon: icon(HistoryIcon),
    groups: [
      {
        value: "recents",
        label: "Recent documents",
        items: recents.map((entry): CommandPaletteActionItem => ({
          kind: "action",
          value: `recent:${entry.id}`,
          title: entry.name,
          searchTerms: [entry.name],
          icon: icon(FileIcon),
          run: async () => {
            await openRecent(entry.id);
          },
        })),
      },
    ],
  };

  /** Items that are not commands, placed after the command they belong beside. */
  const extrasAfter: Partial<
    Record<KeybindingCommand, ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>>
  > = {
    "document.open": recents.length > 0 ? [openRecentMenu] : [],
    "theme.select": [themeItems.changeAppearance],
  };

  const commandGroups = commandsByGroup().flatMap((group): CommandPaletteGroup[] => {
    const items = group.commands.flatMap((command) => {
      // The theme picker is a list of its own, opened in place.
      const item =
        command === "theme.select"
          ? themeItems.changeTheme
          : commandItem(command, commandAvailability(command, state));
      return item === null ? [] : [item, ...(extrasAfter[command] ?? [])];
    });
    return items.length === 0 ? [] : [{ value: group.id, label: group.title, items }];
  });

  return [
    ...commandGroups,
    {
      value: "settings",
      label: "Settings",
      items: [
        settingsAction({
          value: "settings:general",
          title: "Open general settings",
          to: "/settings/general",
          Icon: Settings2Icon,
          navigate,
          searchTerms: ["preferences", "confirmations"],
        }),
        settingsAction({
          value: "settings:appearance",
          title: "Open appearance settings",
          to: "/settings/appearance",
          Icon: PaletteIcon,
          navigate,
          searchTerms: ["themes", "colors", "fonts", "contrast", "motion", "typography"],
        }),
        settingsAction({
          value: "settings:storage",
          title: "Open storage settings",
          to: "/settings/storage",
          Icon: HardDriveIcon,
          navigate,
          searchTerms: ["disk", "usage", "clear data"],
        }),
        settingsAction({
          value: "settings:about",
          title: "About Quipu",
          to: "/settings/general",
          hash: "about",
          Icon: InfoIcon,
          navigate,
          searchTerms: ["version", "licenses", "notices"],
        }),
      ],
    },
  ];
}

export function CommandPalette({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    openIntent: null,
  });
  const setOpen = useCallback((open: boolean) => dispatch({ _tag: "SetOpen", open }), []);
  const clearOpenIntent = useCallback(() => dispatch({ _tag: "ClearOpenIntent" }), []);

  useEffect(() => onToggleCommandPalette(() => dispatch({ _tag: "Toggle" })), []);
  useEffect(() => onOpenChangeThemePalette(() => dispatch({ _tag: "OpenChangeTheme" })), []);
  useEffect(() => reportCommandPaletteOpen(state.open), [state.open]);

  return (
    <CommandDialog open={state.open} onOpenChange={setOpen}>
      {/* Block background focus calls for the entire time the palette is open. */}
      <div className="contents" inert={state.open}>
        {children}
      </div>
      <CommandDialogPopup
        aria-label="Command palette"
        className="overflow-hidden"
        data-command-palette="true"
        data-testid="command-palette"
        onBackdropPointerDown={() => setOpen(false)}
      >
        <OpenCommandPaletteDialog
          setOpen={setOpen}
          openIntent={state.openIntent}
          clearOpenIntent={clearOpenIntent}
        />
      </CommandDialogPopup>
    </CommandDialog>
  );
}

function OpenCommandPaletteDialog({
  setOpen,
  openIntent,
  clearOpenIntent,
}: {
  readonly setOpen: (open: boolean) => void;
  readonly openIntent: "change-theme" | null;
  readonly clearOpenIntent: () => void;
}) {
  const navigate = useNavigate();
  const keybindings = useResolvedKeybindings();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = deferredQuery.startsWith(">");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const [viewStack, setViewStack] = useState<CommandPaletteView[]>([]);
  const resultListRef = useRef<LegendListRef | null>(null);
  // Typing or entering a submenu clears the highlight. Base UI keeps its own on the
  // first row, but the palette shows none until the user navigates, and the first
  // ArrowDown lands on it.
  const highlightClearedRef = useRef(false);

  const navigateTo = useCallback(
    (to: string, hash?: string) => void navigate({ to, ...(hash === undefined ? {} : { hash }) }),
    [navigate],
  );
  const themeItems = useThemePaletteItems();
  const changeThemeView = useMemo<CommandPaletteView>(
    () => ({ addonIcon: themeItems.changeTheme.addonIcon, groups: themeItems.changeTheme.groups }),
    [themeItems],
  );
  // `theme.select` opens the palette straight on the theme list.
  const effectiveViewStack =
    openIntent === "change-theme" && changeThemeView ? [changeThemeView] : viewStack;
  const activeView = effectiveViewStack.at(-1) ?? null;
  const recents = useRecentDocuments((state) => state.documents);
  // Read once as the palette opens: what can run does not change while it is up.
  const [commandState] = useState(readCommandState);
  const rootGroups = useMemo(
    () => buildRootGroups(navigateTo, themeItems, recents, commandState),
    [navigateTo, themeItems, recents, commandState],
  );
  const activeGroups = activeView?.groups ?? rootGroups;
  const displayedGroups = filterCommandPaletteGroups({
    activeGroups,
    query: deferredQuery,
  });
  const resultRows = buildCommandPaletteRows(displayedGroups);
  const isSubmenu = activeView !== null;

  function clearTypedHighlight(): void {
    highlightClearedRef.current = true;
    setHighlightedItemValue(null);
  }

  function pushView(item: CommandPaletteSubmenuItem): void {
    clearOpenIntent();
    setViewStack([...effectiveViewStack, { addonIcon: item.addonIcon, groups: item.groups }]);
    setQuery("");
    clearTypedHighlight();
  }

  function popView(): void {
    clearOpenIntent();
    setViewStack(effectiveViewStack.slice(0, -1));
    setQuery("");
    clearTypedHighlight();
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.disabled) return;

    if (item.kind === "submenu") {
      pushView(item);
      return;
    }

    if (!item.keepOpen) {
      setOpen(false);
    }

    void item.run().catch((error: unknown) => {
      toastManager.add(
        stackedToast({
          type: "error",
          title: "Unable to run command",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // The palette's own chord is resolved by ShellCommandHost, in the capture
    // phase, so it reaches here only as a close.
    if (event.key === "Backspace" && query === "" && isSubmenu) {
      event.preventDefault();
      popView();
      return;
    }

    // Base UI ignores navigation keys with modifiers, so these fallbacks do too.
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    // Base UI only keeps a hidden highlight on the first row when it auto-highlights.
    const firstItemValue = resultRows.itemValues[0];
    if (
      event.key === "ArrowDown" &&
      highlightClearedRef.current &&
      firstItemValue &&
      !event.nativeEvent.isComposing
    ) {
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      highlightClearedRef.current = false;
      setHighlightedItemValue(firstItemValue);
      scrollCommandPaletteRowIntoView(
        resultListRef.current,
        resultRows.rowIndexByItemIndex[0] ?? 0,
      );
      return;
    }

    // Base UI clicks the highlighted row on Enter, which does nothing once the
    // virtualized list has unmounted it, so run the tracked highlight directly.
    if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      const highlightedItem = findHighlightedCommandPaletteItem(
        displayedGroups,
        highlightedItemValue ?? firstItemValue ?? null,
      );
      if (highlightedItem) {
        (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
        event.preventDefault();
        event.stopPropagation();
        executeItem(highlightedItem);
      }
    }
  }

  return (
    <CommandPaletteContent
      key={effectiveViewStack.length}
      aria-label="Command palette"
      autoHighlight="always"
      inputProps={{
        placeholder: getCommandPaletteInputPlaceholder(isSubmenu),
        ...(isSubmenu
          ? {
              startAddon: (
                <button
                  type="button"
                  className={cn("flex cursor-pointer items-center")}
                  aria-label="Back"
                  onClick={popView}
                >
                  <ArrowLeftIcon />
                </button>
              ),
            }
          : {}),
        onKeyDown: handleKeyDown,
      }}
      mode="none"
      items={resultRows.itemValues}
      virtualized
      onItemHighlighted={(value, eventDetails) => {
        if (eventDetails.reason === "none" && highlightClearedRef.current) return;
        highlightClearedRef.current = false;
        setHighlightedItemValue(typeof value === "string" ? value : null);
        const rowIndex = resultRows.rowIndexByItemIndex[eventDetails.index];
        if (eventDetails.reason === "keyboard" && rowIndex !== undefined) {
          scrollCommandPaletteRowIntoView(resultListRef.current, rowIndex);
        }
      }}
      onValueChange={(value) => {
        setQuery(value);
        clearTypedHighlight();
      }}
      showBackHint={isSubmenu}
      value={query}
    >
      <CommandPaletteVirtualizedResults
        rows={resultRows.rows}
        listRef={resultListRef}
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={isActionsOnly}
        keybindings={keybindings}
        onExecuteItem={executeItem}
      />
    </CommandPaletteContent>
  );
}
