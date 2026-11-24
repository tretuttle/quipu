import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopJsonFile from "./DesktopJsonFile.ts";
import * as DesktopKeybindings from "./DesktopKeybindings.ts";

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

  return DesktopKeybindings.layer.pipe(
    Layer.provideMerge(layerEnvironment),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withKeybindings = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopKeybindings.DesktopKeybindings>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const userDataPath = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "quipu-desktop-keybindings-test-",
    });
    return yield* effect.pipe(Effect.provide(layer(userDataPath)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopKeybindings", () => {
  it.effect("means the defaults when keybindings.json does not exist", () =>
    withKeybindings(
      Effect.gen(function* () {
        const keybindings = yield* DesktopKeybindings.DesktopKeybindings;
        assert.isTrue(Option.isNone(yield* keybindings.get));
      }),
    ),
  );

  it.effect("writes the rules the user changed to keybindings.json", () =>
    withKeybindings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const keybindings = yield* DesktopKeybindings.DesktopKeybindings;
        const rules = [
          { key: "mod+shift+b", command: "sidebar.toggle" as const },
          { key: "mod+j", command: "rightPanel.toggle" as const, when: "!editableFocus" },
        ];
        yield* keybindings.set(rules);

        assert.match(environment.keybindingsPath, /keybindings\.json$/);
        assert.deepEqual(
          JSON.parse(yield* fileSystem.readFileString(environment.keybindingsPath)),
          rules,
        );
        assert.deepEqual(yield* keybindings.get, Option.some(rules));
      }),
    ),
  );

  it.effect("skips rules for commands this build does not have", () =>
    withKeybindings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const keybindings = yield* DesktopKeybindings.DesktopKeybindings;
        yield* fileSystem.writeFileString(
          environment.keybindingsPath,
          JSON.stringify([
            { key: "mod+t", command: "example.missing" },
            { key: "mod+k", command: "commandPalette.toggle" },
          ]),
        );

        assert.deepEqual(
          yield* keybindings.get,
          Option.some([{ key: "mod+k", command: "commandPalette.toggle" }]),
        );
      }),
    ),
  );

  it.effect("reports a file that is not valid JSON instead of falling back to defaults", () =>
    withKeybindings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const keybindings = yield* DesktopKeybindings.DesktopKeybindings;
        yield* fileSystem.writeFileString(environment.keybindingsPath, "[{");

        const error = yield* keybindings.get.pipe(Effect.flip);
        assert.instanceOf(error, DesktopJsonFile.DesktopJsonFileReadError);
        assert.equal(error.operation, "decode-document");
        assert.equal(yield* fileSystem.readFileString(environment.keybindingsPath), "[{");
      }),
    ),
  );
});
