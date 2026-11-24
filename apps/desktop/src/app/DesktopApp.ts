import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopDocuments from "../documents/DesktopDocuments.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import { installDesktopIpcHandlers } from "../ipc/DesktopIpcHandlers.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

type DesktopAppServices =
  | DesktopApplicationMenu.DesktopApplicationMenu
  | DesktopDocuments.DesktopDocuments
  | DesktopEnvironment.DesktopEnvironment
  | DesktopUpdates.DesktopUpdates
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronTheme.ElectronTheme;

const bootstrap = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const context = yield* Effect.context<DesktopAppServices>();
  const runFork = Effect.runForkWith(context);

  // The renderer is served through the app scheme: from the bundled client, or
  // proxied to Vite in development.
  const electronProtocol = yield* ElectronProtocol.ElectronProtocol;
  yield* electronProtocol.registerDesktopProtocol({
    scheme: ElectronProtocol.getDesktopScheme(environment.isDevelopment),
    ...(environment.isDevelopment
      ? { targetOrigin: Option.getOrThrow(environment.devServerUrl) }
      : { assetDirectory: environment.clientAssetsDir }),
  });
  yield* installDesktopIpcHandlers();
  const applicationMenu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
  yield* applicationMenu.configure;
  yield* electronTheme.onUpdated(() => {
    runFork(desktopWindow.syncAppearance);
  });
  yield* desktopWindow.createMain;
  // Without an `app-update.yml` feed this only records why checks are off.
  yield* updates.configure;
  // The window exists; files named on the command line wait for its page to say it is ready.
  const documents = yield* DesktopDocuments.DesktopDocuments;
  yield* documents.enqueueLaunch;
}).pipe(Effect.withSpan("desktop.bootstrap"));

const startup = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const context = yield* Effect.context<DesktopAppServices>();
  const runFork = Effect.runForkWith(context);

  const documents = yield* DesktopDocuments.DesktopDocuments;
  // A second launch hands its files to the first and quits; open-file can arrive before ready.
  if (!(yield* documents.install)) return;

  yield* electronApp.setName(environment.displayName);
  yield* electronApp.whenReady.pipe(Effect.withSpan("desktop.electron.whenReady"));
  yield* bootstrap;

  // macOS keeps the process alive without windows; a dock click reopens one.
  yield* electronApp.on("activate", () => {
    runFork(desktopWindow.revealOrCreateMain.pipe(Effect.ignoreCause));
  });
}).pipe(Effect.withSpan("desktop.startup"));

const scopedProgram = Effect.scoped(
  Effect.gen(function* () {
    const electronApp = yield* ElectronApp.ElectronApp;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const quitRequested = yield* Latch.make(false);
    const context = yield* Effect.context<DesktopAppServices>();
    const runFork = Effect.runForkWith(context);

    // Windows and Linux quit with the last window; macOS waits for Cmd+Q.
    yield* electronApp.on("window-all-closed", () => {
      if (environment.platform !== "darwin") {
        runFork(electronApp.quit);
      }
    });
    yield* electronApp.on("will-quit", () => {
      runFork(quitRequested.open);
    });

    yield* startup;
    yield* quitRequested.await;
  }),
);

export const program = scopedProgram.pipe(Effect.withSpan("desktop.app"));
