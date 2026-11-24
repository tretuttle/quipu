// @effect-diagnostics nodeBuiltinImport:off - builds and serves the web app from Node for a recording.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import { preview } from "vite";

const repoRoot = NodePath.resolve(import.meta.dirname, "..", "..");
const webRoot = NodePath.join(repoRoot, "apps", "web");
const configFile = NodePath.join(webRoot, "vite.config.ts");

export interface ServedApp {
  readonly url: string;
  readonly close: () => Promise<void>;
}

/**
 * Builds the web app into `outDir` (unless `skipBuild`) and serves that build
 * on a port the OS picks, so a recording never collides with another server.
 */
export const serveBuiltApp = async (options: {
  readonly outDir: string;
  readonly skipBuild?: boolean;
}): Promise<ServedApp> => {
  if (options.skipBuild !== true) {
    // A child process in the app's own directory, where its Babel plugins resolve.
    const result = NodeChildProcess.spawnSync(
      NodePath.join(repoRoot, "node_modules", ".bin", "vp"),
      ["build", "--outDir", options.outDir, "--emptyOutDir", "--logLevel", "warn"],
      { cwd: webRoot, stdio: ["ignore", "inherit", "inherit"] },
    );
    if (result.status !== 0) {
      throw new Error(`Building the web app failed (${result.error?.message ?? result.status}).`);
    }
  }
  const server = await preview({
    configFile,
    root: webRoot,
    logLevel: "silent",
    build: { outDir: options.outDir },
    preview: { port: 0, host: "127.0.0.1" },
  });
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error("The preview server did not report its address.");
  return { url, close: () => server.close() };
};
