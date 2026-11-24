import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

import * as HostProcess from "@quipu/shared/HostProcess";

import * as DesktopApp from "./app/DesktopApp.ts";
import * as DesktopEnvironment from "./app/DesktopEnvironment.ts";
import * as DesktopIpc from "./ipc/DesktopIpc.ts";
import * as ElectronApp from "./electron/ElectronApp.ts";
import * as ElectronProtocol from "./electron/ElectronProtocol.ts";
import * as ElectronTheme from "./electron/ElectronTheme.ts";
import * as ElectronUpdater from "./electron/ElectronUpdater.ts";
import * as ElectronWindow from "./electron/ElectronWindow.ts";
import * as DesktopDocuments from "./documents/DesktopDocuments.ts";
import * as DesktopClientSettings from "./settings/DesktopClientSettings.ts";
import * as DesktopKeybindings from "./settings/DesktopKeybindings.ts";
import * as DesktopUpdates from "./updates/DesktopUpdates.ts";
import * as DesktopApplicationMenu from "./window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "./window/DesktopWindow.ts";
import * as ElectronMenu from "./electron/ElectronMenu.ts";

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
  });
}

const layerDesktopEnvironment = Layer.unwrap(
  Effect.gen(function* () {
    const metadata = yield* Effect.service(ElectronApp.ElectronApp).pipe(
      Effect.flatMap((app) => app.metadata),
    );
    const platform = yield* HostProcess.Platform;
    return DesktopEnvironment.layer({
      dirname: __dirname,
      platform,
      appVersion: metadata.appVersion,
      appPath: metadata.appPath,
      resourcesPath: metadata.resourcesPath,
      userDataPath: metadata.userDataPath,
      isPackaged: metadata.isPackaged,
    });
  }),
);

const layerElectron = Layer.mergeAll(
  ElectronApp.layer,
  ElectronMenu.layer,
  ElectronProtocol.layer,
  ElectronTheme.layer,
  ElectronUpdater.layer,
  ElectronWindow.layer,
  DesktopIpc.layer(Electron.ipcMain),
);

const layerDesktopWindow = Layer.mergeAll(
  DesktopWindow.layer,
  DesktopUpdates.layer,
  DesktopClientSettings.layer,
  DesktopKeybindings.layer,
).pipe(
  Layer.provideMerge(DesktopDocuments.layer.pipe(Layer.provide(DesktopWindow.layer))),
  Layer.provideMerge(DesktopApplicationMenu.layer.pipe(Layer.provide(DesktopWindow.layer))),
  Layer.provideMerge(layerDesktopEnvironment),
  Layer.provideMerge(layerElectron),
);

// Scheme privileges must be registered before Electron emits `ready`, so this
// layer is acquired first and synchronously.
const layerDesktopRuntime = layerDesktopWindow.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ElectronProtocol.layerSchemePrivileges),
);

DesktopApp.program.pipe(Effect.provide(layerDesktopRuntime), NodeRuntime.runMain);
