// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { dropFile, useBrowser } from "./harness";
import { mapNode as node, toggleMapRow as toggleRow } from "./mapHarness";

const withPage = useBrowser();

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-map-har-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

/**
 * A capture past every 1,000-row list: 1,002 hosts, a page with 1,003
 * requests, and a host with 1,001 pages. The two big hosts come last, so
 * they land in the second range of hosts.
 */
function overflowingHar(): string {
  const entry = (host: string, pageref: string, n: number) => ({
    pageref,
    request: { method: "GET", url: `https://${host}/e/${n}` },
    response: { status: 200 },
  });
  const entries = [
    ...Array.from({ length: 1000 }, (_, n) => entry(`host-${n}.example`, "page_1", n)),
    ...Array.from({ length: 1003 }, (_, n) => entry("big.example", "page_1", n)),
    ...Array.from({ length: 1001 }, (_, n) => entry("pages.example", `p${n}`, n)),
  ];
  return JSON.stringify({
    log: { version: "1.2", pages: [{ id: "page_1", title: "Home" }], entries },
  });
}

describe("a HAR capture past 1,000 hosts, pages and requests on the map", () => {
  it("opens every list past 1,000 as ranges down to a request's data", async () => {
    await withPage(async (page) => {
      const file = NodePath.join(scratch, "overflow.har");
      NodeFS.writeFileSync(file, overflowingHar());
      await dropFile(page, file);
      const capture = node(page, /^Capture 3,004 requests, 1,002 hosts$/);
      await capture.waitFor({ timeout: 30_000 });
      await capture.getByText("[0…999]").waitFor();
      await capture.getByText("1,000 hosts").waitFor();
      await capture.getByText("[1000…1001]").waitFor();

      // The hosts past 1,000 are a range that opens.
      await toggleRow(page, /^\[1000…1001\]/);
      const lastHosts = node(page, /^\[1000…1001\] 2 hosts$/);
      await lastHosts.getByText("big.example").waitFor();
      await lastHosts.getByText("pages.example").waitFor();

      // A host with 1,001 pages: the page past 1,000 is in a range of its own. Closing the host takes it away.
      await toggleRow(page, /^pages\.example/);
      const pagesHost = node(page, /^pages\.example 1,001 requests, 1,001 pages$/);
      await pagesHost.getByText("[1000…1000]").waitFor();
      await toggleRow(page, /^\[1000…1000\]/);
      await node(page, /^\[1000…1000\] 1 page$/)
        .getByText("p1000")
        .waitFor();
      await toggleRow(page, /^pages\.example/);
      await pagesHost.waitFor({ state: "detached" });

      // A page with 1,003 requests lists two ranges; the last one holds requests 1000 to 1002.
      await toggleRow(page, /^big\.example/);
      await node(page, /^big\.example 1,003 requests, 1 page$/).waitFor();
      await toggleRow(page, /^Home/);
      const home = node(page, /^Home 1,003 requests$/);
      await home.getByText("[0…999]").waitFor();
      await home.getByText("[1000…1002]").waitFor();
      await toggleRow(page, /^\[1000…1002\]/);
      const lastRequests = node(page, /^\[1000…1002\] 3 requests$/);
      await lastRequests.getByText("GET /e/1002").waitFor();
      await toggleRow(page, /^GET \/e\/1002/);
      const request = node(page, /^GET \/e\/1002 \{\} 3 keys$/);
      await request.getByText("response").waitFor();
    });
  }, 120_000);
});

describe("a HAR capture's first frame on the map", () => {
  it("shows the capture node from the start, never the raw log object", async () => {
    await withPage(async (page) => {
      const file = NodePath.join(scratch, "first-frame.har");
      NodeFS.writeFileSync(file, overflowingHar());
      // Every map card name that was ever on screen, from before the drop.
      await page.evaluate(() => {
        const seen = new Set<string>();
        Object.assign(window, { seenCards: seen });
        new MutationObserver(() => {
          for (const card of document.querySelectorAll("[role=treeitem]")) {
            seen.add(card.getAttribute("aria-label") ?? "");
          }
        }).observe(document.body, { subtree: true, childList: true, attributes: true });
      });
      await dropFile(page, file);
      await node(page, /^Capture 3,004 requests, 1,002 hosts$/).waitFor();
      const seen = await page.evaluate(() =>
        Array.from((window as unknown as { seenCards: Set<string> }).seenCards),
      );
      expect(seen.filter((name) => /^(root|log)\b/.test(name))).toEqual([]);
      expect(seen.filter((name) => name.startsWith("Capture"))).not.toEqual([]);
    });
  });
});

describe("framing a capture once it is grouped", () => {
  it("frames a capture taller than the screen from its top, not where its placeholder was", async () => {
    await withPage(async (page) => {
      // 60 hosts of one request: one page of entries, and a capture card taller than the canvas.
      const entries = Array.from({ length: 60 }, (_, h) => ({
        pageref: "page_1",
        request: { method: "GET", url: `https://host-${h}.example/r`, headers: [] },
        response: { status: 200, content: { mimeType: "text/plain", text: "ok" } },
      }));
      const file = NodePath.join(scratch, "tall.har");
      NodeFS.writeFileSync(
        file,
        JSON.stringify({
          log: { version: "1.2", pages: [{ id: "page_1", title: "Home" }], entries },
        }),
      );
      await dropFile(page, file);
      const capture = node(page, /^Capture 60 requests, 60 hosts$/);
      await capture.waitFor();
      const [canvas, toolbar] = await Promise.all([
        page.getByLabel("Map canvas").boundingBox(),
        page.getByTestId("board-toolbar").boundingBox(),
      ]);
      // Its top just under the toolbar, on screen.
      await expect
        .poll(async () => {
          const at = await capture.boundingBox();
          return (
            at !== null &&
            at.y >= toolbar!.y + toolbar!.height &&
            at.y < toolbar!.y + toolbar!.height + 60 &&
            at.x >= canvas!.x
          );
        })
        .toBe(true);
    });
  });
});
