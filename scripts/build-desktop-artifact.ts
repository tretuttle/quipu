#!/usr/bin/env node

import * as NodeModule from "node:module";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import * as HostProcess from "@quipu/shared/HostProcess";
import rootPackageJson from "../package.json" with { type: "json" };
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };

import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const LINUX_ICON_SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512] as const;
export const DESKTOP_APP_ID = "tech.trents.quipu";

const BuildPlatform = Schema.Literals(["linux", "win"]);
// Quipu publishes x64 only.
const BuildArch = Schema.Literals(["x64"]);

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;
const decodeWorkspaceConfig = Schema.decodeUnknownEffect(WorkspaceConfig);

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(parseYaml(workspaceYaml) as unknown);
});

interface DesktopBuildIconAssets {
  readonly linuxIconPng: string;
  readonly windowsIconIco: string;
}

interface PlatformConfig {
  readonly cliFlag: "--linux" | "--win";
  readonly defaultTarget: string;
  readonly archChoices: ReadonlyArray<typeof BuildArch.Type>;
}

const PLATFORM_CONFIG: Record<typeof BuildPlatform.Type, PlatformConfig> = {
  linux: { cliFlag: "--linux", defaultTarget: "AppImage", archChoices: ["x64"] },
  win: { cliFlag: "--win", defaultTarget: "nsis", archChoices: ["x64"] },
};

interface BuildCliInput {
  readonly platform: Option.Option<typeof BuildPlatform.Type>;
  readonly target: Option.Option<string>;
  readonly arch: Option.Option<typeof BuildArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly updateUrl: Option.Option<string>;
  readonly verbose: Option.Option<boolean>;
}

function detectHostBuildPlatform(hostPlatform: string): typeof BuildPlatform.Type | undefined {
  if (hostPlatform === "linux") return "linux";
  if (hostPlatform === "win32") return "win";
  return undefined;
}

export class UnsupportedHostBuildPlatformError extends Schema.TaggedError<UnsupportedHostBuildPlatformError>()(
  "UnsupportedHostBuildPlatformError",
  {
    hostPlatform: Schema.String,
  },
) {
  override get message(): string {
    return `Unsupported host platform '${this.hostPlatform}'. Quipu builds on Linux and Windows.`;
  }
}

export class UnsupportedDesktopBuildArchitectureError extends Schema.TaggedError<UnsupportedDesktopBuildArchitectureError>()(
  "UnsupportedDesktopBuildArchitectureError",
  {
    platform: BuildPlatform,
    arch: Schema.String,
    supportedArchitectures: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Unsupported architecture '${this.arch}' for ${this.platform}.`;
  }
}

export class BuildCommandFailedError extends Schema.TaggedError<BuildCommandFailedError>()(
  "BuildCommandFailedError",
  {
    command: Schema.String,
    exitCode: Schema.Int,
    stdoutTail: Schema.optionalKey(Schema.String),
    stderrTail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const outputSections = [
      `Command: ${this.command}`,
      formatOutputSection("stdout", this.stdoutTail ?? ""),
      formatOutputSection("stderr", this.stderrTail ?? ""),
    ].filter((section): section is string => section !== undefined);
    const outputSuffix = outputSections.length > 0 ? `\n\n${outputSections.join("\n\n")}` : "";
    return `Command exited with non-zero exit code (${this.exitCode})${outputSuffix}`;
  }
}

// Quipu compiles no native helpers, so ImageMagick (Linux icon sizes) is the
// only host tool the Linux build needs beyond Node and vp.
export const LINUX_DESKTOP_BUILD_PREREQUISITES = [
  { id: "imagemagick", description: "ImageMagick", packages: ["imagemagick"] },
] as const;

export class LinuxDesktopBuildPrerequisitesMissingError extends Schema.TaggedError<LinuxDesktopBuildPrerequisitesMissingError>()(
  "LinuxDesktopBuildPrerequisitesMissingError",
  {
    missing: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const missingRequirements = LINUX_DESKTOP_BUILD_PREREQUISITES.filter((requirement) =>
      this.missing.includes(requirement.id),
    );
    const details = missingRequirements
      .map((requirement) => `  - ${requirement.description} (${requirement.packages.join(", ")})`)
      .join("\n");
    return [
      "Linux desktop build prerequisites are missing:",
      details,
      "",
      "Install them with your distribution's package manager,",
      "then rerun `vp run dist:desktop:linux`.",
    ].join("\n");
  }
}

const desktopIconPlatformNames = {
  linux: "Linux",
  win: "Windows",
} satisfies Record<typeof BuildPlatform.Type, string>;

export class DesktopIconSourceMissingError extends Schema.TaggedError<DesktopIconSourceMissingError>()(
  "DesktopIconSourceMissingError",
  {
    platform: BuildPlatform,
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop ${desktopIconPlatformNames[this.platform]} icon source is missing at ${this.sourcePath}`;
  }
}

export class BundledClientAssetsMissingError extends Schema.TaggedError<BundledClientAssetsMissingError>()(
  "BundledClientAssetsMissingError",
  {
    indexPath: Schema.String,
    missingFiles: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const preview = this.missingFiles.slice(0, 6).join(", ");
    const suffix = this.missingFiles.length > 6 ? ` (+${this.missingFiles.length - 6} more)` : "";
    return `Bundled client references missing files in ${this.indexPath}: ${preview}${suffix}. Rebuild the web app.`;
  }
}

export class MissingDesktopBuildInputError extends Schema.TaggedError<MissingDesktopBuildInputError>()(
  "MissingDesktopBuildInputError",
  {
    artifact: Schema.String,
    artifactPath: Schema.String,
    buildCommand: Schema.String,
  },
) {
  override get message(): string {
    return `Missing ${this.artifact} at ${this.artifactPath}. Run \`${this.buildCommand}\` or drop --skip-build.`;
  }
}

export class DesktopBuildDependencyResolutionError extends Schema.TaggedError<DesktopBuildDependencyResolutionError>()(
  "DesktopBuildDependencyResolutionError",
  {
    manifestPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to resolve catalog dependencies from ${this.manifestPath}.`;
  }
}

export class UnresolvedBundleRequireError extends Schema.TaggedError<UnresolvedBundleRequireError>()(
  "UnresolvedBundleRequireError",
  {
    file: Schema.String,
    specifiers: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `${this.file} requires packages that the packaged app does not ship: ${this.specifiers.join(", ")}. Bundle them in apps/desktop/vite.config.ts or add them to the staged runtime externals.`;
  }
}

export class DesktopBuildDistDirectoryMissingError extends Schema.TaggedError<DesktopBuildDistDirectoryMissingError>()(
  "DesktopBuildDistDirectoryMissingError",
  {
    distPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Build completed but dist directory was not found at ${this.distPath}`;
  }
}

export class DesktopBuildNoArtifactsProducedError extends Schema.TaggedError<DesktopBuildNoArtifactsProducedError>()(
  "DesktopBuildNoArtifactsProducedError",
  {
    distPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Build completed but no files were produced in ${this.distPath}`;
  }
}

export class LinuxIconResizeError extends Schema.TaggedError<LinuxIconResizeError>()(
  "LinuxIconResizeError",
  {
    operation: Schema.Literal("resize"),
    iconSize: Schema.Int,
    primaryTool: Schema.Literal("magick"),
    fallbackTool: Schema.Literal("convert"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the Linux desktop icon to ${this.iconSize}x${this.iconSize} with \`${this.primaryTool}\` or \`${this.fallbackTool}\`. Install ImageMagick so either tool is available.`;
  }
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const COMMAND_OUTPUT_TAIL_LENGTH = 20_000;

function appendOutputTail(acc: string, chunk: string): string {
  const next = acc + chunk;
  return next.length > COMMAND_OUTPUT_TAIL_LENGTH ? next.slice(-COMMAND_OUTPUT_TAIL_LENGTH) : next;
}

function formatOutputSection(label: string, output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  return `${label} tail:\n${trimmed}`;
}

const collectCommandStream = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  output: NodeJS.WriteStream,
  verbose: boolean,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(
      () => "",
      (acc, chunk) =>
        Effect.as(
          verbose ? Effect.sync(() => output.write(chunk)) : Effect.void,
          appendOutputTail(acc, chunk),
        ),
    ),
  );

const spawnAndCollectOutput = Effect.fn("spawnAndCollectOutput")(function* (
  command: ChildProcess.Command,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  return { stdout, stderr, exitCode } as const;
});

const resolveGitCommitHash = Effect.fn("resolveGitCommitHash")(function* (repoRoot: string) {
  const result = yield* spawnAndCollectOutput(
    ChildProcess.make("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: repoRoot,
    }),
  ).pipe(
    Effect.orElseSucceed(() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    })),
  );

  if (result.exitCode !== 0) {
    return "unknown";
  }
  const hash = result.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
    return "unknown";
  }
  return hash.toLowerCase();
});

interface ResolvedBuildOptions {
  readonly platform: typeof BuildPlatform.Type;
  readonly target: string;
  readonly arch: typeof BuildArch.Type;
  readonly version: string | undefined;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  // Static directory the installed app polls for updates. Written to
  // app-update.yml at pack time; never part of the bundle.
  readonly updateUrl: Option.Option<string>;
  readonly verbose: boolean;
}

interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly quipuCommitHash: string;
  readonly private: true;
  readonly packageManager: string;
  readonly description: string;
  readonly license: string;
  readonly homepage: string;
  readonly author: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
}

export const STAGE_INSTALL_ARGS = ["install", "--prod"] as const;
export const DESKTOP_ELECTRON_LANGUAGES = ["en-US"] as const;
export const DESKTOP_FILE_EXCLUSIONS = [
  // Nothing in the packaged app enables source maps or serves them: the web
  // client's maps alone would be most of app.asar and no request reads them.
  "!**/*.map",
  "!**/*.d.cts",
] as const;
// Windows keeps native packages archived so they do not inflate the loose-file
// count and slow NSIS installation; dlopen and spawn need real files, so
// natives, shared libraries and helper executables live in app.asar.unpacked.
export const WINDOWS_NATIVE_ASAR_UNPACK_GLOB =
  "{**/*.node,**/*.dll,**/*.exe,**/*.so,**/*.so.*,**/*.dylib}";

/**
 * File types Quipu opens. Each entry becomes an NSIS
 * file association and, through `mimeType`, a `MimeType` entry in the Linux
 * .desktop file, so "Open with" lists Quipu for these files.
 */
export const DESKTOP_FILE_ASSOCIATIONS = [
  { ext: "json", description: "JSON document", mimeType: "application/json" },
  { ext: "jsonc", description: "JSON with comments document", mimeType: "application/json" },
  { ext: "har", description: "HTTP archive", mimeType: "application/json" },
  {
    ext: "ndjson",
    description: "Newline-delimited JSON document",
    mimeType: "application/x-ndjson",
  },
  { ext: "jsonl", description: "JSON Lines document", mimeType: "application/jsonl" },
  { ext: "yaml", description: "YAML document", mimeType: "application/yaml" },
  { ext: "yml", description: "YAML document", mimeType: "application/yaml" },
  { ext: "xml", description: "XML document", mimeType: "application/xml" },
  { ext: "csv", description: "CSV document", mimeType: "text/csv" },
  { ext: "tsv", description: "TSV document", mimeType: "text/tab-separated-values" },
  { ext: "toml", description: "TOML document", mimeType: "application/toml" },
] as const;

/**
 * Packages the desktop main-process bundle must NOT inline: whatever Node has
 * to load from the real filesystem. `apps/desktop/vite.config.ts` and this
 * stage derive from the same rule, so an external package is also the only
 * kind of package the staged production install carries.
 */
export const DESKTOP_RUNTIME_EXTERNAL_PREFIXES = [
  // Reads its own bundle from disk by resolving `playwright-core/package.json`
  // at runtime and ships the browser driver alongside.
  "playwright-core",
] as const;

export function isDesktopRuntimeExternalDependency(id: string): boolean {
  return DESKTOP_RUNTIME_EXTERNAL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

// The main-process bundle inlines every JS dependency (see
// apps/desktop/vite.config.ts), so the packaged app only installs the packages
// that bundle leaves external.
export function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, string> | undefined,
  catalog: Record<string, string>,
): Record<string, string> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  return resolveCatalogDependencies(
    Object.fromEntries(
      Object.entries(dependencies).filter(([name]) => isDesktopRuntimeExternalDependency(name)),
    ),
    catalog,
    "apps/desktop",
  );
}

export interface StageWorkspaceConfig {
  readonly supportedArchitectures: {
    readonly os: ReadonlyArray<string>;
    readonly cpu: ReadonlyArray<string>;
    readonly libc?: ReadonlyArray<string>;
  };
  readonly allowBuilds?: Record<string, boolean>;
  readonly patchedDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
}

export function createStageWorkspaceConfig(input: {
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly allowBuilds?: Record<string, boolean>;
  readonly patchedDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
}): StageWorkspaceConfig {
  const { platform, arch, allowBuilds, patchedDependencies, overrides } = input;
  const hostOs = platform === "win" ? "win32" : "linux";
  // Linux AppImages run a Linux/glibc process that loads Linux-native optional
  // deps at runtime. Keep libc explicit so pnpm includes them in the staged
  // production install.
  const supportedArchitectures =
    platform === "linux"
      ? { os: [hostOs], cpu: [arch], libc: ["glibc"] }
      : { os: [hostOs], cpu: [arch] };

  return {
    supportedArchitectures,
    ...(allowBuilds && Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
    ...(patchedDependencies && Object.keys(patchedDependencies).length > 0
      ? { patchedDependencies }
      : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
  };
}

export function createStagePatchedDependencies(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) =>
      Object.hasOwn(dependencies, getPatchedDependencyPackageName(patchKey)),
    ),
  );
}

function getPatchedDependencyPackageName(patchKey: string): string {
  const versionSeparator = patchKey.lastIndexOf("@");
  return versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey;
}

const resolveBooleanFlag = (flag: Option.Option<boolean>, envValue: boolean) =>
  Option.getOrElse(flag, () => envValue);
const mergeOptions = <A>(a: Option.Option<A>, b: Option.Option<A>, defaultValue: A) =>
  Option.getOrElse(a, () => Option.getOrElse(b, () => defaultValue));

const BuildEnvConfig = Config.all({
  platform: Config.schema(BuildPlatform, "QUIPU_DESKTOP_PLATFORM").pipe(Config.option),
  target: Config.String("QUIPU_DESKTOP_TARGET").pipe(Config.option),
  arch: Config.schema(BuildArch, "QUIPU_DESKTOP_ARCH").pipe(Config.option),
  version: Config.String("QUIPU_DESKTOP_VERSION").pipe(Config.option),
  outputDir: Config.String("QUIPU_DESKTOP_OUTPUT_DIR").pipe(Config.option),
  skipBuild: Config.Boolean("QUIPU_DESKTOP_SKIP_BUILD").pipe(Config.withDefault(false)),
  keepStage: Config.Boolean("QUIPU_DESKTOP_KEEP_STAGE").pipe(Config.withDefault(false)),
  updateUrl: Config.String("QUIPU_DESKTOP_UPDATE_URL").pipe(Config.option),
  verbose: Config.Boolean("QUIPU_DESKTOP_VERBOSE").pipe(Config.withDefault(false)),
});

export const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (
  input: BuildCliInput,
) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const env = yield* BuildEnvConfig;
  const hostPlatform = yield* HostProcess.Platform;

  const platform = mergeOptions(
    input.platform,
    env.platform,
    detectHostBuildPlatform(hostPlatform),
  );

  if (!platform) {
    return yield* new UnsupportedHostBuildPlatformError({ hostPlatform });
  }

  const target = mergeOptions(input.target, env.target, PLATFORM_CONFIG[platform].defaultTarget);
  const arch = mergeOptions(input.arch, env.arch, "x64" as const);
  const supportedArchitectures = PLATFORM_CONFIG[platform].archChoices;
  if (!supportedArchitectures.includes(arch)) {
    return yield* new UnsupportedDesktopBuildArchitectureError({
      platform,
      arch,
      supportedArchitectures: [...supportedArchitectures],
    });
  }
  const version = mergeOptions(input.buildVersion, env.version, undefined);
  const outputDir = path.resolve(repoRoot, mergeOptions(input.outputDir, env.outputDir, "release"));

  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    skipBuild: resolveBooleanFlag(input.skipBuild, env.skipBuild),
    keepStage: resolveBooleanFlag(input.keepStage, env.keepStage),
    updateUrl: Option.orElse(input.updateUrl, () => env.updateUrl),
    verbose: resolveBooleanFlag(input.verbose, env.verbose),
  } satisfies ResolvedBuildOptions;
});

const WINDOWS_SHELL_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Quotes one argument for a `cmd.exe` shell spawn so spaces and `&` in a
 * stage path survive. Same escaping as cross-spawn.
 */
export function escapeWindowsShellArg(arg: string): string {
  // Double up backslashes that precede a double quote, then escape the quote.
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  // Double up trailing backslashes so the closing quote is not escaped away.
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  // Escape cmd.exe metacharacters so cmd passes them through verbatim.
  return escaped.replace(WINDOWS_SHELL_META_CHARS, "^$1");
}

// `vp` is a .cmd shim on Windows, which Node only spawns through a shell.
const resolveSpawnCommand = Effect.fn("resolveSpawnCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const platform = yield* HostProcess.Platform;
  return platform === "win32"
    ? {
        // The command is a fixed name; quoting it makes cmd.exe resolve the
        // shim's own directory (%~dp0) against the working directory.
        command: `${command}.cmd`,
        args: args.map(escapeWindowsShellArg),
        shell: true,
      }
    : { command, args: [...args], shell: false };
});

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.Command,
  options: {
    readonly label: string;
    readonly verbose: boolean;
  },
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectCommandStream(child.stdout, process.stdout, options.verbose),
      collectCommandStream(child.stderr, process.stderr, options.verbose),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0) {
    return yield* new BuildCommandFailedError({
      command: options.label,
      exitCode,
      ...(stdout.trim() ? { stdoutTail: stdout } : {}),
      ...(stderr.trim() ? { stderrTail: stderr } : {}),
    });
  }
});

const desktopBuildProbeSucceeds = Effect.fn("desktopBuildProbeSucceeds")(function* (
  command: ChildProcess.Command,
  label: string,
) {
  return yield* runCommand(command, { label, verbose: false }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

export const preflightLinuxDesktopBuild = Effect.fn("preflightLinuxDesktopBuild")(function* () {
  const hasImageMagick =
    (yield* desktopBuildProbeSucceeds(
      ChildProcess.make("magick", ["-version"]),
      "magick -version",
    )) ||
    (yield* desktopBuildProbeSucceeds(
      ChildProcess.make("convert", ["-version"]),
      "convert -version",
    ));
  const missing = hasImageMagick ? [] : ["imagemagick"];
  if (missing.length > 0) {
    return yield* new LinuxDesktopBuildPrerequisitesMissingError({ missing });
  }
});

function trimLiteral(value: string): string {
  return value.replace(/^\/+/u, "");
}

/**
 * Bare `require("x")` specifiers in a CommonJS bundle that Node cannot resolve
 * in the packaged app: not a builtin, not `electron`, not relative, and not a
 * staged runtime dependency. A bundle that fails this crashes at launch with
 * MODULE_NOT_FOUND, so the build fails first.
 */
export function findUnresolvedBareRequires(
  source: string,
  shippedPackages: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const builtins = new Set(NodeModule.builtinModules);
  const unresolved = new Set<string>();
  for (const match of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/gu)) {
    const specifier = match[1];
    if (specifier === undefined) continue;
    if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
    if (specifier.startsWith("node:")) continue;
    if (builtins.has(specifier) || specifier === "electron") continue;
    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : (specifier.split("/")[0] ?? specifier);
    if (shippedPackages.includes(packageName)) continue;
    unresolved.add(specifier);
  }
  return [...unresolved].sort();
}

function stageLinuxIcons(stageResourcesDir: string, sourcePng: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourcePng))) {
      return yield* new DesktopIconSourceMissingError({
        platform: "linux",
        sourcePath: sourcePng,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.png");
    yield* fs.copyFile(sourcePng, iconPath);

    const iconsDir = path.join(stageResourcesDir, "icons");
    yield* fs.makeDirectory(iconsDir, { recursive: true });
    for (const iconSize of LINUX_ICON_SIZES) {
      yield* stageLinuxIconSize(
        sourcePng,
        path.join(iconsDir, `${iconSize}x${iconSize}.png`),
        iconSize,
        verbose,
      );
    }
  });
}

export function stageLinuxIconSize(
  sourcePng: string,
  targetPng: string,
  iconSize: number,
  verbose: boolean,
) {
  const resize = (command: string) =>
    runCommand(
      ChildProcess.make(command, [sourcePng, "-resize", `${iconSize}x${iconSize}`, targetPng]),
      { label: `${command} linux icon ${iconSize}x${iconSize}`, verbose },
    );

  return resize("magick").pipe(
    Effect.catch((primaryCause) =>
      resize("convert").pipe(
        Effect.mapError(
          (fallbackCause) =>
            new LinuxIconResizeError({
              operation: "resize",
              iconSize,
              primaryTool: "magick",
              fallbackTool: "convert",
              cause: new AggregateError(
                [primaryCause, fallbackCause],
                "Both Linux icon resize tool attempts failed.",
                { cause: primaryCause },
              ),
            }),
        ),
      ),
    ),
  );
}

/**
 * electron-builder's installer.nsh hook (picked up from buildResources).
 * Its uninstaller deletes each file class but leaves `.<ext>` pointing at
 * it, so after uninstalling, `.json` would name a class that no longer
 * exists. Clear the default only while it still names Quipu's class.
 */
export function renderWindowsInstallerInclude(
  associations: ReadonlyArray<{ readonly ext: string }>,
): string {
  const clears = associations
    .map(({ ext }) => `  !insertmacro quipuClearAssociation "${ext}" "Quipu.${ext}"`)
    .join("\n");
  return [
    "!macro quipuClearAssociation EXT FILECLASS",
    '  ReadRegStr $R9 SHELL_CONTEXT "Software\\Classes\\.${EXT}" ""',
    '  StrCmp $R9 "${FILECLASS}" 0 +2',
    '  DeleteRegValue SHELL_CONTEXT "Software\\Classes\\.${EXT}" ""',
    "!macroend",
    "",
    "!macro customUnInstall",
    clears,
    "!macroend",
    "",
  ].join("\n");
}

function stageWindowsInstallerInclude(stageResourcesDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(
      path.join(stageResourcesDir, "installer.nsh"),
      renderWindowsInstallerInclude(DESKTOP_FILE_ASSOCIATIONS),
    );
  });
}

function stageWindowsIcons(stageResourcesDir: string, sourceIco: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!(yield* fs.exists(sourceIco))) {
      return yield* new DesktopIconSourceMissingError({
        platform: "win",
        sourcePath: sourceIco,
      });
    }

    yield* fs.copyFile(sourceIco, path.join(stageResourcesDir, "icon.ico"));
  });
}

export function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);
    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";
      if (!normalizedRef) continue;
      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;
      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);
      if (!ext) continue;

      const assetPath = path.join(clientDir, trimLiteral(normalizedRef));
      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      return yield* new BundledClientAssetsMissingError({
        indexPath,
        missingFiles: missing,
      });
    }
  });
}

// Electron Builder detects pnpm from npm_config_user_agent, whose value uses
// user-agent syntax (pnpm/11.10.0) rather than packageManager syntax
// (pnpm@11.10.0).
export function resolvePackageManagerUserAgent(packageManager: string): string {
  const trimmed = packageManager.trim();
  const versionSeparator = trimmed.lastIndexOf("@");
  if (versionSeparator <= 0 || versionSeparator === trimmed.length - 1) {
    return trimmed;
  }

  return `${trimmed.slice(0, versionSeparator)}/${trimmed.slice(versionSeparator + 1)}`;
}

export function resolveDesktopProductName(): string {
  return desktopPackageJson.productName;
}

export function resolveDesktopBuildIconAssets(): DesktopBuildIconAssets {
  return {
    linuxIconPng: "apps/desktop/resources/icon.png",
    windowsIconIco: "apps/desktop/resources/icon.ico",
  };
}

// Without QUIPU_DESKTOP_UPDATE_URL there is no `publish` block, so
// electron-builder writes no app-update.yml, no latest*.yml and, with
// differentialPackage off, no blockmaps. The app still ships electron-updater;
// it finds no feed and turns checks off. A feed is configuration: the URL lands
// in app-update.yml, never in the bundle.
export function createBuildConfig(
  platform: typeof BuildPlatform.Type,
  target: string,
  updateUrl: Option.Option<string> = Option.none(),
): Record<string, unknown> {
  const buildConfig: Record<string, unknown> = {
    appId: DESKTOP_APP_ID,
    productName: resolveDesktopProductName(),
    artifactName: "Quipu-${version}-${arch}.${ext}",
    electronLanguages: [...DESKTOP_ELECTRON_LANGUAGES],
    files: [...DESKTOP_FILE_EXCLUSIONS],
    directories: {
      buildResources: "apps/desktop/resources",
    },
    ...(Option.isSome(updateUrl)
      ? { publish: [{ provider: "generic", url: updateUrl.value }] }
      : {}),
    // Associations for every platform. NSIS registers the extensions under
    // HKCU. On Linux electron-builder writes a shared-mime-info glob for an
    // association only when it carries a `mimeType`, so every association
    // carries one; extensions that share a type each get their own glob, and
    // the .desktop MimeType entry repeats the shared type (harmless).
    fileAssociations: DESKTOP_FILE_ASSOCIATIONS.map((association) => ({
      ext: association.ext,
      // NSIS uses `name` as the registry ProgID under HKCU\Software\Classes.
      name: `Quipu.${association.ext}`,
      description: association.description,
      mimeType: association.mimeType,
      role: "Editor",
    })),
    // Smart unpack extracts entire native packages, including JavaScript and
    // metadata. Windows keeps those files archived so native dependencies do
    // not inflate the loose-file count and slow NSIS installation.
    ...(platform === "win"
      ? { asar: { smartUnpack: false }, asarUnpack: [WINDOWS_NATIVE_ASAR_UNPACK_GLOB] }
      : {}),
  };

  if (platform === "linux") {
    // electron-builder 26 defaults to its legacy AppImage runtime, which
    // dynamically loads the system libfuse2 library. Pin the static runtime so
    // the AppImage also launches on distributions that only provide FUSE 3.
    buildConfig.toolsets = { appimage: "1.0.3" };
    buildConfig.linux = {
      // Quipu publishes the AppImage only; there is no .deb.
      target: [target],
      executableName: "quipu",
      icon: "icons",
      category: "Utility",
      synopsis: "Local-first data canvas",
      desktop: {
        entry: {
          StartupWMClass: "quipu",
        },
      },
    };
  }

  if (platform === "win") {
    buildConfig.npmRebuild = false;
    buildConfig.nsis = {
      // A per-user, one-click install: no UAC prompt and no machine-wide
      // changes. /S installs silently and /D= picks the directory.
      oneClick: true,
      perMachine: false,
      // Blockmaps only matter to a feed; without one none are written.
      differentialPackage: Option.isSome(updateUrl),
    };
    buildConfig.win = {
      target: [target],
      icon: "icon.ico",
      // Resource editing applies the product metadata and icon independently
      // of code signing. Disabling it for local unsigned builds leaves the
      // packaged executable with Electron's stock icon.
      signAndEditExecutable: true,
    };
  }

  return buildConfig;
}

const assertPlatformBuildResources = Effect.fn("assertPlatformBuildResources")(function* (
  platform: typeof BuildPlatform.Type,
  stageResourcesDir: string,
  iconAssets: DesktopBuildIconAssets,
  verbose: boolean,
) {
  if (platform === "linux") {
    yield* stageLinuxIcons(stageResourcesDir, iconAssets.linuxIconPng, verbose);
    return;
  }

  yield* stageWindowsIcons(stageResourcesDir, iconAssets.windowsIconIco);
  yield* stageWindowsInstallerInclude(stageResourcesDir);
});

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcess.Platform;
  if (hostPlatform === "linux" && options.platform === "linux") {
    yield* preflightLinuxDesktopBuild();
  }
  const workspaceConfig = yield* readWorkspaceConfig();
  const workspaceCatalog = workspaceConfig.catalog ?? {};
  const workspaceOverrides = workspaceConfig.overrides ?? {};
  const workspacePatchedDependencies = workspaceConfig.patchedDependencies ?? {};
  const workspaceAllowBuilds = workspaceConfig.allowBuilds ?? {};

  const platformConfig = PLATFORM_CONFIG[options.platform];
  const electronVersion = desktopPackageJson.dependencies.electron;

  const resolvedOverrides = yield* Effect.try({
    try: () => resolveCatalogDependencies(workspaceOverrides, workspaceCatalog, "apps/desktop"),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({ manifestPath: "pnpm-workspace.yaml", cause }),
  });
  const stageDependencies = yield* Effect.try({
    try: () => resolveDesktopRuntimeDependencies(desktopPackageJson.dependencies, workspaceCatalog),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        manifestPath: "apps/desktop/package.json",
        cause,
      }),
  });

  const appVersion = options.version ?? desktopPackageJson.version;
  const iconAssets = resolveDesktopBuildIconAssets();
  const commitHash = yield* resolveGitCommitHash(repoRoot);
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `quipu-desktop-${options.platform}-stage-`,
  });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");
  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    webDist: path.join(repoRoot, "apps/web/dist"),
  };

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop and web artifacts...");
    const spawnCommand = yield* resolveSpawnCommand("vp", ["run", "build:desktop"]);
    yield* runCommand(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: repoRoot,
        shell: spawnCommand.shell,
      }),
      { label: "vp run build:desktop", verbose: options.verbose },
    );
  }

  const requiredBuildInputs = [
    { artifact: "desktop-dist", artifactPath: distDirs.desktopDist },
    { artifact: "web-dist", artifactPath: path.join(distDirs.webDist, "index.html") },
  ] as const;
  for (const input of requiredBuildInputs) {
    if (!(yield* fs.exists(input.artifactPath))) {
      return yield* new MissingDesktopBuildInputError({
        ...input,
        buildCommand: "vp run build:desktop",
      });
    }
  }
  yield* validateBundledClientAssets(distDirs.webDist);

  // Assert against the emitted bundle, not the bundler config: a package that
  // slipped out of the bundle only fails at launch, on the user's machine.
  const shippedPackages = Object.keys(stageDependencies);
  for (const entry of yield* fs.readDirectory(distDirs.desktopDist)) {
    if (!entry.endsWith(".cjs")) continue;
    const specifiers = findUnresolvedBareRequires(
      yield* fs.readFileString(path.join(distDirs.desktopDist, entry)),
      shippedPackages,
    );
    if (specifiers.length > 0) {
      return yield* new UnresolvedBundleRequireError({ file: entry, specifiers });
    }
  }

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.webDist, path.join(stageAppDir, "apps/web/dist"));
  yield* fs.makeDirectory(stageResourcesDir, { recursive: true });
  yield* assertPlatformBuildResources(
    options.platform,
    stageResourcesDir,
    {
      linuxIconPng: path.join(repoRoot, iconAssets.linuxIconPng),
      windowsIconIco: path.join(repoRoot, iconAssets.windowsIconIco),
    },
    options.verbose,
  );

  const stagePatchedDependencies = createStagePatchedDependencies(
    workspacePatchedDependencies,
    stageDependencies,
  );
  const stagePackageJson: StagePackageJson = {
    name: "quipu",
    version: appVersion,
    buildVersion: appVersion,
    quipuCommitHash: commitHash,
    private: true,
    packageManager: rootPackageJson.packageManager,
    description:
      "Quipu is a local-first data canvas. Open any data file and see it as a map you can search, decode, edit, sort, diff, convert and draw on.",
    license: "MIT",
    homepage: "https://quipu.trents.tech",
    author: "Trent Tuttle",
    main: "apps/desktop/dist-electron/boot.cjs",
    build: createBuildConfig(options.platform, options.target, options.updateUrl),
    dependencies: stageDependencies,
    devDependencies: {
      electron: electronVersion,
    },
  };

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);
  yield* fs.writeFileString(
    path.join(stageAppDir, "pnpm-workspace.yaml"),
    stringifyYaml(
      createStageWorkspaceConfig({
        platform: options.platform,
        arch: options.arch,
        allowBuilds: workspaceAllowBuilds,
        patchedDependencies: stagePatchedDependencies,
        overrides: resolvedOverrides,
      }),
    ),
  );

  if (Object.keys(stagePatchedDependencies).length > 0) {
    yield* fs.copy(path.join(repoRoot, "patches"), path.join(stageAppDir, "patches"));
  }

  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");
  const installCommand = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);
  yield* runCommand(
    ChildProcess.make(installCommand.command, installCommand.args, {
      cwd: stageAppDir,
      shell: installCommand.shell,
    }),
    { label: "vp install --prod", verbose: options.verbose },
  );

  // electron-builder treats several set-but-empty variables (e.g. CSC_LINK="")
  // as enabled, so copy the host env and scrub empty values instead of relying
  // on `extendEnv` merging. Quipu is never signed: certificate discovery stays off.
  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };
  buildEnv.npm_config_user_agent = resolvePackageManagerUserAgent(rootPackageJson.packageManager);
  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }
  buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  delete buildEnv.CSC_LINK;
  delete buildEnv.CSC_KEY_PASSWORD;
  if (options.verbose) {
    buildEnv.DEBUG = [buildEnv.DEBUG, "electron-builder", "electron-builder:*"]
      .filter(Boolean)
      .join(",");
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );
  const builderArgs = [
    "exec",
    "--filter",
    "@quipu/desktop",
    "--",
    "electron-builder",
    "--projectDir",
    stageAppDir,
    platformConfig.cliFlag,
    `--${options.arch}`,
    "--publish",
    "never",
  ];
  const builderCommand = yield* resolveSpawnCommand("vp", builderArgs);
  yield* runCommand(
    ChildProcess.make(builderCommand.command, builderCommand.args, {
      cwd: repoRoot,
      env: buildEnv,
      shell: builderCommand.shell,
    }),
    {
      label: `vp exec --filter @quipu/desktop -- electron-builder --projectDir ${stageAppDir} ${platformConfig.cliFlag} --${options.arch} --publish never`,
      verbose: options.verbose,
    },
  );

  const stageDistDir = path.join(stageAppDir, "dist");
  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new DesktopBuildDistDirectoryMissingError({
      distPath: stageDistDir,
      platform: options.platform,
      arch: options.arch,
    });
  }

  const stageEntries = yield* fs.readDirectory(stageDistDir);
  yield* fs.makeDirectory(options.outputDir, { recursive: true });

  const copiedArtifacts: string[] = [];
  for (const entry of stageEntries) {
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.orElseSucceed(() => null));
    if (!stat || stat.type !== "File") continue;
    // electron-builder-debug.yml is its config dump, not an artifact.
    if (entry === "builder-debug.yml") continue;

    const to = path.join(options.outputDir, entry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new DesktopBuildNoArtifactsProducedError({
      distPath: stageDistDir,
      platform: options.platform,
      arch: options.arch,
    });
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.Literals("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: QUIPU_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.String("target").pipe(
    Flag.withDescription("Artifact target, AppImage or nsis (env: QUIPU_DESKTOP_TARGET)."),
    Flag.optional,
  ),
  arch: Flag.Literals("arch", BuildArch.literals).pipe(
    Flag.withDescription("Build arch, x64 (env: QUIPU_DESKTOP_ARCH)."),
    Flag.optional,
  ),
  buildVersion: Flag.String("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: QUIPU_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  outputDir: Flag.String("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: QUIPU_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.Boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `vp run build:desktop` and use existing dist artifacts (env: QUIPU_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.Boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: QUIPU_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  updateUrl: Flag.String("update-url").pipe(
    Flag.withDescription(
      "Static directory the app polls for updates; omit for no feed (env: QUIPU_DESKTOP_UPDATE_URL).",
    ),
    Flag.optional,
  ),
  verbose: Flag.Boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: QUIPU_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a desktop artifact for Quipu."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
