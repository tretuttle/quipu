import { describe, expect, it } from "vite-plus/test";

import { migratePersistedRightPanelState, isRightPanelTab } from "./rightPanelStore";

describe("migratePersistedRightPanelState", () => {
  it("keeps a valid saved state", () => {
    expect(migratePersistedRightPanelState({ isOpen: true, activeTab: "source" })).toEqual({
      isOpen: true,
      activeTab: "source",
    });
  });

  it.each([null, undefined, "garbage", 7, [], { isOpen: "yes", activeTab: "missing" }])(
    "falls back to a closed panel on the Inspector for %j",
    (saved) => {
      expect(migratePersistedRightPanelState(saved)).toEqual({
        isOpen: false,
        activeTab: "inspector",
      });
    },
  );

  it("reopens a panel saved on a tab that no longer exists on the Inspector", () => {
    expect(migratePersistedRightPanelState({ isOpen: true, activeTab: "files" })).toEqual({
      isOpen: true,
      activeTab: "inspector",
    });
  });

  it("recognizes the Inspector, Source, Trace, Schema, and Problems tabs", () => {
    expect(["inspector", "source", "trace", "schema", "problems"].every(isRightPanelTab)).toBe(
      true,
    );
    for (const tab of ["diff", "files", "missing"]) expect(isRightPanelTab(tab)).toBe(false);
  });
});
