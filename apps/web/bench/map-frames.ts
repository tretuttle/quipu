// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - a bench harness, run by node outside the app.
/**
 * Pan and zoom frame times with 50 k nodes expanded on json-2g-wide, headed on the
 * real GPU, five gestures. The vsync interval is the median idle rAF delta; every
 * gesture-frame delta is snapped to a multiple of it, and the run passes when the
 * nearest-rank p95 of the snapped deltas is at most 16.7 ms. Run it in a memory
 * scope capped at 8 GiB with no swap:
 *
 *   cd apps/web && systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0 -- node bench/map-frames.ts
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { chromium, type Page } from "playwright-core";
import { createServer } from "vite-plus";

import { requireFixture } from "../../../scripts/fixtures/fixtures.ts";

// Port 0 unless one is asked for: the OS picks a free port, so two benches never collide.
const PORT = Number(process.env.QUIPU_BENCH_PORT ?? 0);
const FIXTURE = process.env.QUIPU_BENCH_FIXTURE ?? requireFixture("json-2g-wide.json").path;
const MIN_FIXTURE_BYTES = 2 * 1024 ** 3;
const TARGET_NODES = 50_000;
const BUDGET_MS = 16.7;
const RUNS = 5;
const webRoot = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] as number;
}

async function dropFile(page: Page, path: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: [path], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await cdp.send("Input.dispatchDragEvent", { type, x: 640, y: 400, data });
  }
  await cdp.detach();
}

/** The memory charged to this process's cgroup scope, split into anonymous and file-cache bytes. */
function scopeMemory(): string {
  try {
    const cgroup = NodeFS.readFileSync("/proc/self/cgroup", "utf8").trim().split(":").pop() ?? "";
    const root = `/sys/fs/cgroup${cgroup}`;
    const current = Number(NodeFS.readFileSync(`${root}/memory.current`, "utf8"));
    const stat = Object.fromEntries(
      NodeFS.readFileSync(`${root}/memory.stat`, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(" ") as [string, string]),
    );
    const mb = (bytes: number | string) => Math.round(Number(bytes) / 1e6);
    return `scope ${mb(current)} MB (anon ${mb(stat.anon ?? 0)} MB, file ${mb(stat.file ?? 0)} MB)`;
  } catch {
    return "scope memory unavailable";
  }
}

const fixtureBytes = NodeFS.statSync(FIXTURE).size;
if (fixtureBytes < MIN_FIXTURE_BYTES) {
  throw new Error(`${FIXTURE} is ${fixtureBytes} bytes; the bench needs at least 2 GiB`);
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
  const openedAt = Date.now();
  await dropFile(page, FIXTURE);
  const map = page.getByRole("tree", { name: "Document map" });
  await map.getByRole("treeitem", { name: /^root/ }).waitFor({ timeout: 30_000 });
  const firstPaintMs = Date.now() - openedAt;
  console.log(`first map paint ${firstPaintMs} ms`);
  await page.getByText("Indexing…").waitFor({ state: "detached", timeout: 120_000 });
  console.log(`indexed after ${Date.now() - openedAt} ms`);

  // Expand all, 5 000 containers per command, until 50 k nodes are open.
  const canvas = page.getByLabel("Map canvas");
  await canvas.click({ position: { x: 10, y: 10 } });
  const status = page.getByTestId("map-status");
  const nodeCount = async () => {
    const text = (await status.textContent()) ?? "";
    return Number(/([\d,]+) nodes?/.exec(text)?.[1]?.replaceAll(",", "") ?? 0);
  };
  const expandStartedAt = Date.now();
  let nodes = await nodeCount();
  while (nodes < TARGET_NODES) {
    const before = nodes;
    await page.keyboard.press("Control+Shift+ArrowRight");
    await page.waitForFunction(
      ([selector, previous]) => {
        const text = document.querySelector(selector)?.textContent ?? "";
        const now = Number(/([\d,]+) nodes?/.exec(text)?.[1]?.replaceAll(",", "") ?? 0);
        return now > previous;
      },
      ['[data-testid="map-status"]', before] as const,
      { timeout: 300_000 },
    );
    // The command keeps going until its limit; wait for the count to settle.
    let settled = await nodeCount();
    for (;;) {
      await page.waitForTimeout(500);
      const next = await nodeCount();
      if (next === settled) break;
      settled = next;
    }
    nodes = settled;
    const heap = await page.evaluate(() => {
      const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return memory ? Math.round(memory.usedJSHeapSize / 1e6) : -1;
    });
    console.log(
      `expanded to ${nodes} nodes after ${Date.now() - expandStartedAt} ms; page heap ${heap} MB; ${scopeMemory()}`,
    );
    if (nodes === before) throw new Error(`expand all stopped at ${nodes} nodes`);
  }
  const expandMs = Date.now() - expandStartedAt;
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(500);
  const detailAtFit = await page.locator("[data-map-view]").getAttribute("data-map-detail");
  const fitZoom = await page.evaluate(() => {
    const m = /scale\(([-\d.e]+)\)/.exec(
      document.querySelector('[data-testid="map-camera"]')?.getAttribute("transform") ?? "",
    );
    return m ? Number(m[1]) : null;
  });
  console.log(`fit: detail ${detailAtFit} at zoom ${fitZoom}`);

  const gpu = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
  });

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

  interface Recording {
    readonly frames: number[];
    /** The level of detail the map showed on each frame: full, marks or bitmap. */
    readonly details: string[];
    /** Nodes mounted on each frame (data-map-nodes). */
    readonly mounted: number[];
  }
  const startRecording = () =>
    page.evaluate(() => {
      const w = window as unknown as { __rec: Recording & { stop: boolean } };
      // The loop closes over its own record: stopping it must not leave it
      // ticking on the next gesture's record.
      const rec: Recording & { stop: boolean } = {
        frames: [],
        details: [],
        mounted: [],
        stop: false,
      };
      w.__rec = rec;
      let last = performance.now();
      const tick = (now: number) => {
        rec.frames.push(now - last);
        const group = document.querySelector("[data-map-view] [data-map-detail]");
        rec.details.push(group?.getAttribute("data-map-detail") ?? "");
        rec.mounted.push(Number(group?.getAttribute("data-map-nodes") ?? 0));
        last = now;
        if (!rec.stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  const stopRecording = () =>
    page.evaluate((): Recording => {
      const w = window as unknown as { __rec: Recording & { stop: boolean } };
      w.__rec.stop = true;
      return { frames: w.__rec.frames, details: w.__rec.details, mounted: w.__rec.mounted };
    });

  const host = await canvas.boundingBox();
  if (!host) throw new Error("no canvas box");
  const gestures: number[][] = [];
  const details = new Set<string>();
  /** Every recorded frame after the warm-up, with the detail it was painted at. */
  const byDetail = new Map<string, number[]>();
  let maxMounted = 0;
  for (let g = 0; g < RUNS; g += 1) {
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
    // Zoom: wheel with ctrl about the pointer, in and then out, through every level of detail.
    await page.keyboard.down("Control");
    for (let i = 0; i < 40; i += 1) {
      await page.mouse.wheel(0, -60);
      await page.waitForTimeout(16);
      details.add((await page.locator("[data-map-view]").getAttribute("data-map-detail")) ?? "");
    }
    for (let i = 0; i < 40; i += 1) {
      await page.mouse.wheel(0, 60);
      await page.waitForTimeout(16);
    }
    await page.keyboard.up("Control");
    const recording = await stopRecording();
    const frames = recording.frames;
    const elapsed = Date.now() - startedAt;
    console.log(`gesture ${g + 1}: ${frames.length} frames in ${elapsed} ms`);
    const skip = Math.round((500 / elapsed) * frames.length);
    gestures.push(frames.slice(skip));
    for (let i = skip; i < frames.length; i += 1) {
      const detail = recording.details[i] ?? "";
      const bucket = byDetail.get(detail) ?? [];
      bucket.push(frames[i] as number);
      byDetail.set(detail, bucket);
      maxMounted = Math.max(maxMounted, recording.mounted[i] ?? 0);
    }
  }

  const snap = (delta: number) => Math.max(1, Math.round(delta / vsync)) * vsync;
  const perGesture = gestures.map((frames) => percentile(frames.map(snap), 95));
  const pooled = gestures.flat().map(snap);
  const p95 = percentile(pooled, 95);
  const rawP95 = percentile(gestures.flat(), 95);
  const spread = Math.max(...perGesture) / Math.min(...perGesture);
  // The canvas fallback's own numbers: frames painted at each level of detail.
  const perDetail = Object.fromEntries(
    [...byDetail.entries()].map(([detail, frames]) => [
      detail,
      {
        frames: frames.length,
        rawP95Ms: Number(percentile(frames, 95).toFixed(2)),
        snappedP95Ms: Number(percentile(frames.map(snap), 95).toFixed(2)),
        maxMs: Number(Math.max(...frames).toFixed(2)),
      },
    ]),
  );
  const result = {
    version: 1,
    row: "Pan and zoom with 50 k nodes expanded",
    fixture: NodePath.basename(FIXTURE),
    fixtureBytes,
    surface: "chromium",
    gpu,
    nodes,
    firstPaintMs,
    expandMs,
    detailAtFit,
    fitZoom,
    maxMountedNodes: maxMounted,
    detailsSeen: [...details],
    perDetail,
    vsyncMs: Number(vsync.toFixed(3)),
    frames: pooled.length,
    rawP95Ms: Number(rawP95.toFixed(2)),
    snappedP95Ms: Number(p95.toFixed(2)),
    perGestureSnappedP95Ms: perGesture.map((v) => Number(v.toFixed(2))),
    gestureSpread: Number(spread.toFixed(2)),
    budgetMs: BUDGET_MS,
    pass: p95 <= BUDGET_MS,
  };
  const outDir = NodePath.join(webRoot, "bench", "out");
  NodeFS.mkdirSync(outDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(outDir, "map-frames.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result));
  if (!result.pass) process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
