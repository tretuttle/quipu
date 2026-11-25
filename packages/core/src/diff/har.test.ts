import { describe, expect, it } from "vite-plus/test";

import { memorySource } from "../source.ts";
import { decodeBase64Ascii } from "../base64.ts";
import { decodeUtf8 } from "../boundedSlice.ts";
import { indexBytes } from "../indexBuffer.ts";
import { FULL_DEPTH } from "../scan.ts";
import {
  classifyHarCaptures,
  diffHarCaptures,
  diffHarEntryBodies,
  extractHarEntryPrintFromSlice,
  extractHarPrintFromOversizedSource,
  extractHarPrintsStreaming,
  hashJsonValueCanonical,
  matchKey,
  scanHarEntryRanges,
  withoutFragment,
} from "./har.ts";
import { fnv1a64, fnv1a64Utf8String, mix64, mix64Into, toBigInt64 } from "./hash.ts";
import { computeSubtreeHashes, formatChangeSummary } from "./structural.ts";
import { HAR_DIFF_FIXTURES } from "./testFixtures/harDiffFixtures.ts";

const ENCODER = new TextEncoder();

function loadFixture(name: "a" | "b" | "c" | "d" | "e"): Uint8Array {
  return ENCODER.encode(HAR_DIFF_FIXTURES[name]);
}

interface SyntheticEntry {
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly status: number;
  readonly body: string;
  readonly headers?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly queryString?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly postData?: { readonly mimeType: string; readonly text: string };
  readonly encoding?: "base64";
}

function buildHar(entries: ReadonlyArray<SyntheticEntry>): Uint8Array {
  const doc = {
    log: {
      version: "1.2",
      creator: { name: "test", version: "1" },
      entries: entries.map((e) => ({
        startedDateTime: "2026-01-01T00:00:00.000Z",
        time: 1,
        _resourceType: e.resourceType,
        request: {
          method: e.method,
          url: e.url,
          headers: e.headers ?? [{ name: "Accept", value: "*/*" }],
          queryString: e.queryString ?? [],
          ...(e.postData ? { postData: e.postData } : {}),
        },
        response: {
          status: e.status,
          headers: [],
          content: {
            size: e.body.length,
            mimeType: "application/json",
            text: e.body,
            ...(e.encoding ? { encoding: e.encoding } : {}),
          },
        },
      })),
    },
  };
  return ENCODER.encode(JSON.stringify(doc));
}

describe("HAR capture diff", () => {
  it("strips fragments when building match keys", () => {
    expect(withoutFragment("https://a.test/x?q=1#one")).toBe("https://a.test/x?q=1");
    expect(matchKey("GET", "https://a.test/x?q=1#one", "fetch")).toBe(
      matchKey("GET", "https://a.test/x?q=1#two", "fetch"),
    );
    expect(matchKey("GET", "https://a.test/x", "fetch")).not.toBe(
      matchKey("GET", "https://a.test/x", "xhr"),
    );
    expect(matchKey("GET", "https://a.test/x", "fetch")).not.toBe(
      matchKey("POST", "https://a.test/x", "fetch"),
    );
  });

  it("matches HAR diff fixtures a vs b, a vs c, a vs d, a vs e and 5-way classification", async () => {
    const [aBytes, bBytes, cBytes, dBytes, eBytes] = (["a", "b", "c", "d", "e"] as const).map(
      loadFixture,
    );
    const [pa, pb, pc, pd, pe] = await Promise.all([
      extractHarPrintsStreaming(memorySource(aBytes!)),
      extractHarPrintsStreaming(memorySource(bBytes!)),
      extractHarPrintsStreaming(memorySource(cBytes!)),
      extractHarPrintsStreaming(memorySource(dBytes!)),
      extractHarPrintsStreaming(memorySource(eBytes!)),
    ]);

    const ab = diffHarCaptures(pa, pb);
    expect(ab.counts).toEqual({ same: 6, added: 1, removed: 0, changed: 1 });
    const abOrder = ab.entries.find((e) => e.url.includes("/v1/order/7"));
    expect(abOrder?.classification).toBe("changed");
    expect(abOrder?.changedSections).toEqual(["body"]);
    expect(ab.entries.find((e) => e.url.includes("/v1/weather"))?.classification).toBe("added");

    const ac = diffHarCaptures(pa, pc);
    expect(ac.counts).toEqual({ same: 6, added: 1, removed: 0, changed: 1 });

    // d.har changes fragment #summary -> #details on order/7, which matching ignores.
    const ad = diffHarCaptures(pa, pd);
    expect(ad.counts).toEqual({ same: 6, added: 1, removed: 0, changed: 1 });
    expect(ad.entries.find((e) => e.url.includes("/v1/order/7"))?.classification).toBe("changed");

    // e.har removes recommendations and adds weather.
    const ae = diffHarCaptures(pa, pe);
    expect(ae.counts).toEqual({ same: 5, added: 1, removed: 1, changed: 1 });
    expect(ae.entries.find((e) => e.url.includes("/v1/recommendations"))?.classification).toBe(
      "removed",
    );
    expect(ae.entries.find((e) => e.url.includes("/v1/weather"))?.classification).toBe("added");

    // All 5 captures together yield counts `5,1,1,1`.
    const five = classifyHarCaptures([pa, pb, pc, pd, pe], 0);
    expect(five.counts).toEqual({ same: 5, added: 1, removed: 1, changed: 1 });
    expect(five.classes[0]?.[1]).toBe("changed");
    expect(five.classes[0]?.[2]).toBe("removed");
    expect(five.classes[4]?.[3]).toBe("added");
  });

  it("supports swapping the reference document instead of hardcoding slot 0 or 1", async () => {
    const pa = await extractHarPrintsStreaming(memorySource(loadFixture("a")));
    const pe = await extractHarPrintsStreaming(memorySource(loadFixture("e")));

    const refB = diffHarCaptures(pa, pe, { reference: "b" });
    expect(refB.referenceIndex).toBe(1);
    expect(refB.counts).toEqual({ same: 5, added: 1, removed: 1, changed: 1 });
    // Relative to e.har as reference, recommendations is added in a.har and weather is removed.
    expect(refB.entries.find((e) => e.url.includes("/v1/recommendations"))?.classification).toBe(
      "added",
    );
    expect(refB.entries.find((e) => e.url.includes("/v1/weather"))?.classification).toBe("removed");
  });

  it("produces exactly 1 changed entry when 1 scalar is modified in a multi-entry HAR", async () => {
    const entries: SyntheticEntry[] = Array.from({ length: 20 }, (_, i) => ({
      method: i % 2 === 0 ? "GET" : "POST",
      url: `https://api.example.test/v1/item/${i}`,
      resourceType: "fetch",
      status: 200,
      body: JSON.stringify({ id: i, price: 100 + i, tags: ["a", "b"] }),
    }));
    const modified = entries.map((e, i) =>
      i === 13 ? { ...e, body: JSON.stringify({ id: i, price: 999, tags: ["a", "b"] }) } : e,
    );
    const pa = await extractHarPrintsStreaming(memorySource(buildHar(entries)));
    const pb = await extractHarPrintsStreaming(memorySource(buildHar(modified)));
    const res = diffHarCaptures(pa, pb);
    expect(res.counts).toEqual({ same: 19, added: 0, removed: 0, changed: 1 });
    const changed = res.entries.filter((e) => e.classification === "changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.entryIndexAfter).toBe(13);
    expect(changed[0]?.changedSections).toEqual(["body"]);
  });

  it("treats request headers as a case-insensitive set and detects status/query/postData diffs", async () => {
    const a = buildHar([
      {
        method: "POST",
        url: "https://a.test/submit",
        resourceType: "fetch",
        status: 200,
        headers: [
          { name: "X-One", value: "1" },
          { name: "Accept", value: "application/json" },
        ],
        queryString: [{ name: "v", value: "1" }],
        postData: { mimeType: "application/json", text: '{"a":1,"b":2}' },
        body: '{"ok":true}',
      },
    ]);
    const bSameHeadersReordered = buildHar([
      {
        method: "POST",
        url: "https://a.test/submit",
        resourceType: "fetch",
        status: 200,
        headers: [
          { name: "accept", value: "application/json" },
          { name: "x-one", value: "1" },
        ],
        queryString: [{ name: "v", value: "1" }],
        postData: { mimeType: "application/json", text: '{"b":2,"a":1}' },
        body: '{"ok": true}',
      },
    ]);
    const cStatusAndHeader = buildHar([
      {
        method: "POST",
        url: "https://a.test/submit",
        resourceType: "fetch",
        status: 500,
        headers: [{ name: "accept", value: "text/plain" }],
        queryString: [{ name: "v", value: "2" }],
        postData: { mimeType: "application/json", text: '{"a":2,"b":2}' },
        body: '{"ok":true}',
      },
    ]);

    const [pa, pb, pc] = await Promise.all([
      extractHarPrintsStreaming(memorySource(a)),
      extractHarPrintsStreaming(memorySource(bSameHeadersReordered)),
      extractHarPrintsStreaming(memorySource(cStatusAndHeader)),
    ]);

    expect(diffHarCaptures(pa, pb).counts).toEqual({ same: 1, added: 0, removed: 0, changed: 0 });
    const ac = diffHarCaptures(pa, pc);
    expect(ac.counts).toEqual({ same: 0, added: 0, removed: 0, changed: 1 });
    expect(ac.entries[0]?.changedSections).toEqual(["headers", "query", "postData", "status"]);
  });

  it("matches repeated identical calls by occurrence order", async () => {
    const a = buildHar([
      {
        method: "GET",
        url: "https://a.test/poll",
        resourceType: "xhr",
        status: 200,
        body: '{"n":1}',
      },
      {
        method: "GET",
        url: "https://a.test/poll",
        resourceType: "xhr",
        status: 200,
        body: '{"n":2}',
      },
    ]);
    const b = buildHar([
      {
        method: "GET",
        url: "https://a.test/poll",
        resourceType: "xhr",
        status: 200,
        body: '{"n":1}',
      },
    ]);
    const pa = await extractHarPrintsStreaming(memorySource(a));
    const pb = await extractHarPrintsStreaming(memorySource(b));
    const out = classifyHarCaptures([pa, pb], 0);
    expect(out.classes[0]).toEqual(["same", "removed"]);
    expect(out.classes[1]).toEqual(["same"]);
  });

  it("decodes base64 response bodies and computes on-demand structural body diffs", async () => {
    const aBytes = loadFixture("a");
    const bBytes = loadFixture("b");
    const aRanges = await scanHarEntryRanges(memorySource(aBytes));
    const bRanges = await scanHarEntryRanges(memorySource(bBytes));

    const aOrderSlice = aBytes.subarray(aRanges[1]!.start, aRanges[1]!.end);
    const bOrderSlice = bBytes.subarray(bRanges[1]!.start, bRanges[1]!.end);
    const bodyDiff = diffHarEntryBodies(aOrderSlice, bOrderSlice);
    expect(bodyDiff.changes.map(formatChangeSummary)).toEqual(["changed /order/price"]);

    // Base64 encoded JSON body vs plain JSON body with identical parsed payload.
    const rawJson = '{"order":{"id":7,"price":10}}';
    const b64 = btoa(rawJson);
    const h1 = buildHar([
      {
        method: "GET",
        url: "https://a.test/b64",
        resourceType: "fetch",
        status: 200,
        body: b64,
        encoding: "base64",
      },
    ]);
    const h2 = buildHar([
      {
        method: "GET",
        url: "https://a.test/b64",
        resourceType: "fetch",
        status: 200,
        body: rawJson,
      },
    ]);
    const p1 = await extractHarPrintsStreaming(memorySource(h1));
    const p2 = await extractHarPrintsStreaming(memorySource(h2));
    expect(diffHarCaptures(p1, p2).counts).toEqual({ same: 1, added: 0, removed: 0, changed: 0 });
  });

  it("streams batches cleanly for elementMap-compatible extraction", async () => {
    const bytes = loadFixture("b");
    const batches: number[] = [];
    const streamed = await extractHarPrintsStreaming(memorySource(bytes), {
      batchSize: 3,
      onBatch: (batch) => {
        batches.push(batch.length);
      },
    });
    expect(batches).toEqual([3, 3, 2]);
    expect(streamed).toHaveLength(8);
    // Verify individual slice extraction agrees with streaming.
    const ranges = await scanHarEntryRanges(memorySource(bytes));
    const single = extractHarEntryPrintFromSlice(
      bytes.subarray(ranges[4]!.start, ranges[4]!.end),
      4,
    );
    expect(single).toEqual(streamed[4]);
  });

  it("matches UTF-8 string FNV-1a bit-for-bit and extracts oversized prints via bounded cursor", async () => {
    const sample = "hello 🌍 \u0026 UTF-8 café ☃";
    expect(fnv1a64Utf8String(sample)).toBe(fnv1a64(ENCODER.encode(sample)));
    const entry1 = ENCODER.encode(
      JSON.stringify({
        _resourceType: "fetch",
        request: {
          method: "GET",
          url: "https://big.example/blob",
          headers: [{ name: "Accept", value: "text/csv" }],
          queryString: [{ name: "range", value: "all" }],
        },
        response: {
          status: 200,
          content: { mimeType: "text/csv", text: "a,b\n" + "1,2\n".repeat(1000) },
        },
      }),
    );
    const entry2 = ENCODER.encode(
      JSON.stringify({
        _resourceType: "fetch",
        request: {
          method: "GET",
          url: "https://big.example/blob",
          headers: [{ name: "accept", value: "text/csv" }],
          queryString: [{ name: "range", value: "all" }],
        },
        response: {
          status: 201,
          content: { mimeType: "text/csv", text: "a,b\n" + "1,2\n".repeat(1000) },
        },
      }),
    );
    const p1 = await extractHarPrintFromOversizedSource(memorySource(entry1), 0, entry1.length, 42);
    const p2 = await extractHarPrintFromOversizedSource(memorySource(entry2), 0, entry2.length, 42);
    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    expect(p1).toEqual(extractHarEntryPrintFromSlice(entry1, 42));
    const diff = diffHarCaptures([p1!], [p2!]);
    expect(diff.counts).toEqual({ same: 0, added: 0, removed: 0, changed: 1 });
    expect(diff.entries[0]?.changedSections).toEqual(["status"]);
  });

  it("matches BigInt mix64 and computeSubtreeHashes on 32-bit limbs, deep nesting, and base64 ASCII", () => {
    const out = new Uint32Array(2);
    const probes = [
      0n,
      1n,
      0xffff_ffffn,
      0x1_0000_0000n,
      0x8000_0000_0000_0000n,
      0xffff_ffff_ffff_ffffn,
      0xdead_beef_cafe_baben,
      0xbf58_476d_1ce4_e5b9n,
    ];
    let state = 0x1234_5678_9abc_def0n;
    for (let i = 0; i < 200; i++) {
      state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffff_ffff_ffff_ffffn;
      probes.push(state);
    }
    for (const v of probes) {
      mix64Into(Number(v & 0xffff_ffffn) >>> 0, Number((v >> 32n) & 0xffff_ffffn) >>> 0, out, 0);
      expect(toBigInt64(out[0]!, out[1]!)).toBe(mix64(v));
    }

    let nested: unknown = { leaf: "é🎉", nums: [0, -0, 1.5, 42], flag: true, empty: null };
    for (let d = 0; d < 72; d++) {
      nested = d % 2 === 0 ? { child: nested, idx: d } : [nested, d];
    }
    const bytes = ENCODER.encode(JSON.stringify(nested));
    const { tape } = indexBytes(bytes, 0, { maxDepth: FULL_DEPTH, chunkBytes: bytes.length + 1 });
    expect(hashJsonValueCanonical(nested)).toBe(computeSubtreeHashes({ tape, bytes })[0]);

    const decoded = decodeBase64Ascii(" eyJvayI6\n  dHJ1ZX0= ");
    expect(decoded ? decodeUtf8(decoded, 128) : null).toBe('{"ok":true}');
    expect(decodeBase64Ascii("abc\\/def")).toBeNull();
    expect(decodeBase64Ascii("héllo")).toBeNull();
  });
});
