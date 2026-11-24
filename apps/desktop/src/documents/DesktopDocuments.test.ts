// @effect-diagnostics nodeBuiltinImport:off - real files in a temp directory stand in for what the user opens.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { DesktopOpenedDocument, DesktopRecentDocument } from "@quipu/contracts";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Electron exists only inside its binary. This stand-in answers the open
// dialog with chosen paths, keeps the app's event handlers so a test can fire
// `second-instance`, and gives ports that do nothing but can be closed.
const electron = vi.hoisted(() => ({
  appHandlers: new Map<string, (...args: never[]) => void>(),
  dialogPaths: [] as string[],
  closePorts: [] as Array<() => void>,
}));

vi.mock("electron", () => {
  const port = () => {
    const closeListeners: Array<() => void> = [];
    const value = {
      on: (event: string, listener: () => void) => {
        if (event === "close") closeListeners.push(listener);
      },
      postMessage: () => undefined,
      start: () => undefined,
      close: () => closeListeners.forEach((listener) => listener()),
    };
    electron.closePorts.push(value.close);
    return value;
  };
  return {
    app: {
      requestSingleInstanceLock: () => true,
      quit: () => undefined,
      whenReady: () => Promise.resolve(),
      on: (event: string, handler: (...args: never[]) => void) =>
        electron.appHandlers.set(event, handler),
      getAppPath: () => "/opt/quipu/app",
      addRecentDocument: () => undefined,
      clearRecentDocuments: () => undefined,
    },
    dialog: {
      showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: electron.dialogPaths }),
    },
    MessageChannelMain: class {
      port1 = port();
      port2 = port();
    },
  };
});

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DOCUMENT_OPEN_FAILED_CHANNEL, DOCUMENT_SOURCE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopDocuments from "./DesktopDocuments.ts";

/** The window the documents are handed to: what it was sent, and its navigation listeners. */
const fakeWindow = () => {
  const opened: DesktopOpenedDocument[] = [];
  const failures: unknown[] = [];
  const failureWaiters: Array<(failure: unknown) => void> = [];
  const published: Array<ReadonlyArray<DesktopRecentDocument>> = [];
  const navigation: Array<(details: { isMainFrame: boolean; isSameDocument: boolean }) => void> =
    [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      postMessage: (channel: string, document: DesktopOpenedDocument) => {
        if (channel === DOCUMENT_SOURCE_CHANNEL) opened.push(document);
      },
      send: (channel: string, failure: unknown) => {
        if (channel !== DOCUMENT_OPEN_FAILED_CHANNEL) return;
        failures.push(failure);
        for (const resolve of failureWaiters.splice(0)) resolve(failure);
      },
      on: (event: string, listener: (typeof navigation)[number]) => {
        if (event === "did-start-navigation") navigation.push(listener);
      },
    },
  };
  /** The window starts loading a new page (a reload). */
  const reload = () => {
    for (const listener of navigation) listener({ isMainFrame: true, isSameDocument: false });
  };
  /** The next failure the page is told about. */
  const nextFailure = () => new Promise<unknown>((resolve) => failureWaiters.push(resolve));
  return { window, opened, failures, published, reload, nextFailure };
};

const setup = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-documents-"));
  const file = (name: string, contents = '{"a":1}') => {
    const path = NodePath.join(dir, name);
    NodeFS.writeFileSync(path, contents);
    return path;
  };
  const view = fakeWindow();
  const services = Layer.mergeAll(
    Layer.succeed(DesktopEnvironment.DesktopEnvironment)({
      userDataPath: dir,
      platform: "linux",
    } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
    Layer.succeed(ElectronWindow.ElectronWindow)({
      currentMainOrFirst: Effect.sync(() => Option.some(view.window)),
      sendAll: (_channel: string, list: ReadonlyArray<DesktopRecentDocument>) =>
        Effect.sync(() => view.published.push(list)),
    } as unknown as ElectronWindow.ElectronWindow["Service"]),
    Layer.succeed(DesktopWindow.DesktopWindow)({
      revealOrCreateMain: Effect.succeed(view.window),
    } as unknown as DesktopWindow.DesktopWindow["Service"]),
  );
  const layer = DesktopDocuments.layer.pipe(
    Layer.provide(services),
    Layer.provide(NodeServices.layer),
  );
  const recentsOnDisk = (): ReadonlyArray<DesktopRecentDocument> =>
    JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "recents.json"), "utf8"));
  return { dir, file, layer, view, recentsOnDisk };
};

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of electron.closePorts.splice(0)) close();
  for (const step of cleanup.splice(0)) step();
  electron.appHandlers.clear();
  electron.dialogPaths = [];
});

const run = <A>(
  t: ReturnType<typeof setup>,
  body: Effect.Effect<A, never, DesktopDocuments.DesktopDocuments>,
) => {
  cleanup.push(() => NodeFS.rmSync(t.dir, { recursive: true, force: true }));
  return body.pipe(Effect.provide(t.layer));
};

describe("files the desktop app could not open", () => {
  it.effect(
    "are told to the page once it is ready, for a launch path, a second launch and the dialog",
    () => {
      const t = setup();
      const unreadable = t.file("locked.json");
      NodeFS.chmodSync(unreadable, 0o000);
      cleanup.push(() => NodeFS.chmodSync(unreadable, 0o600));
      return run(
        t,
        Effect.gen(function* () {
          const documents = yield* DesktopDocuments.DesktopDocuments;
          // The command line names a file that is not there, before the page exists.
          yield* documents.openPath(NodePath.join(t.dir, "gone.json"));
          expect(t.view.failures).toEqual([]);
          yield* documents.rendererReady(Option.none());
          expect(t.view.failures).toEqual([{ name: "gone.json", reason: "missing" }]);

          // A second launch hands over another missing file.
          yield* documents.install;
          const secondInstance = electron.appHandlers.get("second-instance") as unknown as (
            event: unknown,
            argv: ReadonlyArray<string>,
          ) => void;
          const told = t.view.nextFailure();
          secondInstance({}, ["quipu", NodePath.join(t.dir, "also-gone.har")]);
          expect(yield* Effect.promise(() => told)).toEqual({
            name: "also-gone.har",
            reason: "missing",
          });

          // The dialog picks a file the system will not let this process read.
          electron.dialogPaths = [unreadable];
          yield* documents.openDialog;
          // Named by its recent, which the page offers to take off the list.
          expect(t.view.failures.at(-1)).toEqual({
            name: "locked.json",
            reason: process.getuid?.() === 0 ? "unreadable" : "denied",
            id: t.recentsOnDisk()[0]?.id,
          });
          expect(t.view.opened).toEqual([]);
          // It stays in the recents, to try again.
          expect(t.recentsOnDisk().map((entry) => entry.name)).toEqual(["locked.json"]);
        }),
      );
    },
  );

  it.effect("include a recent whose file is gone, which stays listed", () => {
    const t = setup();
    const path = t.file("moved.json");
    return run(
      t,
      Effect.gen(function* () {
        const documents = yield* DesktopDocuments.DesktopDocuments;
        yield* documents.rendererReady(Option.none());
        yield* documents.openPath(path);
        const [entry] = t.recentsOnDisk();
        expect(t.view.opened.map((document) => document.name)).toEqual(["moved.json"]);
        NodeFS.rmSync(path);
        expect(yield* documents.openRecent((entry as DesktopRecentDocument).id)).toBe(false);
        expect(t.view.failures).toEqual([{ name: "moved.json", reason: "missing" }]);
        expect(t.recentsOnDisk().map((row) => row.name)).toEqual(["moved.json"]);
      }),
    );
  });
});

describe("removing a recent document", () => {
  it.effect("takes only that one off recents.json and tells the page", () => {
    const t = setup();
    const first = t.file("first.json");
    const second = t.file("second.json");
    return run(
      t,
      Effect.gen(function* () {
        const documents = yield* DesktopDocuments.DesktopDocuments;
        yield* documents.openPath(first);
        yield* documents.openPath(second);
        const firstId = t.recentsOnDisk().find((row) => row.name === "first.json")?.id as string;
        yield* documents.removeRecent(firstId);
        expect(t.recentsOnDisk().map((row) => row.name)).toEqual(["second.json"]);
        expect(t.view.published.at(-1)?.map((row) => row.name)).toEqual(["second.json"]);
        // An id that is not listed changes nothing.
        const publishes = t.view.published.length;
        yield* documents.removeRecent("path:unknown");
        expect(t.view.published.length).toBe(publishes);
      }),
    );
  });
});

describe("a reload of the window", () => {
  it.effect("opens the document again, and a file that arrives meanwhile waits and wins", () => {
    const t = setup();
    const first = t.file("first.json");
    const later = t.file("later.json");
    return run(
      t,
      Effect.gen(function* () {
        const documents = yield* DesktopDocuments.DesktopDocuments;
        yield* documents.rendererReady(Option.none());
        yield* documents.openPath(first);
        const firstId = t.view.opened[0]?.id as string;

        // Reload: the page asks for what it had open, and gets it through a new port.
        t.view.reload();
        yield* documents.rendererReady(Option.some(firstId));
        expect(t.view.opened.map((document) => document.name)).toEqual([
          "first.json",
          "first.json",
        ]);

        // A file that arrives while the page is loading waits for it...
        t.view.reload();
        yield* documents.openPath(later);
        expect(t.view.opened).toHaveLength(2);
        // ...and is opened instead of the one the page had, being newer.
        yield* documents.rendererReady(Option.some(firstId));
        expect(t.view.opened.map((document) => document.name)).toEqual([
          "first.json",
          "first.json",
          "later.json",
        ]);

        // A reopen of a recent that is no longer listed opens nothing.
        t.view.reload();
        yield* documents.rendererReady(Option.some("path:unknown"));
        expect(t.view.opened).toHaveLength(3);
      }),
    );
  });
});

describe("the reason a file could not be opened", () => {
  it("is read from the system's code, through the errors that wrap it", () => {
    expect(DesktopDocuments.openFailureReason({ code: "ENOENT" })).toBe("missing");
    expect(DesktopDocuments.openFailureReason({ cause: { code: "EACCES" } })).toBe("denied");
    expect(DesktopDocuments.openFailureReason({ reason: { _tag: "NotFound" } })).toBe("missing");
    expect(DesktopDocuments.openFailureReason({ code: "EISDIR" })).toBe("unreadable");
    expect(DesktopDocuments.openFailureReason(new Error("no code"))).toBe("unreadable");
  });
});
