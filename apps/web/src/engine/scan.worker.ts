// One of the engine's scan workers: pass 1, pass 2, search, unescape and slice
// jobs over a File or a shared buffer, driven by engine.worker.ts.
import { createJobRunner } from "@quipu/core/jobs";
import type { Reply, Request } from "@quipu/core/protocol";
import { openSource } from "@quipu/core/source";

const run = createJobRunner({ openSource });

self.addEventListener("message", async (event: MessageEvent<Request>) => {
  const request = event.data;
  let reply: Reply;
  let transfer: ArrayBuffer[] = [];
  try {
    const outcome = await run(request.job);
    transfer = outcome.transfer;
    reply = { id: request.id, ok: true, result: outcome.result };
  } catch (error) {
    reply = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  }
  self.postMessage(reply, { transfer });
});
