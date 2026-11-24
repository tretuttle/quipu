import { describe, expect, it } from "vite-plus/test";

import {
  getWindowTitleBarOptions,
  isRetryableDevelopmentRendererLoadFailure,
  isSameOriginRendererNavigation,
} from "./DesktopWindow.ts";

describe("window title bar", () => {
  it("overlays a 40px title bar with native controls on Linux and Windows", () => {
    for (const platform of ["linux", "win32"] as const) {
      const dark = getWindowTitleBarOptions(true, platform);
      expect(dark.titleBarStyle).toBe("hidden");
      expect(dark.titleBarOverlay).toMatchObject({ height: 40, symbolColor: "#f8fafc" });
      expect(dark.trafficLightPosition).toBeUndefined();

      const light = getWindowTitleBarOptions(false, platform);
      expect(light.titleBarOverlay).toMatchObject({ height: 40, symbolColor: "#1f2937" });
    }
  });

  it("insets the macOS traffic lights at x 16 inside the 52px bar", () => {
    const options = getWindowTitleBarOptions(true, "darwin");
    expect(options.titleBarStyle).toBe("hiddenInset");
    expect(options.trafficLightPosition).toEqual({ x: 16, y: 19 });
    expect(options.titleBarOverlay).toBeUndefined();
  });
});

describe("renderer navigation", () => {
  it("keeps the renderer on the app origin", () => {
    expect(
      isSameOriginRendererNavigation({
        applicationUrl: "quipu://app/",
        navigationUrl: "quipu://app/settings",
      }),
    ).toBe(true);
    expect(
      isSameOriginRendererNavigation({
        applicationUrl: "quipu://app/",
        navigationUrl: "https://example.com/",
      }),
    ).toBe(false);
    expect(
      isSameOriginRendererNavigation({ applicationUrl: "quipu://app/", navigationUrl: "nope" }),
    ).toBe(false);
  });

  it("retries only main-frame loads of the app origin that failed transiently", () => {
    const base = { applicationUrl: "quipu-dev://app/", validatedUrl: "quipu-dev://app/" };
    expect(
      isRetryableDevelopmentRendererLoadFailure({ ...base, errorCode: -102, isMainFrame: true }),
    ).toBe(true);
    expect(
      isRetryableDevelopmentRendererLoadFailure({ ...base, errorCode: -102, isMainFrame: false }),
    ).toBe(false);
    expect(
      isRetryableDevelopmentRendererLoadFailure({ ...base, errorCode: -3, isMainFrame: true }),
    ).toBe(false);
    expect(
      isRetryableDevelopmentRendererLoadFailure({
        ...base,
        validatedUrl: "https://example.com/",
        errorCode: -102,
        isMainFrame: true,
      }),
    ).toBe(false);
  });
});
