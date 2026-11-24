// One of the engine's format workers: region jobs of a streamed conversion
// (JSON to YAML, TOML, CSV, TSV, NDJSON), driven by engine.worker.ts through
// @quipu/formats' pool.
import { createFormatJobRunner, type FormatJob, toFailure } from "@quipu/formats/jobs";
import { openSource } from "@quipu/core/source";

const run = createFormatJobRunner({ openSource });

self.addEventListener(
  "message",
  async (event: MessageEvent<{ readonly id: number; readonly job: FormatJob }>) => {
    const { id, job } = event.data;
    try {
      const outcome = await run(job);
      self.postMessage({ id, ok: true, result: outcome.result }, { transfer: outcome.transfer });
    } catch (error) {
      self.postMessage({ id, ok: false, error: toFailure(error) }, { transfer: [] });
    }
  },
);
