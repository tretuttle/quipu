import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
} from "@quipu/contracts";
import { symlinksSupported } from "@quipu/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "./DesktopClientSettings.ts";
import * as DesktopJsonFile from "./DesktopJsonFile.ts";

const clientSettings: ClientSettings = {
  ...DEFAULT_CLIENT_SETTINGS,
  panelAnimationDurationMs: 150,
  confirmStorageClear: false,
};

const decodeClientSettingsJson = Schema.decodeEffect(Schema.fromJsonString(ClientSettingsSchema));

function layer(userDataPath: string) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    platform: "linux",
    appVersion: "1.2.3",
    appPath: "/repo",
    resourcesPath: "/repo/resources",
    userDataPath,
    isPackaged: true,
  }).pipe(Layer.provide(NodeServices.layer));

  return DesktopClientSettings.layer.pipe(
    Layer.provideMerge(layerEnvironment),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withClientSettings = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopClientSettings.DesktopClientSettings>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const userDataPath = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "quipu-desktop-client-settings-test-",
    });
    return yield* effect.pipe(Effect.provide(layer(userDataPath)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopClientSettings", () => {
  it.effect("returns none when no client settings file exists", () =>
    withClientSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        assert.isTrue(Option.isNone(yield* settings.get));
      }),
    ),
  );

  it.effect("persists and reloads client settings in the app data folder", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* settings.set(clientSettings);

        assert.deepEqual(yield* settings.get, Option.some(clientSettings));
        assert.match(environment.clientSettingsPath, /client-settings\.json$/);
        assert.deepEqual(
          yield* decodeClientSettingsJson(
            yield* fileSystem.readFileString(environment.clientSettingsPath),
          ),
          clientSettings,
        );
      }),
    ),
  );

  it.effect("replaces the file without leaving temporary files behind", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* settings.set(clientSettings);
        yield* settings.set(DEFAULT_CLIENT_SETTINGS);

        const entries = yield* fileSystem.readDirectory(environment.userDataPath);
        assert.deepEqual(entries, ["client-settings.json"]);
        assert.deepEqual(yield* settings.get, Option.some(DEFAULT_CLIENT_SETTINGS));
      }),
    ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "saves through a symlinked file without replacing the link",
    () =>
      withClientSettings(
        Effect.gen(function* () {
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const settings = yield* DesktopClientSettings.DesktopClientSettings;
          const dotfiles = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "quipu-desktop-client-settings-dotfiles-",
          });
          const linkedPath = path.join(dotfiles, "client-settings.json");
          yield* fileSystem.writeFileString(linkedPath, "{}\n");
          yield* fileSystem.symlink(linkedPath, environment.clientSettingsPath);

          yield* settings.set(clientSettings);

          assert.equal(yield* fileSystem.readLink(environment.clientSettingsPath), linkedPath);
          assert.deepEqual(
            yield* decodeClientSettingsJson(yield* fileSystem.readFileString(linkedPath)),
            clientSettings,
          );
        }),
      ),
  );

  it.effect("loads a hand-edited file with comments and trailing commas", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.writeFileString(
          environment.clientSettingsPath,
          `{
            // I turned this off.
            "confirmStorageClear": false,
          }\n`,
        );

        const persisted = yield* settings.get;
        assert.isTrue(Option.isSome(persisted));
        if (Option.isSome(persisted)) {
          assert.equal(persisted.value.confirmStorageClear, false);
          assert.equal(persisted.value.panelAnimationDurationMs, 0);
        }
      }),
    ),
  );

  it.effect("loads defaults from an empty document", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.writeFileString(environment.clientSettingsPath, "{}\n");

        assert.deepEqual(yield* settings.get, Option.some(DEFAULT_CLIENT_SETTINGS));
      }),
    ),
  );

  it.effect.each([
    { label: "malformed JSON", contents: "{not-json" },
    { label: "an out-of-range value", contents: '{"panelAnimationDurationMs":9000}' },
  ])("reports $label without treating the file as absent", (document) =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* fileSystem.writeFileString(environment.clientSettingsPath, document.contents);

        const error = yield* settings.get.pipe(Effect.flip);
        assert.instanceOf(error, DesktopJsonFile.DesktopJsonFileReadError);
        assert.equal(error.operation, "decode-document");
        assert.equal(error.path, environment.clientSettingsPath);
        assert.equal(
          yield* fileSystem.readFileString(environment.clientSettingsPath),
          document.contents,
        );
      }),
    ),
  );

  it.effect.each([
    { label: "permission", reason: "PermissionDenied" },
    { label: "I/O", reason: "Unknown" },
  ] as const)("preserves saved settings across $label read failures and retries", (failure) =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        yield* settings.set(clientSettings);
        const savedContents = yield* fileSystem.readFileString(environment.clientSettingsPath);
        const cause = PlatformError.systemError({
          _tag: failure.reason,
          module: "FileSystem",
          method: "readFileString",
          pathOrDescriptor: environment.clientSettingsPath,
        });
        let failRead = true;
        const retryable = yield* DesktopClientSettings.make.pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.FileSystem.of({
              ...fileSystem,
              readFileString: (path) =>
                Effect.suspend(() =>
                  failRead ? Effect.fail(cause) : fileSystem.readFileString(path),
                ),
            }),
          ),
        );

        const error = yield* retryable.get.pipe(Effect.flip);
        assert.instanceOf(error, DesktopJsonFile.DesktopJsonFileReadError);
        assert.equal(error.operation, "read-file");
        assert.strictEqual(error.cause, cause);
        assert.equal(
          yield* fileSystem.readFileString(environment.clientSettingsPath),
          savedContents,
        );

        failRead = false;
        assert.deepEqual(yield* retryable.get, Option.some(clientSettings));
      }),
    ),
  );

  it.effect("reports the failed write operation and path", () =>
    withClientSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const settings = yield* DesktopClientSettings.DesktopClientSettings;
        // A directory where the file belongs makes the final rename fail.
        yield* fileSystem.makeDirectory(environment.clientSettingsPath, { recursive: true });

        const error = yield* settings.set(clientSettings).pipe(Effect.flip);
        assert.instanceOf(error, DesktopJsonFile.DesktopJsonFileWriteError);
        assert.equal(error.operation, "replace-file");
        assert.equal(error.path, environment.clientSettingsPath);
        assert.instanceOf(error.cause, PlatformError.PlatformError);
        assert.equal(
          error.message,
          `Desktop client settings write failed during replace-file at ${environment.clientSettingsPath}.`,
        );
      }),
    ),
  );
});
