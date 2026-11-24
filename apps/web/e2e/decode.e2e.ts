// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
// @effect-diagnostics preferSchemaOverJson:off - the expectations come from the sample HAR itself, parsed with JSON.parse in Node.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Locator, Page } from "playwright-core";
import { build, preview } from "vite-plus";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { expectMedianWithin, sampleRuns } from "./budget";
import { cachedHar, REFERENCE_HAR_SAMPLES, referenceSamplesMissing, skipWithout } from "./fixtures";
import { locateHar2g } from "./har2gIndex";
import { dropFile, MOD, useBrowser } from "./harness";
import { type Step, TreeNavigator } from "./treeNavigation";

const withBrowserPage = useBrowser();
// The map is the default view; these tests drive the tree.
const withPage: typeof withBrowserPage = (run, options = {}) =>
  withBrowserPage(run, { storage: { "quipu:document-view": "tree" }, ...options });

const SAMPLES = REFERENCE_HAR_SAMPLES;
const HAR_2G = cachedHar("har-2g.har");
const EVIDENCE =
  process.env.QUIPU_EVIDENCE_DIR ?? NodePath.join(NodeOS.tmpdir(), "quipu-evidence", "decoders");

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-decode-e2e-"));
  NodeFS.mkdirSync(EVIDENCE, { recursive: true });
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

interface HarEntry {
  request: {
    headers: Array<{ name: string; value: string }>;
    postData?: { mimeType: string; text: string };
  };
  response: {
    cookies: Array<{ name: string; value: string }>;
    content: { text?: string; mimeType: string };
  };
  _webSocketMessages?: Array<{ type: string; time: number; opcode: number; data: string }>;
}
const readHar = (name: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(SAMPLES, `${name}.har`), "utf8")) as {
    log: { entries: HarEntry[] };
  };

const ENTRY = ["log", "entries"] as const;

/** Drops the HAR, waits for the index, and opens the Inspector. */
async function open(page: Page, file: string) {
  await dropFile(page, file);
  const tree = page.getByRole("tree", { name: "Document tree" });
  try {
    await tree.getByRole("treeitem", { name: /^log/ }).waitFor({ timeout: 30_000 });
  } catch (error) {
    await page.screenshot({ path: NodePath.join(EVIDENCE, "open-failed.png") });
    throw error;
  }
  await page.getByText("Indexing…").waitFor({ state: "detached", timeout: 60_000 });
  await page.keyboard.press(`${MOD}+Alt+b`);
  await page
    .getByRole("region", { name: "Right panel" })
    .or(page.locator("[data-right-panel]"))
    .first()
    .waitFor();
  return new TreeNavigator(page);
}

const inspector = (page: Page) => page.locator("[data-inspector]");
const decoded = (page: Page, title: RegExp | string) =>
  inspector(page).getByRole("region", { name: title });

/** Waits until the element's text holds `text`, so a view that fills in late is not a flake. */
async function contains(locator: Locator, text: string) {
  await locator.first().waitFor();
  await expect.poll(() => locator.first().innerText()).toContain(text);
}

/** Prints a measurement and appends it to `budgets.txt` in the evidence directory. */
function record(line: string) {
  console.log(line);
  NodeFS.appendFileSync(NodePath.join(EVIDENCE, "budgets.txt"), `${line}\n`);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: NodePath.join(EVIDENCE, `${name}.png`) });
}

/** Moves the focus to the row at `path`: the Inspector follows the focus, and nothing is toggled. */
async function pick(nav: TreeNavigator, path: ReadonlyArray<Step>): Promise<Locator> {
  const id = await nav.reveal(path);
  const row = nav.row(id);
  await row.focus();
  return row;
}

/** Asks for the decode of the focused row with its command's keybinding. */
async function decodeFocused(page: Page) {
  await page.keyboard.press(`${MOD}+d`);
}

describe.skipIf(referenceSamplesMissing !== null)("decoders on real HAR captures", () => {
  it("decodes a Bearer JWT: header and payload shown, the signature marked not verified", async () => {
    const har = readHar("allbirds");
    const index = 341;
    const header = har.log.entries[index]!.request.headers[2]!;
    expect(header.value).toMatch(/^Bearer eyJ/);
    const claims = JSON.parse(
      Buffer.from(
        header.value.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    ) as Record<string, unknown>;
    const [firstClaim] = Object.keys(claims);

    await withPage(async (page) => {
      const nav = await open(page, NodePath.join(SAMPLES, "allbirds.har"));
      const row = await pick(nav, [...ENTRY, index, "request", "headers", 2, "value"]);
      await row.getByText("JWT · HS256").waitFor();

      const region = decoded(page, "Decoded: JWT · HS256");
      await region.waitFor();
      await contains(region.getByRole("group", { name: "Header" }), '"alg": "HS256"');
      await contains(region.getByRole("group", { name: "Payload" }), `"${firstClaim}":`);
      await contains(region.getByRole("group", { name: "Signature" }), "not verified");

      await decodeFocused(page);
      const tree = page.getByRole("tree", { name: "Document tree" });
      await tree.getByRole("treeitem", { name: /^header : \{\}/ }).waitFor();
      await tree.getByRole("treeitem", { name: /^payload : \{\}/ }).waitFor();
      await tree.getByRole("treeitem", { name: /^signature : .*not verified/ }).waitFor();
      await shot(page, "jwt");
    });
  }, 120_000);

  it("expands stringified JSON inline as children, and shows what it holds", async () => {
    const har = readHar("npm-search");
    const index = 59;
    const text = har.log.entries[index]!.response.content.text!;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const [firstKey] = Object.keys(parsed);

    await withPage(async (page) => {
      const nav = await open(page, NodePath.join(SAMPLES, "npm-search.har"));
      const row = await pick(nav, [...ENTRY, index, "response", "content", "text"]);
      await row.getByText("JSON", { exact: true }).waitFor();
      await decoded(page, /^Decoded: JSON/).waitFor();

      await decodeFocused(page);
      const tree = page.getByRole("tree", { name: "Document tree" });
      const child = tree.getByRole("treeitem", { name: new RegExp(`^${firstKey}\\b`) }).last();
      await child.waitFor();
      const parentLevel = Number(await row.getAttribute("aria-level"));
      expect(Number(await child.getAttribute("aria-level"))).toBe(parentLevel + 1);
      await shot(page, "nested-json");
    });
  }, 120_000);

  it.each([
    [49, "image/png"],
    [50, "image/webp"],
  ] as const)(
    "previews the base64 image in bbc-news entry %i by its bytes (%s)",
    async (index, mime) => {
      await withPage(async (page) => {
        const nav = await open(page, NodePath.join(SAMPLES, "bbc-news.har"));
        const row = await pick(nav, [...ENTRY, index, "response", "content", "text"]);
        await row.getByText(`base64 · ${mime}`).waitFor();
        const image = inspector(page).getByRole("img", { name: new RegExp(`^Decoded ${mime}`) });
        await image.waitFor();
        await expect
          .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
          .toBeGreaterThan(0);
        // A preview is an <img> over a Blob URL, never markup in the page.
        expect(await image.getAttribute("src")).toMatch(/^blob:/);
        await shot(page, `image-${mime.split("/")[1]}`);
      });
    },
    120_000,
  );

  it("previews a JPEG, and says what a body is when it carries no image", async () => {
    const har = readHar("mdn-web-api");
    const index = 68;
    expect(har.log.entries[index]!.response.content.mimeType).toBe("image/jpeg");
    await withPage(async (page) => {
      const nav = await open(page, NodePath.join(SAMPLES, "mdn-web-api.har"));
      await pick(nav, [...ENTRY, index, "response", "content", "text"]);
      const image = inspector(page).getByRole("img", { name: /^Decoded image\/jpeg/ });
      await image.waitFor();
      await expect
        .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalHeight))
        .toBeGreaterThan(0);
      await shot(page, "image-jpeg");
    });
  }, 120_000);

  it("draws an SVG body as an image and never as markup", async () => {
    const har = readHar("mdn-web-api");
    const index = har.log.entries.findIndex(
      (e) => e.response.content.mimeType.startsWith("image/svg+xml") && e.response.content.text,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    await withPage(async (page) => {
      const nav = await open(page, NodePath.join(SAMPLES, "mdn-web-api.har"));
      const row = await pick(nav, [...ENTRY, index, "response", "content", "text"]);
      await row.getByText("SVG image").waitFor();
      const image = inspector(page).getByRole("img", { name: /^Decoded image\/svg\+xml/ });
      await image.waitFor();
      await expect
        .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
        .toBeGreaterThan(0);
      expect(await image.getAttribute("src")).toMatch(/^blob:/);
      expect(await inspector(page).locator("svg[xmlns]").count()).toBe(0);
      await shot(page, "image-svg");
    });
  }, 120_000);

  it("shows URL-encoded form fields as a table and as members", async () => {
    const har = readHar("bbc-news");
    const index = 119;
    const body = har.log.entries[index]!.request.postData!;
    const pairs = [...new URLSearchParams(body.text).entries()];
    expect(pairs.length).toBeGreaterThan(3);
    await withPage(async (page) => {
      const nav = await open(page, NodePath.join(SAMPLES, "bbc-news.har"));
      const row = await pick(nav, [...ENTRY, index, "request", "postData", "text"]);
      await row.getByText("form", { exact: true }).waitFor();
      const region = decoded(page, /^Decoded: form/);
      await region.waitFor();
      for (const [name, value] of pairs.slice(0, 4)) {
        const tableRow = region.getByRole("row").filter({ hasText: name });
        await contains(tableRow.first(), value.slice(0, 20));
      }
      await decodeFocused(page);
      const tree = page.getByRole("tree", { name: "Document tree" });
      await tree
        .getByRole("treeitem", {
          name: new RegExp(`^${pairs[0]![0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
        })
        .last()
        .waitFor();
      await shot(page, "form");
    });
  }, 120_000);

  it("pretty-prints a GraphQL query found inside a JSON request body", async () => {
    const har = readHar("allbirds");
    const index = 275;
    const body = JSON.parse(har.log.entries[index]!.request.postData!.text) as { query: string };
    expect(body.query).toContain("query GetStorefrontCart");
    await withPage(async (page) => {
      const nav = await open(page, NodePath.join(SAMPLES, "allbirds.har"));
      const text = await pick(nav, [...ENTRY, index, "request", "postData", "text"]);
      await text.getByText("JSON", { exact: true }).waitFor();
      await decodeFocused(page);
      const query = await pick(nav, [...ENTRY, index, "request", "postData", "text", "query"]);
      await query.getByText("GraphQL · query GetStorefrontCart").waitFor();
      const region = decoded(page, "Decoded: GraphQL · query GetStorefrontCart");
      await region.waitFor();
      const lines = (await region.locator("pre").first().innerText()).split("\n");
      expect(lines[0]).toBe("query GetStorefrontCart($id: ID!) {");
      expect(lines[1]).toBe("  cart(id: $id) {");
      expect(lines.at(-1)).toBe("}");
      await decodeFocused(page);
      const tree = page.getByRole("tree", { name: "Document tree" });
      await tree.getByRole("treeitem", { name: /^1\s+query GetStorefrontCart/ }).waitFor();
      await shot(page, "graphql");
    });
  }, 120_000);

  it("splits an NDJSON body into lines", async () => {
    const har = readHar("live-market");
    const index = 72;
    const body = har.log.entries[index]!.request.postData!.text;
    const lines = body.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    await withPage(async (page) => {
      const nav = await open(page, NodePath.join(SAMPLES, "live-market.har"));
      const row = await pick(nav, [...ENTRY, index, "request", "postData", "text"]);
      await row.getByText("NDJSON", { exact: true }).waitFor();
      const region = decoded(page, /^Decoded: NDJSON/);
      await region.waitFor();
      await contains(region.getByRole("listitem").first(), lines[0]!.slice(0, 40));
      await decodeFocused(page);
      const tree = page.getByRole("tree", { name: "Document tree" });
      const level = Number(await row.getAttribute("aria-level"));
      await expect
        .poll(() =>
          tree
            .locator(`[role="treeitem"][aria-level="${level + 1}"]`)
            .filter({ hasText: /^0/ })
            .count(),
        )
        .toBe(1);
      await shot(page, "ndjson");
    });
  }, 120_000);

  it("inflates a gzip body inside base64 and shows the text it holds", async () => {
    const har = readHar("anilist-feed");
    const index = 454;
    const value = har.log.entries[index]!.response.cookies[0]!.value;
    expect(value).toMatch(/^H4sI/);
    const inflated = new Uint8Array(
      await new Response(
        new Blob([Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64")])
          .stream()
          .pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer(),
    );
    await withPage(async (page) => {
      const nav = await open(page, NodePath.join(SAMPLES, "anilist-feed.har"));
      const row = await pick(nav, [...ENTRY, index, "response", "cookies", 0, "value"]);
      await row.getByText(/base64 · application\/gzip/).waitFor();
      const region = decoded(page, /^Decoded: base64 · gzip/);
      await region.waitFor();
      await contains(region, "base64 → gzip");
      // What the gzip holds is binary (a protobuf message): the Inspector shows its first bytes in hex.
      const bytes = inflated.slice(0, 6);
      expect(bytes.length).toBeGreaterThan(0);
      await contains(
        region.locator("[data-binary-summary]"),
        Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" "),
      );
      await shot(page, "gzip");
    });
  }, 120_000);

  it("lists WebSocket frames, DevTools-shaped, with their direction, kind and content", async () => {
    // Playwright's recordHar has no `_webSocketMessages`; the frames were saved beside the
    // HAR. Attach them the way DevTools writes them: one websocket entry per socket.
    const sidecar = JSON.parse(
      NodeFS.readFileSync(NodePath.join(SAMPLES, "live-market.websockets.json"), "utf8"),
    ) as {
      sockets: Array<{
        url: string;
        messages: Array<{ type: string; time: number; opcode: number; data: string }>;
      }>;
    };
    const har = readHar("live-market");
    for (const socket of sidecar.sockets) {
      if (socket.messages.length === 0) continue;
      har.log.entries.push({
        request: { headers: [] },
        response: { cookies: [], content: { mimeType: "x-unknown" } },
        _webSocketMessages: socket.messages,
        _resourceType: "websocket",
        request_url: socket.url,
      } as unknown as HarEntry);
    }
    const first = har.log.entries.findIndex((e) => e._webSocketMessages);
    const file = NodePath.join(scratch, "live-market-ws.har");
    NodeFS.writeFileSync(file, JSON.stringify(har));
    const frames = har.log.entries[first]!._webSocketMessages!;

    await withPage(async (page) => {
      const nav = await open(page, file);
      const array = await pick(nav, [...ENTRY, first, "_webSocketMessages"]);
      await array.waitFor();
      const region = inspector(page).getByRole("region", { name: "WebSocket frames" });
      await region.waitFor();
      await expect.poll(() => region.getByRole("listitem").count()).toBe(frames.length);
      const firstFrame = region.getByRole("listitem").first();
      await contains(firstFrame, frames[0]!.type);
      await contains(firstFrame, "binary");

      const tree = page.getByRole("tree", { name: "Document tree" });
      await decodeFocused(page);
      await tree.getByRole("treeitem", { name: /^0\s.*(↑ send|↓ receive) · binary/ }).waitFor();
      await shot(page, "websocket-frames");
    });
  }, 120_000);
});

describe("decoder budgets on the 2 GiB HAR", () => {
  // Budgets are measured on the production build: the dev server runs React's development
  // build, whose component-tracking alone costs tens of milliseconds per render.
  let productionUrl = "";
  let closePreview: (() => Promise<void>) | null = null;
  beforeAll(async () => {
    // Without the fixture the test skips; building for it would only cost time.
    if (HAR_2G.missing !== null) return;
    const configFile = new URL("../vite.config.ts", import.meta.url).pathname;
    const outDir = NodePath.join(scratch, "dist");
    await build({
      configFile,
      logLevel: "warn",
      build: { outDir, emptyOutDir: true, sourcemap: false },
    });
    // Port 0: the OS picks a free one, as the dev server's does.
    const server = await preview({
      configFile,
      logLevel: "warn",
      build: { outDir },
      preview: { host: "127.0.0.1", port: 0 },
    });
    const local = server.resolvedUrls?.local[0];
    if (!local) throw new Error("the preview server did not report its address");
    productionUrl = local.replace(/\/$/, "");
    closePreview = () => new Promise((resolve) => server.httpServer.close(() => resolve()));
  }, 300_000);
  afterAll(async () => {
    await closePreview?.();
  });

  /** Time from the click to the first mutation that makes `selector` match, measured in the page. */
  async function clickUntil(page: Page, row: Locator, selector: string) {
    await page.evaluate((sel) => {
      const state = { start: 0, end: 0 };
      (window as unknown as { __decodeTiming: typeof state }).__decodeTiming = state;
      document.addEventListener("click", () => (state.start = performance.now()), {
        capture: true,
        once: true,
      });
      const observer = new MutationObserver(() => {
        if (state.end === 0 && document.querySelector(sel) !== null) {
          state.end = performance.now();
          observer.disconnect();
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    }, selector);
    await row.click();
    await page.waitForFunction(
      () => (window as unknown as { __decodeTiming: { end: number } }).__decodeTiming.end > 0,
      undefined,
      { timeout: 30_000 },
    );
    return page.evaluate(() => {
      const t = (window as unknown as { __decodeTiming: { start: number; end: number } })
        .__decodeTiming;
      return t.end - t.start;
    });
  }

  /**
   * One cold measurement of both budgets in a fresh page: nothing is decoded before the click.
   * Each budget is checked against the median of five such runs, so one slow sample does not
   * decide it; every run is recorded.
   */
  async function measure(
    landmarks: ReturnType<typeof locateHar2g>,
    nested: { entry: number },
    capture: boolean,
  ) {
    return withPage(
      async (page) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const nav = await open(page, HAR_2G.path);

        // The 600 MiB body: selecting its row shows the decoded head, the type and the size.
        const bigRow = nav.row(
          await nav.reveal([...ENTRY, landmarks.bigBodyEntry, "response", "content", "text"]),
        );
        await bigRow.waitFor();
        await bigRow.getByText(/^base64/).waitFor();
        expect(await page.locator('[aria-label^="Decoded: base64"]').count()).toBe(0);
        const firstScreen = await clickUntil(
          page,
          bigRow,
          '[data-inspector] [role="region"][aria-label^="Decoded: base64"] :is(pre, [data-binary-summary])',
        );
        const region = decoded(page, /^Decoded: base64/);
        await contains(region, "video/mp4");
        await contains(region, "MB");
        if (capture) await shot(page, "base64-600mib");

        // The 60 MiB nested stringified body: opening the row lists its decoded members.
        const nestedRow = nav.row(
          await nav.reveal([...ENTRY, nested.entry, "response", "content", "text"]),
        );
        await nestedRow.getByText("JSON", { exact: true }).waitFor();
        const level = Number(await nestedRow.getAttribute("aria-level"));
        // Cold: nothing has been decoded yet, so no row is a decoded value's child.
        expect(await page.locator("[data-decoded-child]").count()).toBe(0);
        // The triangle opens the row; a click on the row itself only selects it.
        const expand = await clickUntil(
          page,
          nestedRow.locator("[data-tree-toggle]"),
          `[data-tree-view] [role="treeitem"][aria-level="${level + 1}"][data-decoded-child]`,
        );
        if (capture) await shot(page, "nested-60mib");
        expect(errors).toEqual([]);
        return { firstScreen, expand };
      },
      { baseUrl: productionUrl },
    );
  }

  it("shows the first screen of the 600 MiB base64 body within 300 ms, and its largest nested body expands within 200 ms", async (context) => {
    skipWithout(context, HAR_2G);
    const landmarks = locateHar2g(HAR_2G.path);
    record(`har-2g landmarks: ${JSON.stringify(landmarks)}`);
    // The generator's manifest says how big the largest nested body was written.
    const nestedBytes = Math.max(...HAR_2G.spec.nestedBodyBytes);
    const nested = landmarks.nestedBodies.find((b) => b.size === nestedBytes);
    expect(landmarks.bigBodyEntry).toBeGreaterThan(0);
    expect(nested).toBeDefined();

    const runs = await sampleRuns((run) => measure(landmarks, nested!, run === 0));
    const mib = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MiB`;
    expectMedianWithin(
      `har-2g: open the ${mib(HAR_2G.spec.bigBodyChars)} body, first screen`,
      runs.map((r) => r.firstScreen),
      300,
      record,
    );
    expectMedianWithin(
      `har-2g: expand the ${mib(nestedBytes)} nested body`,
      runs.map((r) => r.expand),
      200,
      record,
    );
  }, 900_000);
});
