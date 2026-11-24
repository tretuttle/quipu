import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";

const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
const AUTO_UPDATE_POLL_INTERVAL = "4 minutes";

const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;
const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);

export type DesktopUpdateStatus = "disabled" | "idle" | "checking" | "available" | "error";

export interface DesktopUpdateState {
  readonly status: DesktopUpdateStatus;
  readonly currentVersion: string;
  readonly availableVersion: string | null;
  /** Why checks are off; null while they are on. */
  readonly disabledReason: string | null;
}

const setStatus =
  (status: DesktopUpdateStatus, availableVersion?: string | null) =>
  (state: DesktopUpdateState): DesktopUpdateState => ({
    ...state,
    status,
    ...(availableVersion === undefined ? {} : { availableVersion }),
  });

const UpdateInfo = Schema.Struct({ version: Schema.String });
const decodeUpdateInfo = Schema.decodeUnknownEffect(UpdateInfo);

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopUpdateState>;
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@quipu/desktop/updates/DesktopUpdates") {}

/**
 * Checks stay off unless the build was packed with an update feed. A missing
 * feed is reported first, so a build without `app-update.yml` says so and
 * never touches the updater.
 */
function getAutoUpdateDisabledReason(args: {
  readonly isDevelopment: boolean;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly appImage: Option.Option<string>;
  readonly disabledByEnv: boolean;
  readonly hasUpdateFeedConfig: boolean;
}): string | null {
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the QUIPU_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && Option.isNone(args.appImage)) {
    return "Automatic updates on Linux require the AppImage.";
  }
  return null;
}

// electron-builder writes `app-update.yml` into resources only when the build
// has a `publish` feed; its presence is what turns update checks on.
function parseAppUpdateYml(raw: string): Effect.Effect<Option.Option<AppUpdateYmlConfig>> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim();
    }
  }
  return decodeAppUpdateYmlConfig(entries).pipe(
    Effect.map((config) => (config.provider ? Option.some(config) : Option.none())),
    Effect.orElseSucceed(() => Option.none<AppUpdateYmlConfig>()),
  );
}

const UpdateConfig = Config.all({
  disableAutoUpdate: Config.Boolean("QUIPU_DISABLE_AUTO_UPDATE").pipe(Config.withDefault(false)),
  appImage: Config.String("APPIMAGE").pipe(Config.option),
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* UpdateConfig.pipe(Effect.orDie);

  const stateRef = yield* Ref.make<DesktopUpdateState>({
    status: "disabled",
    currentVersion: environment.appVersion,
    availableVersion: null,
    disabledReason: null,
  });
  const configuredRef = yield* Ref.make(false);

  const checkForUpdates = Effect.gen(function* () {
    if (!(yield* Ref.get(configuredRef))) return;
    yield* Ref.update(stateRef, setStatus("checking"));
    yield* electronUpdater.checkForUpdates.pipe(
      Effect.catchTags({
        ElectronUpdaterCheckForUpdatesError: (error) =>
          Effect.logError(error.message).pipe(
            Effect.andThen(Ref.update(stateRef, setStatus("error"))),
          ),
      }),
    );
  });

  const settled = (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.void
      : Effect.logError("Desktop update poller failed.", cause);

  const startUpdatePollers = Effect.gen(function* () {
    yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(checkForUpdates),
      Effect.catchCause(settled),
      Effect.forkScoped,
    );
    yield* Effect.sleep(AUTO_UPDATE_POLL_INTERVAL).pipe(
      Effect.andThen(checkForUpdates),
      Effect.forever,
      Effect.catchCause(settled),
      Effect.forkScoped,
    );
  });

  return DesktopUpdates.of({
    getState: Ref.get(stateRef),
    configure: Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runEffect = (effect: Effect.Effect<void>) => {
        void Effect.runPromiseWith(context)(effect);
      };

      const appUpdateYmlConfig = yield* fileSystem
        .readFileString(environment.appUpdateYmlPath, "utf-8")
        .pipe(
          Effect.option,
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none<AppUpdateYmlConfig>()),
              onSome: parseAppUpdateYml,
            }),
          ),
        );

      const disabledReason = getAutoUpdateDisabledReason({
        isDevelopment: environment.isDevelopment,
        isPackaged: environment.isPackaged,
        platform: environment.platform,
        appImage: config.appImage,
        disabledByEnv: config.disableAutoUpdate,
        hasUpdateFeedConfig: Option.isSome(appUpdateYmlConfig),
      });
      if (disabledReason !== null) {
        yield* Ref.update(stateRef, (state) => ({
          ...state,
          status: "disabled" as const,
          disabledReason,
        }));
        yield* Effect.logInfo(disabledReason);
        return;
      }

      yield* Ref.set(configuredRef, true);
      yield* Ref.update(stateRef, (state) => ({
        ...state,
        status: "idle" as const,
        disabledReason: null,
      }));

      yield* electronUpdater.setAutoDownload(false);
      yield* electronUpdater.setAutoInstallOnAppQuit(false);

      yield* electronUpdater.on("update-available", (info: unknown) => {
        runEffect(
          decodeUpdateInfo(info).pipe(
            Effect.flatMap((decoded) =>
              Ref.update(stateRef, setStatus("available", decoded.version)),
            ),
            Effect.ignoreCause,
          ),
        );
      });
      yield* electronUpdater.on("update-not-available", () => {
        runEffect(Ref.update(stateRef, setStatus("idle", null)));
      });
      yield* electronUpdater.on("error", (error: unknown) => {
        runEffect(
          Effect.logError("Desktop updater reported an error.", error).pipe(
            Effect.andThen(Ref.update(stateRef, setStatus("error"))),
          ),
        );
      });

      yield* startUpdatePollers;
    }).pipe(Effect.withSpan("desktop.updates.configure")),
  });
});

export const layer = Layer.effect(DesktopUpdates, make);
