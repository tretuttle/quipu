import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeModule from "node:module";

import * as HostProcess from "@quipu/shared/HostProcess";

import {
  BundledClientAssetsMissingError,
  DESKTOP_ELECTRON_LANGUAGES,
  DESKTOP_FILE_ASSOCIATIONS,
  DESKTOP_FILE_EXCLUSIONS,
  WINDOWS_NATIVE_ASAR_UNPACK_GLOB,
  createBuildConfig,
  createStagePatchedDependencies,
  escapeWindowsShellArg,
  createStageWorkspaceConfig,
  findUnresolvedBareRequires,
  renderWindowsInstallerInclude,
  resolveBuildOptions,
  resolveDesktopRuntimeDependencies,
  resolvePackageManagerUserAgent,
  validateBundledClientAssets,
} from "./build-desktop-artifact.ts";

const noCliInput = {
  platform: Option.none(),
  target: Option.none(),
  arch: Option.none(),
  buildVersion: Option.none(),
  outputDir: Option.none(),
  skipBuild: Option.none(),
  keepStage: Option.none(),
  updateUrl: Option.none(),
  verbose: Option.none(),
} as const;

const envLayer = (env: Record<string, string>) =>
  Layer.mergeAll(
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
    NodeServices.layer,
    Layer.succeed(HostProcess.Platform, "linux"),
  );

describe("build-desktop-artifact", () => {
  it("registers Quipu for every data file type it opens, on both platforms", () => {
    const linux = createBuildConfig("linux", "AppImage");
    const win = createBuildConfig("win", "nsis");

    const extensions = (config: Record<string, unknown>) =>
      (config.fileAssociations as ReadonlyArray<{ ext: string }>).map((entry) => entry.ext);
    const wanted = [
      "json",
      "jsonc",
      "har",
      "ndjson",
      "jsonl",
      "yaml",
      "yml",
      "xml",
      "csv",
      "tsv",
      "toml",
    ];
    assert.deepStrictEqual(extensions(linux), wanted);
    assert.deepStrictEqual(extensions(win), wanted);

    // Windows registers each extension under its own Quipu ProgID.
    assert.deepStrictEqual(
      (win.fileAssociations as ReadonlyArray<{ name: string }>).map((entry) => entry.name),
      wanted.map((ext) => `Quipu.${ext}`),
    );
  });

  it("ships the Quipu name, app id and executable, and no other product's branding", () => {
    const linux = createBuildConfig("linux", "AppImage");
    const win = createBuildConfig("win", "nsis");

    assert.strictEqual(linux.productName, "Quipu (Alpha)");
    assert.strictEqual(linux.appId, "tech.trents.quipu");
    assert.strictEqual((linux.linux as Record<string, unknown>).executableName, "quipu");
    for (const config of [linux, win]) {
      assert.notMatch(JSON.stringify(config), /t3/iu);
    }
  });

  it("builds a mime package that globs every association and a desktop file that lists their types", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = createBuildConfig("linux", "AppImage");
      const tempDir = yield* fs.makeTempDirectoryScoped();
      // The same class electron-builder's AppImage target runs, fed the
      // build config's associations.
      const builderRequire = NodeModule.createRequire(
        NodeModule.createRequire(import.meta.url).resolve("electron-builder/package.json", {
          paths: [path.resolve(import.meta.dirname, "../apps/desktop")],
        }),
      );
      const { LinuxTargetHelper } = builderRequire(
        "app-builder-lib/out/targets/LinuxTargetHelper.js",
      ) as {
        LinuxTargetHelper: new (packager: unknown) => {
          readonly mimeTypeFiles: Promise<string | null>;
          computeDesktopEntry: (
            options: unknown,
            exec?: string,
            extra?: unknown,
          ) => Promise<string>;
        };
      };
      let tempFiles = 0;
      const linuxOptions = config.linux as { desktop: unknown };
      const helper = new LinuxTargetHelper({
        fileAssociations: config.fileAssociations,
        getTempFile: async (ext: string) => path.join(tempDir, `mime-${++tempFiles}${ext}`),
        appInfo: { productName: "Quipu (Alpha)", sanitizedProductName: "Quipu (Alpha)" },
        executableName: "quipu",
        info: { metadata: { desktopName: "quipu.desktop" } },
        platformSpecificBuildOptions: config.linux,
        config,
      });

      const mimeFile = yield* Effect.promise(() => helper.mimeTypeFiles);
      assert.isNotNull(mimeFile);
      const mimeXml = yield* fs.readFileString(mimeFile as string);
      const desktopFile = yield* Effect.promise(() => helper.computeDesktopEntry(linuxOptions));

      const globbed = [...mimeXml.matchAll(/<glob pattern="\*\.([^"]+)"\/>/gu)].map(
        (match) => match[1],
      );
      assert.deepStrictEqual(
        globbed,
        DESKTOP_FILE_ASSOCIATIONS.map((association) => association.ext),
      );
      assert.lengthOf(globbed, 11);
      for (const association of DESKTOP_FILE_ASSOCIATIONS) {
        assert.include(
          mimeXml,
          `<mime-type type="${association.mimeType}">\n  <glob pattern="*.${association.ext}"/>`,
        );
      }

      const mimeLine = desktopFile.split("\n").find((line) => line.startsWith("MimeType="));
      assert.isDefined(mimeLine);
      const listed = (mimeLine as string).slice("MimeType=".length).split(";").filter(Boolean);
      assert.deepStrictEqual(
        listed,
        DESKTOP_FILE_ASSOCIATIONS.map((association) => association.mimeType),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise));

  it("writes no update feed and no publish target", () => {
    const linux = createBuildConfig("linux", "AppImage");
    const win = createBuildConfig("win", "nsis");

    assert.notProperty(linux, "publish");
    assert.notProperty(win, "publish");
    assert.deepStrictEqual(win.nsis, {
      oneClick: true,
      perMachine: false,
      differentialPackage: false,
    });
  });

  it("writes the update feed into the build config only when a URL is given", () => {
    const url = "https://updates.example.test/quipu/";
    const linux = createBuildConfig("linux", "AppImage", Option.some(url));
    const win = createBuildConfig("win", "nsis", Option.some(url));

    for (const config of [linux, win]) {
      assert.deepStrictEqual(config.publish, [{ provider: "generic", url }]);
    }
    assert.strictEqual((win.nsis as Record<string, unknown>).differentialPackage, true);
  });

  it("quotes Windows shell arguments so a stage path with spaces or & stays one argument", () => {
    assert.strictEqual(escapeWindowsShellArg("--filter"), '^"--filter^"');
    assert.strictEqual(escapeWindowsShellArg("C:\\Users\\a b\\c&d"), '^"C:\\Users\\a^ b\\c^&d^"');
    assert.strictEqual(escapeWindowsShellArg('say "hi"'), '^"say^ \\^"hi\\^"^"');
  });

  it("builds an AppImage only on Linux and unpacks natives only on Windows", () => {
    const linux = createBuildConfig("linux", "AppImage");
    const win = createBuildConfig("win", "nsis");

    assert.deepStrictEqual((linux.linux as Record<string, unknown>).target, ["AppImage"]);
    assert.deepStrictEqual(linux.toolsets, { appimage: "1.0.3" });
    assert.notProperty(linux, "asarUnpack");
    assert.deepStrictEqual(win.asar, { smartUnpack: false });
    assert.deepStrictEqual(win.asarUnpack, [WINDOWS_NATIVE_ASAR_UNPACK_GLOB]);
    assert.deepStrictEqual((win.win as Record<string, unknown>).target, ["nsis"]);
    assert.strictEqual((win.win as Record<string, unknown>).signAndEditExecutable, true);
    for (const config of [linux, win]) {
      assert.deepStrictEqual(config.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
      assert.deepStrictEqual(config.files, DESKTOP_FILE_EXCLUSIONS);
    }
  });

  it("installs only the packages the main-process bundle leaves external", () => {
    const resolved = resolveDesktopRuntimeDependencies(
      {
        "@quipu/shared": "workspace:*",
        effect: "catalog:",
        electron: "44.4.5",
        "playwright-core": "1.60.0",
      },
      { effect: "4.0.2" },
    );

    assert.deepStrictEqual(resolved, { "playwright-core": "1.60.0" });
  });

  it("carries only staged dependency patch metadata into staged installs", () => {
    const patches = createStagePatchedDependencies(
      {
        "playwright-core@1.60.0": "patches/playwright-core@1.60.0.patch",
        "@effect/vitest@4.0.2": "patches/@effect__vitest@4.0.2.patch",
      },
      { "playwright-core": "1.60.0" },
    );

    assert.deepStrictEqual(patches, {
      "playwright-core@1.60.0": "patches/playwright-core@1.60.0.patch",
    });
  });

  it("pins the staged install to the target platform", () => {
    const linux = createStageWorkspaceConfig({
      platform: "linux",
      arch: "x64",
      allowBuilds: { electron: true },
    });
    const win = createStageWorkspaceConfig({ platform: "win", arch: "x64" });

    assert.deepStrictEqual(linux.supportedArchitectures, {
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
    });
    assert.deepStrictEqual(linux.allowBuilds, { electron: true });
    assert.deepStrictEqual(win.supportedArchitectures, { os: ["win32"], cpu: ["x64"] });
  });

  it("derives the electron-builder package manager user agent from packageManager", () => {
    assert.strictEqual(resolvePackageManagerUserAgent("pnpm@11.10.0"), "pnpm/11.10.0");
    assert.strictEqual(resolvePackageManagerUserAgent("pnpm"), "pnpm");
  });

  it("clears every registered extension when the Windows uninstaller runs", () => {
    const include = renderWindowsInstallerInclude(DESKTOP_FILE_ASSOCIATIONS);

    for (const { ext } of DESKTOP_FILE_ASSOCIATIONS) {
      assert.include(include, `quipuClearAssociation "${ext}" "Quipu.${ext}"`);
    }
    assert.include(include, "!macro customUnInstall");
  });

  it("flags requires the packaged app cannot resolve", () => {
    const source = [
      'const fs = require("node:fs");',
      'const os = require("os");',
      'const electron = require("electron");',
      'const local = require("./main.cjs");',
      'const playwright = require("playwright-core/lib/server");',
      'const effect = require("effect/Effect");',
      'const scoped = require("@effect/platform-node/NodeRuntime");',
    ].join("\n");

    assert.deepStrictEqual(findUnresolvedBareRequires(source, ["playwright-core"]), [
      "@effect/platform-node/NodeRuntime",
      "effect/Effect",
    ]);
  });

  it.effect("resolves host platform and x64 by default, and rejects other arches", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions(noCliInput);
      assert.strictEqual(resolved.platform, "linux");
      assert.strictEqual(resolved.target, "AppImage");
      assert.strictEqual(resolved.arch, "x64");

      const overridden = yield* resolveBuildOptions({
        ...noCliInput,
        platform: Option.some("win"),
      });
      assert.strictEqual(overridden.platform, "win");
      assert.strictEqual(overridden.target, "nsis");

      const arm = yield* Effect.exit(
        resolveBuildOptions(noCliInput).pipe(
          Effect.provide(envLayer({ QUIPU_DESKTOP_ARCH: "arm64" })),
        ),
      );
      assert.strictEqual(arm._tag, "Failure");
    }).pipe(Effect.provide(envLayer({}))),
  );

  it.effect("fails when the bundled client references a file the build did not emit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "quipu-client-" });
      yield* fs.makeDirectory(path.join(dir, "assets"));
      yield* fs.writeFileString(path.join(dir, "assets", "index.js"), "");
      yield* fs.writeFileString(
        path.join(dir, "index.html"),
        '<script src="/assets/index.js"></script><link href="/assets/index.css">',
      );

      const error = yield* Effect.flip(validateBundledClientAssets(dir));

      assert.instanceOf(error, BundledClientAssetsMissingError);
      assert.deepStrictEqual(error.missingFiles, ["/assets/index.css"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
