// @effect-diagnostics nodeBuiltinImport:off
// Runs before any Effect runtime exists, so it stays on Node built-ins.
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Turns on Node's on-disk V8 code cache for every module loaded after this one,
// so later launches skip recompiling the main bundle.
// Packaged builds only: boot.ts loads it before the main process bundle. Dev
// launches main.cjs directly and skips it.
// Linux uses the user's cache dir because /tmp is shared between users; the
// macOS and Windows temp dirs are already per user.
//
// Skipped under AppImage: it mounts the app at a new /tmp/.mount_* path each
// launch, and Node keys entries by path, so every launch would miss and leave
// another copy behind.
try {
  if (!process.env.APPIMAGE) {
    const cacheRoot =
      // oxlint-disable-next-line quipu/no-global-process-runtime -- Loads before any Effect runtime.
      process.platform === "linux"
        ? process.env.XDG_CACHE_HOME || NodePath.join(NodeOS.homedir(), ".cache")
        : NodeOS.tmpdir();
    NodeModule.enableCompileCache(NodePath.join(cacheRoot, "quipu", "compile-cache"));
  }
} catch {
  // The cache is only a speedup. Never let it stop the app from starting.
}
