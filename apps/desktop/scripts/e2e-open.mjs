// Drives the built desktop app through documents arriving the three native ways:
// a path on the command line, a second launch handing its file to the first,
// and the File > Open file… dialog. What it asserts is what the window shows and
// what lands in recents.json. Every file that opens is read through the main
// process's handle, a read window at a time: a file larger than one window
// shows the member that lies past it, and no debugger is ever attached. A file
// that is not there, or may not be read, is reported in the window instead, and
// stays in the recents.
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

const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-desktop-open-"));
const userDataDir = NodePath.join(workDir, "user-data");
const write = (name, contents) => {
  const file = NodePath.join(workDir, name);
  NodeFS.writeFileSync(file, contents);
  return file;
};
const launchedFile = write("launched.json", JSON.stringify({ fromArgv: "opened at launch" }));
const handedOverFile = write(
  "handed-over.json",
  JSON.stringify({ viaSecondInstance: "handed over" }),
);
const dialogFile = write("chosen.har", JSON.stringify({ log: { version: "1.2", entries: [] } }));

// Larger than one read window (MAX_DOCUMENT_READ_BYTES, 64 MiB), with a member
// that starts past it, so the window shows it only if later windows were read.
const READ_WINDOW_BYTES = 64 * 1024 * 1024;
const bigFile = NodePath.join(workDir, "big.json");

// Files the app cannot open: two that are not there, and one it may not read.
const missingAtLaunch = NodePath.join(workDir, "missing-at-launch.json");
const missingAtSecondLaunch = NodePath.join(workDir, "missing-at-second-launch.json");
const lockedFile = write("locked.json", '{"never":"read"}');
NodeFS.chmodSync(lockedFile, 0o000);
{
  const row = `{"id":0,"text":"${"x".repeat(100)}"}`;
  const rows = Math.ceil((READ_WINDOW_BYTES + 4 * 1024 * 1024) / (row.length + 1));
  const chunk = Array.from({ length: 10_000 }, () => row).join(",");
  const fd = NodeFS.openSync(bigFile, "w");
  NodeFS.writeSync(fd, '{"rows":[');
  for (let written = 0; written < rows; written += 10_000) {
    NodeFS.writeSync(fd, written === 0 ? chunk : `,${chunk}`);
  }
  NodeFS.writeSync(fd, '],"tail":"past the first read window"}');
  NodeFS.closeSync(fd);
}
NodeAssert.ok(NodeFS.statSync(bigFile).size > READ_WINDOW_BYTES + 1024 * 1024);

// The shipped main process has no debugger path left to take.
const bundle = NodeFS.readFileSync(mainJs.replace(/boot\.cjs$/, "main.cjs"), "utf8");
for (const forbidden of ["setFileInputFiles", "debugger.attach", ".debugger"]) {
  NodeAssert.ok(!bundle.includes(forbidden), `the main bundle mentions ${forbidden}`);
}

const { electronPath, args } = resolveElectronLaunchCommand([
  mainJs,
  `--user-data-dir=${userDataDir}`,
]);
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...parentEnv } = process.env;
const env = { ...parentEnv, VITE_DEV_SERVER_URL: "" };

const tree = (page) => page.getByRole("tree", { name: "Document tree" });

/**
 * Counts every attach of every window's debugger from now on, and says
 * whether one is attached now.
 */
const watchDebuggers = (app) =>
  app.evaluate(({ BrowserWindow }) => {
    globalThis.__debuggerAttaches ??= 0;
    for (const window of BrowserWindow.getAllWindows()) {
      const cdp = window.webContents.debugger;
      if (cdp.__watched) continue;
      cdp.__watched = true;
      const attach = cdp.attach.bind(cdp);
      cdp.attach = (...args) => {
        globalThis.__debuggerAttaches++;
        return attach(...args);
      };
    }
  });
const debuggerState = (app) =>
  app.evaluate(({ BrowserWindow }) => ({
    attaches: globalThis.__debuggerAttaches,
    attached: BrowserWindow.getAllWindows().some((window) =>
      window.webContents.debugger.isAttached(),
    ),
  }));

try {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [...args, launchedFile, missingAtLaunch],
    env,
  });
  const page = await app.firstWindow();
  await watchDebuggers(app);
  await page.locator("[data-app-sidebar]").waitFor();

  // A path on the command line opens in the window, as a map by default; this
  // script reads the outline, so View > Show tree view first.
  await page.getByRole("tree", { name: "Document map" }).waitFor();
  await app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()?.items.find((entry) => entry.label === "View");
    view?.submenu?.items.find((entry) => entry.label === "Show tree view")?.click();
  });
  await tree(page)
    .getByRole("treeitem", { name: /fromArgv.*opened at launch/ })
    .waitFor();
  await page.getByTestId("recent-document").getByText("launched.json").waitFor();
  // The second path on the command line is not there: the window says so.
  await page.getByText("missing-at-launch.json can't be found", { exact: true }).waitFor();

  // A second launch hands its file to this window and exits.
  const second = NodeChildProcess.spawn(electronPath, [...args, handedOverFile], {
    env,
    stdio: "ignore",
  });
  await new Promise((resolve) => second.once("exit", resolve));
  await tree(page)
    .getByRole("treeitem", { name: /viaSecondInstance.*handed over/ })
    .waitFor();

  // A second launch with a file that is not there: the first window says so and keeps its document.
  const third = NodeChildProcess.spawn(electronPath, [...args, missingAtSecondLaunch], {
    env,
    stdio: "ignore",
  });
  await new Promise((resolve) => third.once("exit", resolve));
  await page.getByText("missing-at-second-launch.json can't be found", { exact: true }).waitFor();
  await tree(page)
    .getByRole("treeitem", { name: /viaSecondInstance.*handed over/ })
    .waitFor();

  // File > Open file… shows the native dialog; a stub answers it with a path.
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, dialogFile);
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((entry) => entry.label === "File");
    file?.submenu?.items.find((entry) => entry.label === "Open file…")?.click();
  });
  await tree(page).getByRole("treeitem", { name: /^log/ }).waitFor();
  await page.getByText("HAR", { exact: true }).waitFor();

  // A file larger than one read window: its last member lies past the first window.
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, bigFile);
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((entry) => entry.label === "File");
    file?.submenu?.items.find((entry) => entry.label === "Open file…")?.click();
  });
  await tree(page)
    .getByRole("treeitem", { name: /tail.*past the first read window/ })
    .waitFor({ timeout: 60_000 });
  await tree(page).getByRole("treeitem", { name: /^rows/ }).waitFor();

  // The dialog picks a file this user may not read: the window says so, the
  // open document stays, and the file is listed to try again.
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, lockedFile);
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((entry) => entry.label === "File");
    file?.submenu?.items.find((entry) => entry.label === "Open file…")?.click();
  });
  await page.getByText("Access to locked.json was not allowed", { exact: true }).waitFor();
  await page.getByTestId("recent-document").getByText("locked.json").waitFor();
  await tree(page).getByRole("treeitem", { name: /^rows/ }).waitFor();

  NodeAssert.deepEqual(await debuggerState(app), { attaches: 0, attached: false });
  await app.close();

  const recents = JSON.parse(
    NodeFS.readFileSync(NodePath.join(userDataDir, "recents.json"), "utf8"),
  );
  NodeAssert.deepEqual(
    recents.map((entry) => entry.name),
    ["locked.json", "big.json", "chosen.har", "handed-over.json", "launched.json"],
  );
  console.log("Desktop open e2e passed.");
} finally {
  NodeFS.chmodSync(lockedFile, 0o600);
  NodeFS.rmSync(workDir, { recursive: true, force: true });
}
process.exit(0);
