/**
 * The desktop save sink: the renderer streams the engine's bytes over a
 * MessagePort, the main process writes them to a sibling temp file, syncs it,
 * renames it over the target and syncs the directory. A crash before the
 * rename leaves the original untouched; the rename is the commit. The settings
 * writer (DesktopJsonFile.ts) uses the same temp-then-rename shape without the
 * syncs; a document is the user's source of truth, so it pays for them.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

export class DesktopDocumentSaveError extends Schema.TaggedError<DesktopDocumentSaveError>()(
  "DesktopDocumentSaveError",
  {
    operation: Schema.Literals([
      "open",
      "chmod",
      "write",
      "sync",
      "rename",
      "sync-directory",
      "abort",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} while saving ${this.path}.`;
  }
}

export interface SaveStream {
  readonly write: (chunk: Uint8Array) => Effect.Effect<void, DesktopDocumentSaveError>;
  /** Syncs, renames over the target and syncs the directory. */
  readonly close: Effect.Effect<void, DesktopDocumentSaveError>;
  /** Drops the temp file; the target is untouched. */
  readonly abort: Effect.Effect<void, DesktopDocumentSaveError>;
}

export interface SaveStreamInput {
  readonly path: string;
  readonly pid: number;
  readonly suffix: string;
  /** Directory sync is not supported on Windows; the save skips it there. */
  readonly platform: NodeJS.Platform;
}

export const tempPathFor = (path: string, pid: number, suffix: string) =>
  `${path}.${pid}.${suffix}.tmp`;

/** Opens the temp file beside `path`; `close` is the atomic replace. The services are captured, so the stream itself needs none. */
export const openSaveStream = Effect.fn("desktop.documents.openSaveStream")(function* (
  input: SaveStreamInput,
): Effect.fn.Return<SaveStream, DesktopDocumentSaveError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempPath = tempPathFor(input.path, input.pid, input.suffix);
  const fail = (operation: DesktopDocumentSaveError["operation"], at: string) => (cause: unknown) =>
    new DesktopDocumentSaveError({ operation, path: at, cause });
  const scope = yield* Scope.make();
  const file = yield* fileSystem
    .open(tempPath, { flag: "w" })
    .pipe(Scope.provide(scope), Effect.mapError(fail("open", tempPath)));
  let open = true;
  const closeFile = Effect.suspend(() => {
    if (!open) return Effect.void;
    open = false;
    return Scope.close(scope, Exit.void);
  });
  // The rename replaces the file, so the temp file takes the target's permissions first.
  const target = yield* fileSystem.stat(input.path).pipe(Effect.option);
  if (target._tag === "Some" && input.platform !== "win32") {
    yield* fileSystem.chmod(tempPath, target.value.mode & 0o7777).pipe(
      Effect.mapError(fail("chmod", tempPath)),
      Effect.tapError(() =>
        closeFile.pipe(Effect.andThen(fileSystem.remove(tempPath, { force: true })), Effect.ignore),
      ),
    );
  }
  const syncDirectory = Effect.gen(function* () {
    if (input.platform === "win32") return;
    const directory = path.dirname(input.path);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* fileSystem.open(directory, { flag: "r" });
        yield* dir.sync;
      }),
    ).pipe(Effect.mapError(fail("sync-directory", directory)));
  });
  return {
    write: (chunk) => file.writeAll(chunk).pipe(Effect.mapError(fail("write", tempPath))),
    close: Effect.gen(function* () {
      yield* file.sync.pipe(Effect.mapError(fail("sync", tempPath)));
      yield* closeFile;
      yield* fileSystem
        .rename(tempPath, input.path)
        .pipe(Effect.mapError(fail("rename", input.path)));
      yield* syncDirectory;
    }),
    abort: Effect.gen(function* () {
      yield* closeFile;
      yield* fileSystem
        .remove(tempPath, { force: true })
        .pipe(Effect.mapError(fail("abort", tempPath)));
    }),
  };
});

/** Messages the renderer sends on the save port: a chunk, the end, or an abort. */
export const SavePortMessage = Schema.Union([
  Schema.TaggedStruct("chunk", { bytes: Schema.Uint8Array }),
  Schema.TaggedStruct("close", {}),
  Schema.TaggedStruct("abort", {}),
]);
export type SavePortMessage = typeof SavePortMessage.Type;

/** What the main process answers per message, so the renderer's stream has backpressure and a result. */
export const SavePortReply = Schema.Union([
  Schema.TaggedStruct("ok", { bytes: Schema.Int }),
  Schema.TaggedStruct("error", { message: Schema.String }),
]);
export type SavePortReply = typeof SavePortReply.Type;

/** The MessagePortMain surface the server uses. */
export interface SavePortLike {
  on(event: "message", listener: (event: { readonly data: unknown }) => void): void;
  on(event: "close", listener: () => void): void;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

/**
 * Drives one save over a port: every chunk is written before its `ok` goes back,
 * `close` commits, `abort` or a dropped port discards the temp file.
 */
export const serveSavePort = (port: SavePortLike, stream: SaveStream) => {
  const decode = Schema.decodeUnknownSync(SavePortMessage);
  const encode = Schema.encodeSync(SavePortReply);
  let written = 0;
  let finished = false;
  let queue: Promise<void> = Promise.resolve();
  const reply = (message: SavePortReply) => port.postMessage(encode(message));
  const finish = () => {
    finished = true;
    port.close();
  };
  const abortQuietly = () => Effect.runPromise(stream.abort.pipe(Effect.ignore));
  const run = (step: Effect.Effect<void, DesktopDocumentSaveError>, done: () => void) =>
    Effect.runPromise(step.pipe(Effect.result)).then((result) => {
      if (Result.isFailure(result)) {
        reply({ _tag: "error", message: result.failure.message });
        finish();
        return abortQuietly();
      }
      done();
    });
  port.on("message", (event) => {
    if (finished) return;
    let message: SavePortMessage;
    try {
      message = decode(event.data);
    } catch (error) {
      reply({ _tag: "error", message: error instanceof Error ? error.message : String(error) });
      finish();
      queue = queue.then(abortQuietly);
      return;
    }
    queue = queue.then(() => {
      if (finished) return;
      switch (message._tag) {
        case "chunk":
          return run(stream.write(message.bytes), () => {
            written += message.bytes.byteLength;
            reply({ _tag: "ok", bytes: written });
          });
        case "close":
          return run(stream.close, () => {
            reply({ _tag: "ok", bytes: written });
            finish();
          });
        case "abort":
          return run(stream.abort, () => {
            reply({ _tag: "ok", bytes: written });
            finish();
          });
      }
    });
  });
  port.on("close", () => {
    if (finished) return;
    finished = true;
    queue = queue.then(abortQuietly);
  });
  port.start();
  return { settled: () => queue };
};
