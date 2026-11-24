import { normalizeSearchText } from "../../lib/utils";

/** The settings pages, in nav order. */
export const SETTINGS_SECTION_LABELS = {
  "/settings/general": "General",
  "/settings/appearance": "Appearance",
  "/settings/keybindings": "Keybindings",
  "/settings/storage": "Storage",
} as const;

export type SettingsPath = keyof typeof SETTINGS_SECTION_LABELS;

/** The detail page, reached from About on General, that lists third-party notices. */
export const OPEN_SOURCE_LICENSES_PATH = "/settings/open-source-licenses";

/** The nav section a path belongs to: a detail page counts as part of its parent. */
export function settingsSectionForPath(pathname: string): SettingsPath | null {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === OPEN_SOURCE_LICENSES_PATH) return "/settings/general";
  const match = (Object.keys(SETTINGS_SECTION_LABELS) as SettingsPath[]).find(
    (path) => normalized === path || normalized.startsWith(`${path}/`),
  );
  return match ?? null;
}

export interface SettingsSearchItem {
  readonly id: string;
  readonly to: SettingsPath | typeof OPEN_SOURCE_LICENSES_PATH;
  readonly title: string;
  /** The row to scroll to on arrival, when it is not the page's top. */
  readonly targetId?: string;
  /** Extra words that should find the item without being part of its title. */
  readonly keywords: ReadonlyArray<string>;
}

const SETTINGS_SEARCH_ITEMS = [
  {
    id: "confirm-storage-clear",
    to: "/settings/general",
    targetId: "confirm-storage-clear",
    title: "Confirm before clearing stored data",
    keywords: ["confirmations", "dialog", "warn", "delete"],
  },
  {
    id: "color-scheme",
    to: "/settings/appearance",
    title: "Color scheme",
    keywords: ["appearance", "light", "dark", "system", "mode"],
  },
  {
    id: "theme",
    to: "/settings/appearance",
    title: "Themes",
    keywords: ["appearance", "colors", "palette", "custom", "import", "open vsx", "editor"],
  },
  {
    // Prefixed because the slider control already owns the `appearance-contrast` id.
    id: "setting-appearance-contrast",
    to: "/settings/appearance",
    title: "Contrast",
    keywords: ["colors", "borders", "interface"],
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    to: "/settings/appearance",
    title: "Glass opacity",
    keywords: ["transparent", "transparency", "solid", "menus", "dialogs"],
  },
  {
    id: "panel-animations",
    to: "/settings/appearance",
    title: "Panel animations",
    keywords: ["motion", "duration", "speed", "reduce motion"],
  },
  {
    id: "interface-font",
    to: "/settings/appearance",
    title: "Interface font",
    keywords: ["typography", "family", "size", "system", "sans"],
  },
  {
    id: "code-font",
    to: "/settings/appearance",
    title: "Code font",
    keywords: ["typography", "family", "size", "monospace", "source"],
  },
  {
    id: "font-smoothing",
    to: "/settings/appearance",
    title: "Font smoothing",
    keywords: ["typography", "text", "grayscale", "anti aliasing", "macos", "thin"],
  },
  {
    id: "keybindings",
    to: "/settings/keybindings",
    title: "Keyboard shortcuts",
    keywords: ["keybindings", "hotkeys", "keys", "chords", "rebind", "when", "condition"],
  },
  {
    id: "storage-usage",
    to: "/settings/storage",
    title: "Storage used on this device",
    keywords: ["disk", "quota", "space", "cache", "indexeddb", "opfs", "clear data"],
  },
  {
    id: "about-version",
    to: "/settings/general",
    targetId: "about",
    title: "Version",
    keywords: ["about", "build", "release"],
  },
  {
    id: "about-licenses",
    to: OPEN_SOURCE_LICENSES_PATH,
    title: "Open-source licenses",
    keywords: ["third-party", "notices", "attribution"],
  },
  {
    id: "about-name",
    to: "/settings/general",
    targetId: "about-name",
    title: "About the name Quipu",
    keywords: ["khipu", "inca", "knots", "cords"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

/**
 * The id and title a settings row renders for a catalogued setting. Rows spread
 * this instead of restating the strings, so the catalog and the page cannot
 * drift apart.
 */
export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const item = SETTINGS_SEARCH_ITEMS.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`Unknown searchable setting ${id}`);
  return { id: item.id, title: item.title };
}

export function sectionLabelFor(to: SettingsSearchItem["to"]): string {
  const section = settingsSectionForPath(to);
  return section === null ? "" : SETTINGS_SECTION_LABELS[section];
}

/** Items whose title and keywords contain every query word, titles ranked first. */
export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const tokens = normalizedQuery.split(" ");

  const ranked: Array<{ item: SettingsSearchItem; rank: number; index: number }> = [];
  items.forEach((item, index) => {
    const title = normalizeSearchText(item.title);
    const haystack = normalizeSearchText(
      [item.title, sectionLabelFor(item.to), ...item.keywords].join(" "),
    );
    if (!tokens.every((token) => haystack.includes(token))) return;
    const rank =
      title === normalizedQuery
        ? 3
        : title.startsWith(normalizedQuery)
          ? 2
          : title.includes(normalizedQuery)
            ? 1
            : 0;
    ranked.push({ item, rank, index });
  });
  return ranked
    .toSorted((left, right) => right.rank - left.rank || left.index - right.index)
    .map((entry) => entry.item);
}
