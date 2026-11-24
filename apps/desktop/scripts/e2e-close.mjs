// Drives the built desktop app through closing and quitting with unsaved edits:
// an edit made in the Tree, then a window close and a quit that each ask Save,
// Discard or Cancel. Cancel keeps the window and the app; Discard closes the
// window, and with it the app, and the edit is gone for good. An edit the app
// was killed with comes back when the file opens again, and after a save in
// place only the edits made since the save do.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { _electron as electron } from "playwright-core";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mainJs = NodePath.resolve(__dirname, "../dist-electron/boot.cjs");

const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-desktop-close-"));
const userDataDir = NodePath.join(workDir, "user-data");
const file = NodePath.join(workDir, "small.json");
NodeFS.writeFileSync(file, JSON.stringify({ name: "quipu", count: 3 }, null, 2));

const { electronPath, args } = resolveElectronLaunchCommand([
  mainJs,
  `--user-data-dir=${userDataDir}`,
]);
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...parentEnv } = process.env;
const env = { ...parentEnv, VITE_DEV_SERVER_URL: "", QUIPU_HOME: NodePath.join(workDir, "home") };

const windowCount = (app) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

const launch = async () => {
  const app = await electron.launch({ executablePath: electronPath, args: [...args, file], env });
  const exited = new Promise((resolve) => app.process().once("exit", resolve));
  const page = await app.firstWindow();
  await page.locator("[data-app-sidebar]").waitFor();
  return { app, exited, page };
};

/** The value of `count` in the Tree. */
const countIn = (page) =>
  page
    .getByRole("tree", { name: "Document tree" })
    .locator('[role="treeitem"]')
    .filter({ has: page.locator("[data-tree-key]", { hasText: /^count$/ }) })
    .locator("[data-tree-value]");

const showTree = (page) =>
  page.getByLabel("Document view").getByRole("button", { name: "Tree" }).click();

const editCount = async (page, value) => {
  await countIn(page).dblclick();
  const input = page.getByRole("tree", { name: "Document tree" }).getByLabel("Value");
  await input.fill(value);
  await input.press("Enter");
  await countIn(page)
    .filter({ hasText: new RegExp(`^${value}$`) })
    .waitFor();
};

/** Ends the app as a crash would, by the process it was launched as. */
const kill = async ({ app, exited }) => {
  app.process().kill("SIGKILL");
  await exited;
};

try {
  const app = await electron.launch({ executablePath: electronPath, args: [...args, file], env });
  const exited = new Promise((resolve) => app.process().once("exit", resolve));
  const page = await app.firstWindow();
  await page.locator("[data-app-sidebar]").waitFor();
  await page.getByRole("tree", { name: "Document map" }).waitFor();

  // An edit through the Tree, as a user makes one.
  await page.getByLabel("Document view").getByRole("button", { name: "Tree" }).click();
  const tree = page.getByRole("tree", { name: "Document tree" });
  const count = tree
    .locator('[role="treeitem"]')
    .filter({ has: page.locator("[data-tree-key]", { hasText: /^count$/ }) })
    .locator("[data-tree-value]");
  await count.dblclick();
  await tree.getByLabel("Value").fill("42");
  await tree.getByLabel("Value").press("Enter");
  await count.filter({ hasText: /^42$/ }).waitFor();
  await page.locator("[data-unsaved-dot]").first().waitFor();

  const dialog = page.locator("[data-unsaved-changes-dialog]");
  const asked = () => dialog.getByText("Save changes to small.json?").waitFor();

  // Closing the window asks; Cancel keeps it.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await asked();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached" });
  NodeAssert.equal(await windowCount(app), 1, "Cancel keeps the window open");

  // Quitting asks too; Cancel keeps the app running.
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await asked();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached" });
  NodeAssert.equal(await windowCount(app), 1, "Cancel keeps the app running");
  await count.filter({ hasText: /^42$/ }).waitFor();

  // Discard closes the window, and the app with its last window.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await asked();
  await dialog.getByRole("button", { name: "Discard" }).click();
  await exited;

  // Discarded means gone: the same file opened again has nothing to restore.
  let run = await launch();
  await showTree(run.page);
  await countIn(run.page).filter({ hasText: /^3$/ }).waitFor();
  NodeAssert.equal(await run.page.getByText(/^Restored \d+ unsaved edits?$/).count(), 0);
  NodeAssert.equal(await run.page.locator("[data-unsaved-dot]").count(), 0);

  // An edit the app was killed with is journaled under the file's identity (path, size,
  // modified time): the same file opened again offers it back.
  await editCount(run.page, "7");
  await kill(run);
  run = await launch();
  await run.page.getByText("Restored 1 unsaved edit", { exact: true }).waitFor();
  await showTree(run.page);
  await countIn(run.page).filter({ hasText: /^7$/ }).waitFor();

  // A save in place makes the saved bytes the file: only the edits made after it come back.
  await run.page.keyboard.press("Control+s");
  await run.page.getByText("Saved small.json").first().waitFor();
  NodeAssert.equal(JSON.parse(NodeFS.readFileSync(file, "utf8")).count, 7);
  await editCount(run.page, "8");
  await kill(run);
  run = await launch();
  await run.page.getByText("Restored 1 unsaved edit", { exact: true }).waitFor();
  await showTree(run.page);
  await countIn(run.page).filter({ hasText: /^8$/ }).waitFor();
  await run.page.getByRole("button", { name: "Discard" }).click();
  await countIn(run.page).filter({ hasText: /^7$/ }).waitFor();
  await run.app.close();
  console.log("Desktop close e2e passed.");
} finally {
  NodeFS.rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
