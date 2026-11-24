// @effect-diagnostics nodeBuiltinImport:off - starts the app's dev server for a test from Node, outside any Effect runtime.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  createServer,
  type InlineConfig,
  optimizeDeps,
  resolveConfig,
  type ViteDevServer,
} from "vite";

const webRoot = NodeURL.fileURLToPath(new URL("../..", import.meta.url));

export interface TestDevServer {
  readonly server: ViteDevServer;
  /** `http://127.0.0.1:<port>`, without a trailing slash. */
  readonly origin: string;
}

/**
 * The web app's dev server for one test file, on a port the OS picks.
 *
 * Every test file gets its own dependency cache, `node_modules/.vite/test-<name>`.
 * A dev server with a cold or stale cache deletes the cache directory and writes
 * its own bundle there; test files run in parallel, and two servers sharing one
 * directory answer each other's pages with 504s for the optimized dependencies
 * (the shell never renders, a dynamic import fails to fetch).
 *
 * The dependencies are bundled before the server starts, so a cold cache costs
 * the setup hook, never the first test. Vite calls a manual `optimizeDeps`
 * deprecated because the server does it on its own; it is used here because it
 * is the one call that resolves when the bundle is written.
 */
export async function startDevServer(
  name: string,
  server: NonNullable<InlineConfig["server"]> = {},
): Promise<TestDevServer> {
  const inline: InlineConfig = {
    configFile: NodePath.join(webRoot, "vite.config.ts"),
    root: webRoot,
    logLevel: "silent",
    cacheDir: NodePath.join(webRoot, "node_modules", ".vite", `test-${name}`),
  };
  await optimizeDeps(await resolveConfig(inline, "serve"));
  const dev = await createServer({
    ...inline,
    server: { host: "127.0.0.1", port: 0, strictPort: true, ...server },
  });
  await dev.listen();
  const local = dev.resolvedUrls?.local[0];
  if (!local) {
    await dev.close();
    throw new Error("the dev server did not report its address");
  }
  return { server: dev, origin: local.replace(/\/$/, "") };
}
