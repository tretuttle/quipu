import { SliceTooLargeError } from "@quipu/contracts/engine";
import { describe, expect, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { inflateGzip } from "./gzip.ts";
import { gzip } from "./testing/decoderSamples.ts";

describe("inflateGzip", () => {
  it.live.prop(
    "returns the bytes that were compressed",
    [Arbitrary.schema(Schema.Uint8Array)],
    ([bytes]) =>
      Effect.promise(async () => {
        expect(Array.from(await inflateGzip(await gzip(bytes)))).toEqual(Array.from(bytes));
      }),
    { arbitrary: { runs: 40 } },
  );

  it("stops at the limit: a bomb costs the limit, not its size", async () => {
    const bomb = await gzip(new Uint8Array(32 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024);
    await expect(inflateGzip(bomb, 1024 * 1024)).rejects.toBeInstanceOf(SliceTooLargeError);
    expect((await inflateGzip(bomb, 32 * 1024 * 1024)).length).toBe(32 * 1024 * 1024);
  });

  it("refuses bytes that are not gzip", async () => {
    await expect(inflateGzip(new TextEncoder().encode("plainly not gzip"))).rejects.toThrow();
  });
});
