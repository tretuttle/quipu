/**
 * The desktop journal store: the same `journals/<kind>/<id>/…` files as OPFS,
 * under the state directory, written by the main process with `sync` as the
 * durability call.
 * A replace is a `.tmp` sibling renamed over the target. Paths are relative and
 * are refused when they leave the state directory.
 */
import type { JournalStore } from "@quipu/core/journalStore";
import * as HostProcess from "@quipu/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";

class DesktopJournalPathError extends Error {
  constructor(path: string) {
    super(`journal path ${path} leaves the state directory`);
  }
}

/** Builds a store rooted at `stateDir`; every operation runs with the given services. */
export const makeDesktopJournalStore = Effect.fn("desktop.documents.makeJournalStore")(function* (
  stateDir: string,
): Effect.fn.Return<JournalStore, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(context)(effect);
  const resolve = (relative: string) => {
    const full = path.resolve(stateDir, relative);
    if (full !== stateDir && !full.startsWith(stateDir + path.sep))
      throw new DesktopJournalPathError(relative);
    return full;
  };
  const sizeOf = (full: string) =>
    fileSystem.stat(full).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => -1),
    );
  /** Open, do the work, sync and close; the scope closes the handle on any outcome. */
  const withFile = <A>(
    full: string,
    flag: "r" | "a" | "r+" | "w",
    work: (file: FileSystem.File) => Effect.Effect<A, PlatformError>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(full, { flag });
        const result = yield* work(file);
        if (flag !== "r") yield* file.sync;
        return result;
      }),
    );
  const ensureDirectory = (full: string) =>
    fileSystem.makeDirectory(path.dirname(full), { recursive: true });

  const store: JournalStore = {
    size: async (relative) => run(sizeOf(resolve(relative))),
    read: async (relative, start, end) =>
      run(
        Effect.gen(function* () {
          const full = resolve(relative);
          const size = yield* sizeOf(full);
          if (size < 0) return new Uint8Array(0);
          const from = Math.min(start, size);
          const to = Math.min(end, size);
          if (to <= from) return new Uint8Array(0);
          return yield* withFile(full, "r", (file) =>
            Effect.gen(function* () {
              const out = new Uint8Array(to - from);
              yield* file.seek(BigInt(from), "start");
              let filled = 0;
              while (filled < out.byteLength) {
                const n = yield* file.read(out.subarray(filled));
                if (n === 0) break;
                filled += n;
              }
              return out.subarray(0, filled);
            }),
          );
        }),
      ),
    append: async (relative, bytes) =>
      run(
        Effect.gen(function* () {
          const full = resolve(relative);
          yield* ensureDirectory(full);
          yield* withFile(full, "a", (file) => file.writeAll(bytes));
        }),
      ),
    truncate: async (relative, size) =>
      run(
        Effect.gen(function* () {
          const full = resolve(relative);
          // A log never written to is already empty.
          if (size === 0 && (yield* sizeOf(full)) < 0) return;
          yield* ensureDirectory(full);
          yield* withFile(full, "r+", (file) => file.truncate(size));
        }),
      ),
    replace: async (relative, bytes) =>
      run(
        Effect.gen(function* () {
          const full = resolve(relative);
          yield* ensureDirectory(full);
          const tmp = `${full}.tmp`;
          yield* withFile(tmp, "w", (file) => file.writeAll(bytes));
          yield* fileSystem.rename(tmp, full);
          if (!(yield* HostProcess.isWindows)) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const dir = yield* fileSystem.open(path.dirname(full), { flag: "r" });
                yield* dir.sync;
              }),
            );
          }
        }),
      ),
    remove: async (relative) =>
      run(fileSystem.remove(resolve(relative), { recursive: true, force: true })),
    list: async (relative) =>
      run(
        fileSystem.readDirectory(resolve(relative)).pipe(Effect.orElseSucceed((): string[] => [])),
      ),
    close: () => Promise.resolve(),
  };
  return store;
});
