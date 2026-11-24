// @effect-diagnostics nodeBuiltinImport:off - drives Chromium and a temp preview directory from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { chromium, type Browser, type Page } from "playwright-core";
import { preview } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { startDevServer, type TestDevServer } from "../testing/devServer.ts";

/**
 * SharedArrayBuffer only exists on a cross-origin isolated page. These tests
 * load the real app config on the dev server and on `vp preview`, in Chromium,
 * and read `crossOriginIsolated` in the page and in a worker served by the same
 * host. The Electron side is checked by apps/desktop/scripts/smoke-test.mjs.
 */
const webRoot = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
const configFile = NodePath.join(webRoot, "vite.config.ts");

/**
 * Preview binds port 0 and the test reads back the port the OS handed out: a
 * fixed port collides when two checkouts run this test at once.
 */
const boundOrigin = (address: NodeNet.AddressInfo | string | null) => {
  if (address === null || typeof address === "string") {
    throw new Error(`The server is not listening on a TCP port: ${String(address)}`);
  }
  return `http://127.0.0.1:${address.port}`;
};

interface Isolation {
  readonly page: boolean;
  readonly sharedArrayBuffer: boolean;
  readonly worker: unknown;
}

const probe = (page: Page, workerUrl: string) =>
  page.evaluate(async (url) => {
    const worker = new Worker(url, { type: "module" });
    const fromWorker = await new Promise<unknown>((resolve, reject) => {
      worker.addEventListener("message", (event: MessageEvent<unknown>) => resolve(event.data), {
        once: true,
      });
      worker.addEventListener("error", (event) => reject(new Error(event.message)), {
        once: true,
      });
    });
    worker.terminate();
    return {
      page: crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer === "function",
      worker: fromWorker,
    } satisfies Isolation;
  }, workerUrl);

const expectIsolated = (isolation: Isolation) => {
  expect(isolation.page).toBe(true);
  expect(isolation.sharedArrayBuffer).toBe(true);
  expect(isolation.worker).toEqual({ crossOriginIsolated: true, sharedArrayBuffer: true });
};

describe("cross-origin isolation", () => {
  let browser: Browser;
  let dev: TestDevServer;
  // The hook bundles the app's dependencies when this file's cache is cold.
  beforeAll(async () => {
    browser = await chromium.launch({ channel: "chromium", headless: true });
    dev = await startDevServer("cross-origin-isolation");
  }, 60_000);
  afterAll(async () => {
    await browser.close();
    await dev.server.close();
  });

  it("holds in the page and in a worker on the dev server", async () => {
    const page = await browser.newPage();
    try {
      const response = await page.goto(`${dev.origin}/`);
      expect(response?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
      expect(response?.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
      expectIsolated(await probe(page, "/src/engine/isolationProbe.worker.ts"));
    } finally {
      await page.close();
    }
  });

  it("holds in the page and in a worker on preview", async () => {
    // Preview serves whatever sits in outDir; a two-file site keeps the test off the build.
    const outDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-preview-"));
    NodeFS.writeFileSync(
      NodePath.join(outDir, "index.html"),
      "<!doctype html><html><head><meta charset=utf-8><title>probe</title></head><body></body></html>",
    );
    NodeFS.copyFileSync(
      NodePath.join(webRoot, "src/engine/isolationProbe.worker.ts"),
      NodePath.join(outDir, "isolationProbe.worker.js"),
    );
    const server = await preview({
      configFile,
      root: webRoot,
      logLevel: "silent",
      build: { outDir },
      preview: { port: 0, host: "127.0.0.1" },
    });
    const page = await browser.newPage();
    try {
      const response = await page.goto(`${boundOrigin(server.httpServer.address())}/`);
      expect(response?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
      expect(response?.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
      expectIsolated(await probe(page, "/isolationProbe.worker.js"));
    } finally {
      await page.close();
      await new Promise<void>((resolve, reject) =>
        server.httpServer.close((error) => (error ? reject(error) : resolve())),
      );
      NodeFS.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
