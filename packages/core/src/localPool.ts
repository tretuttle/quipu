/**
 * An in-process pool: each "worker" is its own job runner with its own buffers,
 * answering asynchronously on the same thread. Tests drive the real coordinator
 * protocol through it without spawning threads; nothing in the product uses it.
 */
import { createJobRunner } from "./jobs.ts";
import { Pool, type WorkerLike } from "./pool.ts";
import type { Reply, Request } from "./protocol.ts";
import { openSource } from "./source.ts";

export const createLocalPool = (count: number) => {
  const workers: WorkerLike[] = [];
  for (let i = 0; i < count; i++) {
    const run = createJobRunner({ openSource });
    let handler: ((reply: Reply) => void) | undefined;
    let queue = Promise.resolve();
    workers.push({
      postMessage: (message: Request) => {
        // One job at a time per worker, in call order, replies delivered asynchronously.
        queue = queue.then(async () => {
          let reply: Reply;
          try {
            const outcome = await run(message.job);
            reply = { id: message.id, ok: true, result: outcome.result };
          } catch (error) {
            reply = {
              id: message.id,
              ok: false,
              error: error instanceof Error ? (error.stack ?? error.message) : `${error as string}`,
            };
          }
          handler?.(reply);
        });
      },
      onMessage: (h) => {
        handler = h;
      },
      terminate: () => {},
    });
  }
  return new Pool(workers);
};
