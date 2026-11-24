import { DEFAULT_CLIENT_SETTINGS } from "@quipu/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function getTestWindow(): Window & typeof globalThis {
  const localStorage = createLocalStorageStub();
  const testWindow = {
    localStorage,
  } as Window & typeof globalThis;
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("localStorage", localStorage);
  return testWindow;
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client settings storage", () => {
  it("persists client settings in browser storage", async () => {
    getTestWindow();
    const { readBrowserClientSettings, writeBrowserClientSettings } =
      await import("./clientPersistenceStorage");
    const settings = { ...DEFAULT_CLIENT_SETTINGS, confirmStorageClear: false };

    writeBrowserClientSettings(settings);

    expect(readBrowserClientSettings()).toEqual(settings);
  });

  it("reads nothing before anything was saved", async () => {
    getTestWindow();
    const { readBrowserClientSettings } = await import("./clientPersistenceStorage");

    expect(readBrowserClientSettings()).toBeNull();
  });

  it.each(["not-json", '{"panelAnimationDurationMs":"slow"}'])(
    "does not treat invalid saved settings as absent: %s",
    async (value) => {
      const testWindow = getTestWindow();
      testWindow.localStorage.setItem("quipu:client-settings:v1", value);
      const { readBrowserClientSettings } = await import("./clientPersistenceStorage");

      expect(() => readBrowserClientSettings()).toThrow(
        expect.objectContaining({
          _tag: "LocalStorageOperationError",
          operation: "decode",
          storageKey: "quipu:client-settings:v1",
        }),
      );
      expect(testWindow.localStorage.getItem("quipu:client-settings:v1")).toBe(value);
    },
  );

  it("preserves saved settings across a transient read failure", async () => {
    const testWindow = getTestWindow();
    const settings = { ...DEFAULT_CLIENT_SETTINGS, confirmStorageClear: false };
    testWindow.localStorage.setItem("quipu:client-settings:v1", JSON.stringify(settings));
    const write = vi.spyOn(testWindow.localStorage, "setItem");
    const failure = new Error("storage unavailable");
    vi.spyOn(testWindow.localStorage, "getItem").mockImplementationOnce(() => {
      throw failure;
    });
    const { readBrowserClientSettings } = await import("./clientPersistenceStorage");

    expect(() => readBrowserClientSettings()).toThrow(
      expect.objectContaining({
        _tag: "LocalStorageOperationError",
        operation: "read",
        storageKey: "quipu:client-settings:v1",
        cause: failure,
      }),
    );
    expect(readBrowserClientSettings()).toEqual(settings);
    expect(write).not.toHaveBeenCalled();
  });

  it("fills missing fields with their defaults", async () => {
    const testWindow = getTestWindow();
    testWindow.localStorage.setItem("quipu:client-settings:v1", JSON.stringify({}));
    const { readBrowserClientSettings } = await import("./clientPersistenceStorage");

    expect(readBrowserClientSettings()).toEqual(DEFAULT_CLIENT_SETTINGS);
  });
});

describe("keybindings storage", () => {
  it("persists custom keybindings in browser storage", async () => {
    const testWindow = getTestWindow();
    const { readBrowserKeybindings, writeBrowserKeybindings } =
      await import("./clientPersistenceStorage");

    expect(readBrowserKeybindings()).toBeNull();
    writeBrowserKeybindings([{ key: "mod+shift+b", command: "sidebar.toggle" }]);

    expect(readBrowserKeybindings()).toEqual([{ key: "mod+shift+b", command: "sidebar.toggle" }]);
    expect(testWindow.localStorage.getItem("quipu:keybindings:v1")).toBe(
      JSON.stringify([{ key: "mod+shift+b", command: "sidebar.toggle" }]),
    );
  });

  it("skips saved rules for commands this build does not have", async () => {
    const testWindow = getTestWindow();
    testWindow.localStorage.setItem(
      "quipu:keybindings:v1",
      JSON.stringify([
        { key: "mod+t", command: "example.missing" },
        { key: "mod+j", command: "rightPanel.toggle", when: "isDesktop" },
      ]),
    );
    const { readBrowserKeybindings } = await import("./clientPersistenceStorage");

    expect(readBrowserKeybindings()).toEqual([
      { key: "mod+j", command: "rightPanel.toggle", when: "isDesktop" },
    ]);
  });
});
