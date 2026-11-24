import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { describe, expect, it, vi } from "vite-plus/test";

const autoUpdaterMock = vi.hoisted(() => ({
  autoDownload: true,
  autoInstallOnAppQuit: true,
  channel: null as string | null,
  checkForUpdates: vi.fn(() => Promise.resolve(null)),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron-updater", () => ({ autoUpdater: autoUpdaterMock }));

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

const NO_FEED = "Automatic updates are not available because no update feed is configured.";

function configureWith(options: {
  readonly appUpdateYml: Option.Option<string>;
  readonly env?: Record<string, string>;
  readonly isPackaged?: boolean;
}) {
  autoUpdaterMock.autoDownload = true;
  autoUpdaterMock.autoInstallOnAppQuit = true;
  autoUpdaterMock.checkForUpdates.mockClear();
  autoUpdaterMock.on.mockClear();

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resourcesPath = yield* fs.makeTempDirectoryScoped();
    if (Option.isSome(options.appUpdateYml)) {
      yield* fs.writeFileString(
        path.join(resourcesPath, "app-update.yml"),
        options.appUpdateYml.value,
      );
    }
    const environmentLayer = DesktopEnvironment.layer({
      dirname: resourcesPath,
      platform: "win32",
      appVersion: "0.0.1",
      appPath: resourcesPath,
      resourcesPath,
      userDataPath: resourcesPath,
      isPackaged: options.isPackaged ?? true,
    });
    const updates = yield* DesktopUpdates.make.pipe(
      Effect.provide(Layer.mergeAll(environmentLayer, ElectronUpdater.layer)),
    );
    yield* updates.configure;
    return yield* updates.getState;
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.env ?? {} })),
      ),
    ),
    Effect.runPromise,
  );
}

describe("desktop updates", () => {
  it("turns checks off and leaves the updater alone when the build has no feed", async () => {
    const state = await configureWith({ appUpdateYml: Option.none() });

    expect(state.status).toBe("disabled");
    expect(state.disabledReason).toBe(NO_FEED);
    expect(autoUpdaterMock.autoDownload).toBe(true);
    expect(autoUpdaterMock.on).not.toHaveBeenCalled();
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();
  });

  it("does not treat an app-update.yml without a provider as a feed", async () => {
    const state = await configureWith({ appUpdateYml: Option.some("url: https://example.test\n") });

    expect(state.status).toBe("disabled");
    expect(state.disabledReason).toBe(NO_FEED);
  });

  it("enables checks, with downloads and installs left manual, when a feed is configured", async () => {
    const state = await configureWith({
      appUpdateYml: Option.some("provider: generic\nurl: https://updates.example.test/quipu/\n"),
    });

    expect(state.status).toBe("idle");
    expect(state.disabledReason).toBeNull();
    expect(autoUpdaterMock.autoDownload).toBe(false);
    expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false);
    expect(autoUpdaterMock.on.mock.calls.map(([event]) => event).sort()).toEqual([
      "error",
      "update-available",
      "update-not-available",
    ]);
  });

  it("lets the environment switch updates off even with a feed", async () => {
    const state = await configureWith({
      appUpdateYml: Option.some("provider: generic\nurl: https://updates.example.test/\n"),
      env: { QUIPU_DISABLE_AUTO_UPDATE: "true" },
    });

    expect(state.status).toBe("disabled");
    expect(state.disabledReason).toBe(
      "Automatic updates are disabled by the QUIPU_DISABLE_AUTO_UPDATE setting.",
    );
    expect(autoUpdaterMock.on).not.toHaveBeenCalled();
  });
});
