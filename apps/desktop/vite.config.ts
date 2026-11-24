import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// The main process is bundled with every JS dependency inlined; only Electron
// itself and packages Node must load from disk stay external.
const isMainProcessExternal = (id: string) =>
  id === "electron" || id.startsWith("electron/") || id.startsWith("playwright-core");
const shouldLaunchElectronAfterPack = process.env.QUIPU_DESKTOP_DEV === "1";

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp pack && node scripts/verify-preload-bundle.mjs",
        dependsOn: ["@quipu/web#build"],
        cache: false,
      },
      dev: {
        command: "cross-env QUIPU_DESKTOP_DEV=1 vp pack --watch",
        cache: false,
      },
      "dev:bundle": {
        command: "vp pack --watch",
        cache: false,
      },
      "dev:electron": {
        command: "node scripts/dev-electron.mjs",
        cache: false,
      },
    },
  },
  pack: [
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      outputOptions: { codeSplitting: false },
      entry: ["src/main.ts"],
      clean: true,
      deps: {
        alwaysBundle: (id) => !id.startsWith("node:") && !isMainProcessExternal(id),
        neverBundle: isMainProcessExternal,
        onlyBundle: false,
      },
      ...(shouldLaunchElectronAfterPack ? { onSuccess: "node scripts/dev-electron.mjs" } : {}),
    },
    {
      // boot.cjs requires the other two at runtime, so all three stay separate files.
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/boot.ts", "src/compileCache.ts"],
      clean: false,
      deps: {
        neverBundle: (id) => id === "./main.cjs" || id === "./compileCache.cjs",
      },
    },
    {
      // Sandboxed preloads must be self-contained, without shared runtime chunks.
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preload.ts"],
    },
  ],
  test: {
    // Filesystem-heavy desktop integration tests can exceed Vitest's 5 second
    // default on Windows when workspace suites run concurrently.
    testTimeout: 15_000,
    setupFiles: ["../../packages/shared/src/testing/longTempDir.ts"],
  },
});
