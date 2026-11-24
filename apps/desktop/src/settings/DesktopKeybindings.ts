import { PersistedKeybindingsConfig, type KeybindingsConfig } from "@quipu/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopJsonFile from "./DesktopJsonFile.ts";

/**
 * `keybindings.json` in the app's data folder: the rules the user changed. A
 * missing file means the defaults, and rules for commands this build does not
 * have (written by a newer one) are skipped.
 */
export class DesktopKeybindings extends Context.Service<
  DesktopKeybindings,
  {
    readonly get: Effect.Effect<
      Option.Option<KeybindingsConfig>,
      DesktopJsonFile.DesktopJsonFileReadError
    >;
    readonly set: (
      keybindings: KeybindingsConfig,
    ) => Effect.Effect<void, DesktopJsonFile.DesktopJsonFileWriteError>;
  }
>()("@quipu/desktop/settings/DesktopKeybindings") {}

const DOCUMENT = "keybindings";

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  return DesktopKeybindings.of({
    get: DesktopJsonFile.readJsonFile({
      document: DOCUMENT,
      schema: PersistedKeybindingsConfig,
      fileSystem,
      path: environment.keybindingsPath,
    }).pipe(Effect.withSpan("desktop.keybindings.get")),
    set: (keybindings) =>
      DesktopJsonFile.writeJsonFile({
        document: DOCUMENT,
        schema: PersistedKeybindingsConfig,
        fileSystem,
        path,
        crypto,
        filePath: environment.keybindingsPath,
        value: keybindings,
      }).pipe(Effect.withSpan("desktop.keybindings.set")),
  });
});

export const layer = Layer.effect(DesktopKeybindings, make);
