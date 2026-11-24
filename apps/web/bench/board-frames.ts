// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - a bench harness, run by node outside the app.
/**
 * Pan and zoom frame times for a board with 5,000 elements, headed, on the real
 * GPU. Measures the vsync interval as the median idle rAF delta, snaps every
 * gesture-frame delta to a multiple of it, and reports the nearest-rank p95 of the
 * snapped deltas. Passes when p95 <= 16.7 ms and the slowest gesture's p95 is at
 * most twice the fastest's.
 *
 *   systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0 -- node apps/web/bench/board-frames.ts
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite-plus";

import { createRng } from "@quipu/canvas/random";
import { DEFAULT_STYLE, type Element } from "@quipu/canvas/elements";
import { keysBetween } from "@quipu/canvas/fractionalIndex";
import { encodeDrawingJson, makeDrawingDocument } from "@quipu/canvas/persistence";

// Port 0 unless one is asked for: the OS picks a free port, so two benches never collide.
const PORT = Number(process.env.QUIPU_BENCH_PORT ?? 0);
const ELEMENT_COUNT = 5000;
const BUDGET_MS = 16.7;
const webRoot = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

function buildScene(): string {
  const rng = createRng(0x5e_ed);
  const keys = keysBetween(null, null, ELEMENT_COUNT);
  const types = ["rectangle", "ellipse", "diamond"] as const;
  const inks = ["default", "red", "blue", "green", "amber", "violet"] as const;
  const elements: Element[] = [];
  const columns = Math.ceil(Math.sqrt(ELEMENT_COUNT));
  for (let i = 0; i < ELEMENT_COUNT; i += 1) {
    const type = types[i % types.length] as (typeof types)[number];
    elements.push({
      id: `b${i}`,
      type,
      x: (i % columns) * 90,
      y: Math.floor(i / columns) * 70,
      width: 40 + Math.floor(rng.next() * 40),
      height: 30 + Math.floor(rng.next() * 30),
      angle: 0,
      index: keys[i] as string,
      seed: rng.nextSeed(),
      version: 0,
      isDeleted: false,
      locked: false,
      groupIds: [],
      frameId: null,
      style: {
        ...DEFAULT_STYLE,
        stroke: inks[i % inks.length] as (typeof inks)[number],
        fill: i % 4 === 0 ? "soft" : "none",
      },
    });
  }
  return encodeDrawingJson(makeDrawingDocument(elements));
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] as number;
}

const server = await createServer({
  configFile: NodePath.join(webRoot, "vite.config.ts"),
  logLevel: "warn",
  server: { host: "127.0.0.1", port: PORT, strictPort: true },
});
await server.listen();
const address = server.httpServer?.address();
if (address === null || address === undefined || typeof address === "string")
  throw new Error("the bench server did not report a TCP address");
const baseUrl = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: false });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New board" }).click();
  await page.getByRole("application", { name: "Board canvas" }).waitFor();
  await page.getByTestId("board-save-status").getByText("Saved").waitFor();
  const boardId = page.url().split("/boards/")[1] as string;

  // Write the scene straight into the drawings store, then reload through the real load path.
  await page.evaluate(
    ([id, json]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("quipu", 1);
        open.addEventListener("success", () => {
          const transaction = open.result.transaction("drawings", "readwrite");
          transaction.objectStore("drawings").put({
            schemaVersion: 1,
            documentId: id,
            updatedAt: Date.now(),
            sceneSchemaVersion: 1,
            sceneJson: json,
          });
          transaction.addEventListener("complete", () => resolve());
          transaction.addEventListener("abort", () => reject(transaction.error));
        });
        open.addEventListener("error", () => reject(open.error));
      }),
    [decodeURIComponent(boardId), buildScene()] as const,
  );
  await page.reload();
  const canvas = page.getByRole("application", { name: "Board canvas" });
  await canvas.waitFor();
  await page.waitForFunction(
    (count) => document.querySelectorAll("[data-element-id]").length >= count,
    Math.min(ELEMENT_COUNT, 200),
  );
  await canvas.click({ position: { x: 10, y: 10 } });
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(500);

  const gpu = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
  });

  // Vsync interval: the median rAF delta while idle.
  const vsync = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const deltas: number[] = [];
        let last = performance.now();
        const tick = (now: number) => {
          deltas.push(now - last);
          last = now;
          if (deltas.length < 120) requestAnimationFrame(tick);
          else {
            const sorted = deltas.slice(5).sort((a, b) => a - b);
            resolve(sorted[Math.floor(sorted.length / 2)] as number);
          }
        };
        requestAnimationFrame(tick);
      }),
  );

  const startRecording = () =>
    page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __stop: boolean };
      w.__frames = [];
      w.__stop = false;
      let last = performance.now();
      const tick = (now: number) => {
        w.__frames.push(now - last);
        last = now;
        if (!w.__stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  const stopRecording = () =>
    page.evaluate(() => {
      const w = window as unknown as { __frames: number[]; __stop: boolean };
      w.__stop = true;
      return w.__frames;
    });

  const host = await canvas.boundingBox();
  if (!host) throw new Error("no canvas box");
  const gestures: number[][] = [];
  for (let g = 0; g < 5; g += 1) {
    await startRecording();
    const startedAt = Date.now();
    // Pan: a 1.2 s drag across the viewport, one move per frame.
    await page.mouse.move(host.x + 200, host.y + 450);
    await page.keyboard.down("Space");
    await page.mouse.down();
    for (let i = 0; i < 70; i += 1) {
      await page.mouse.move(
        host.x + 200 + i * 12 * (g % 2 === 0 ? 1 : -1),
        host.y + 450 + Math.sin(i / 8) * 60,
      );
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.keyboard.up("Space");
    // Zoom: wheel with ctrl about the pointer, in and then out.
    for (let i = 0; i < 25; i += 1) {
      await page.mouse.wheel(0, -60);
      await page.waitForTimeout(16);
    }
    for (let i = 0; i < 25; i += 1) {
      await page.mouse.wheel(0, 60);
      await page.waitForTimeout(16);
    }
    const frames = await stopRecording();
    const elapsed = Date.now() - startedAt;
    // Drop the first 500 ms of each gesture.
    const skip = Math.round((500 / elapsed) * frames.length);
    gestures.push(frames.slice(skip));
  }

  const snap = (delta: number) => Math.max(1, Math.round(delta / vsync)) * vsync;
  const perGesture = gestures.map((frames) => percentile(frames.map(snap), 95));
  const pooled = gestures.flat().map(snap);
  const p95 = percentile(pooled, 95);
  const rawP95 = percentile(gestures.flat(), 95);
  const spread = Math.max(...perGesture) / Math.min(...perGesture);
  const result = {
    version: 1,
    surface: "chromium",
    gpu,
    elements: ELEMENT_COUNT,
    vsyncMs: Number(vsync.toFixed(3)),
    frames: pooled.length,
    rawP95Ms: Number(rawP95.toFixed(2)),
    snappedP95Ms: Number(p95.toFixed(2)),
    perGestureSnappedP95Ms: perGesture.map((v) => Number(v.toFixed(2))),
    gestureSpread: Number(spread.toFixed(2)),
    budgetMs: BUDGET_MS,
    pass: p95 <= BUDGET_MS && spread <= 2,
  };
  const outDir = NodePath.join(webRoot, "bench", "out");
  NodeFS.mkdirSync(outDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(outDir, "board-frames.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result));
  if (!result.pass) process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
