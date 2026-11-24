import { resolveSymlinkTarget } from "@quipu/shared/symlink";
import { fromLenientJson } from "@quipu/shared/schemaJson";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * A JSON document kept in the app's data folder (client settings,
 * keybindings). A missing file is `None`: the app falls back to its defaults.
 * A file that exists but cannot be read or decoded is an error, never `None`,
 * so a transient failure cannot let defaults overwrite what the user saved.
 */
export class DesktopJsonFileReadError extends Schema.TaggedError<DesktopJsonFileReadError>()(
  "DesktopJsonFileReadError",
  {
    document: Schema.String,
    operation: Schema.Literals(["read-file", "decode-document"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop ${this.document} read failed during ${this.operation} at ${this.path}.`;
  }
}

const DesktopJsonFileWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "resolve-symlink",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-file",
]);

export class DesktopJsonFileWriteError extends Schema.TaggedError<DesktopJsonFileWriteError>()(
  "DesktopJsonFileWriteError",
  {
    document: Schema.String,
    operation: DesktopJsonFileWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop ${this.document} write failed during ${this.operation} at ${this.path}.`;
  }
}

export const readJsonFile = <S extends Schema.Codec<unknown, unknown>>(input: {
  readonly document: string;
  readonly schema: S;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: string;
}): Effect.Effect<Option.Option<S["Type"]>, DesktopJsonFileReadError> => {
  const decode = Schema.decodeEffect(fromLenientJson(input.schema));
  return input.fileSystem.readFileString(input.path).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.logWarning(`Could not read desktop ${input.document}.`, cause).pipe(
              Effect.annotateLogs({ path: input.path }),
              Effect.andThen(
                Effect.fail(
                  new DesktopJsonFileReadError({
                    document: input.document,
                    operation: "read-file",
                    path: input.path,
                    cause,
                  }),
                ),
              ),
            ),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<S["Type"]>()),
        onSome: (raw) =>
          decode(raw).pipe(
            Effect.asSome,
            Effect.catchTags({
              SchemaError: (cause) =>
                Effect.logWarning(`Could not decode desktop ${input.document}.`, cause).pipe(
                  Effect.annotateLogs({ path: input.path }),
                  Effect.andThen(
                    Effect.fail(
                      new DesktopJsonFileReadError({
                        document: input.document,
                        operation: "decode-document",
                        path: input.path,
                        cause,
                      }),
                    ),
                  ),
                ),
            }),
          ),
      }),
    ),
  );
};

/**
 * Writes to a temporary file beside the target and renames it into place, so
 * a crash never leaves half a document. A symlinked file keeps its link.
 */
export const writeJsonFile = Effect.fnUntraced(function* <
  S extends Schema.Codec<unknown, unknown>,
>(input: {
  readonly document: string;
  readonly schema: S;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly crypto: Crypto.Crypto;
  readonly filePath: string;
  readonly value: S["Type"];
}): Effect.fn.Return<void, DesktopJsonFileWriteError> {
  const fail =
    (operation: typeof DesktopJsonFileWriteOperation.Type, path: string) => (cause: unknown) =>
      new DesktopJsonFileWriteError({ document: input.document, operation, path, cause });

  const suffix = yield* input.crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => uuid.replace(/-/g, "")),
    Effect.mapError(fail("create-temporary-file-name", input.filePath)),
  );
  const targetPath = yield* resolveSymlinkTarget(input.filePath).pipe(
    Effect.provideService(FileSystem.FileSystem, input.fileSystem),
    Effect.provideService(Path.Path, input.path),
    Effect.mapError(fail("resolve-symlink", input.filePath)),
  );
  const directory = input.path.dirname(targetPath);
  const tempPath = `${targetPath}.${process.pid}.${suffix}.tmp`;
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(input.schema))(input.value).pipe(
    Effect.mapError(fail("encode-document", input.filePath)),
  );
  yield* input.fileSystem
    .makeDirectory(directory, { recursive: true })
    .pipe(Effect.mapError(fail("create-directory", directory)));
  yield* input.fileSystem
    .writeFileString(tempPath, `${encoded}\n`)
    .pipe(Effect.mapError(fail("write-temporary-file", tempPath)));
  yield* input.fileSystem
    .rename(tempPath, targetPath)
    .pipe(Effect.mapError(fail("replace-file", input.filePath)));
});
