import { ClientSettingsSchema, type ClientSettings } from "@quipu/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopJsonFile from "./DesktopJsonFile.ts";

export class DesktopClientSettings extends Context.Service<
  DesktopClientSettings,
  {
    readonly get: Effect.Effect<
      Option.Option<ClientSettings>,
      DesktopJsonFile.DesktopJsonFileReadError
    >;
    readonly set: (
      settings: ClientSettings,
    ) => Effect.Effect<void, DesktopJsonFile.DesktopJsonFileWriteError>;
  }
>()("@quipu/desktop/settings/DesktopClientSettings") {}

const DOCUMENT = "client settings";

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  return DesktopClientSettings.of({
    get: DesktopJsonFile.readJsonFile({
      document: DOCUMENT,
      schema: ClientSettingsSchema,
      fileSystem,
      path: environment.clientSettingsPath,
    }).pipe(Effect.withSpan("desktop.clientSettings.get")),
    set: (settings) =>
      DesktopJsonFile.writeJsonFile({
        document: DOCUMENT,
        schema: ClientSettingsSchema,
        fileSystem,
        path,
        crypto,
        filePath: environment.clientSettingsPath,
        value: settings,
      }).pipe(Effect.withSpan("desktop.clientSettings.set")),
  });
});

export const layer = Layer.effect(DesktopClientSettings, make);
