// Named exemption to no-whole-document-materialization: JSON.parse is the reference parser for
// these differential and round-trip tests, and every input is a sample of a few KiB.
import { describe, expect, it } from "@effect/vitest";
import { parseJsonSlice, decodeUtf8 } from "@quipu/core/boundedSlice";
import { openSource } from "@quipu/core/source";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parse as parseCsv } from "csv-parse/sync";
import { parse as parseYaml } from "yaml";

import { convertJsonSource } from "./convertSource.ts";
import { UnrepresentableError } from "./errors.ts";
import { createFormatJobRunner, toFailure, type FormatJob, type FormatJobResult } from "./jobs.ts";
import { FormatPool, type WorkerLike } from "./pool.ts";
import { convertBytes } from "./testing/run.ts";

const utf8 = new TextEncoder();
const text = (b: Uint8Array) => decodeUtf8(b);
const enc = (s: string) => utf8.encode(s);

describe("JSON to YAML", () => {
  it("writes block YAML for nested documents", async () => {
    const out = await convertBytes(
      enc(
        '{"name":"quipu","tags":["a","b c"],"nest":{"x":1,"y":[{"k":true},[1,2],[]],"z":{}},"n":null}',
      ),
      "yaml",
    );
    expect(text(out)).toBe(
      [
        "name: quipu",
        "tags:",
        "  - a",
        "  - b c",
        "nest:",
        "  x: 1",
        '  "y":',
        "    - k: true",
        "    - - 1",
        "      - 2",
        "    - []",
        "  z: {}",
        '"n": null',
        "",
      ].join("\n"),
    );
  });

  it("quotes strings that would read back as something else", async () => {
    const out = await convertBytes(
      enc('["true","12","a: b","# c"," lead","x\\ny","null","yes",""]'),
      "yaml",
    );
    expect(parseYaml(text(out))).toEqual([
      "true",
      "12",
      "a: b",
      "# c",
      " lead",
      "x\ny",
      "null",
      "yes",
      "",
    ]);
  });

  it.effect.prop(
    "reads back as the same value, whatever the region size",
    [Arbitrary.schema(Schema.Json)],
    ([value]) =>
      Effect.promise(async () => {
        const bytes = enc(JSON.stringify(value));
        const whole = text(await convertBytes(bytes, "yaml", { regionBytes: 1 << 20 }));
        expect(JSON.parse(JSON.stringify(parseYaml(whole)))).toEqual(
          JSON.parse(JSON.stringify(value)),
        );
        for (const regionBytes of [1, 3, 7]) {
          const split = text(await convertBytes(bytes, "yaml", { regionBytes }));
          expect(split).toBe(whole);
        }
      }),
    { arbitrary: { runs: 150 } },
  );
});

describe("JSON to CSV", () => {
  const rows =
    '[{"id":1,"name":"Ana, \\"A\\"","note":"line\\none"},{"id":2,"name":"Bo","note":null,"tags":["x",{"y":1}]}]';

  it("writes a header and quoted cells", async () => {
    const out = text(await convertBytes(enc(rows), "csv", { firstRows: 10 }));
    expect(out).toBe('id,name,note,tags\n1,"Ana, ""A""","line\none",\n2,Bo,,"[""x"",{""y"":1}]"\n');
  });

  it("parses back to the rows, across region sizes", async () => {
    const expected = [
      { id: "1", name: 'Ana, "A"', note: "line\none", tags: "" },
      { id: "2", name: "Bo", note: "", tags: '["x",{"y":1}]' },
    ];
    for (const regionBytes of [1, 5, 16, 1 << 20]) {
      const out = text(await convertBytes(enc(rows), "csv", { regionBytes }));
      expect(parseCsv(out, { columns: true })).toEqual(expected);
    }
  });

  it("names the first node a table cannot hold, by JSON Pointer", async () => {
    const bad = enc('[{"a":1},{"a":2},3]');
    const error = await convertBytes(bad, "csv", { regionBytes: 4 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrepresentableError);
    expect((error as UnrepresentableError).pointer).toBe("/2");
    expect((error as UnrepresentableError).reason).toBe("row-not-object");
    const unknown = await convertBytes(enc('[{"a":1},{"a":2,"b":3}]'), "csv", {
      firstRows: 1,
    }).catch((e: unknown) => e);
    expect((unknown as UnrepresentableError).pointer).toBe("/1/b");
    const nested = await convertBytes(enc('[{"a":{"b":1}}]'), "csv", { nested: "error" }).catch(
      (e: unknown) => e,
    );
    expect((nested as UnrepresentableError).pointer).toBe("/0/a");
  });

  it("fails at the first bad row without waiting on regions after it, however many there are", async () => {
    const bad = enc(`[3,${Array.from({ length: 80 }, (_, i) => `{"a":${i}}`).join(",")}]`);
    const error = await convertBytes(bad, "csv", { regionBytes: 16, workers: 3 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnrepresentableError);
    expect((error as UnrepresentableError).pointer).toBe("/0");
    const late = enc(`[${Array.from({ length: 80 }, (_, i) => `{"a":${i}}`).join(",")},4]`);
    const lateError = await convertBytes(late, "csv", { regionBytes: 16, workers: 3 }).catch(
      (e: unknown) => e,
    );
    expect((lateError as UnrepresentableError).pointer).toBe("/80");
  });

  it("settles when a later summarize resumes after an earlier convert failure", async () => {
    const ones = Array.from({ length: 130 }, () => "1").join(",");
    const bytes = enc(`[${ones}]`);
    expect(bytes.byteLength).toBe(261);
    const scripted = scriptSummarizePastConvertFailure();
    const saw = { settled: false, error: undefined as unknown };
    const pending = convertJsonSource(
      scripted.pool,
      {
        spec: {
          kind: "memory",
          buffer: bytes.buffer,
          byteOffset: bytes.byteOffset,
          byteLength: bytes.byteLength,
        },
        size: bytes.byteLength,
      },
      "toml",
      { write: () => undefined },
      { regionBytes: 16 },
    ).then(
      () => {
        saw.settled = true;
      },
      (error: unknown) => {
        saw.settled = true;
        saw.error = error;
      },
    );
    try {
      for (let turn = 0; scripted.order.length < 3 && turn < 500; turn++) await Promise.resolve();
      expect(scripted.order).toEqual([
        "summarize region 3 entered",
        "convert region 0 failure delivered",
        "summarize region 3 resuming",
      ]);
      for (let turn = 0; !saw.settled && turn < 100; turn++) await Promise.resolve();
      if (!saw.settled) {
        throw new Error(`convertJsonSource did not settle after ${scripted.order.join(", ")}`);
      }
      await pending;
      expect(saw.error).toBeInstanceOf(UnrepresentableError);
      const error = saw.error as UnrepresentableError;
      expect(error.reason).toBe("not-a-table");
      expect(error.pointer).toBe("");
    } finally {
      await scripted.pool.terminate();
    }
  });

  it("names the offending row by pointer in a document larger than the locator's window", async () => {
    const rows = Array.from(
      { length: 120_000 },
      (_, i) => `{"a":${i},"b":"row ${i} padding padding"}`,
    );
    const bad = enc(`[${[...rows, "3", '{"a":1}'].join(",")}]`);
    expect(bad.length).toBeGreaterThan(4 * 1024 * 1024);
    const error = await convertBytes(bad, "csv", { regionBytes: 1 << 20 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrepresentableError);
    expect((error as UnrepresentableError).pointer).toBe("/120000");
  });

  it.effect.prop(
    "string tables round trip through csv-parse",
    [
      Arbitrary.schema(
        Schema.Array(Schema.Struct({ a: Schema.String, b: Schema.String })).check(
          Schema.isMinLength(1),
        ),
      ),
    ],
    ([table]) =>
      Effect.promise(async () => {
        const out = text(
          await convertBytes(enc(JSON.stringify(table)), "csv", { regionBytes: 13 }),
        );
        expect(parseCsv(out, { columns: true })).toEqual(
          table.map((row) => ({ a: row.a.toWellFormed(), b: row.b.toWellFormed() })),
        );
      }),
    { arbitrary: { runs: 100 } },
  );
});

describe("JSON to NDJSON and minified JSON", () => {
  it("writes one compact element per line", async () => {
    const out = text(
      await convertBytes(enc('[ {"a": 1,\n "b":[1, 2]}, 7, "x" ]'), "ndjson", { regionBytes: 5 }),
    );
    expect(out).toBe('{"a":1,"b":[1,2]}\n7\n"x"\n');
  });
  it("minifies", async () => {
    const out = text(
      await convertBytes(enc('{ "a" : [ 1 , 2 ] , "b" : { } }'), "minify", { regionBytes: 4 }),
    );
    expect(out).toBe('{"a":[1,2],"b":{}}');
    expect(parseJsonSlice(enc(out))).toEqual({ a: [1, 2], b: {} });
  });
});

/**
 * Two workers, region size 16, over a 261-byte array. Summarize of region 3 is
 * entered before region 0's convert failure is delivered, and that summarize
 * reply is delivered only after the failure. A hang fails this test once those
 * three deliveries have happened; the bound is microtask turns.
 */
const scriptSummarizePastConvertFailure = () => {
  const order: string[] = [];
  let summarize3Entered = false;
  let convert0Delivered = false;
  let releaseConvert0: (() => void) | undefined;
  let releaseSummarize3: (() => void) | undefined;
  const workers: WorkerLike<FormatJob, FormatJobResult>[] = [0, 1].map(() => {
    const run = createFormatJobRunner({ openSource });
    let handler: Parameters<WorkerLike<FormatJob, FormatJobResult>["onMessage"]>[0] | undefined;
    let queue = Promise.resolve();
    const worker: WorkerLike<FormatJob, FormatJobResult> = {
      postMessage: (message) => {
        queue = queue.then(async () => {
          const job = message.job;
          if (job.type === "summarize" && job.region === 3) {
            order.push("summarize region 3 entered");
            summarize3Entered = true;
            const release = releaseConvert0;
            releaseConvert0 = undefined;
            release?.();
          }
          try {
            const outcome = await run(job);
            if (job.type === "summarize" && job.region === 3) {
              if (!convert0Delivered) {
                await new Promise<void>((resolve) => {
                  releaseSummarize3 = resolve;
                });
              }
              handler?.({ id: message.id, ok: true, result: outcome.result });
              order.push("summarize region 3 resuming");
              return;
            }
            if (job.type === "convert" && job.region === 0) {
              order.push("convert region 0 succeeded");
              convert0Delivered = true;
              const release = releaseSummarize3;
              releaseSummarize3 = undefined;
              release?.();
            }
            handler?.({ id: message.id, ok: true, result: outcome.result });
          } catch (error) {
            if (job.type === "convert" && job.region === 0) {
              if (!summarize3Entered) {
                await new Promise<void>((resolve) => {
                  releaseConvert0 = resolve;
                });
              }
              handler?.({ id: message.id, ok: false, error: toFailure(error) });
              order.push("convert region 0 failure delivered");
              convert0Delivered = true;
              await Promise.resolve();
              const release = releaseSummarize3;
              releaseSummarize3 = undefined;
              release?.();
              return;
            }
            handler?.({ id: message.id, ok: false, error: toFailure(error) });
          }
        });
      },
      onMessage: (next) => {
        handler = next;
      },
      terminate: () => undefined,
    };
    return worker;
  });
  return { order, pool: new FormatPool<FormatJob, FormatJobResult>(workers) };
};
