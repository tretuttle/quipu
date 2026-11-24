// Drives the built desktop app through the ways a document gets in from the
// page itself: a file dropped on the window, a file and text pasted, and a
// click on a recent document's row in the sidebar. What it asserts is what the
// window shows and what lands in recents.json: a dropped file has a path and
// becomes a recent; a pasted one has none and does not. Then a reload, which
// brings the open document back with its unsaved edit; a recent whose file is
// gone, which is reported and stays listed; and removing recents, the open one
// closing first.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { _electron as electron } from "playwright-core";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mainJs = NodePath.resolve(__dirname, "../dist-electron/boot.cjs");

const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-desktop-in-page-"));
const userDataDir = NodePath.join(workDir, "user-data");
const write = (name, contents) => {
  const file = NodePath.join(workDir, name);
  NodeFS.writeFileSync(file, contents);
  return file;
};
const launchedFile = write(
  "first.json",
  JSON.stringify({ firstOpened: "from the command line", count: 3 }, null, 2),
);
const droppedFile = write("dropped.json", JSON.stringify({ droppedIn: "from the file manager" }));

const { electronPath, args } = resolveElectronLaunchCommand([
  mainJs,
  `--user-data-dir=${userDataDir}`,
]);
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...parentEnv } = process.env;
// Journals (the unsaved edits a reload brings back) go to a state directory of this run's own.
const env = { ...parentEnv, VITE_DEV_SERVER_URL: "", QUIPU_HOME: NodePath.join(workDir, "home") };

const tree = (page) => page.getByRole("tree", { name: "Document tree" });
const recentRows = (page) => page.getByTestId("recent-document");
const showTree = (page) =>
  page.getByLabel("Document view").getByRole("button", { name: "Tree" }).click();
/** The value cell of the member named `key`. */
const valueOf = (page, key) =>
  tree(page)
    .locator('[role="treeitem"]')
    .filter({ has: page.locator("[data-tree-key]", { hasText: new RegExp(`^${key}$`) }) })
    .locator("[data-tree-value]");
const recentsOnDisk = () =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(userDataDir, "recents.json"), "utf8")).map(
    (entry) => entry.name,
  );

/** A file dragged from the file manager, as Chromium delivers one: with its path. */
const dropFile = async (page, path) => {
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: [path], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await cdp.send("Input.dispatchDragEvent", { type, x: 640, y: 400, data });
  }
  await cdp.detach();
};

/** A file on the clipboard (copied from another app): it exists only in memory. */
const pasteFile = (page, name, contents) =>
  page.evaluate(
    ([fileName, text]) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([text], fileName, { type: "application/json" }));
      document.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    },
    [name, contents],
  );

const pasteText = (page, text) =>
  page.evaluate((value) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", value);
    document.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, text);

try {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [...args, launchedFile],
    env,
  });
  const page = await app.firstWindow();
  await page.locator("[data-app-sidebar]").waitFor();
  await page.getByRole("tree", { name: "Document map" }).waitFor();
  await app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((entry) => entry.label === "View");
    view?.submenu?.items.find((entry) => entry.label === "Show tree view")?.click();
  });
  await tree(page)
    .getByRole("treeitem", { name: /firstOpened.*from the command line/ })
    .waitFor();
  await recentRows(page).getByText("first.json").waitFor();

  // Drop: the file opens, and its path makes it a recent.
  await dropFile(page, droppedFile);
  await tree(page)
    .getByRole("treeitem", { name: /droppedIn.*from the file manager/ })
    .waitFor();
  await recentRows(page).getByText("dropped.json").waitFor();

  // Paste a file and then text: both open; neither has a path, so neither is a recent.
  await pasteFile(page, "clip.json", JSON.stringify({ pastedFile: "only in memory" }));
  await tree(page)
    .getByRole("treeitem", { name: /pastedFile.*only in memory/ })
    .waitFor();
  await pasteText(page, JSON.stringify({ pastedText: "typed somewhere else" }));
  await tree(page)
    .getByRole("treeitem", { name: /pastedText.*typed somewhere else/ })
    .waitFor();

  // Reopen the first file from its row. The main process reads it again from
  // disk and moves it to the top of the list; anything the pastes had recorded
  // would have reached the list before this.
  await recentRows(page).getByText("first.json").click();
  await tree(page)
    .getByRole("treeitem", { name: /firstOpened.*from the command line/ })
    .waitFor();
  await recentRows(page).first().getByText("first.json").waitFor();
  const rows = await recentRows(page).allInnerTexts();
  NodeAssert.equal(rows.length, 2, `recent rows: ${JSON.stringify(rows)}`);
  NodeAssert.match(rows[0], /first\.json/);
  NodeAssert.match(rows[1], /dropped\.json/);
  NodeAssert.deepEqual(recentsOnDisk(), ["first.json", "dropped.json"]);

  // A reload opens the same document again, through the main process.
  await page.reload();
  await page.locator("[data-app-sidebar]").waitFor();
  await showTree(page);
  await tree(page)
    .getByRole("treeitem", { name: /firstOpened.*from the command line/ })
    .waitFor();

  // An unsaved edit comes back with it, from the document's journal.
  await valueOf(page, "count").dblclick();
  await tree(page).getByLabel("Value").fill("42");
  await tree(page).getByLabel("Value").press("Enter");
  await valueOf(page, "count").filter({ hasText: /^42$/ }).waitFor();
  await page.locator("[data-unsaved-dot]").first().waitFor();
  await page.reload();
  await page.locator("[data-app-sidebar]").waitFor();
  await page.getByText("Restored 1 unsaved edit", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Keep" }).click();
  await showTree(page);
  await valueOf(page, "count").filter({ hasText: /^42$/ }).waitFor();
  await page.locator("[data-unsaved-dot]").first().waitFor();

  // A recent whose file is gone: the window says so, and the row stays.
  NodeFS.rmSync(droppedFile);
  await recentRows(page).getByText("dropped.json").click();
  await page.getByText("dropped.json can't be found", { exact: true }).waitFor();
  await valueOf(page, "count").filter({ hasText: /^42$/ }).waitFor();
  NodeAssert.deepEqual(recentsOnDisk(), ["first.json", "dropped.json"]);

  // Remove it from the list.
  await page.getByRole("button", { name: "Remove dropped.json from recent documents" }).click();
  await recentRows(page).getByText("dropped.json").waitFor({ state: "detached" });
  NodeAssert.deepEqual(recentsOnDisk(), ["first.json"]);

  // Removing the open document closes it first, asking about its unsaved edit.
  await page.getByRole("button", { name: "Remove first.json from recent documents" }).click();
  const unsaved = page.locator("[data-unsaved-changes-dialog]");
  await unsaved.getByText("Save changes to first.json?").waitFor();
  await unsaved.getByRole("button", { name: "Discard" }).click();
  await page.getByText("No document open").waitFor();
  await page.getByTestId("sidebar-documents-empty").waitFor();
  NodeAssert.deepEqual(recentsOnDisk(), []);

  const debuggerAttached = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((window) => window.webContents.debugger.isAttached()),
  );
  NodeAssert.equal(debuggerAttached, false);

  await app.close();
  console.log("Desktop in-page open e2e passed.");
} finally {
  NodeFS.rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
