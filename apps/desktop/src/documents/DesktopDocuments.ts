// @effect-diagnostics nodeBuiltinImport:off
// The file's identity is a SHA-256 of its canonical path, which Node's crypto
// computes synchronously; there is no Effect service for hashing.
import {
  type DesktopOpenedDocument,
  type DesktopOpenFailure,
  type DesktopOpenFailureReason,
  type DesktopRecentDocument,
  type SaveDialogRequest,
} from "@quipu/contracts";
import { pushRecentDocument } from "@quipu/shared/recentDocuments";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  DOCUMENT_OPEN_FAILED_CHANNEL,
  DOCUMENT_SOURCE_CHANNEL,
  RECENT_DOCUMENTS_CHANNEL,
} from "../ipc/channels.ts";
import * as DesktopJsonFile from "../settings/DesktopJsonFile.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { documentStamp, openDocumentReader, serveDocumentReads } from "./DesktopDocumentSource.ts";
import { documentPathsFromArgv } from "./launchPaths.ts";

const DOCUMENT_NAME = "recent documents";
const RecentDocumentsSchema = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    path: Schema.String,
    name: Schema.String,
    size: Schema.Number,
    lastModified: Schema.Number,
    lastOpenedAt: Schema.Number,
  }),
);

export class DesktopDocumentOpenError extends Schema.TaggedError<DesktopDocumentOpenError>()(
  "DesktopDocumentOpenError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not open ${this.path} for the page.`;
  }
}

export class DesktopDocuments extends Context.Service<
  DesktopDocuments,
  {
    /**
     * Claims the app's single-instance lock and listens for files arriving by
     * `open-file` and `second-instance`. False when another instance holds the
     * lock; this process is then quitting.
     */
    readonly install: Effect.Effect<boolean>;
    /** The files this process was launched with join the queue. */
    readonly enqueueLaunch: Effect.Effect<void>;
    /**
     * The page listens for documents: hand it everything that is waiting. With
     * nothing new waiting, `reopen` (the recent the page had open before it
     * reloaded) opens again.
     */
    readonly rendererReady: (reopen: Option.Option<string>) => Effect.Effect<void>;
    /** Shows the native open dialog and opens the choice; resolves to how many files. */
    readonly openDialog: Effect.Effect<number>;
    readonly openRecent: (id: string) => Effect.Effect<boolean>;
    readonly recents: Effect.Effect<ReadonlyArray<DesktopRecentDocument>>;
    readonly removeRecent: (id: string) => Effect.Effect<void>;
    readonly clearRecents: Effect.Effect<void>;
    /** Records a file the page opened itself (a drop); its recent id, none when it is not a file. */
    readonly recordFile: (path: string) => Effect.Effect<Option.Option<string>>;
    /** The path behind a document id the window was given; none once it left the recents. */
    readonly pathOf: (id: string) => Effect.Effect<Option.Option<string>>;
    /** The size and time the file behind a document id would open with now; none when it cannot be read. */
    readonly stampOf: (
      id: string,
    ) => Effect.Effect<Option.Option<{ readonly size: number; readonly lastModified: number }>>;
    /** The native save dialog, starting in the folder of `documentId` when it has one; none when cancelled. */
    readonly saveDialog: (request: SaveDialogRequest) => Effect.Effect<Option.Option<string>>;
    /** Opens a file the way the open dialog does, after a save wrote it. */
    readonly openPath: (path: string) => Effect.Effect<void>;
  }
>()("@quipu/desktop/documents/DesktopDocuments") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const recentsPath = path.join(environment.userDataPath, "recents.json");

  /** What waits for the page to be ready, oldest first. */
  const waiting = yield* Ref.make<ReadonlyArray<Pending>>([]);
  const pageReady = yield* Ref.make(false);
  /** Pages whose navigations this service watches, so a reload is never mistaken for a ready page. */
  const watched = new WeakSet<Electron.WebContents>();

  const readRecents = DesktopJsonFile.readJsonFile({
    document: DOCUMENT_NAME,
    schema: RecentDocumentsSchema,
    fileSystem,
    path: recentsPath,
  }).pipe(
    Effect.map(Option.getOrElse((): ReadonlyArray<DesktopRecentDocument> => [])),
    // A damaged list is not worth blocking an open: start a new one.
    Effect.orElseSucceed((): ReadonlyArray<DesktopRecentDocument> => []),
  );

  const writeRecents = (value: ReadonlyArray<DesktopRecentDocument>) =>
    DesktopJsonFile.writeJsonFile({
      document: DOCUMENT_NAME,
      schema: RecentDocumentsSchema,
      fileSystem,
      path,
      crypto,
      filePath: recentsPath,
      value,
    }).pipe(Effect.catch((error) => Effect.logWarning(error.message, error)));

  const publishRecents = (value: ReadonlyArray<DesktopRecentDocument>) =>
    electronWindow.sendAll(RECENT_DOCUMENTS_CHANNEL, value);

  /** Remembers a file the user opened, and tells the OS and the page. */
  const record = Effect.fn("desktop.documents.record")(function* (filePath: string) {
    const canonical = yield* fileSystem.realPath(filePath);
    const info = yield* fileSystem.stat(canonical);
    if (info.type !== "File") return Option.none<DesktopRecentDocument>();
    const now = yield* Clock.currentTimeMillis;
    const hashed = canonicalIdentity(canonical, environment.platform);
    const entry: DesktopRecentDocument = {
      id: `path:${hashed}`,
      path: canonical,
      name: path.basename(canonical),
      size: Number(info.size),
      lastModified: Option.match(info.mtime, {
        onNone: () => 0,
        onSome: (mtime) => mtime.getTime(),
      }),
      lastOpenedAt: now,
    };
    const { list: next } = pushRecentDocument(yield* readRecents, entry);
    yield* writeRecents(next);
    yield* Effect.sync(() => Electron.app.addRecentDocument(canonical));
    yield* publishRecents(next);
    return Option.some(entry);
  });

  /** Says a file could not be opened, to the page once it is ready. */
  const tell = (webContents: Electron.WebContents, failure: DesktopOpenFailure) =>
    Effect.sync(() => webContents.send(DOCUMENT_OPEN_FAILED_CHANNEL, failure));

  /**
   * Opens one file and posts it to the page with a port that reads it: the
   * file handle stays here, and the port's server closes it when the page lets
   * go of the document. A file that cannot be read now is not opened: the page
   * is told, and the file stays in the recents to try again.
   */
  const deliver = Effect.fn("desktop.documents.deliver")(function* (
    webContents: Electron.WebContents,
    entry: DesktopRecentDocument,
  ) {
    const delivered = yield* Effect.tryPromise({
      try: async () => {
        const reader = await openDocumentReader(entry.path);
        const document: DesktopOpenedDocument = {
          id: entry.id,
          name: entry.name,
          size: reader.size,
          lastModified: reader.lastModified,
        };
        const { port1, port2 } = new Electron.MessageChannelMain();
        try {
          serveDocumentReads(port1, reader);
          webContents.postMessage(DOCUMENT_SOURCE_CHANNEL, document, [port2]);
        } catch (error) {
          port1.close();
          await reader.close();
          throw error;
        }
      },
      catch: (cause) => new DesktopDocumentOpenError({ path: entry.path, cause }),
    }).pipe(Effect.result);
    if (delivered._tag === "Success") return;
    yield* Effect.logWarning(delivered.failure.message, delivered.failure);
    yield* tell(webContents, {
      name: entry.name,
      reason: openFailureReason(delivered.failure.cause),
      id: entry.id,
    });
  });

  /** A reload or a navigation away: until the new page says it is ready, files wait. */
  const watch = (webContents: Electron.WebContents) => {
    if (watched.has(webContents)) return;
    watched.add(webContents);
    webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) runFork(Ref.set(pageReady, false));
    });
  };

  /**
   * Hands the page what is waiting: every failure, and the first file to open
   * (the rest stay in the recents). With no window, everything waits for the next ready.
   */
  const flush = Effect.gen(function* () {
    if (!(yield* Ref.get(pageReady))) return;
    const main = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(main) || main.value.isDestroyed()) {
      yield* Ref.set(pageReady, false);
      return;
    }
    const { webContents } = main.value;
    const { failures, open } = takeWaiting(yield* Ref.getAndSet(waiting, []));
    for (const failure of failures) yield* tell(webContents, failure);
    if (open !== undefined) yield* deliver(webContents, open);
  });

  /**
   * Records each file and queues the first one that is a file to open; a path
   * that is not there or cannot be read queues a failure instead. True when a
   * file was queued to open.
   */
  const arrive = Effect.fn("desktop.documents.arrive")(function* (paths: ReadonlyArray<string>) {
    const pending: Pending[] = [];
    let queuedOpen = false;
    for (const candidate of paths) {
      const recorded = yield* record(candidate).pipe(Effect.result);
      if (recorded._tag === "Failure") {
        pending.push({
          _tag: "failed",
          failure: {
            name: path.basename(candidate),
            reason: openFailureReason(recorded.failure),
          },
        });
      } else if (Option.isNone(recorded.success)) {
        pending.push({
          _tag: "failed",
          failure: { name: path.basename(candidate), reason: "unreadable" },
        });
      } else if (!queuedOpen) {
        queuedOpen = true;
        pending.push({ _tag: "open", entry: recorded.success.value });
      }
    }
    if (pending.length === 0) return false;
    yield* Ref.update(waiting, (current) => [...current, ...pending]);
    yield* desktopWindow.revealOrCreateMain.pipe(Effect.ignoreCause);
    yield* flush;
    return queuedOpen;
  });

  const install = Effect.sync(() => {
    if (!Electron.app.requestSingleInstanceLock()) {
      Electron.app.quit();
      return false;
    }
    const afterReady = Effect.promise(() => Electron.app.whenReady());
    Electron.app.on("second-instance", (_event, argv) => {
      runFork(
        afterReady.pipe(
          Effect.andThen(
            arrive(documentPathsFromArgv(argv, { appPath: Electron.app.getAppPath() })),
          ),
          Effect.catchCause((cause) => Effect.logWarning("second-instance open failed", cause)),
        ),
      );
    });
    // macOS delivers "Open with" and file associations here, possibly before ready.
    Electron.app.on("open-file", (event, filePath) => {
      event.preventDefault();
      runFork(afterReady.pipe(Effect.andThen(arrive([filePath])), Effect.ignoreCause));
    });
    return true;
  });

  const enqueueLaunch = Effect.suspend(() =>
    arrive(documentPathsFromArgv(process.argv, { appPath: Electron.app.getAppPath() })),
  ).pipe(Effect.ignoreCause);

  const openDialog = Effect.gen(function* () {
    const main = yield* electronWindow.currentMainOrFirst;
    const options: Electron.OpenDialogOptions = { properties: ["openFile", "multiSelections"] };
    const result = yield* Effect.promise(() =>
      Option.isSome(main) && !main.value.isDestroyed()
        ? Electron.dialog.showOpenDialog(main.value, options)
        : Electron.dialog.showOpenDialog(options),
    );
    if (result.canceled || result.filePaths.length === 0) return 0;
    yield* arrive(result.filePaths);
    return result.filePaths.length;
  }).pipe(Effect.withSpan("desktop.documents.openDialog"));

  /** Opens a recent the way any file opens; one that is gone is reported and stays listed. */
  const openRecent = Effect.fn("desktop.documents.openRecent")(function* (id: string) {
    const entry = (yield* readRecents).find((candidate) => candidate.id === id);
    if (entry === undefined) return false;
    return yield* arrive([entry.path]);
  });

  const removeRecent = Effect.fn("desktop.documents.removeRecent")(function* (id: string) {
    const current = yield* readRecents;
    const remaining = current.filter((candidate) => candidate.id !== id);
    if (remaining.length === current.length) return;
    yield* writeRecents(remaining);
    yield* publishRecents(remaining);
  });

  const rendererReady = Effect.fn("desktop.documents.rendererReady")(function* (
    reopen: Option.Option<string>,
  ) {
    const main = yield* electronWindow.currentMainOrFirst;
    if (Option.isSome(main) && !main.value.isDestroyed()) watch(main.value.webContents);
    yield* Ref.set(pageReady, true);
    // A file that arrived while the page loaded is newer than the one it had open.
    const newer = (yield* Ref.get(waiting)).some((item) => item._tag === "open");
    if (!newer && Option.isSome(reopen)) {
      const entry = (yield* readRecents).find((candidate) => candidate.id === reopen.value);
      if (entry !== undefined) {
        yield* Ref.update(waiting, (current): ReadonlyArray<Pending> => [
          ...current,
          { _tag: "open", entry },
        ]);
      }
    }
    yield* flush;
  });

  const pathOf = Effect.fn("desktop.documents.pathOf")(function* (id: string) {
    const entry = (yield* readRecents).find((candidate) => candidate.id === id);
    return Option.fromNullishOr(entry?.path);
  });

  const stampOf = Effect.fn("desktop.documents.stampOf")(function* (id: string) {
    const found = yield* pathOf(id);
    if (Option.isNone(found)) return Option.none();
    return yield* Effect.tryPromise(() => documentStamp(found.value)).pipe(Effect.option);
  });

  const saveDialog = Effect.fn("desktop.documents.saveDialog")(function* (
    request: SaveDialogRequest,
  ) {
    const main = yield* electronWindow.currentMainOrFirst;
    const folder = request.documentId === null ? Option.none() : yield* pathOf(request.documentId);
    const options: Electron.SaveDialogOptions = {
      defaultPath: Option.isSome(folder)
        ? path.join(path.dirname(folder.value), request.suggestedName)
        : request.suggestedName,
      filters: [
        { name: request.filter.name, extensions: [...request.filter.extensions] },
        { name: "All Files", extensions: ["*"] },
      ],
    };
    const result = yield* Effect.promise(() =>
      Option.isSome(main) && !main.value.isDestroyed()
        ? Electron.dialog.showSaveDialog(main.value, options)
        : Electron.dialog.showSaveDialog(options),
    );
    return result.canceled || !result.filePath ? Option.none() : Option.some(result.filePath);
  });

  return DesktopDocuments.of({
    pathOf,
    stampOf,
    saveDialog,
    openPath: (filePath) => arrive([filePath]).pipe(Effect.asVoid),
    install,
    enqueueLaunch,
    rendererReady,
    openDialog,
    openRecent,
    recents: readRecents,
    removeRecent,
    clearRecents: Effect.gen(function* () {
      yield* writeRecents([]);
      yield* publishRecents([]);
      yield* Effect.sync(() => Electron.app.clearRecentDocuments());
    }),
    recordFile: (filePath) =>
      record(filePath).pipe(
        Effect.map(Option.map((entry) => entry.id)),
        Effect.catchCause((cause) =>
          Effect.logWarning("could not record a dropped file", cause).pipe(
            Effect.as(Option.none<string>()),
          ),
        ),
      ),
  });
});

/** What waits for the page: a file to open, or the news that one could not be. */
type Pending =
  | { readonly _tag: "open"; readonly entry: DesktopRecentDocument }
  | { readonly _tag: "failed"; readonly failure: DesktopOpenFailure };

/**
 * Splits what was waiting into the failures to report, in order, and the one
 * file to open: the newest, since each open replaces the one before it.
 */
const takeWaiting = (pending: ReadonlyArray<Pending>) => {
  const failures: DesktopOpenFailure[] = [];
  let open: DesktopRecentDocument | undefined;
  for (const item of pending) {
    if (item._tag === "failed") failures.push(item.failure);
    else open = item.entry;
  }
  return { failures, open };
};

/** The reason a file could not be opened, from the system's error code. */
export const openFailureReason = (cause: unknown): DesktopOpenFailureReason => {
  const code = errorCode(cause);
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  if (code === "EACCES" || code === "EPERM") return "denied";
  return "unreadable";
};

const errorCode = (cause: unknown): string | undefined => {
  let current: unknown = cause;
  // Effect's platform errors and our own wrap the Node error one or two levels down.
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const record = current as { code?: unknown; cause?: unknown; reason?: { _tag?: unknown } };
    if (typeof record.code === "string") return record.code;
    if (record.reason?._tag === "NotFound") return "ENOENT";
    if (record.reason?._tag === "PermissionDenied") return "EACCES";
    current = record.cause;
  }
  return undefined;
};

/**
 * Case-insensitive file systems must not give one file two ids: on Windows the
 * hash input is the path with backslashes and a lowercase drive letter, so
 * `C:\Foo` and `c:\foo` are one document.
 */
function canonicalIdentity(canonicalPath: string, platform: NodeJS.Platform): string {
  const input =
    platform === "win32"
      ? canonicalPath.replace(/^[a-z]:/i, (drive) => drive.toLowerCase())
      : canonicalPath;
  return NodeCrypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export const layer = Layer.effect(DesktopDocuments, make);
