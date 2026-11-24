/**
 * Structural index of NDJSON, CSV/TSV or XML through worker threads, at fixture
 * scale. Run it with a memory cap, for example:
 *   systemd-run --user --scope --quiet -p MemoryMax=8G -p MemorySwapMax=0 -- \
 *     node packages/formats/bench/index.ts <ndjson|csv|tsv|xml> <file> [workers]
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeWorkerThreads from "node:worker_threads";

import { indexLineDocument } from "../src/indexLines.ts";
import { indexXmlDocument } from "../src/indexXml.ts";
import type { FormatJob, FormatJobResult } from "../src/jobs.ts";
import { FormatPool, type WorkerLike } from "../src/pool.ts";

const [kind = "ndjson", input, workersArg = "16"] = process.argv.slice(2);
if (!input) throw new Error("usage: index.ts <ndjson|csv|tsv|xml> <file> [workers]");
const workers = Number(workersArg);
const size = NodeFS.statSync(input).size;
const workerUrl = new URL("./convertWorker.ts", import.meta.url);
const like: WorkerLike<FormatJob, FormatJobResult>[] = [];
for (let i = 0; i < workers; i++) {
  const thread = new NodeWorkerThreads.Worker(NodeURL.fileURLToPath(workerUrl), {
    workerData: input,
  });
  like.push({
    postMessage: (message, transfer = []) => thread.postMessage(message, transfer),
    onMessage: (handler) => thread.on("message", handler),
    terminate: () => void thread.terminate(),
  });
}
const pool = new FormatPool(like);
const spec = { kind: "memory" as const, buffer: new ArrayBuffer(0), byteOffset: 0, byteLength: 0 };
const started = performance.now();
let summary: string;
if (kind === "xml") {
  const r = await indexXmlDocument(pool, { spec, size });
  summary = `tokens ${r.tape.count}, maxLevel ${r.maxLevel}, root children ${r.tape.childCount(1 < r.tape.count ? 1 : 0)}`;
} else {
  const r = await indexLineDocument(
    pool,
    { spec, size },
    { kind: kind === "ndjson" ? "ndjson" : "csv", delimiter: kind === "tsv" ? 9 : 0x2c },
  );
  summary = `tokens ${r.tape.count}, rows ${r.rows}, depth ${r.depth}, anchors ${r.anchors.length / 2}`;
}
const seconds = (performance.now() - started) / 1000;
const mib = size / (1024 * 1024);
process.stdout.write(
  `${kind} ${NodePath.basename(input)} workers=${workers}: ${mib.toFixed(0)} MiB in ${seconds.toFixed(2)} s = ${(mib / seconds).toFixed(0)} MiB/s; ${summary}; rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB\n`,
);
await pool.terminate();
