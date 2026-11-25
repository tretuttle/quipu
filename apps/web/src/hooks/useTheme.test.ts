// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { getThemeColorsForMode, ORCHID_THEME } from "../themePalette";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme-id");
  document.documentElement.removeAttribute("style");
  document.body.innerHTML = "";
});

describe("theme failure handling", () => {
  it("preserves exact storage causes and operation context", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const readCause = new Error("storage read blocked");
    const writeCause = new Error("storage quota exceeded");
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw readCause;
        },
        setItem: () => {
          throw writeCause;
        },
      }),
    });

    const { readThemePreference, ThemeStorageError, writeThemePreference } =
      await import("./useTheme");

    try {
      readThemePreference();
      expect.unreachable("expected the theme read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "read",
        storageKey: "quipu:theme",
        cause: readCause,
      });
    }

    try {
      writeThemePreference("dark");
      expect.unreachable("expected the theme write to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "write",
        storageKey: "quipu:theme",
        theme: "dark",
        cause: writeCause,
      });
    }
  });

  it("reads a stored built-in palette by its id", async () => {
    const storage = createStorage();
    storage.setItem("quipu:theme", "orchid");
    vi.stubGlobal("window", { localStorage: storage });

    const { readThemePreference } = await import("./useTheme");

    expect(readThemePreference()).toBe("orchid");
  });

  it("gives a new install the stock Graphite look, following the system", async () => {
    vi.stubGlobal("window", { localStorage: createStorage() });

    const { readAppearanceModePreference, readThemePreference } = await import("./useTheme");

    expect(readThemePreference()).toBe("system");
    expect(readAppearanceModePreference(readThemePreference())).toBe("system");
  });

  it("keeps a legacy single-mode preference in its own mode", async () => {
    const storage = createStorage();
    storage.setItem("quipu:theme", "dark");
    vi.stubGlobal("window", { localStorage: storage });

    const { readAppearanceModePreference, readThemePreference } = await import("./useTheme");

    expect(readAppearanceModePreference(readThemePreference())).toBe("dark");
  });

  it("falls back during initial theme application and logs only safe attributes", async () => {
    const cause = new Error("private browsing storage failure");
    const logged: Array<readonly [unknown, unknown]> = [];
    vi.spyOn(console, "error").mockImplementation((message?: unknown, attributes?: unknown) => {
      logged.push([message, attributes]);
    });
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createStorage({
        getItem: () => {
          throw cause;
        },
      }),
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });

    await import("./useTheme");

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.dataset.themeId).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--app-theme-canvas")).toBe("");
    expect(logged).toEqual([
      [
        "Failed to read theme preference for quipu:theme.",
        expect.objectContaining({
          operation: "read",
          storageKey: "quipu:theme",
          errorTag: "ThemeStorageError",
        }),
      ],
    ]);
    const attributes = logged[0]?.[1];
    expect(attributes).not.toHaveProperty("cause");
    expect(JSON.stringify(attributes)).not.toContain(cause.message);
  });

  it("retries a failed storage read only after a relevant storage event", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const cause = new Error("persistent storage failure");
    let failThemeRead = true;
    const backing = new Map<string, string>([["quipu:theme", "orchid"]]);
    const storage = createStorage({
      getItem: (key) => {
        if (key === "quipu:theme" && failThemeRead) throw cause;
        return backing.get(key) ?? null;
      },
      setItem: (key, value) => {
        backing.set(key, value);
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });

    const { useTheme } = await import("./useTheme");

    function Probe() {
      const { theme } = useTheme();
      return createElement("output", { "data-theme-probe": theme }, theme);
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(Probe));
    });

    expect(host.querySelector("output")?.textContent).toBe("system");
    expect(document.documentElement.dataset.themeId).toBeUndefined();

    // Storage recovers, but an unrelated storage key does not clear the cached read failure.
    failThemeRead = false;
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "quipu:theme-follow-system" }));
    });
    expect(host.querySelector("output")?.textContent).toBe("system");
    expect(document.documentElement.dataset.themeId).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--app-theme-canvas")).toBe("");

    // A storage event for quipu:theme clears the failure and applies the stored theme.
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "quipu:theme" }));
    });
    expect(storage.getItem("quipu:theme")).toBe("orchid");
    expect(host.querySelector("output")?.textContent).toBe("orchid");
    expect(document.documentElement.dataset.themeId).toBe("orchid");
    expect(document.documentElement.style.getPropertyValue("--app-theme-canvas")).toBe(
      getThemeColorsForMode(ORCHID_THEME, "light")!.canvas,
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("preserves desktop sync causes and retries after a failed cosmetic sync", async () => {
    const cause = new Error("desktop IPC unavailable");
    const logged: Array<readonly [unknown, unknown]> = [];
    vi.spyOn(console, "error").mockImplementation((message?: unknown, attributes?: unknown) => {
      logged.push([message, attributes]);
    });
    let desktopShellTheme: string | null = null;
    let rejectNextSync = true;
    const setTheme = async (next: string) => {
      if (rejectNextSync) throw cause;
      desktopShellTheme = next;
    };
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { setTheme },
    });

    const { DesktopThemeSyncError, syncDesktopTheme, syncDesktopThemePreference } =
      await import("./useTheme");
    await Promise.resolve();
    await Promise.resolve();
    logged.length = 0;

    const error = await syncDesktopThemePreference({ setTheme }, "dark").then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(DesktopThemeSyncError);
    expect(error).toMatchObject({ theme: "dark", cause });

    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();
    expect(desktopShellTheme).toBeNull();

    rejectNextSync = false;
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();
    expect(desktopShellTheme).toBe("dark");

    expect(logged).toEqual([
      [
        "Failed to sync the dark theme to the desktop shell.",
        expect.objectContaining({
          theme: "dark",
          errorTag: "DesktopThemeSyncError",
        }),
      ],
    ]);
    for (const [, attributes] of logged) {
      expect(attributes).not.toHaveProperty("cause");
      expect(JSON.stringify(attributes)).not.toContain(cause.message);
    }
  });
});
