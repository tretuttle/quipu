// Drives the built desktop app through the Source view: a document too big for
// shiki is colored from the structural index and scrolled to its end, and a
// small one handed over by a second launch is highlighted by shiki. What it
// asserts is what the window paints (computed colors and rows), the same as the
// web app's source e2e.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { _electron as electron } from "playwright-core";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mainJs = NodePath.resolve(__dirname, "../dist-electron/boot.cjs");

const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-desktop-source-"));
const userDataDir = NodePath.join(workDir, "user-data");
const write = (name, contents) => {
  const file = NodePath.join(workDir, name);
  NodeFS.writeFileSync(file, contents);
  return file;
};

// About 3 MiB pretty-printed: past the 1 MiB shiki highlights.
const bigFile = write(
  "big.json",
  JSON.stringify(
    {
      title: "big",
      items: Array.from({ length: 24_000 }, (_, id) => ({
        id,
        name: `item ${id}`,
        tags: ["a", "b"],
        ok: id % 2 === 0,
      })),
    },
    null,
    2,
  ),
);
NodeAssert.ok(NodeFS.statSync(bigFile).size > 1024 * 1024);
const smallFile = write(
  "small.json",
  JSON.stringify({ name: "quipu", count: 3, ok: true }, null, 2),
);

const { electronPath, args } = resolveElectronLaunchCommand([
  mainJs,
  `--user-data-dir=${userDataDir}`,
]);
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...parentEnv } = process.env;
const env = { ...parentEnv, VITE_DEV_SERVER_URL: "" };

const colorOf = (page, text) =>
  page
    .locator("[data-row-code] span", { hasText: new RegExp(`^${text}$`) })
    .first()
    .evaluate((element) => getComputedStyle(element).color);

try {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [...args, bigFile],
    env,
  });
  const page = await app.firstWindow();
  await page.locator("[data-app-sidebar]").waitFor();
  // A path on the command line opens as a map by default; the toggle switches to the source.
  await page.getByRole("tree", { name: "Document map" }).waitFor();

  await page.getByLabel("Document view").getByRole("button", { name: "Source" }).click();
  await page.locator('[data-source-view][data-highlighter="index"]').waitFor();
  NodeAssert.equal(
    await page.locator("[data-row-code]").first().textContent(),
    "{",
    "the first row is the opening brace",
  );
  // pierre-light's key, string and number colors, from the index.
  NodeAssert.equal(await colorOf(page, '"title"'), "rgb(213, 81, 47)");
  NodeAssert.equal(await colorOf(page, '"big"'), "rgb(25, 159, 67)");

  // The end of the file, by keyboard.
  await page.getByRole("document", { name: "Document text" }).focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll("[data-row-code]")];
    return rows.at(-1)?.textContent === "}";
  });
  const gutter = await page.locator("[data-row-gutter]").last().textContent();
  NodeAssert.ok(Number(gutter) > 100_000, `the last row is numbered (${gutter})`);

  // A second launch hands a small file to the window: shiki highlights it.
  const second = NodeChildProcess.spawn(electronPath, [...args, smallFile], {
    env,
    stdio: "ignore",
  });
  await new Promise((resolve) => second.once("exit", resolve));
  await page.locator('[data-source-view][data-highlighter="shiki"]').waitFor();
  NodeAssert.deepEqual(await page.locator("[data-row-code]").allTextContents(), [
    "{",
    '  "name": "quipu",',
    '  "count": 3,',
    '  "ok": true',
    "}",
  ]);
  NodeAssert.equal(await colorOf(page, '"name"'), "rgb(213, 81, 47)");

  await app.close();
  console.log("Desktop source e2e passed.");
} finally {
  NodeFS.rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
