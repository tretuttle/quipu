// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Locator, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { dropFile, MOD, pasteText, useBrowser } from "./harness";
import { map, mapNode as node, mapRowOf, toggleRowOf } from "./mapHarness";

const withPage = useBrowser();

/** One value per decoder kind (and two that are not decodable), from the QA sample. */
const EVERY_KIND = {
  nestedJson:
    '{"source": "sensor", "rev": 3, "flags": [true, null], "inner": {"a": 1, "b": "two"}}',
  jwt: "eyJhbGciOiAiSFMyNTYiLCAidHlwIjogIkpXVCJ9.eyJzdWIiOiAidXNlci0wMDQyIiwgIm5hbWUiOiAiU2FtcGxlIFVzZXIiLCAiaWF0IjogMTc2MDAwMDAwMCwgImV4cCI6IDE3NjAwMDM2MDAsICJyb2xlcyI6IFsicmVhZGVyIiwgImVkaXRvciJdfQ.c2lnbmF0dXJlLW5vdC1yZWFs",
  form: "name=Sample+User&city=Lyon&tags=a%2Cb&page=2",
  ndjson:
    '{"seq": 0, "event": "tick", "ok": true}\n{"seq": 1, "event": "tick", "ok": false}\n{"seq": 2, "event": "tick", "ok": true}\n{"seq": 3, "event": "tick", "ok": false}\n{"seq": 4, "event": "tick", "ok": true}',
  graphql:
    "query GetStation($id: ID!) { station(id: $id) { id name readings(last: 5) { at value } } }",
  imagePng:
    "iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAGklEQVR4nGO4E6BBFcQwatCoQaMGjRpEGQIAxsT+ECE++wYAAAAASUVORK5CYII=",
  plainText: "just a string",
  count: 42,
  gzipBlob: "H4sIAAAAAAAC/8tIzcnJVygszSwoVcgYZQ87NgDWwTXy4AEAAA==",
  pdfBlob:
    "JVBERi0xLjQKJeLjz9MKMSAwIG9iajw8Pj5lbmRvYmoKdHJhaWxlcjw8Pj4KJSVFT0YKJVBERi0xLjQKJeLjz9MKMSAwIG9iajw8Pj5lbmRvYmoKdHJhaWxlcjw8Pj4KJSVFT0YKJVBERi0xLjQKJeLjz9MKMSAwIG9iajw8Pj5lbmRvYmoKdHJhaWxlcjw8Pj4KJSVFT0YK",
};

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-map-decode-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const JWT = `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url({ sub: "quipu", name: "Ada" })}.c2lnbmF0dXJl`;
/** A 1×1 PNG. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A capture with a JSON body, a Bearer token and a base64 image, the way DevTools writes them. */
function decodableHar(): string {
  const entry = (path: string, host: string, fields: Record<string, unknown>) => ({
    pageref: "page_1",
    request: { method: "GET", url: `https://${host}${path}`, headers: [] },
    response: { status: 200, content: { mimeType: "text/plain", text: "" } },
    ...fields,
  });
  return JSON.stringify({
    log: {
      version: "1.2",
      pages: [{ id: "page_1", title: "Home" }],
      entries: [
        entry("/data", "api.example", {
          response: {
            status: 200,
            content: {
              mimeType: "application/json",
              text: JSON.stringify({ user: { id: 7, name: "Ada" }, tags: ["x", "y"] }),
            },
          },
        }),
        entry("/me", "api.example", {
          request: {
            method: "GET",
            url: "https://api.example/me",
            headers: [{ name: "Authorization", value: `Bearer ${JWT}` }],
          },
        }),
        entry("/pixel.png", "cdn.example", {
          response: {
            status: 200,
            content: { mimeType: "image/png", encoding: "base64", text: PIXEL },
          },
        }),
      ],
    },
  });
}

/** Drops the capture and opens host → page → request on the map. */
async function openRequest(page: Page, host: RegExp, request: RegExp): Promise<Locator> {
  const file = NodePath.join(scratch, "decodable.har");
  NodeFS.writeFileSync(file, decodableHar());
  await dropFile(page, file);
  const capture = node(page, /^Capture 3 requests, 2 hosts$/);
  await capture.waitFor();
  await toggleRowOf(page, capture, host);
  const hostNode = node(page, new RegExp(`^${host.source.slice(1)} \\d+ requests?, 1 page$`));
  await toggleRowOf(page, hostNode, /^Home/);
  const home = node(page, /^Home \d+ requests?$/);
  await toggleRowOf(page, home, request);
  const entry = node(page, new RegExp(`^${request.source.slice(1)} \\{\\}`));
  await entry.waitFor();
  return entry;
}

const treeView = (page: Page) => page.getByRole("tree", { name: "Document tree" });
const showTree = (page: Page) =>
  page.getByLabel("Document view").getByRole("button", { name: "Tree" }).click();
const showMap = (page: Page) =>
  page.getByLabel("Document view").getByRole("button", { name: "Map" }).click();

describe("decoded values on the map", () => {
  it("opens a nested JSON body into decoded cards, and shares the open state with the tree", async () => {
    await withPage(async (page) => {
      const entry = await openRequest(page, /^api\.example/, /^GET \/data/);
      await toggleRowOf(page, entry, /^response/);
      const response = node(page, /^response \{\}/);
      await toggleRowOf(page, response, /^content/);
      const content = node(page, /^content \{\} 2 keys$/);
      const text = await mapRowOf(page, content, /^text/);
      await expect.poll(() => text.locator("[data-decode-badge]").textContent()).toBe("JSON");

      // The body opens into a decoded card, and its object into one more, both marked as decoded.
      await toggleRowOf(page, content, /^text/);
      const card = node(page, /^text JSON · 2 keys$/);
      await card.waitFor();
      expect(await card.getAttribute("data-map-decoded")).toBe("");
      await toggleRowOf(page, card, /^user/);
      const user = node(page, /^user \{\} 2 keys$/);
      await user.getByText("Ada").waitFor();
      expect(await user.getAttribute("data-map-decoded")).toBe("");

      // The tree shows the same decoded rows; collapsing the value there closes the card on the map.
      await showTree(page);
      const decodedUser = treeView(page)
        .locator("[data-decoded-child]")
        .filter({ hasText: /^user/ });
      await decodedUser.waitFor();
      const textRow = treeView(page).locator("[data-row-id]").filter({ hasText: /^text/ });
      expect(await textRow.getAttribute("aria-expanded")).toBe("true");
      await textRow.locator("[data-tree-toggle]").click();
      await expect.poll(() => textRow.getAttribute("aria-expanded")).toBe("false");
      await showMap(page);
      await node(page, /^content \{\} 2 keys$/).waitFor();
      expect(await card.count()).toBe(0);

      // And back: the value's row picked on the map, Mod+D decodes it again, and the tree follows.
      const again = await mapRowOf(page, content, /^text/);
      const at = await again.locator("text").first().boundingBox();
      if (!at) throw new Error("the text row is not on screen");
      await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
      await page.keyboard.press(`${MOD}+d`);
      await card.waitFor();
      await showTree(page);
      await expect.poll(() => textRow.getAttribute("aria-expanded")).toBe("true");
      await treeView(page).locator("[data-decoded-child]").filter({ hasText: /^user/ }).waitFor();
    });
  }, 120_000);

  it("opens a Bearer JWT into its header and payload, the signature marked not verified", async () => {
    await withPage(async (page) => {
      const entry = await openRequest(page, /^api\.example/, /^GET \/me/);
      await toggleRowOf(page, entry, /^request/);
      const request = node(page, /^request \{\}/);
      await toggleRowOf(page, request, /^headers/);
      const headers = node(page, /^headers \[\] 1 item$/);
      await toggleRowOf(page, headers, /^0/);
      const header = node(page, /^0 \{\} 2 keys$/);
      const value = await mapRowOf(page, header, /^value/);
      await expect
        .poll(() => value.locator("[data-decode-badge]").textContent())
        .toBe("JWT · HS256");
      await toggleRowOf(page, header, /^value/);
      const token = node(page, /^value JWT · HS256$/);
      await token.waitFor();
      const signature = await mapRowOf(page, token, /^signature/);
      expect(await signature.textContent()).toMatch(/^signature: "not verified \(9 bytes\)"$/);
      await toggleRowOf(page, token, /^payload/);
      const payload = node(page, /^payload \{\} 2 keys$/);
      await payload.getByText('"quipu"').waitFor();
      await payload.getByText('"Ada"').waitFor();

      // Collapsing the token takes its cards away.
      await toggleRowOf(page, header, /^value/);
      await token.waitFor({ state: "detached" });
      expect(await payload.count()).toBe(0);
    });
  }, 120_000);

  it("shows a base64 image as a preview card, and closes it again", async () => {
    await withPage(async (page) => {
      const entry = await openRequest(page, /^cdn\.example/, /^GET \/pixel\.png/);
      await toggleRowOf(page, entry, /^response/);
      const response = node(page, /^response \{\}/);
      await toggleRowOf(page, response, /^content/);
      const content = node(page, /^content \{\} 3 keys$/);
      const text = await mapRowOf(page, content, /^text/);
      await expect
        .poll(() => text.locator("[data-decode-badge]").textContent())
        .toMatch(/image\/png/);
      await toggleRowOf(page, content, /^text/);
      const card = node(page, /^text .*image\/png/);
      await card.waitFor();
      const type = await mapRowOf(page, card, /^type/);
      expect(await type.textContent()).toBe("type: image/png");
      const image = card.locator("[data-map-preview]");
      await image.waitFor();
      expect(await image.getAttribute("href")).toMatch(/^blob:/);

      await toggleRowOf(page, content, /^text/);
      await card.waitFor({ state: "detached" });
    });
  }, 120_000);

  it("decodes a subtree in bulk, keeps a value closed by hand, and decodes the rest automatically", async () => {
    await withPage(async (page) => {
      await pasteText(
        page,
        JSON.stringify({
          bodies: {
            first: JSON.stringify({ a: 1, b: 2 }),
            second: JSON.stringify({ c: 3, d: 4 }),
            third: JSON.stringify({ e: 5, f: 6 }),
          },
          later: JSON.stringify({ g: 7, h: 8 }),
        }),
      );
      const root = node(page, /^root \{\} 2 keys$/);
      await toggleRowOf(page, root, /^bodies/);
      const bodies = node(page, /^bodies \{\} 3 keys$/);
      await bodies.waitFor();

      // Select `bodies`, then decode everything in it from the palette.
      const header = await bodies.locator("text").first().boundingBox();
      if (!header) throw new Error("the bodies node is not on screen");
      await page.mouse.click(header.x + 4, header.y + header.height / 2);
      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      // Typed before the palette has the focus, a letter would pick a drawing tool on the canvas.
      await palette.getByRole("combobox").waitFor();
      await palette.getByRole("combobox").fill("Decode all values in selection");
      await palette.getByRole("option", { name: /Decode all values in selection/ }).click();
      const card = (name: string) => node(page, new RegExp(`^${name} JSON · 2 keys$`));
      for (const name of ["first", "second", "third"]) await card(name).waitFor();
      expect(await card("later").count()).toBe(0);

      // One closed by hand stays closed when automatic decoding comes on; the value outside opens.
      await toggleRowOf(page, bodies, /^second/);
      await card("second").waitFor({ state: "detached" });
      // The status bar's control names each command as the palette does.
      await page.getByRole("button", { name: "Decode", exact: true }).click();
      await page.getByRole("menuitem", { name: "Decode all values in selection" }).waitFor();
      await page
        .getByRole("menuitem", { name: "Collapse all decoded values in selection" })
        .waitFor();
      await page.getByRole("menuitemcheckbox", { name: "Decode automatically" }).click();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Decode automatically", exact: true }).waitFor();
      await card("later").waitFor();
      await card("first").waitFor();
      await card("third").waitFor();
      expect(await card("second").count()).toBe(0);
      expect(
        await map(page)
          .getByRole("treeitem", { name: /^second/ })
          .count(),
      ).toBe(0);
    });
  }, 120_000);

  it("decodes every decoder kind in bulk, the last ones too, even where they open off screen", async () => {
    await withPage(async (page) => {
      // One value of each kind, as a capture's bodies and headers carry them.
      await pasteText(page, JSON.stringify(EVERY_KIND));
      const root = node(page, /^root \{\} 10 keys$/);
      await root.waitFor();
      const header = await root.locator("text").first().boundingBox();
      if (!header) throw new Error("the root is not on screen");
      await page.mouse.click(header.x + 4, header.y + header.height / 2);
      await page.keyboard.press(`${MOD}+k`);
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("combobox").fill("Decode all values in selection");
      await palette
        .getByRole("option", { name: /Decode all values in selection/ })
        .first()
        .click();
      // The root and one card per decodable value: JSON, JWT, form, NDJSON, GraphQL, PNG, gzip, PDF.
      await page
        .getByTestId("map-status")
        .getByText(/^9 nodes/)
        .waitFor();
      // Fit twice shows the whole map, where every card is drawn.
      const fit = page.getByRole("button", { name: "Zoom to fit" });
      await fit.click();
      await fit.click();
      for (const key of [
        "nestedJson",
        "jwt",
        "form",
        "ndjson",
        "graphql",
        "imagePng",
        "gzipBlob",
        "pdfBlob",
      ]) {
        await map(page)
          .getByRole("treeitem", { name: new RegExp(`^${key} `) })
          .waitFor();
      }
    });
  });
});
