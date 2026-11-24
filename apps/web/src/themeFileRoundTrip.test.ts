import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import t3ExportedThemeFile from "./testFixtures/t3-cord-sunrise.theme.json?raw";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes,
  installCustomTheme,
  invalidateCustomThemes,
  parseThemeFile,
  QUIPU_THEME,
  serializeThemeFile,
  THEME_FILE_VERSION,
} from "./themePalette";

function stubBrowserStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  invalidateCustomThemes();
  return store;
}

afterEach(() => {
  invalidateCustomThemes();
  vi.unstubAllGlobals();
});

describe("theme file interchange with T3 Code", () => {
  // The fixture is a file T3 Code's own theme export wrote. Comparing the
  // strings catches a reordered key, a different color precision, or a missing
  // trailing newline, which a JSON.parse comparison would pass.
  it("exports a file T3 Code wrote byte for byte", () => {
    expect(t3ExportedThemeFile.endsWith("}\n")).toBe(true);
    const imported = parseThemeFile(JSON.parse(t3ExportedThemeFile));

    expect(serializeThemeFile(imported)).toBe(t3ExportedThemeFile);
  });

  it("keeps the bytes through the installed theme library", () => {
    const store = stubBrowserStorage();

    installCustomTheme(parseThemeFile(JSON.parse(t3ExportedThemeFile)));
    invalidateCustomThemes();

    const stored = JSON.parse(store.get(CUSTOM_THEMES_STORAGE_KEY) ?? "null") as Array<{
      id: string;
      label: string;
    }>;
    expect(stored.map((theme) => [theme.id, theme.label])).toEqual([
      ["cord-sunrise", "Cord Sunrise"],
    ]);
    const [installed] = getCustomThemes();
    expect(installed).toBeDefined();
    expect(serializeThemeFile(installed!)).toBe(t3ExportedThemeFile);
  });

  it("writes the version, name, and T3 Code's key order at the top of the file", () => {
    const file = JSON.parse(t3ExportedThemeFile) as Record<string, unknown>;

    expect(Object.keys(file)).toEqual([
      "version",
      "id",
      "name",
      "appearance",
      "colors",
      "variants",
      "collection",
    ]);
    expect(file.version).toBe(THEME_FILE_VERSION);
    expect(THEME_FILE_VERSION).toBe(1);
  });

  // Built-in ids are reserved, so a copy has to take a new id.
  it("exports the Quipu palette as a file a copy of it can import without losing a color", () => {
    const exported = serializeThemeFile(QUIPU_THEME);
    const file = JSON.parse(exported) as Record<string, unknown>;

    expect(file).toMatchObject({ version: 1, id: "quipu", name: "Quipu", appearance: "light" });
    expect(Object.keys(file.variants as object)).toEqual(["dark"]);
    expect(() => parseThemeFile(file)).toThrow('The theme id "quipu" is reserved.');

    const copy = { ...file, id: "quipu-copy" };
    expect(serializeThemeFile(parseThemeFile(copy))).toBe(`${JSON.stringify(copy, null, 2)}\n`);
  });
});
