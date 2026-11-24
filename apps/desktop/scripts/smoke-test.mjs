import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { chromium } from "playwright-core";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(__dirname, "..");
const mainJs = NodePath.resolve(desktopDir, "dist-electron/boot.cjs");

const loadTimeoutMs = 20_000;

const fatalPatterns = [
  "Cannot find module",
  "MODULE_NOT_FOUND",
  "Refused to execute",
  "Uncaught Error",
  "Uncaught TypeError",
  "Uncaught ReferenceError",
];

// Chromium prints "DevTools listening on ws://127.0.0.1:<port>/..." once it has
// bound the remote debugging port; port 0 lets the OS choose a free one.
function readDebuggingPort(output) {
  const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output());
  return match === null ? null : Number(match[1]);
}

// Resolves with the URL of the first page that has navigated to expectedPrefix,
// and the debugging port it was found on. A page the launcher created but has
// not navigated yet reports url "", which any any-page filter accepts and hands
// back before the real navigation lands.
async function waitForWindowUrl(output, expectedPrefix) {
  const deadline = Date.now() + loadTimeoutMs;
  while (Date.now() < deadline) {
    const debuggingPort = readDebuggingPort(output);
    if (debuggingPort === null) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json`)).json();
      const page = targets.find(
        (target) => target.type === "page" && target.url.startsWith(expectedPrefix),
      );
      if (page) return { url: page.url, debuggingPort };
    } catch {
      // The debugging endpoint is not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The Electron window never loaded a page at ${expectedPrefix}.`);
}

const probeWorkerSource =
  "self.postMessage({ crossOriginIsolated: self.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer === 'function' });";

// The engine's SharedArrayBuffers need a cross-origin isolated renderer and
// worker. Read both through the DevTools endpoint the window already exposes;
// `workerUrl` is null when the worker comes from a blob URL, which inherits the
// document's isolation.
async function readIsolation(debuggingPort, expectedPrefix, workerUrl) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`);
  try {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith(expectedPrefix));
    if (!page) throw new Error(`No page at ${expectedPrefix} is attached to the debugger.`);
    await page.waitForLoadState("load");
    return await page.evaluate(
      async ({ url, source }) => {
        const workerSource =
          url ?? URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const worker = new Worker(workerSource, { type: "module" });
        const fromWorker = await new Promise((resolve, reject) => {
          worker.addEventListener("message", (event) => resolve(event.data));
          worker.addEventListener("error", (event) => reject(new Error(event.message)));
        });
        worker.terminate();
        return {
          page: crossOriginIsolated,
          sharedArrayBuffer: typeof SharedArrayBuffer === "function",
          worker: fromWorker,
        };
      },
      { url: workerUrl, source: probeWorkerSource },
    );
  } finally {
    await browser.close();
  }
}

function isolationFailures(isolation) {
  const failures = [];
  if (isolation.page !== true) failures.push("the renderer is not cross-origin isolated");
  if (isolation.sharedArrayBuffer !== true)
    failures.push("SharedArrayBuffer is missing in the renderer");
  if (isolation.worker?.crossOriginIsolated !== true)
    failures.push("the worker is not cross-origin isolated");
  if (isolation.worker?.sharedArrayBuffer !== true)
    failures.push("SharedArrayBuffer is missing in the worker");
  return failures;
}

async function launch({ label, devServerUrl, expectedPrefix, workerUrl }) {
  console.log(`\nLaunching Electron smoke test (${label})...`);
  const electronCommand = resolveElectronLaunchCommand(["--remote-debugging-port=0", mainJs]);
  // ELECTRON_RUN_AS_NODE would make the binary behave as plain Node.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...parentEnv } = process.env;
  const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...parentEnv,
      VITE_DEV_SERVER_URL: devServerUrl,
      ELECTRON_ENABLE_LOGGING: "1",
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  const exited = new Promise((resolve) => child.on("exit", resolve));

  const failures = [];
  try {
    const { url, debuggingPort } = await waitForWindowUrl(() => output, expectedPrefix);
    console.log(`Window loaded ${url}`);
    if (!url.startsWith(expectedPrefix)) {
      failures.push(`window URL ${url} does not start with ${expectedPrefix}`);
    } else {
      const isolation = await readIsolation(debuggingPort, expectedPrefix, workerUrl);
      console.log(`Isolation ${JSON.stringify(isolation)}`);
      failures.push(...isolationFailures(isolation));
    }
  } catch (error) {
    failures.push(error.message);
  }
  child.kill();
  await exited;
  failures.push(...fatalPatterns.filter((pattern) => output.includes(pattern)));
  if (failures.length > 0) {
    console.error(`\nDesktop smoke test (${label}) failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    console.error("\nFull output:\n" + output);
    process.exit(1);
  }
}

// Production build: the bundled client is served from quipu://app.
await launch({
  label: "production",
  devServerUrl: "",
  expectedPrefix: "quipu://app",
  workerUrl: null,
});

// Development: the same window is served from quipu-dev://app, proxied to a
// stand-in dev server.
const devServer = NodeHttp.createServer((request, response) => {
  if (request.url === "/isolationProbe.worker.js") {
    response.setHeader("content-type", "text/javascript");
    response.end(probeWorkerSource);
    return;
  }
  response.setHeader("content-type", "text/html");
  response.end("<!doctype html><title>dev</title>");
});
await new Promise((resolve) => devServer.listen(0, "127.0.0.1", resolve));
const devServerPort = devServer.address().port;
try {
  await launch({
    label: "development",
    devServerUrl: `http://127.0.0.1:${devServerPort}`,
    expectedPrefix: "quipu-dev://app",
    workerUrl: "/isolationProbe.worker.js",
  });
} finally {
  devServer.close();
}

console.log("Desktop smoke test passed.");
process.exit(0);
