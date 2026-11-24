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
    expect(migratePersistedRightPanelState({ isOpen: true, activeTab: "schema" })).toEqual({
      isOpen: true,
      activeTab: "inspector",
    });
  });

  it("recognizes exactly the Inspector and Source tabs", () => {
    expect(["inspector", "source"].every(isRightPanelTab)).toBe(true);
    for (const tab of ["diff", "schema", "files"]) expect(isRightPanelTab(tab)).toBe(false);
  });
});
