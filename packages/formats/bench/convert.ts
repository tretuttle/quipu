/**
 * Streamed conversion throughput: JSON to YAML or CSV over a fixture, through a
 * pool of worker threads, output written to a file. Run it with a memory cap, for example:
 *   systemd-run --user --scope --quiet -p MemoryMax=8G -p MemorySwapMax=0 -- \
 *     node packages/formats/bench/convert.ts <yaml|toml|csv|tsv|ndjson> <input.json> [workers] [output]
 * Prints throughput and the process's peak resident set (all worker threads included).
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeWorkerThreads from "node:worker_threads";

import { convert } from "../src/convert.ts";
import type { ConvertFormat } from "../src/formatIds.ts";
import type { FormatJob, FormatJobResult } from "../src/jobs.ts";
import { FormatPool, type WorkerLike } from "../src/pool.ts";
import { openFileSource } from "./fileSource.ts";

const [target = "yaml", input, workersArg = "16", outputArg] = process.argv.slice(2);
if (!input)
  throw new Error("usage: convert.ts <yaml|toml|csv|tsv|ndjson> <input> [workers] [output]");
const workers = Number(workersArg);
const output = outputArg ?? NodePath.join(NodeOS.tmpdir(), `quipu-convert-${process.pid}.out`);

const workerUrl = new URL("./convertWorker.ts", import.meta.url);
const threads: NodeWorkerThreads.Worker[] = [];
const like: WorkerLike<FormatJob, FormatJobResult>[] = [];
for (let i = 0; i < workers; i++) {
  const thread = new NodeWorkerThreads.Worker(NodeURL.fileURLToPath(workerUrl), {
    workerData: input,
  });
  threads.push(thread);
  like.push({
    postMessage: (message, transfer = []) => thread.postMessage(message, transfer),
    onMessage: (handler) => thread.on("message", handler),
    terminate: () => void thread.terminate(),
  });
}
const pool = new FormatPool(like);
const size = NodeFS.statSync(input).size;
const fd = NodeFS.openSync(output, "w");
let written = 0;
const started = performance.now();
const stats = await convert(
  "json",
  target as ConvertFormat,
  {
    spec: { kind: "memory", buffer: new ArrayBuffer(0), byteOffset: 0, byteLength: 0 },
    size,
    source: openFileSource(input),
  },
  {
    pool,
    sink: {
      write: (chunk) => {
        NodeFS.writeSync(fd, chunk);
        written += chunk.length;
      },
    },
  },
);
const seconds = (performance.now() - started) / 1000;
NodeFS.closeSync(fd);
const mib = size / (1024 * 1024);
process.stdout.write(
  `${target} ${NodePath.basename(input)} workers=${workers}: ${mib.toFixed(0)} MiB in ${seconds.toFixed(2)} s = ${(mib / seconds).toFixed(0)} MiB/s; out ${(written / (1024 * 1024)).toFixed(0)} MiB, rows ${stats.rows}, regions ${stats.regions}, peak rss ${((process.resourceUsage().maxRSS * 1024) / 1e6).toFixed(0)} MB\n`,
);
if (outputArg === undefined) NodeFS.rmSync(output);
await pool.terminate();
