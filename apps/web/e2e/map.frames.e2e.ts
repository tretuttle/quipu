// @effect-diagnostics nodeBuiltinImport:off - drives Chromium from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { dropFile, useBrowser } from "./harness";
import { mapNode as node, mapRowOf, toggleRowOf } from "./mapHarness";

const withPage = useBrowser();

let scratch = "";
beforeAll(() => {
  scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-map-frames-e2e-"));
});
afterAll(() => {
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

/** A capture with one WebSocket: two text frames sent and one binary frame received, as DevTools writes them. */
function webSocketHar(): string {
  return JSON.stringify({
    log: {
      version: "1.2",
      pages: [{ id: "page_1", title: "Market" }],
      entries: [
        {
          pageref: "page_1",
          request: { method: "GET", url: "wss://stream.example/ws", headers: [] },
          response: { status: 101, content: { mimeType: "x-unknown", text: "" } },
          _resourceType: "websocket",
          _webSocketMessages: [
            {
              type: "send",
              time: 1760000000.1,
              opcode: 1,
              data: '{"op": "subscribe", "channel": "ticker.0"}',
            },
            {
              type: "send",
              time: 1760000001.1,
              opcode: 1,
              data: '{"op": "subscribe", "channel": "ticker.1"}',
            },
            { type: "receive", time: 1760000010, opcode: 2, data: "AAFiaW5hcnlwYXlsb2Fk" },
          ],
        },
      ],
    },
  });
}

describe("WebSocket frames on the map", () => {
  it("reads each frame as the tree does: direction, kind, size and a preview", async () => {
    await withPage(async (page) => {
      const file = NodePath.join(scratch, "ws.har");
      NodeFS.writeFileSync(file, webSocketHar());
      await dropFile(page, file);
      const capture = node(page, /^Capture 1 request, 1 host$/);
      await toggleRowOf(page, capture, /^stream\.example/);
      await toggleRowOf(page, node(page, /^stream\.example/), /^Market/);
      await toggleRowOf(page, node(page, /^Market/), /^GET \/ws/);
      const entry = node(page, /^GET \/ws \{\}/);
      await toggleRowOf(page, entry, /^_webSocketMessages/);
      const frames = node(page, /^_webSocketMessages \[\] 3 items$/);
      const rows = async () =>
        (await mapRowOf(page, frames, /^0/))
          .locator("xpath=..")
          .locator("[data-map-row]")
          .allTextContents();
      await expect
        .poll(rows)
        .toEqual([
          expect.stringMatching(/^0: ↑ send · text · \d+ B · \{"op": "subscribe"/),
          expect.stringMatching(/^1: ↑ send · text · \d+ B · \{"op": "subscribe"/),
          expect.stringMatching(/^2: ↓ receive · binary .*· 15 B/),
        ]);
    });
  });
});
