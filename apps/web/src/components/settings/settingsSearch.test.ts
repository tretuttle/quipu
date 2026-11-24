import { describe, expect, it } from "vite-plus/test";

import {
  OPEN_SOURCE_LICENSES_PATH,
  SETTINGS_SECTION_LABELS,
  searchableSetting,
  searchSettings,
  settingsSectionForPath,
  type SettingsSearchItem,
} from "./settingsSearch";

const items: ReadonlyArray<SettingsSearchItem> = [
  { id: "a", to: "/settings/general", title: "Confirm before clearing", keywords: ["dialog"] },
  { id: "b", to: "/settings/storage", title: "Storage used", keywords: ["clear data"] },
  { id: "c", to: "/settings/general", title: "Version", keywords: ["about"] },
];

describe("searchSettings", () => {
  it("returns nothing for a blank query", () => {
    expect(searchSettings("   ", items)).toEqual([]);
  });

  it("matches titles and keywords, and the section name", () => {
    expect(searchSettings("dialog", items).map((item) => item.id)).toEqual(["a"]);
    expect(searchSettings("about", items).map((item) => item.id)).toEqual(["c"]);
    expect(searchSettings("general", items).map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("requires every word to match", () => {
    expect(searchSettings("clear storage", items).map((item) => item.id)).toEqual(["b"]);
    expect(searchSettings("clear zebra", items)).toEqual([]);
  });

  it("ranks a title match ahead of a keyword match", () => {
    expect(searchSettings("clear", items).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("ignores case and accents", () => {
    expect(searchSettings("VÉRSION", items).map((item) => item.id)).toEqual(["c"]);
  });
});

describe("settingsSectionForPath", () => {
  it("treats the licenses page as part of General, where About lives", () => {
    expect(settingsSectionForPath(OPEN_SOURCE_LICENSES_PATH)).toBe("/settings/general");
  });

  it("matches a section by prefix and ignores a trailing slash", () => {
    expect(settingsSectionForPath("/settings/keybindings/")).toBe("/settings/keybindings");
    expect(settingsSectionForPath("/settings/unknown")).toBeNull();
  });
});

describe("Appearance in the settings search", () => {
  it("is a page of its own, between General and Keybindings", () => {
    expect(Object.values(SETTINGS_SECTION_LABELS)).toEqual([
      "General",
      "Appearance",
      "Keybindings",
      "Storage",
    ]);
    expect(settingsSectionForPath("/settings/appearance")).toBe("/settings/appearance");
  });

  it.each([
    ["contrast", "Contrast"],
    ["glass", "Glass opacity"],
    ["panel animation", "Panel animations"],
    ["interface font", "Interface font"],
    ["monospace", "Code font"],
    ["palette", "Themes"],
  ])("finds %j on the Appearance page", (query, title) => {
    const results = searchSettings(query);
    expect(results.map((item) => item.title)).toContain(title);
    expect(results.find((item) => item.title === title)?.to).toBe("/settings/appearance");
  });

  it("gives a row the id and title the search lists", () => {
    expect(searchableSetting("setting-glass-opacity")).toEqual({
      id: "setting-glass-opacity",
      title: "Glass opacity",
    });
  });
});
