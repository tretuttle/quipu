/**
 * A small document the app keeps on the device (client settings, keybindings).
 *
 * Reads happen once, lazily. Until a read has succeeded, no write may reach
 * storage: the in-memory value is only the schema defaults, and persisting it
 * would overwrite what the user saved. Writes queue so two quick changes never
 * persist out of order, and each persists the value after every earlier change.
 */
export type PersistedDocumentHydrationStatus = "pending" | "ready" | "failed" | "retrying";

export interface PersistedDocument<T> {
  readonly getSnapshot: () => T;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getHydrationStatus: () => PersistedDocumentHydrationStatus;
  readonly subscribeHydration: (listener: () => void) => () => void;
  /** Resolves once storage has been read. Rejects when the read failed; a later call retries. */
  readonly hydrate: () => Promise<void>;
  /** Persists `update(current)` and publishes it. The update re-runs if another write landed first. */
  readonly update: (update: (current: T) => T) => Promise<T>;
}

export function createPersistedDocument<T>(options: {
  readonly name: string;
  readonly defaults: T;
  /** The stored value, or null when nothing has been saved yet. */
  readonly read: () => T | null | Promise<T | null>;
  readonly write: (value: T) => void | Promise<void>;
}): PersistedDocument<T> {
  const listeners = new Set<() => void>();
  const hydrationListeners = new Set<() => void>();
  let snapshot = options.defaults;
  let status: PersistedDocumentHydrationStatus = "pending";
  let hydration: Promise<void> | null = null;
  let writeQueue: Promise<unknown> = Promise.resolve();

  const publish = (value: T) => {
    snapshot = value;
    for (const listener of listeners) listener();
  };
  const setStatus = (next: PersistedDocumentHydrationStatus) => {
    if (status === next) return;
    status = next;
    for (const listener of hydrationListeners) listener();
  };

  const hydrate = (): Promise<void> => {
    if (status === "ready") return Promise.resolve();
    if (hydration) return hydration;
    setStatus(status === "failed" || status === "retrying" ? "retrying" : "pending");
    const attempt = (async () => {
      try {
        const stored = await options.read();
        if (stored !== null) publish(stored);
        setStatus("ready");
      } catch (error) {
        setStatus("failed");
        console.error(`[${options.name}] read failed`, error);
        throw error;
      }
    })();
    const settled = attempt.finally(() => {
      if (hydration === settled) hydration = null;
    });
    hydration = settled;
    return settled;
  };

  const enqueue = <A>(work: () => Promise<A>): Promise<A> => {
    const result = writeQueue.then(work);
    writeQueue = result.catch(() => undefined);
    return result;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      void hydrate().catch(() => undefined);
      return () => {
        listeners.delete(listener);
      };
    },
    getHydrationStatus: () => status,
    subscribeHydration: (listener) => {
      hydrationListeners.add(listener);
      void hydrate().catch(() => undefined);
      return () => {
        hydrationListeners.delete(listener);
      };
    },
    hydrate,
    update: (update) =>
      enqueue(async () => {
        if (status !== "ready") await hydrate();
        for (;;) {
          const current = snapshot;
          const next = update(current);
          await options.write(next);
          if (snapshot === current) {
            publish(next);
            return next;
          }
        }
      }),
  };
}
