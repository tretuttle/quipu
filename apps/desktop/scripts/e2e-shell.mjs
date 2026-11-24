// Drives the built desktop app through playwright-core's Electron support:
// a native menu item runs a shell command in the renderer, and a rebound
// keybinding and a changed setting land in files in the app data folder.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { _electron as electron } from "playwright-core";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mainJs = NodePath.resolve(__dirname, "../dist-electron/boot.cjs");
// oxlint-disable-next-line quipu/no-global-process-runtime -- Standalone Playwright e2e script has no Effect runtime.
const MOD = process.platform === "darwin" ? "Meta" : "Control";

const userDataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-desktop-e2e-"));
// The state directory (journals, drawings) is `$QUIPU_HOME/userdata`.
const quipuHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-desktop-e2e-home-"));
// A second, empty profile stands in for a replaced Chromium profile.
const freshUserDataDir = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "quipu-desktop-e2e-fresh-"),
);
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...parentEnv } = process.env;

async function launch(profile = userDataDir) {
  const { electronPath, args } = resolveElectronLaunchCommand([
    mainJs,
    `--user-data-dir=${profile}`,
  ]);
  const app = await electron.launch({
    executablePath: electronPath,
    args,
    env: { ...parentEnv, VITE_DEV_SERVER_URL: "", QUIPU_HOME: quipuHome },
  });
  const page = await app.firstWindow();
  await page.locator("[data-app-sidebar]").waitFor();
  return { app, page };
}

async function sidebarRightEdge(page) {
  return page.evaluate(
    () => document.querySelector('[role="navigation"]')?.getBoundingClientRect().right ?? 0,
  );
}

async function clickMenuItem(app, menuLabel, itemLabel) {
  await app.evaluate(
    ({ Menu }, [menu, item]) => {
      const top = Menu.getApplicationMenu()?.items.find((entry) => entry.label === menu);
      // A trailing * matches a label by prefix, for items that carry the app's name.
      const target = top?.submenu?.items.find((entry) =>
        item.endsWith("*") ? entry.label.startsWith(item.slice(0, -1)) : entry.label === item,
      );
      if (!target) throw new Error(`No ${menu} > ${item} menu item.`);
      target.click();
    },
    [menuLabel, itemLabel],
  );
}

let drawingFile = "";
try {
  {
    const { app, page } = await launch();

    // The native menu mirrors the shell commands: View > Toggle sidebar hides the sidebar.
    NodeAssert.ok((await sidebarRightEdge(page)) > 100, "the sidebar starts open");
    await clickMenuItem(app, "View", "Toggle sidebar");
    await page.waitForFunction(
      () => document.querySelector('[role="navigation"]').getBoundingClientRect().right <= 0,
    );
    await clickMenuItem(app, "View", "Toggle sidebar");
    await page.waitForFunction(
      () => document.querySelector('[role="navigation"]').getBoundingClientRect().right > 100,
    );

    // Help > Show keyboard shortcuts opens the editor; rebinding a command writes keybindings.json.
    await clickMenuItem(app, "Help", "Show keyboard shortcuts");
    await page.getByRole("heading", { name: "General", exact: true }).waitFor();
    await page.getByRole("button", { name: /^Edit shortcut for Toggle sidebar:/ }).click();
    await page.keyboard.press(`${MOD}+Shift+y`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Custom").first().waitFor();

    // Open keybindings.json hands the file the app reads to the system. The
    // test records the path instead of launching an editor.
    await app.evaluate(({ shell }) => {
      globalThis.__openedPath = new Promise((resolve) => {
        shell.openPath = async (path) => {
          resolve(path);
          return "";
        };
      });
    });
    await page.getByRole("button", { name: "Open keybindings.json" }).click();
    const opened = await app.evaluate(() => globalThis.__openedPath);
    NodeAssert.equal(opened, NodePath.join(userDataDir, "keybindings.json"));

    // Help > About lands on the About section of General, not a page of its own.
    await clickMenuItem(app, "Help", "About*");
    await page.getByRole("heading", { name: "About", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Confirmations" }).waitFor();

    // File > New Board opens a blank board; a mouse drag draws a rectangle on it.
    await clickMenuItem(app, "File", "New board");
    const canvas = page.getByRole("application", { name: "Board canvas" });
    await canvas.waitFor();
    await page.getByTestId("board-save-status").getByText("Saved").waitFor();
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + 20, box.y + 560);
    await page.keyboard.press("r");
    await page.getByRole("radio", { name: "Rectangle", checked: true }).waitFor();
    // Draw right of the floating style panel, which covers the canvas's top-left.
    await page.mouse.move(box.x + 400, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 460, box.y + 150);
    await page.mouse.move(box.x + 520, box.y + 180);
    await page.mouse.up();
    const rect = await page.locator('[data-element-type="rectangle"]').boundingBox();
    NodeAssert.ok(
      Math.abs(rect.x - (box.x + 400)) < 8,
      "the rectangle starts where the drag started",
    );
    NodeAssert.ok(Math.abs(rect.width - 120) < 16, "the rectangle spans the drag");
    await page.getByTestId("board-save-status").getByText("Saved", { exact: true }).waitFor();
    await page.getByRole("link", { name: "Board 1" }).waitFor();
    // The drawing is a file in the state directory, not renderer IndexedDB.
    const boardUuid = decodeURIComponent(page.url()).match(/board:([0-9a-f-]+)/)?.[1];
    NodeAssert.ok(boardUuid, "the board's id is in the URL");
    drawingFile = NodePath.join(quipuHome, "userdata", "drawings", "board", `${boardUuid}.json`);

    // A changed setting lands in client-settings.json.
    await clickMenuItem(app, "File", "Settings…");
    await page.getByRole("switch", { name: "Confirm before clearing stored data" }).click();
    await page.getByRole("button", { name: "Restore default settings" }).waitFor();

    await app.close();
  }

  const keybindings = JSON.parse(
    NodeFS.readFileSync(NodePath.join(userDataDir, "keybindings.json"), "utf8"),
  );
  NodeAssert.deepEqual(keybindings, [{ key: "mod+shift+y", command: "sidebar.toggle" }]);
  const settings = JSON.parse(
    NodeFS.readFileSync(NodePath.join(userDataDir, "client-settings.json"), "utf8"),
  );
  NodeAssert.equal(settings.confirmStorageClear, false);
  const drawing = JSON.parse(NodeFS.readFileSync(drawingFile, "utf8"));
  NodeAssert.equal(drawing.type, "quipu-drawing");
  NodeAssert.deepEqual(
    drawing.elements.map((element) => element.type),
    ["rectangle"],
  );
  const boardList = NodePath.join(quipuHome, "userdata", "drawings", "boards.json");
  const listedNames = () =>
    JSON.parse(NodeFS.readFileSync(boardList, "utf8")).boards.map((board) => board.name);
  NodeAssert.deepEqual(listedNames(), ["Board 1"]);

  {
    // A new process reads both back: the rebound chord works, the old one does not.
    const { app, page } = await launch();
    await page.keyboard.press(`${MOD}+b`);
    NodeAssert.ok((await sidebarRightEdge(page)) > 100, "the old chord does nothing");
    await page.keyboard.press(`${MOD}+Shift+y`);
    await page.waitForFunction(
      () => document.querySelector('[role="navigation"]').getBoundingClientRect().right <= 0,
    );
    // The board reopens from its file, and a rename lands in the list file.
    await page.keyboard.press(`${MOD}+Shift+y`);
    await page.getByRole("link", { name: "Board 1" }).click();
    await page.locator('[data-element-type="rectangle"]').waitFor();
    await page.getByRole("button", { name: "Actions for Board 1" }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await page.getByRole("textbox", { name: "Board name" }).fill("Plans");
    await page.keyboard.press("Enter");
    await page.getByRole("link", { name: "Plans" }).waitFor();
    await app.close();
  }
  NodeAssert.deepEqual(listedNames(), ["Plans"]);

  {
    // A replaced browser profile still lists the board and opens its drawing;
    // deleting it removes its file and its row in the list.
    const { app, page } = await launch(freshUserDataDir);
    await page.getByRole("link", { name: "Plans" }).click();
    await page.locator('[data-element-type="rectangle"]').waitFor();
    await page.getByRole("button", { name: "Actions for Plans" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page.getByText("No boards yet").waitFor();
    await app.close();
  }
  NodeAssert.deepEqual(listedNames(), []);
  NodeAssert.equal(NodeFS.existsSync(drawingFile), false, "the deleted drawing's file is gone");

  console.log("Desktop shell e2e passed.");
} finally {
  NodeFS.rmSync(userDataDir, { recursive: true, force: true });
  NodeFS.rmSync(quipuHome, { recursive: true, force: true });
  NodeFS.rmSync(freshUserDataDir, { recursive: true, force: true });
}
process.exit(0);
