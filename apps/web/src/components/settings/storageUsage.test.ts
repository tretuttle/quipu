import { describe, expect, it } from "vite-plus/test";

import {
  buildStorageUsage,
  clearStorageCategory,
  localStorageBytes,
  type StorageClearEnvironment,
} from "./storageUsage";

function fakeLocalStorage(entries: Record<string, string>) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

describe("localStorageBytes", () => {
  it("counts only Quipu's keys, two bytes per character of key and value", () => {
    const storage = fakeLocalStorage({
      "quipu:client-settings:v1": "{}",
      "quipu:keybindings:v1": "[]",
      "someone-else": "x".repeat(1000),
    });
    const expected =
      ("quipu:client-settings:v1".length + 2 + "quipu:keybindings:v1".length + 2) * 2;
    expect(localStorageBytes(storage)).toBe(expected);
  });
});

describe("buildStorageUsage", () => {
  it("breaks the estimate out by category", () => {
    const usage = buildStorageUsage({
      estimate: {
        usage: 5_000,
        quota: 1_000_000,
        usageDetails: {
          indexedDB: 3_000,
          fileSystem: 1_000,
          caches: 400,
          serviceWorkerRegistrations: 100,
        },
      } as StorageEstimate,
      interfaceBytes: 120,
    });
    expect(usage.usedBytes).toBe(5_000);
    expect(usage.quotaBytes).toBe(1_000_000);
    expect(
      Object.fromEntries(usage.categories.map((category) => [category.id, category.bytes])),
    ).toEqual({
      interface: 120,
      databases: 3_000,
      files: 1_000,
      caches: 500,
    });
  });

  it("reports unknown for categories the browser does not break out", () => {
    const usage = buildStorageUsage({
      estimate: { usage: 10, quota: 100 },
      interfaceBytes: 8,
    });
    expect(usage.categories.map((category) => category.bytes)).toEqual([8, null, null, null]);
  });

  it("treats a missing estimate as unknown totals", () => {
    const usage = buildStorageUsage({ estimate: null, interfaceBytes: 0 });
    expect(usage.usedBytes).toBeNull();
    expect(usage.quotaBytes).toBeNull();
  });
});

describe("clearStorageCategory", () => {
  function environment(overrides: Partial<StorageClearEnvironment> = {}) {
    const localStorage = fakeLocalStorage({
      "quipu:client-settings:v1": "{}",
      "quipu:sidebar-width": "300",
      "someone-else": "keep",
    });
    return {
      localStorage,
      env: {
        localStorage,
        caches: undefined,
        indexedDB: undefined,
        storage: undefined,
        ...overrides,
      } satisfies StorageClearEnvironment,
    };
  }

  it("removes Quipu's localStorage keys and nothing else", async () => {
    const { localStorage, env } = environment();
    await clearStorageCategory("interface", env);
    expect([...localStorage.store.keys()]).toEqual(["someone-else"]);
  });

  it("deletes every cache", async () => {
    const deleted: string[] = [];
    const { env } = environment({
      caches: {
        keys: async () => ["app-shell", "fonts"],
        delete: async (name: string) => {
          deleted.push(name);
          return true;
        },
      },
    });
    await clearStorageCategory("caches", env);
    expect(deleted).toEqual(["app-shell", "fonts"]);
  });

  it("deletes every database and waits for each", async () => {
    const deleted: string[] = [];
    const { env } = environment({
      indexedDB: {
        databases: async () => [{ name: "documents" }, { name: "boards" }],
        deleteDatabase: (name: string) => {
          const request = new EventTarget() as IDBOpenDBRequest;
          queueMicrotask(() => {
            deleted.push(name);
            request.dispatchEvent(new Event("success"));
          });
          return request;
        },
      },
    });
    await clearStorageCategory("databases", env);
    expect(deleted).toEqual(["documents", "boards"]);
  });

  it("rejects when a database is held open elsewhere", async () => {
    const { env } = environment({
      indexedDB: {
        databases: async () => [{ name: "documents" }],
        deleteDatabase: () => {
          const request = new EventTarget() as IDBOpenDBRequest;
          queueMicrotask(() => request.dispatchEvent(new Event("blocked")));
          return request;
        },
      },
    });
    await expect(clearStorageCategory("databases", env)).rejects.toThrow(
      "documents is open in another tab.",
    );
  });

  it("removes each entry of the private file system", async () => {
    const removed: Array<[string, boolean | undefined]> = [];
    const directory = {
      keys: async function* () {
        yield "big.har";
        yield "scratch";
      },
      removeEntry: async (name: string, options?: FileSystemRemoveOptions) => {
        removed.push([name, options?.recursive]);
      },
    } as unknown as FileSystemDirectoryHandle;
    const { env } = environment({ storage: { getDirectory: async () => directory } });
    await clearStorageCategory("files", env);
    expect(removed).toEqual([
      ["big.har", true],
      ["scratch", true],
    ]);
  });
});
