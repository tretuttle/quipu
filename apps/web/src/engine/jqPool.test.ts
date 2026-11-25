import { JQ_OUTPUT_LIMIT_BYTES } from "@quipu/contracts/engine";
import { raw } from "jq-wasm";
import { describe, expect, it } from "vite-plus/test";

import type { JqRunReply, JqRunRequest } from "./jq.worker.ts";
import { cleanJqMessage } from "./jqMessage.ts";
import { createJqPool, JQ_POOL_MAX_WORKERS, type JqWorkerLike } from "./jqPool.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function makeFakeWorkerFactory(
  handler: (req: JqRunRequest, workerIndex: number) => Promise<Omit<JqRunReply, "id">> | null,
) {
  let spawned = 0;
  let terminated = 0;
  const spawn = (): JqWorkerLike => {
    const idx = ++spawned;
    let onMsg: ((reply: JqRunReply) => void) | null = null;
    let killed = false;
    return {
      postMessage(req) {
        if (killed) return;
        const promise = handler(req, idx);
        if (promise === null) return; // Simulate hung worker.
        void promise.then((res) => {
          if (killed) return;
          onMsg?.({ ...(req.id === undefined ? {} : { id: req.id }), ...res });
        });
      },
      onMessage(cb) {
        onMsg = cb;
      },
      terminate() {
        killed = true;
        terminated++;
      },
    };
  };
  return { spawn, stats: () => ({ spawned, terminated }) };
}

describe("jqPool", () => {
  it("caps worker concurrency at N = 4 and schedules queued jobs", async () => {
    let inFlight = 0;
    let peak = 0;
    const factory = makeFakeWorkerFactory(async (req) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return {
        status: "ok",
        output: `${decoder.decode(new Uint8Array(req.input))}\n`,
        truncated: false,
        message: "",
      };
    });

    const pool = createJqPool({ size: 8, spawn: factory.spawn });
    expect(pool.size).toBe(JQ_POOL_MAX_WORKERS);

    const inputs = Array.from({ length: 12 }, (_, i) => encoder.encode(`{"i":${i}}`));
    const outcomes = await Promise.all(
      inputs.map((buf) => pool.run(buf, ".", 1000, JQ_OUTPUT_LIMIT_BYTES)),
    );

    expect(peak).toBe(JQ_POOL_MAX_WORKERS);
    expect(factory.stats().spawned).toBe(JQ_POOL_MAX_WORKERS);
    expect(outcomes.map((o) => o.output.trim())).toEqual(inputs.map((_, i) => `{"i":${i}}`));
    pool.terminate();
  });

  it("kills a timed-out worker and respawns a fresh one for subsequent jobs", async () => {
    let call = 0;
    const factory = makeFakeWorkerFactory((req) => {
      call++;
      if (call === 1) return null; // Hang on first call.
      return Promise.resolve({
        status: "ok",
        output: `${decoder.decode(new Uint8Array(req.input))}|${req.program}\n`,
        truncated: false,
        message: "",
      });
    });

    const pool = createJqPool({ size: 1, spawn: factory.spawn });
    const timedOut = await pool.run(encoder.encode("1"), "while(true; .)", 30);
    expect(timedOut.status).toBe("timeout");
    expect(timedOut.message).toContain("30 ms");
    expect(factory.stats().terminated).toBe(1);

    const recovered = await pool.run(encoder.encode("2"), ".+1", 1000);
    expect(recovered).toEqual({
      status: "ok",
      output: "2|.+1\n",
      truncated: false,
      message: "",
    });
    expect(factory.stats().spawned).toBe(2);
    pool.terminate();
  });

  it("runs real jq-wasm over multiple HAR entries via the pool", async () => {
    const factory = makeFakeWorkerFactory(async (req) => {
      const text = decoder.decode(new Uint8Array(req.input));
      const res = await raw(text, req.program);
      if (res.exitCode !== 0) {
        return {
          status: "error",
          output: "",
          truncated: false,
          message: cleanJqMessage(res.stderr.trim()),
        };
      }
      const truncated = res.stdout.length > req.outputLimit;
      return {
        status: "ok",
        output: truncated ? res.stdout.slice(0, req.outputLimit) : res.stdout,
        truncated,
        message: "",
      };
    });

    const pool = createJqPool({ size: 4, spawn: factory.spawn });
    const entries = [
      { request: { url: "https://a.test/1" }, response: { status: 200 } },
      { request: { url: "https://b.test/2" }, response: { status: 404 } },
      { request: { url: "https://c.test/3" }, response: { status: 500 } },
    ];
    const results = await Promise.all(
      entries.map((entry) =>
        pool.run(
          encoder.encode(JSON.stringify(entry)),
          "select(.response.status >= 400) | .request.url",
          5000,
        ),
      ),
    );
    expect(results.map((r) => r.output)).toEqual(["", '"https://b.test/2"', '"https://c.test/3"']);
    pool.terminate();
  });
});
