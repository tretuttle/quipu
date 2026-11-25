/**
 * Worker-readable spill backing for transforms (sort, format, minify).
 *
 * Every transform spill goes to an OPFS scratch file when available (Chromium
 * web and Electron desktop) so scan workers read it as a disk-backed `File`
 * (`Blob`) without keeping the whole output in RAM. When OPFS is unavailable
 * (Node tests or restricted contexts), it falls back to a `Blob` in memory.
 */
import type { Sink } from "./save.ts";
import type { ByteSource } from "./source.ts";

export interface SpillScratch {
  readonly sink: Sink;
  finish(): Promise<Blob>;
  release(): Promise<void>;
}

const SCRATCH_DIRECTORY = "quipu-spill-scratch";
const MIRROR_STEP_BYTES = 8 * 1024 * 1024;
const makeSessionId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const words = new Uint32Array(2);
    crypto.getRandomValues(words);
    return `${words[0]?.toString(36) ?? "0"}-${words[1]?.toString(36) ?? "0"}`;
  }
  return "session-0";
};
const session = makeSessionId();
let nextFile = 1;
let scratchDirectory: Promise<FileSystemDirectoryHandle | null> | null = null;

const openScratchDirectory = async (): Promise<FileSystemDirectoryHandle | null> => {
  if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") {
    return null;
  }
  try {
    const root = await navigator.storage.getDirectory();
    const all = await root.getDirectoryHandle(SCRATCH_DIRECTORY, { create: true });
    if (navigator.locks) {
      await new Promise<void>((held) => {
        void navigator.locks.request(`quipu:${SCRATCH_DIRECTORY}:${session}`, () => {
          held();
          return new Promise<never>(() => {});
        });
      });
      const keys = (all as unknown as { keys?: () => AsyncIterable<string> }).keys?.();
      if (keys) {
        for await (const name of keys) {
          if (name === session) continue;
          await navigator.locks.request(
            `quipu:${SCRATCH_DIRECTORY}:${name}`,
            { ifAvailable: true },
            async (lock) => {
              if (lock) await all.removeEntry(name, { recursive: true }).catch(() => {});
            },
          );
        }
      }
    }
    return await all.getDirectoryHandle(session, { create: true });
  } catch {
    return null;
  }
};

/** Scratch bytes in memory as a Blob, for hosts without OPFS (tests). */
export const memoryScratchBlob = (): SpillScratch => {
  let parts: Blob[] = [];
  let blob: Blob | null = null;
  return {
    sink: {
      write: async (bytes) => {
        parts.push(new Blob([bytes as Uint8Array<ArrayBuffer>]));
      },
      close: async () => {},
      abort: async () => {
        parts = [];
      },
    },
    finish: async () => {
      blob ??= new Blob(parts);
      parts = [];
      return blob;
    },
    release: async () => {
      parts = [];
      blob = null;
    },
  };
};

/** Opens an OPFS scratch file for a transform spill, falling back to an in-memory Blob. */
export const openSpillScratch = async (options?: {
  readonly directory?: () => Promise<FileSystemDirectoryHandle | null>;
}): Promise<SpillScratch> => {
  const dir = options?.directory
    ? await options.directory().catch(() => null)
    : await (scratchDirectory ??= openScratchDirectory());
  if (dir === null) return memoryScratchBlob();
  const name = `spill-${nextFile++}.bin`;
  try {
    const handle = await dir.getFileHandle(name, { create: true });
    if (typeof handle.createWritable === "function") {
      const writer = (await handle.createWritable()).getWriter();
      return {
        sink: {
          write: (bytes) => writer.write(bytes as Uint8Array<ArrayBuffer>),
          close: () => writer.close(),
          abort: () => writer.abort(),
        },
        finish: () => handle.getFile(),
        release: () => dir.removeEntry(name).catch(() => {}),
      };
    }
    const withSync = handle as FileSystemFileHandle & {
      createSyncAccessHandle?: () => Promise<{
        write(buffer: Uint8Array, options: { at: number }): number;
        flush(): void;
        close(): void;
      }>;
    };
    if (typeof withSync.createSyncAccessHandle === "function") {
      const sync = await withSync.createSyncAccessHandle();
      let offset = 0;
      let closed = false;
      const closeHandle = () => {
        if (closed) return;
        closed = true;
        sync.flush();
        sync.close();
      };
      return {
        sink: {
          write: async (bytes) => {
            sync.write(bytes, { at: offset });
            offset += bytes.byteLength;
          },
          close: async () => closeHandle(),
          abort: async () => closeHandle(),
        },
        finish: async () => {
          closeHandle();
          return handle.getFile();
        },
        release: () => {
          closeHandle();
          return dir.removeEntry(name).catch(() => {});
        },
      };
    }
    await dir.removeEntry(name).catch(() => {});
    return memoryScratchBlob();
  } catch {
    await dir.removeEntry(name).catch(() => {});
    return memoryScratchBlob();
  }
};

/** Writes every chunk to both sinks so journal durability and worker-readable scratch stay in sync. */
export const teeSink = (primary: Sink, secondary: Sink): Sink => ({
  write: async (bytes) => {
    await Promise.all([primary.write(bytes), secondary.write(bytes)]);
  },
  close: async () => {
    await Promise.all([primary.close(), secondary.close()]);
  },
  abort: async () => {
    await Promise.allSettled([primary.abort(), secondary.abort()]);
  },
});

/** Copies `[0, length)` from a non-Blob ByteSource into a worker-readable scratch Blob. */
export const mirrorSourceToSpillBlob = async (
  source: Pick<ByteSource, "read">,
  length: number,
  openScratch: () => Promise<SpillScratch> = openSpillScratch,
): Promise<{ readonly blob: Blob; readonly release: () => Promise<void> }> => {
  const scratch = await openScratch();
  try {
    for (let at = 0; at < length; at += MIRROR_STEP_BYTES) {
      const end = Math.min(length, at + MIRROR_STEP_BYTES);
      const chunk = await source.read(at, end);
      if (chunk.byteLength > 0) await scratch.sink.write(chunk);
    }
    await scratch.sink.close();
    const blob = await scratch.finish();
    return { blob, release: scratch.release };
  } catch (error) {
    await scratch.sink.abort().catch(() => {});
    await scratch.release().catch(() => {});
    throw error;
  }
};
