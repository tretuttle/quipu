/**
 * What Quipu keeps on this device, by category.
 *
 * `navigator.storage.estimate()` reports one total, and Chromium adds
 * `usageDetails` with a breakdown. Quipu's own small state in localStorage is
 * not part of the estimate, so it is measured separately.
 */
export type StorageCategoryId = "interface" | "databases" | "files" | "caches";

export interface StorageCategory {
  readonly id: StorageCategoryId;
  readonly label: string;
  readonly description: string;
  /** Null when the browser does not break this category out. */
  readonly bytes: number | null;
}

export interface StorageUsage {
  readonly usedBytes: number | null;
  readonly quotaBytes: number | null;
  readonly categories: ReadonlyArray<StorageCategory>;
}

/** Chromium's `usageDetails` is not in the DOM typings. */
type StorageEstimateWithDetails = StorageEstimate & {
  readonly usageDetails?: Readonly<Record<string, number>>;
};

const LOCAL_STORAGE_KEY_PREFIX = "quipu:";

/** UTF-16 code units are two bytes each in the browser's quota accounting. */
export function localStorageBytes(storage: Pick<Storage, "length" | "key" | "getItem">): number {
  let bytes = 0;
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null || !key.startsWith(LOCAL_STORAGE_KEY_PREFIX)) continue;
    bytes += (key.length + (storage.getItem(key)?.length ?? 0)) * 2;
  }
  return bytes;
}

function detail(details: Readonly<Record<string, number>> | undefined, key: string): number | null {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildStorageUsage(input: {
  readonly estimate: StorageEstimate | null;
  readonly interfaceBytes: number;
}): StorageUsage {
  const estimate = input.estimate as StorageEstimateWithDetails | null;
  const details = estimate?.usageDetails;
  const hasBreakdown = details !== undefined;
  return {
    usedBytes: estimate?.usage ?? null,
    quotaBytes: estimate?.quota ?? null,
    categories: [
      {
        id: "interface",
        label: "Settings and layout",
        description: "Preferences, keybindings and panel sizes saved in this browser.",
        bytes: input.interfaceBytes,
      },
      {
        id: "databases",
        label: "Databases",
        description: "Documents and boards kept in IndexedDB.",
        bytes: hasBreakdown ? (detail(details, "indexedDB") ?? 0) : null,
      },
      {
        id: "files",
        label: "Files",
        description: "Large files kept in this browser's private file system.",
        bytes: hasBreakdown ? (detail(details, "fileSystem") ?? 0) : null,
      },
      {
        id: "caches",
        label: "Caches",
        description: "Downloaded app files kept for offline use.",
        bytes: hasBreakdown
          ? (detail(details, "caches") ?? 0) + (detail(details, "serviceWorkerRegistrations") ?? 0)
          : null,
      },
    ],
  };
}

export interface StorageClearEnvironment {
  readonly localStorage: Pick<Storage, "length" | "key" | "removeItem">;
  readonly caches: Pick<CacheStorage, "keys" | "delete"> | undefined;
  readonly indexedDB: Pick<IDBFactory, "databases" | "deleteDatabase"> | undefined;
  readonly storage: Pick<StorageManager, "getDirectory"> | undefined;
}

function deleteDatabase(factory: Pick<IDBFactory, "deleteDatabase">, name: string) {
  return new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () =>
      reject(request.error ?? new Error(`Could not delete ${name}.`)),
    );
    request.addEventListener("blocked", () => reject(new Error(`${name} is open in another tab.`)));
  });
}

/** Removes everything in one category. Rejects when the browser refuses part of it. */
export async function clearStorageCategory(
  id: StorageCategoryId,
  environment: StorageClearEnvironment,
): Promise<void> {
  switch (id) {
    case "interface": {
      const keys: string[] = [];
      for (let index = 0; index < environment.localStorage.length; index += 1) {
        const key = environment.localStorage.key(index);
        if (key !== null && key.startsWith(LOCAL_STORAGE_KEY_PREFIX)) keys.push(key);
      }
      for (const key of keys) environment.localStorage.removeItem(key);
      return;
    }
    case "databases": {
      const factory = environment.indexedDB;
      if (!factory) return;
      const databases = await factory.databases();
      for (const database of databases) {
        if (database.name !== undefined) await deleteDatabase(factory, database.name);
      }
      return;
    }
    case "files": {
      const directory = await environment.storage?.getDirectory();
      if (!directory) return;
      const names: string[] = [];
      for await (const name of directory.keys()) names.push(name);
      for (const name of names) await directory.removeEntry(name, { recursive: true });
      return;
    }
    case "caches": {
      const caches = environment.caches;
      if (!caches) return;
      for (const name of await caches.keys()) await caches.delete(name);
      return;
    }
  }
}
