// @effect-diagnostics nodeBuiltinImport:off - resolves vite.config.ts across POSIX and Windows in Playwright E2E setup.
import * as NodeURL from "node:url";

import { chromium } from "playwright-core";
import type { TestProject } from "vite-plus/test/node";
import { createServer } from "vite-plus";

import "./provided";

const ROUTES = [
  "/",
  "/boards/warmup",
  "/settings/general",
  "/settings/appearance",
  "/settings/keybindings",
  "/settings/storage",
  "/settings/open-source-licenses",
];

/**
 * Serves the web app for the e2e project; the browser tests load it by URL.
 *
 * Vite discovers some dependencies only when a route first imports them, then
 * reloads the page once it has optimized them. That reload would land in the
 * middle of a test, so every route is visited once here, before any test runs.
 */
export default async function setup(project: TestProject) {
  const server = await createServer({
    configFile: NodeURL.fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
    logLevel: "warn",
    // Port 0 lets the OS pick a free port, so parallel worktrees never collide.
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === "string") {
    throw new Error("The e2e server did not report a TCP address.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  project.provide("e2eBaseUrl", baseUrl);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const route of ROUTES) {
      await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle" });
    }
    // Land on the first route again: if the last visit triggered a reload,
    // this one is served from the optimized dependencies.
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  } finally {
    await browser.close();
  }

  return async () => {
    await server.close();
  };
}
