import { describe, expect, it } from "vite-plus/test";

import { createPersistedDocument } from "./persistedDocument";

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createPersistedDocument", () => {
  it("publishes the stored value once it has been read", async () => {
    const document = createPersistedDocument({
      name: "test",
      defaults: { count: 0 },
      read: () => ({ count: 7 }),
      write: () => undefined,
    });
    await document.hydrate();
    expect(document.getSnapshot()).toEqual({ count: 7 });
    expect(document.getHydrationStatus()).toBe("ready");
  });

  it("keeps the defaults when nothing was saved", async () => {
    const document = createPersistedDocument({
      name: "test",
      defaults: { count: 0 },
      read: () => null,
      write: () => undefined,
    });
    await document.hydrate();
    expect(document.getSnapshot()).toEqual({ count: 0 });
    expect(document.getHydrationStatus()).toBe("ready");
  });

  it("applies an update made before the read finished on top of what was stored", async () => {
    const read = deferred<{ count: number } | null>();
    const written: Array<{ count: number }> = [];
    const document = createPersistedDocument({
      name: "test",
      defaults: { count: 0 },
      read: () => read.promise,
      write: (value) => {
        written.push(value);
      },
    });
    const pending = document.update((current) => ({ count: current.count + 1 }));
    read.resolve({ count: 10 });
    await pending;
    expect(written).toEqual([{ count: 11 }]);
    expect(document.getSnapshot()).toEqual({ count: 11 });
  });

  it("never writes when the read failed, so defaults cannot replace saved data", async () => {
    const written: unknown[] = [];
    const document = createPersistedDocument({
      name: "test",
      defaults: { count: 0 },
      read: () => {
        throw new Error("disk unavailable");
      },
      write: (value) => {
        written.push(value);
      },
    });
    await expect(document.update(() => ({ count: 1 }))).rejects.toThrow("disk unavailable");
    expect(written).toEqual([]);
    expect(document.getHydrationStatus()).toBe("failed");
  });

  it("persists queued updates in order, each seeing the one before", async () => {
    const written: Array<{ count: number }> = [];
    const document = createPersistedDocument({
      name: "test",
      defaults: { count: 0 },
      read: () => null,
      write: async (value) => {
        written.push(value);
      },
    });
    await Promise.all([
      document.update((current) => ({ count: current.count + 1 })),
      document.update((current) => ({ count: current.count * 10 })),
      document.update((current) => ({ count: current.count + 2 })),
    ]);
    expect(written).toEqual([{ count: 1 }, { count: 10 }, { count: 12 }]);
    expect(document.getSnapshot()).toEqual({ count: 12 });
  });

  it("does not publish a value whose write failed", async () => {
    let failNext = true;
    const document = createPersistedDocument({
      name: "test",
      defaults: { count: 0 },
      read: () => null,
      write: () => {
        if (failNext) {
          failNext = false;
          throw new Error("quota exceeded");
        }
      },
    });
    await expect(document.update(() => ({ count: 5 }))).rejects.toThrow("quota exceeded");
    expect(document.getSnapshot()).toEqual({ count: 0 });
    await document.update(() => ({ count: 6 }));
    expect(document.getSnapshot()).toEqual({ count: 6 });
  });
});
