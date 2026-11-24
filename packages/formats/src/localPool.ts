/**
 * An in-process pool: each "worker" is its own job runner with its own buffers,
 * answering asynchronously on the same thread. Tests drive the real coordinator
 * protocol through it without spawning threads; nothing in the product uses it.
 */
import { openSource } from "@quipu/core/source";

import { createFormatJobRunner, type FormatJob, type FormatJobResult, toFailure } from "./jobs.ts";
import { FormatPool, type WorkerLike } from "./pool.ts";

export const createLocalFormatPool = (count: number) => {
  const workers: WorkerLike<FormatJob, FormatJobResult>[] = [];
  for (let i = 0; i < count; i++) {
    const run = createFormatJobRunner({ openSource });
    let handler: Parameters<WorkerLike<FormatJob, FormatJobResult>["onMessage"]>[0] | undefined;
    let queue = Promise.resolve();
    workers.push({
      postMessage: (message) => {
        // One job at a time per worker, in call order, replies delivered asynchronously.
        queue = queue.then(async () => {
          try {
            const outcome = await run(message.job);
            handler?.({ id: message.id, ok: true, result: outcome.result });
          } catch (error) {
            handler?.({ id: message.id, ok: false, error: toFailure(error) });
          }
        });
      },
      onMessage: (h) => {
        handler = h;
      },
      terminate: () => {},
    });
  }
  return new FormatPool<FormatJob, FormatJobResult>(workers);
};
