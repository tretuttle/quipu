// Drives the built desktop app through File > Save document, Save as… and Export…:
// a document opened from a path is written back to that path through the main
// process (a new file renamed over the old one, keeping its mode), Save As and
// Export answer the native save dialog, a save that cannot be written says why,
// and what is asserted is the bytes on disk.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { _electron as electron } from "playwright-core";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mainJs = NodePath.resolve(__dirname, "../dist-electron/boot.cjs");

const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-desktop-save-"));
const userDataDir = NodePath.join(workDir, "user-data");
const ORIGINAL = '{\n  "name" : "quipu",\n  "knots": [1,   2]\n}\n';
const documentFile = NodePath.join(workDir, "doc.json");
NodeFS.writeFileSync(documentFile, ORIGINAL);
NodeFS.chmodSync(documentFile, 0o640);

const { electronPath, args } = resolveElectronLaunchCommand([
  mainJs,
  `--user-data-dir=${userDataDir}`,
]);
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...parentEnv } = process.env;
// Journals and settings go under the work directory, never the developer's own.
const env = { ...parentEnv, VITE_DEV_SERVER_URL: "", QUIPU_HOME: NodePath.join(workDir, "home") };

const tree = (page) => page.getByRole("tree", { name: "Document tree" });
const clickMenu = (app, menu, item) =>
  app.evaluate(
    ({ Menu }, { menu, item }) => {
      const top = Menu.getApplicationMenu()?.items.find((entry) => entry.label === menu);
      const found = top?.submenu?.items.find((entry) => entry.label === item);
      if (!found) throw new Error(`no ${menu} > ${item}`);
      found.click();
    },
    { menu, item },
  );
/** The native save dialog, answered with `path` (or cancelled with null). */
const answerSaveDialog = (app, path) =>
  app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = async () =>
      chosen === null ? { canceled: true, filePath: "" } : { canceled: false, filePath: chosen };
  }, path);

try {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [...args, documentFile],
    env,
  });
  const page = await app.firstWindow();
  await page.locator("[data-app-sidebar]").waitFor();
  await page.getByRole("tree", { name: "Document map" }).waitFor();
  await clickMenu(app, "View", "Show tree view");
  await tree(page)
    .getByRole("treeitem", { name: /^name : "quipu"/ })
    .waitFor();

  // File > Save: written back to the path, as a new file renamed over the old one.
  const before = NodeFS.statSync(documentFile);
  await clickMenu(app, "File", "Save document");
  await page.getByText("Saved doc.json", { exact: true }).first().waitFor();
  const after = NodeFS.statSync(documentFile);
  NodeAssert.equal(NodeFS.readFileSync(documentFile, "utf8"), ORIGINAL);
  NodeAssert.notEqual(
    after.ino,
    before.ino,
    "the save replaced the file rather than writing into it",
  );
  NodeAssert.equal(after.mode & 0o777, 0o640);
  NodeAssert.deepEqual(
    NodeFS.readdirSync(workDir).filter((name) => name.endsWith(".tmp")),
    [],
  );
  // The document was opened again from the saved file, and still reads.
  await tree(page)
    .getByRole("treeitem", { name: /^knots/ })
    .waitFor();

  // File > Save as…: the native dialog picks the path, and the document becomes that file.
  const copy = NodePath.join(workDir, "copy.json");
  await answerSaveDialog(app, copy);
  await clickMenu(app, "File", "Save as…");
  await page.getByText("Saved copy.json", { exact: true }).first().waitFor();
  NodeAssert.equal(NodeFS.readFileSync(copy, "utf8"), ORIGINAL);
  await page.getByRole("navigation", { name: "Documents" }).getByText("copy.json").waitFor();

  // File > Export...: the dialog's format, then the native save dialog.
  const exported = NodePath.join(workDir, "copy.yaml");
  await answerSaveDialog(app, exported);
  await clickMenu(app, "File", "Export…");
  const dialog = page.getByRole("dialog", { name: /^Export / });
  await dialog.getByRole("combobox", { name: "Format" }).click();
  await page.getByRole("option", { name: "YAML", exact: true }).click();
  await dialog.getByRole("button", { name: "Export…" }).click();
  await page.getByText("Exported copy.yaml", { exact: true }).first().waitFor();
  const yaml = NodeFS.readFileSync(exported, "utf8");
  NodeAssert.match(yaml, /^name: quipu$/m);
  NodeAssert.match(yaml, /^knots:\n\s+- 1\n\s+- 2$/m);

  // A save the main process cannot write says why, and writes nothing.
  const nowhere = NodePath.join(workDir, "missing-folder", "lost.json");
  await answerSaveDialog(app, nowhere);
  await clickMenu(app, "File", "Save as…");
  await page.getByText("Could not save lost.json", { exact: true }).first().waitFor();
  await page
    .getByText(/while saving/)
    .first()
    .waitFor();
  NodeAssert.equal(NodeFS.existsSync(NodePath.dirname(nowhere)), false);
  NodeAssert.equal(NodeFS.readFileSync(copy, "utf8"), ORIGINAL);

  // An edit through the Tree, then File > Save: the edited bytes replace copy.json, and the
  // document has nothing left to save.
  const valueOf = (key) =>
    tree(page)
      .locator('[role="treeitem"]')
      .filter({ has: page.locator("[data-tree-key]", { hasText: new RegExp(`^${key}$`) }) })
      .locator("[data-tree-value]");
  const editValue = async (key, text) => {
    await valueOf(key).dblclick();
    await tree(page).getByLabel("Value").fill(text);
    await tree(page).getByLabel("Value").press("Enter");
    await valueOf(key)
      .filter({ hasText: `"${text}"` })
      .waitFor();
    await page.locator("[data-unsaved-dot]").first().waitFor();
  };
  await editValue("name", "khipu");
  const beforeEdit = NodeFS.statSync(copy);
  await clickMenu(app, "File", "Save document");
  await page.getByText("Saved copy.json", { exact: true }).nth(1).waitFor();
  NodeAssert.equal(NodeFS.readFileSync(copy, "utf8"), ORIGINAL.replace('"quipu"', '"khipu"'));
  NodeAssert.notEqual(NodeFS.statSync(copy).ino, beforeEdit.ino, "the edit save replaced the file");
  await page.locator("[data-unsaved-dot]").first().waitFor({ state: "detached" });
  await valueOf("name").filter({ hasText: '"khipu"' }).waitFor();
  // The save kept the history: Undo takes the edit back and the document is unsaved again;
  // Redo brings it back to what is on disk.
  await valueOf("name").click();
  await page.keyboard.press("Control+z");
  await valueOf("name").filter({ hasText: '"quipu"' }).waitFor();
  await page.locator("[data-unsaved-dot]").first().waitFor();
  await page.keyboard.press("Control+Shift+z");
  await valueOf("name").filter({ hasText: '"khipu"' }).waitFor();
  await page.locator("[data-unsaved-dot]").first().waitFor({ state: "detached" });

  // Another edit, then closing the window: the prompt's Save writes the file, then the window
  // (the last one, so the app) closes.
  await editValue("name", "rope");
  const exited = new Promise((resolve) => app.process().once("exit", resolve));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  const prompt = page.locator("[data-unsaved-changes-dialog]");
  await prompt.getByText("Save changes to copy.json?").waitFor();
  await prompt.getByRole("button", { name: "Save" }).click();
  await exited;
  NodeAssert.equal(NodeFS.readFileSync(copy, "utf8"), ORIGINAL.replace('"quipu"', '"rope"'));
  NodeAssert.deepEqual(
    NodeFS.readdirSync(workDir).filter((name) => name.endsWith(".tmp")),
    [],
  );
  console.log("Desktop save e2e passed.");
} finally {
  NodeFS.rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
