import type { KeybindingCommand } from "@quipu/contracts";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { type ReactNode } from "react";

import { normalizeSearchText } from "../lib/utils";

/**
 * The palette is one dialog. `reduceCommandPaletteUiState` owns open state so
 * the keybinding, the menu action and the backdrop cannot disagree, and
 * re-triggering the chord closes it.
 */
export interface CommandPaletteUiState {
  readonly open: boolean;
  /** A list to open on once the dialog mounts, consumed by `ClearOpenIntent`. */
  readonly openIntent: "change-theme" | null;
}

export type CommandPaletteUiAction =
  | { readonly _tag: "SetOpen"; readonly open: boolean }
  | { readonly _tag: "Toggle" }
  | { readonly _tag: "OpenChangeTheme" }
  | { readonly _tag: "ClearOpenIntent" };

export function reduceCommandPaletteUiState(
  state: CommandPaletteUiState,
  action: CommandPaletteUiAction,
): CommandPaletteUiState {
  switch (action._tag) {
    case "SetOpen":
      return { open: action.open, openIntent: action.open ? state.openIntent : null };
    case "Toggle":
      return { open: !state.open, openIntent: null };
    case "OpenChangeTheme":
      return { open: true, openIntent: "change-theme" };
    case "ClearOpenIntent":
      return state.openIntent === null ? state : { ...state, openIntent: null };
  }
}

export interface CommandPaletteItem {
  readonly kind: "action" | "submenu";
  readonly value: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly timestamp?: string;
  readonly searchRecency?: number;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly shortcutCommand?: KeybindingCommand;
  /** Sorts after every other match in its group. */
  readonly secondary?: boolean;
}

export interface CommandPaletteActionItem extends CommandPaletteItem {
  readonly kind: "action";
  readonly keepOpen?: boolean;
  readonly run: () => Promise<void>;
}

export interface CommandPaletteSubmenuItem extends CommandPaletteItem {
  readonly kind: "submenu";
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
}

export interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem>;
}

export interface CommandPaletteView {
  readonly addonIcon: ReactNode;
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
}

export type CommandPaletteRow =
  | {
      readonly kind: "label";
      readonly key: string;
      readonly label: string;
      readonly first: boolean;
    }
  | {
      readonly kind: "item";
      readonly key: string;
      readonly item: CommandPaletteActionItem | CommandPaletteSubmenuItem;
      /** Position among enabled items, or null for disabled rows the keyboard skips. */
      readonly itemIndex: number | null;
    };

/**
 * Flattens groups into the rows a virtualized list renders. `itemValues` is the
 * highlightable item order Base UI navigates; `rowIndexByItemIndex` maps a
 * highlight back to its row for scrolling.
 */
export function buildCommandPaletteRows(groups: ReadonlyArray<CommandPaletteGroup>) {
  const rows: CommandPaletteRow[] = [];
  const itemValues: string[] = [];
  const rowIndexByItemIndex: number[] = [];
  for (const group of groups) {
    if (group.label) {
      rows.push({
        kind: "label",
        key: `group:${group.value}`,
        label: group.label,
        first: rows.length === 0,
      });
    }
    for (const item of group.items) {
      const itemIndex = item.disabled ? null : itemValues.length;
      if (itemIndex !== null) {
        itemValues.push(item.value);
        rowIndexByItemIndex.push(rows.length);
      }
      rows.push({ kind: "item", key: `${group.value}:${item.value}`, item, itemIndex });
    }
  }
  return { rows, itemValues, rowIndexByItemIndex };
}

/** The enabled item Enter should run for a highlight, whether or not its row is mounted. */
export function findHighlightedCommandPaletteItem(
  groups: ReadonlyArray<CommandPaletteGroup>,
  highlightedItemValue: string | null,
): CommandPaletteActionItem | CommandPaletteSubmenuItem | null {
  if (highlightedItemValue === null) return null;
  for (const group of groups) {
    for (const item of group.items) {
      if (item.value === highlightedItemValue && !item.disabled) return item;
    }
  }
  return null;
}

/**
 * Per field: every query token must appear or the field does not match.
 * An exact match scores 3, a prefix 2, a substring 1, tokens scattered 0.
 */
function rankSearchFieldMatch(
  field: string,
  normalizedQuery: string,
  queryTokens: ReadonlyArray<string>,
): number {
  const normalizedField = normalizeSearchText(field);
  if (
    normalizedField.length === 0 ||
    !queryTokens.every((token) => normalizedField.includes(token))
  ) {
    return Number.NEGATIVE_INFINITY;
  }
  if (normalizedField === normalizedQuery) {
    return 3;
  }
  if (normalizedField.startsWith(normalizedQuery)) {
    return 2;
  }
  if (normalizedField.includes(normalizedQuery)) {
    return 1;
  }
  return 0;
}

function rankCommandPaletteItemMatch(
  item: CommandPaletteActionItem | CommandPaletteSubmenuItem,
  normalizedQuery: string,
  queryTokens: ReadonlyArray<string>,
): number {
  const terms = item.searchTerms.filter((term) => term.length > 0);
  if (terms.length === 0) {
    return 0;
  }

  for (const [index, field] of terms.entries()) {
    const fieldRank = rankSearchFieldMatch(field, normalizedQuery, queryTokens);
    if (fieldRank !== Number.NEGATIVE_INFINITY) {
      if (index === 0 && item.searchRecency !== undefined) {
        // All non-exact title matches share a tier so recency breaks the tie.
        return 1_000 + Number(fieldRank === 3);
      }
      return 1_000 - index * 100 + fieldRank;
    }
  }

  return 0;
}

/**
 * `>` limits the palette to commands, leaving out the settings pages. Any
 * other query filters every group to its matches, best match first: title
 * beats later fields, and `secondary` items sort last. A group's name counts
 * as a word of each of its items, so "Map: Collapse all" finds the map's
 * Collapse all and not the tree's.
 */
export function filterCommandPaletteGroups(input: {
  activeGroups: ReadonlyArray<CommandPaletteGroup>;
  query: string;
}): CommandPaletteGroup[] {
  const isActionsFilter = input.query.startsWith(">");
  const searchQuery = isActionsFilter ? input.query.slice(1) : input.query;
  const normalizedQuery = normalizeSearchText(searchQuery.replaceAll(":", " "));
  const baseGroups = isActionsFilter
    ? input.activeGroups.filter((group) => group.value !== "settings")
    : [...input.activeGroups];

  if (normalizedQuery.length === 0) {
    return baseGroups;
  }
  const queryTokens = normalizedQuery.split(" ");

  return baseGroups.flatMap((group) => {
    const items = Arr.filterMap(group.items, (item, index) => {
      const haystack = normalizeSearchText(`${item.searchTerms.join(" ")} ${group.label}`);
      if (!queryTokens.every((token) => haystack.includes(token))) {
        return Result.failVoid;
      }

      return Result.succeed({
        item,
        index,
        rank: rankCommandPaletteItemMatch(item, normalizedQuery, queryTokens),
      });
    })
      .toSorted(
        (left, right) =>
          Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
          right.rank - left.rank ||
          (right.item.searchRecency ?? 0) - (left.item.searchRecency ?? 0) ||
          left.index - right.index,
      )
      .map((entry) => entry.item);

    if (items.length === 0) {
      return [];
    }

    return [{ value: group.value, label: group.label, items }];
  });
}

export function getCommandPaletteInputPlaceholder(isInSubmenu: boolean): string {
  return isInSubmenu ? "Search..." : "Search commands and settings...";
}

export function getCommandPaletteEmptyMessage(isActionsOnly: boolean): string {
  return isActionsOnly ? "No matching actions." : "No matching commands or settings.";
}
