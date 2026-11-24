/** Node worker thread entry for the conversion bench: one format job runner per thread, reading the file by path. */
import * as NodeWorkerThreads from "node:worker_threads";

import { createFormatJobRunner, toFailure } from "../src/jobs.ts";
import { openFileSource } from "./fileSource.ts";

const port = NodeWorkerThreads.parentPort;
if (!port) throw new Error("convertWorker must run as a worker thread");
const path = NodeWorkerThreads.workerData as string;
const run = createFormatJobRunner({ openSource: () => openFileSource(path) });
let queue = Promise.resolve();
port.on("message", (message: { id: number; job: Parameters<typeof run>[0] }) => {
  queue = queue.then(async () => {
    try {
      const outcome = await run(message.job);
      port.postMessage({ id: message.id, ok: true, result: outcome.result }, outcome.transfer);
    } catch (error) {
      port.postMessage({ id: message.id, ok: false, error: toFailure(error) });
    }
  });
});
