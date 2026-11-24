import { describe, expect, it } from "vite-plus/test";

import {
  clampSidebarWidth,
  MAIN_CONTENT_MIN_WIDTH,
  resolveInitialSidebarWidth,
  resolveSidebarMaximumWidth,
  resolveSidebarMinimumWidth,
  SIDEBAR_MIN_WIDTH,
} from "./sidebarWidth";

describe("sidebar width", () => {
  it("opens at the default width on a wide viewport", () => {
    expect(resolveInitialSidebarWidth(null, 1920)).toBe(256);
  });

  it("restores a stored width but never below the minimum", () => {
    expect(resolveInitialSidebarWidth(320, 1920)).toBe(320);
    expect(resolveInitialSidebarWidth(40, 1920)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("leaves room for the main content on a narrow viewport", () => {
    const viewport = 900;
    expect(resolveSidebarMaximumWidth(viewport)).toBe(viewport - MAIN_CONTENT_MIN_WIDTH);
    expect(resolveInitialSidebarWidth(600, viewport)).toBe(viewport - MAIN_CONTENT_MIN_WIDTH);
  });

  it("lets a wide brand raise the minimum", () => {
    expect(resolveSidebarMinimumWidth(100)).toBe(SIDEBAR_MIN_WIDTH);
    expect(resolveSidebarMinimumWidth(250.2)).toBe(251);
  });

  it("clamps into the given range", () => {
    expect(clampSidebarWidth(100, 208, 600)).toBe(208);
    expect(clampSidebarWidth(700, 208, 600)).toBe(600);
    expect(clampSidebarWidth(300, 208, 600)).toBe(300);
  });
});
