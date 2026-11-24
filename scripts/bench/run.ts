// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - a CLI that builds, serves and drives Chromium; the memory sampler yields to a timer between CDP readings.
/**
 * The engine bench, in Chromium through playwright-core:
 * `vp run bench [-- --runs 5 --headed --out bench/results/chromium.json]`.
 *
 * It refuses undersized or ungenerated fixtures, verifies their contents, builds the
 * web app with the bench page, serves dist through `vp preview` (COOP/COEP from
 * the app config), hands the fixtures to the page through its file input, and
 * times every row inside the page with performance.now() around the engine
 * request. Memory is CDP Runtime.getHeapUsage over the page and every worker,
 * sampled every 50 ms. The whole run sits inside the memory guard
 * (scripts/lib/memoryGuard.ts), which the browser inherits. One warm-up
 * iteration is discarded. The result file is local output (bench/results/ is
 * ignored by git); `vp run bench:table` prints it again.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { type BrowserContext, chromium } from "playwright-core";
import { preview } from "vite";

import { requireFixture, type RequiredFixture } from "../fixtures/fixtures.ts";
import { verifyFixture } from "../fixtures/verify.ts";
import { ensureMemoryGuard, memoryGuardCommand } from "../lib/memoryGuard.ts";
import { CdpMemory } from "./cdpMemory.ts";
import { cgroupAnonBytes, machineRecord } from "./machine.ts";
import { type BenchFile, type BenchRow, encodeBenchFile, summarize } from "./schema.ts";
import { renderHeader, renderTable } from "./table.ts";

ensureMemoryGuard();

const { values } = NodeUtil.parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    har: { type: "string", default: "har-2g.har" },
    deep: { type: "string", default: "json-deep.json" },
    out: { type: "string", default: "bench/results/chromium.json" },
    headed: { type: "boolean", default: false },
    "skip-build": { type: "boolean", default: false },
  },
});
const runs = Number(values.runs);
const headed = values.headed;
const MiB = 1024 * 1024;
const SEARCH_NEEDLE = "application/json";
const BODY_HEAD_BYTES = 64 * 1024;
const NESTED_MAX_BYTES = 64 * MiB;
/** Row 7 edits this value of the HAR; row 8 writes the pretty-printed document to this OPFS file. */
const EDIT_PATH = ["log", "version"] as const;
const EDIT_JSON = '"1.2-quipu"';
const EDIT_AFTER_TRANSFORM_JSON = '"1.3-quipu"';
const SAVE_FILE = "bench-save.har";
const SAVE_INDENT = 2;
const SAVE_MEMORY_BUDGET = 2e8;

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const webRoot = NodePath.join(repoRoot, "apps", "web");
const out = (line: string) => process.stdout.write(`${line}\n`);

// 1. Fixtures: present, at least their stated size, written by the generator, and to spec.
const fixtures = { har: requireFixture(values.har), deep: requireFixture(values.deep) };
for (const fixture of Object.values(fixtures)) {
  const verification = verifyFixture(fixture);
  out(verification.lines.join("\n"));
  if (!verification.ok) throw new Error(`${fixture.fixture.name} does not meet its spec`);
}

// 2. The production build with the bench page, served by preview with the app's isolation headers.
if (!values["skip-build"]) {
  const build = NodeChildProcess.spawnSync("vp build", {
    cwd: webRoot,
    shell: true,
    stdio: "inherit",
    env: { ...process.env, QUIPU_BENCH: "1" },
  });
  if (build.status !== 0) throw new Error("vp build failed");
}
const server = await preview({
  configFile: NodePath.join(webRoot, "vite.config.ts"),
  root: webRoot,
  logLevel: "silent",
  // Port 0: the OS picks a free port, so two benches (or a bench and the e2e suite) never collide.
  preview: { port: 0, host: "127.0.0.1" },
});
const previewUrl = server.resolvedUrls?.local[0]?.replace(/\/$/, "");
if (previewUrl === undefined) throw new Error("the preview server did not report its address");

interface OpenReport {
  readonly documentId: number;
  readonly size: number;
  readonly firstPaintMs: number;
  readonly indexMs: number;
  readonly tokens: number;
  readonly regions: number;
  readonly crossOriginIsolated: boolean;
  readonly workers: number;
}

interface Bench {
  open(name: string): Promise<OpenReport>;
  search(documentId: number, needle: string): Promise<{ ms: number; count: number }>;
  bodyHead(
    documentId: number,
    decodedBytes: number,
  ): Promise<{ ms: number; bytes: number; bodyChars: number }>;
  expandNested(
    documentId: number,
    maxBytes: number,
  ): Promise<{
    ms: number;
    escapedBytes: number;
    rawBytes: number;
    rootKind: string;
    rootChildren: number;
  }>;
  edit(
    documentId: number,
    path: ReadonlyArray<string>,
    json: string,
  ): Promise<{ ms: number; text: string; kind: string; size: number; undoDepth: number }>;
  editAfterTransform(
    documentId: number,
    path: ReadonlyArray<string>,
    json: string,
  ): Promise<{ ms: number; sortMs: number; text: string; kind: string; size: number }>;
  save(
    documentId: number,
    indent: number | null,
    fileName: string,
  ): Promise<{
    ms: number;
    bytes: number;
    fileBytes: number;
    head: number[];
    tail: number[];
    mibPerSecond: number;
  }>;
  close(documentId: number): Promise<null>;
}
declare global {
  var quipuBench: Bench;
}

const memorySampler = (cdp: CdpMemory) => {
  let peakJs = 0;
  let peakProcess = 0;
  let targets = 0;
  let samples = 0;
  const state = { stop: false };
  const take = async () => {
    const usage = await cdp.sample();
    samples++;
    peakJs = Math.max(peakJs, usage.heapBytes + usage.backingStoreBytes);
    targets = Math.max(targets, usage.targets);
    peakProcess = Math.max(peakProcess, cgroupAnonBytes());
  };
  const loop = (async () => {
    while (!state.stop) {
      // A real yield between samples; an instantly resolving loop would starve the page's messages.
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!state.stop) await take();
    }
  })();
  return {
    stop: async () => {
      state.stop = true;
      await loop;
      await take();
      return { peakJs, peakProcess, targets, samples };
    },
  };
};

/** The DevTools port Chromium chose: the first line of DevToolsActivePort in its profile. */
const devToolsPort = (profile: string) => {
  const file = NodePath.join(profile, "DevToolsActivePort");
  const port = Number(NodeFS.readFileSync(file, "utf8").split("\n")[0]);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`no DevTools port in ${file}`);
  return port;
};

const openPage = async (browser: BrowserContext, fixture: RequiredFixture) => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${previewUrl}/bench/`);
  const isolated = await page.evaluate(
    () => (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
  );
  if (!isolated) throw new Error("the bench page is not cross-origin isolated");
  await page.setInputFiles("#files", [fixture.path]);
  return { page, errors };
};

interface HarSample {
  readonly firstPaintMs: number;
  readonly indexMs: number;
  readonly peakJs: number;
  readonly peakProcess: number;
  readonly targets: number;
  readonly searchMs: number;
  readonly searchHits: number;
  readonly bodyHeadMs: number;
  readonly bodyChars: number;
  readonly expandMs: number;
  readonly expandEscapedBytes: number;
  readonly editMs: number;
  readonly editAfterTransformMs: number;
  readonly saveMs: number;
  readonly saveBytes: number;
  readonly saveMiBPerSecond: number;
  readonly saveMemoryGrowth: number;
  readonly tokens: number;
  readonly regions: number;
  readonly workers: number;
}

const harRun = async (browser: BrowserContext, cdp: CdpMemory): Promise<HarSample> => {
  const { page, errors } = await openPage(browser, fixtures.har);
  try {
    const name = fixtures.har.fixture.name;
    const sampler = memorySampler(cdp);
    const opened = await page.evaluate((n) => quipuBench.open(n), name);
    const memory = await sampler.stop();
    if (!opened.crossOriginIsolated)
      throw new Error("the engine worker is not cross-origin isolated");
    const search = await page.evaluate(([id, needle]) => quipuBench.search(id, needle), [
      opened.documentId,
      SEARCH_NEEDLE,
    ] as const);
    const head = await page.evaluate(([id, bytes]) => quipuBench.bodyHead(id, bytes), [
      opened.documentId,
      BODY_HEAD_BYTES,
    ] as const);
    if (head.bytes !== BODY_HEAD_BYTES) throw new Error(`body head returned ${head.bytes} bytes`);
    if (
      fixtures.har.fixture.shape === "har" &&
      head.bodyChars < fixtures.har.fixture.bigBodyChars
    ) {
      throw new Error(
        `the biggest string holds ${head.bodyChars} chars, below the fixture's ${fixtures.har.fixture.bigBodyChars}`,
      );
    }
    const expand = await page.evaluate(([id, max]) => quipuBench.expandNested(id, max), [
      opened.documentId,
      NESTED_MAX_BYTES,
    ] as const);
    if (expand.rootKind !== "object" || expand.rootChildren === 0)
      throw new Error("the nested body did not expand to an object");
    // Row 7: one value edited, answered by the re-indexed tape.
    const edit = await page.evaluate(([id, path, json]) => quipuBench.edit(id, path, json), [
      opened.documentId,
      EDIT_PATH,
      EDIT_JSON,
    ] as const);
    if (edit.text !== JSON.parse(EDIT_JSON))
      throw new Error(`the edited value reads back as ${edit.text}`);
    // Row 8: the pretty-printed save, with memory growth over the sample taken just before it.
    const baseline = await cdp.sample();
    const saveSampler = memorySampler(cdp);
    const save = await page.evaluate(([id, indent, file]) => quipuBench.save(id, indent, file), [
      opened.documentId,
      SAVE_INDENT,
      SAVE_FILE,
    ] as const);
    const saveMemory = await saveSampler.stop();
    if (save.fileBytes !== save.bytes)
      throw new Error(`the save wrote ${save.fileBytes} bytes of ${save.bytes}`);
    if (save.fileBytes < fixtures.har.size)
      throw new Error("the pretty-printed save is smaller than the file");
    const headText = Buffer.from(save.head).toString("latin1");
    const tailText = Buffer.from(save.tail).toString("latin1");
    if (!headText.startsWith('{\n  "log"') || !tailText.trimEnd().endsWith("}")) {
      throw new Error(
        `the saved file does not start and end like the document: ${JSON.stringify([headText, tailText])}`,
      );
    }
    // Row 7 again, after a whole-document transform: the edit must stay member-sized.
    const editAfterTransform = await page.evaluate(
      ([id, path, json]) => quipuBench.editAfterTransform(id, path, json),
      [opened.documentId, EDIT_PATH, EDIT_AFTER_TRANSFORM_JSON] as const,
    );
    if (editAfterTransform.text !== JSON.parse(EDIT_AFTER_TRANSFORM_JSON)) {
      throw new Error(`the value edited after the sort reads back as ${editAfterTransform.text}`);
    }
    if (editAfterTransform.kind !== "string")
      throw new Error(`the edit after the sort answered a ${editAfterTransform.kind}`);
    await page.evaluate((id) => quipuBench.close(id), opened.documentId);
    if (errors.length > 0) throw new Error(`page errors: ${errors.join("; ")}`);
    return {
      firstPaintMs: opened.firstPaintMs,
      indexMs: opened.indexMs,
      peakJs: memory.peakJs,
      peakProcess: memory.peakProcess,
      targets: memory.targets,
      searchMs: search.ms,
      searchHits: search.count,
      bodyHeadMs: head.ms,
      bodyChars: head.bodyChars,
      expandMs: expand.ms,
      expandEscapedBytes: expand.escapedBytes,
      editMs: edit.ms,
      editAfterTransformMs: editAfterTransform.ms,
      saveMs: save.ms,
      saveBytes: save.fileBytes,
      saveMiBPerSecond: save.mibPerSecond,
      saveMemoryGrowth: saveMemory.peakJs - (baseline.heapBytes + baseline.backingStoreBytes),
      tokens: opened.tokens,
      regions: opened.regions,
      workers: opened.workers,
    };
  } finally {
    await page.close();
  }
};

const deepRun = async (browser: BrowserContext) => {
  const { page, errors } = await openPage(browser, fixtures.deep);
  try {
    const opened = await page.evaluate((n) => quipuBench.open(n), fixtures.deep.fixture.name);
    await page.evaluate((id) => quipuBench.close(id), opened.documentId);
    const rangeError = errors.find((e) => e.includes("RangeError"));
    return {
      indexMs: opened.indexMs,
      tokens: opened.tokens,
      invalid: rangeError
        ? `RangeError in the page: ${rangeError}`
        : errors[0]
          ? `page error: ${errors[0]}`
          : null,
    };
  } finally {
    await page.close();
  }
};

// A persistent profile: the default context is incognito-like and its OPFS quota is far
// below the 2 GiB the save row writes (the quota error was "exceed its storage quota").
// The profile lives in a temp directory and is removed when the run ends.
const profileDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-bench-profile-"));
const browser = await chromium.launchPersistentContext(profileDir, {
  channel: "chromium",
  headless: !headed,
  // Port 0: Chromium picks a free one and writes it to DevToolsActivePort in the profile.
  args: ["--remote-debugging-port=0"],
});
const browserVersion = browser.browser()?.version() ?? "unknown";
const cdp = await CdpMemory.connect(devToolsPort(profileDir));
const harSamples: HarSample[] = [];
const deepSamples: Array<{ indexMs: number; tokens: number; invalid: string | null }> = [];
try {
  out(
    `Chromium ${browserVersion} ${headed ? "headed" : "headless"}; guard: ${memoryGuardCommand(["…"]).slice(0, -2).join(" ")}`,
  );
  for (let run = -1; run < runs; run++) {
    const label = run < 0 ? "warm-up" : `run ${run + 1}/${runs}`;
    const har = await harRun(browser, cdp);
    out(
      `${label}: first paint ${har.firstPaintMs.toFixed(0)} ms, index ${har.indexMs.toFixed(0)} ms (${har.tokens} tokens, ${har.regions} regions, ${har.workers} workers, ${har.targets} targets sampled), peak ${(har.peakJs / 1e6).toFixed(0)} MB js / ${(har.peakProcess / 1e6).toFixed(0)} MB process, search ${har.searchMs.toFixed(0)} ms (${har.searchHits} hits), body head ${har.bodyHeadMs.toFixed(1)} ms, expand ${har.expandMs.toFixed(0)} ms (${(har.expandEscapedBytes / MiB).toFixed(1)} MiB), edit ${har.editMs.toFixed(1)} ms, edit after sort ${har.editAfterTransformMs.toFixed(1)} ms, save ${har.saveMs.toFixed(0)} ms (${har.saveMiBPerSecond.toFixed(0)} MiB/s, ${(har.saveBytes / MiB).toFixed(0)} MiB, +${(har.saveMemoryGrowth / 1e6).toFixed(0)} MB)`,
    );
    const deep = await deepRun(browser);
    out(
      `${label}: json-deep open ${deep.indexMs.toFixed(0)} ms (${deep.tokens} tokens)${deep.invalid ? `, INVALID: ${deep.invalid}` : ""}`,
    );
    if (run >= 0) {
      harSamples.push(har);
      deepSamples.push(deep);
    }
  }
} finally {
  cdp.close();
  await browser.close();
  NodeFS.rmSync(profileDir, { recursive: true, force: true });
  await new Promise<void>((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  );
}

const harName = fixtures.har.fixture.name.replace(/\.har$/, "");
const deepName = fixtures.deep.fixture.name.replace(/\.json$/, "");
const row = (
  base: Omit<BenchRow, "runs" | "median" | "p95" | "min" | "max" | "pass" | "invalid">,
  samples: ReadonlyArray<number>,
  invalid: string | null = null,
) => summarize(base, samples, invalid);
const harBase = {
  fixture: harName,
  fixtureBytes: fixtures.har.size,
  unit: "ms" as const,
  comparator: "lte" as const,
  statistic: "median" as const,
};
const results: BenchRow[] = [
  row(
    {
      ...harBase,
      measure: "first-map-paint",
      row: 1,
      title: "First map paint (engine proxy: root on the tape)",
      budget: 1000,
    },
    harSamples.map((s) => s.firstPaintMs),
  ),
  row(
    {
      ...harBase,
      measure: "full-structural-index",
      row: 2,
      title: "Full structural index",
      budget: 4000,
    },
    harSamples.map((s) => s.indexMs),
  ),
  row(
    {
      ...harBase,
      measure: "peak-memory",
      row: 3,
      title: "Peak memory (JS heap + ArrayBuffers, every worker)",
      budget: 1.5e9,
      unit: "bytes",
      statistic: "max",
    },
    harSamples.map((s) => s.peakJs),
  ),
  row(
    {
      ...harBase,
      measure: "literal-search",
      row: 4,
      title: `Literal search "${SEARCH_NEEDLE}", all hits counted`,
      budget: 2000,
    },
    harSamples.map((s) => s.searchMs),
  ),
  row(
    {
      ...harBase,
      measure: "big-body-first-screen",
      row: 5,
      title: "600 MiB body, first 64 KiB decoded",
      budget: 300,
    },
    harSamples.map((s) => s.bodyHeadMs),
  ),
  row(
    {
      ...harBase,
      measure: "expand-nested-body",
      row: 6,
      title: "Expand a nested stringified body (≤ 64 MiB)",
      budget: 200,
    },
    harSamples.map((s) => s.expandMs),
  ),
  row(
    {
      ...harBase,
      measure: "edit-value",
      row: 7,
      title: `Edit ${EDIT_PATH.join(".")} until the re-indexed tape answers it (engine half)`,
      budget: 100,
    },
    harSamples.map((s) => s.editMs),
  ),
  row(
    {
      ...harBase,
      measure: "edit-after-transform",
      row: 7,
      title: `Edit ${EDIT_PATH.join(".")} after sorting the root's keys (engine half)`,
      budget: 100,
    },
    harSamples.map((s) => s.editAfterTransformMs),
  ),
  row(
    {
      ...harBase,
      measure: "save-throughput",
      row: 8,
      title: "Save, pretty-printed and streamed to OPFS",
      budget: 200,
      unit: "MiB/s",
      comparator: "gte",
    },
    harSamples.map((s) => s.saveMiBPerSecond),
  ),
  row(
    {
      ...harBase,
      measure: "save-memory-growth",
      row: 8,
      title: "Save: peak memory growth over the pre-save sample",
      budget: SAVE_MEMORY_BUDGET,
      unit: "bytes",
      statistic: "max",
    },
    harSamples.map((s) => s.saveMemoryGrowth),
  ),
  row(
    {
      ...harBase,
      fixture: deepName,
      fixtureBytes: fixtures.deep.size,
      measure: "open-json-deep",
      row: 9,
      title: "Open json-deep (100 k levels, no stack overflow)",
      budget: 1000,
    },
    deepSamples.map((s) => s.indexMs),
    deepSamples.find((s) => s.invalid !== null)?.invalid ?? null,
  ),
];
const first = harSamples[0] as HarSample;
const file: BenchFile = {
  version: 1,
  surface: "chromium",
  browser: browserVersion,
  headless: !headed,
  guard: memoryGuardCommand(["node", "scripts/bench/run.ts"]).join(" "),
  machine: machineRecord(),
  workers: first.workers,
  results,
  diagnostics: {
    playwrightCore: "1.60.0",
    tokens: first.tokens,
    regions: first.regions,
    targetsSampled: harSamples.map((s) => s.targets),
    searchHits: first.searchHits,
    bodyChars: first.bodyChars,
    expandEscapedBytes: first.expandEscapedBytes,
    saveBytes: first.saveBytes,
    saveMs: harSamples.map((s) => s.saveMs),
    peakProcessBytes: harSamples.map((s) => s.peakProcess),
    deepTokens: deepSamples[0]?.tokens ?? 0,
  },
};
const outPath = NodePath.resolve(repoRoot, values.out);
NodeFS.mkdirSync(NodePath.dirname(outPath), { recursive: true });
NodeFS.writeFileSync(outPath, `${JSON.stringify(encodeBenchFile(file), null, 2)}\n`);
out(
  `\n${renderHeader(file)}\n\n${renderTable(file)}\n\nwrote ${NodePath.relative(repoRoot, outPath)}`,
);
if (results.some((r) => !r.pass)) {
  out("bench: FAIL");
  process.exitCode = 1;
} else out("bench: PASS");
