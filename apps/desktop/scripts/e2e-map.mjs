// Drives the built desktop app through the map: a document on the command line
// opens as a map, a node expands, View > Show tree view and View > Show map view switch the view,
// and fit changes the zoom readout. What it asserts is what the window shows.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { _electron as electron } from "playwright-core";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mainJs = NodePath.resolve(__dirname, "../dist-electron/boot.cjs");

const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-desktop-map-"));
const userDataDir = NodePath.join(workDir, "user-data");
const documentFile = NodePath.join(workDir, "knots.json");
NodeFS.writeFileSync(
  documentFile,
  JSON.stringify({ name: "quipu", cords: { count: 3, colors: ["red", "blue"] } }),
);

const { electronPath, args } = resolveElectronLaunchCommand([
  mainJs,
  `--user-data-dir=${userDataDir}`,
]);
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...parentEnv } = process.env;
const env = { ...parentEnv, VITE_DEV_SERVER_URL: "" };

const clickMenu = (app, menuLabel, itemLabel) =>
  app.evaluate(
    ({ Menu }, [menu, item]) => {
      const top = Menu.getApplicationMenu()?.items.find((entry) => entry.label === menu);
      top?.submenu?.items.find((entry) => entry.label === item)?.click();
    },
    [menuLabel, itemLabel],
  );

try {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [...args, documentFile],
    env,
  });
  const page = await app.firstWindow();
  await page.locator("[data-app-sidebar]").waitFor();

  // The file on the command line opens as a map: the root node with its rows.
  const map = page.getByRole("tree", { name: "Document map" });
  const root = map.getByRole("treeitem", { name: "root {} 2 keys" });
  await root.waitFor();
  await root.getByText('"quipu"').waitFor();

  // A row's chevron opens the nested object into its own node.
  await map
    .locator("[data-map-row-id]")
    .filter({ hasText: "cords" })
    .locator("[data-map-toggle]")
    .click({ force: true });
  await map.getByRole("treeitem", { name: "cords {} 2 keys" }).waitFor();

  // View > Zoom to fit changes the readout; View > Show tree view and View > Show map view switch views.
  await page.getByLabel("Map canvas").click({ position: { x: 10, y: 10 } });
  await page.keyboard.press("=");
  await page.getByTestId("map-zoom").getByText("110%").waitFor();
  await clickMenu(app, "View", "Zoom to fit");
  await page.getByTestId("map-zoom").getByText("100%").waitFor();
  await clickMenu(app, "View", "Show tree view");
  await page
    .getByRole("tree", { name: "Document tree" })
    .getByRole("treeitem", { name: /cords/ })
    .waitFor();
  await clickMenu(app, "View", "Show map view");
  await map.getByRole("treeitem", { name: "cords {} 2 keys" }).waitFor();

  const paints = await map
    .locator("rect, path, text, line")
    .evaluateAll((els) =>
      els
        .flatMap((el) => [el.getAttribute("fill"), el.getAttribute("stroke")])
        .filter((v) => v !== null),
    );
  NodeAssert.ok(paints.length > 5, "the map paints something");
  for (const paint of paints) NodeAssert.match(paint, /^(var\(--[a-z0-9-]+\)|none)$/);

  await app.close();
  console.log("desktop map e2e: ok");
} finally {
  NodeFS.rmSync(workDir, { recursive: true, force: true });
}
