import type { DesktopAppBranding, DesktopAppStageLabel } from "@quipu/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

export interface MakeDesktopEnvironmentInput {
  readonly dirname: string;
  readonly platform: NodeJS.Platform;
  readonly appVersion: string;
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly userDataPath: string;
  readonly isPackaged: boolean;
}

export class DesktopEnvironment extends Context.Service<
  DesktopEnvironment,
  {
    readonly dirname: string;
    readonly platform: NodeJS.Platform;
    readonly isPackaged: boolean;
    readonly isDevelopment: boolean;
    readonly appVersion: string;
    readonly appPath: string;
    readonly rootDir: string;
    readonly appRoot: string;
    // Electron's per-user data folder, and the documents the app keeps in it.
    readonly userDataPath: string;
    readonly clientSettingsPath: string;
    readonly keybindingsPath: string;
    // Built web client the packaged renderer is served from over quipu://app.
    readonly clientAssetsDir: string;
    // electron-builder puts `app-update.yml` here when the build has a feed.
    readonly appUpdateYmlPath: string;
    readonly preloadPath: string;
    readonly devServerUrl: Option.Option<URL>;
    readonly branding: DesktopAppBranding;
    readonly displayName: string;
    /**
     * Where Quipu keeps its own files (journals, drawings): `$QUIPU_HOME/userdata`
     * when `QUIPU_HOME` is set, else `~/.quipu/dev` in development and
     * `~/.quipu/userdata` otherwise.
     */
    readonly stateDir: string;
  }
>()("@quipu/desktop/app/DesktopEnvironment") {}

const APP_BASE_NAME = "Quipu";

const DesktopConfig = Config.all({
  devServerUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option),
  quipuHome: Config.String("QUIPU_HOME").pipe(Config.option),
  home: Config.String("HOME").pipe(Config.option),
  userProfile: Config.String("USERPROFILE").pipe(Config.option),
});

const resolveStateDir = (
  path: Path.Path,
  isDevelopment: boolean,
  quipuHome: Option.Option<string>,
  homeDir: string,
) => {
  if (Option.isSome(quipuHome) && quipuHome.value.length > 0) {
    return path.join(quipuHome.value, "userdata");
  }
  return path.join(homeDir, ".quipu", isDevelopment ? "dev" : "userdata");
};

function resolveDesktopAppStageLabel(isDevelopment: boolean): DesktopAppStageLabel {
  return isDevelopment ? "Dev" : "Alpha";
}

function resolveDesktopAppBranding(input: { readonly isDevelopment: boolean }): DesktopAppBranding {
  const stageLabel = resolveDesktopAppStageLabel(input.isDevelopment);
  return {
    baseName: APP_BASE_NAME,
    stageLabel,
    displayName: `${APP_BASE_NAME} (${stageLabel})`,
  };
}

const make = Effect.fn("desktop.environment.make")(function* (
  input: MakeDesktopEnvironmentInput,
): Effect.fn.Return<DesktopEnvironment["Service"], Config.ConfigError, Path.Path> {
  const path = yield* Path.Path;
  const config = yield* DesktopConfig;
  const devServerUrl = config.devServerUrl;
  const isDevelopment = Option.isSome(devServerUrl);
  const rootDir = path.resolve(input.dirname, "../../..");
  const appRoot = input.isPackaged ? input.appPath : rootDir;
  const branding = resolveDesktopAppBranding({ isDevelopment });
  const homeDir = Option.getOrElse(
    Option.orElse(config.home, () => config.userProfile),
    () => rootDir,
  );
  const stateDir = resolveStateDir(path, isDevelopment, config.quipuHome, homeDir);

  return DesktopEnvironment.of({
    dirname: input.dirname,
    platform: input.platform,
    isPackaged: input.isPackaged,
    isDevelopment,
    appVersion: input.appVersion,
    appPath: input.appPath,
    rootDir,
    appRoot,
    userDataPath: input.userDataPath,
    clientSettingsPath: path.join(input.userDataPath, "client-settings.json"),
    keybindingsPath: path.join(input.userDataPath, "keybindings.json"),
    clientAssetsDir: path.join(appRoot, "apps", "web", "dist"),
    preloadPath: path.join(input.dirname, "preload.cjs"),
    appUpdateYmlPath: input.isPackaged
      ? path.join(input.resourcesPath, "app-update.yml")
      : path.join(input.appPath, "dev-app-update.yml"),
    devServerUrl,
    branding,
    displayName: branding.displayName,
    stateDir,
  });
});

export const layer = (input: MakeDesktopEnvironmentInput) =>
  Layer.effect(DesktopEnvironment, make(input));
