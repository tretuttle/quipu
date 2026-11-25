import { afterAll, describe, expect, it } from "@effect/vitest";
import type { DocumentFormat, NodeRef } from "@quipu/contracts/engine";
import { TABLE_COLUMN_SAMPLE_ROWS } from "@quipu/contracts/table";

import { EngineHost } from "./document.ts";
import { createLocalPool } from "./localPool.ts";
import { blobSource, memorySource, type ByteSource } from "./source.ts";
import {
  createTableDocAccessFromHandle,
  extractHarSummaryFromObject,
  extractHarTableRaw,
  extractHarTableRawFromSource,
  HAR_COL_STRIDE,
  harRawToSummary,
  parseIsoDateMsFast,
  scanHarTableWindowColumnar,
  normalizeHarBodySize,
  sortPermutation,
  TableIndexHost,
} from "./tableIndex.ts";

const utf8 = new TextEncoder();

const platform = (workers = 4) => ({
  workers,
  crossOriginIsolated: true,
  createPool: createLocalPool,
});

async function openInHost(json: string, name: string, formatHint?: DocumentFormat) {
  const host = new EngineHost(platform(4), { regionBytes: 64 * 1024 });
  const bytes = utf8.encode(json);
  const info = await host.handle({
    _tag: "open",
    source: new Blob([bytes]),
    name,
    ...(formatHint ? { asFormat: formatHint } : {}),
  });
  const access = createTableDocAccessFromHandle(
    (req) => host.handle(req),
    () => info.format,
  );
  return { host, info, access };
}

describe("tableIndex", () => {
  it("discovers root array, nested arrays, and HAR entries targets", async () => {
    const rootArr = await openInHost(
      JSON.stringify([
        { id: 1, name: "alpha" },
        { id: 2, name: "beta" },
      ]),
      "rows.json",
    );
    const nested = await openInHost(
      JSON.stringify({
        small: [{ a: 1 }],
        big: [{ x: 1 }, { x: 2 }, { x: 3 }],
      }),
      "nested.json",
    );
    const har = await openInHost(
      JSON.stringify({
        log: {
          entries: [
            {
              startedDateTime: "2026-01-01T00:00:00.000Z",
              time: 12,
              request: { method: "GET", url: "https://api.example.com/a" },
              response: { status: 200, content: { size: 42, mimeType: "application/json" } },
            },
          ],
          version: "1.2",
        },
      }),
      "capture.har",
    );

    try {
      const table = new TableIndexHost();
      const r1 = await table.targets(rootArr.access, rootArr.info.documentId);
      expect(r1.recommendedPath).toBe("$");
      expect(r1.targets).toHaveLength(1);

      const r2 = await table.targets(nested.access, nested.info.documentId);
      expect(r2.recommendedPath).toBe("$.big");
      expect(r2.targets.map((t) => t.path)).toEqual(["$.small", "$.big"]);

      const r3 = await table.targets(har.access, har.info.documentId);
      expect(r3.recommendedPath).toBe("$.log.entries");
      expect(r3.targets[0]?.isHarEntries).toBe(true);
    } finally {
      await rootArr.host.handle({ _tag: "close", documentId: rootArr.info.documentId });
      await nested.host.handle({ _tag: "close", documentId: nested.info.documentId });
      await har.host.handle({ _tag: "close", documentId: har.info.documentId });
    }
  });

  it("infers columns from first 1024 rows and appends late columns on demand", async () => {
    const rowCount = TABLE_COLUMN_SAMPLE_ROWS + 20;
    const rows = Array.from({ length: rowCount }, (_, i) =>
      i === TABLE_COLUMN_SAMPLE_ROWS + 5
        ? { id: i, name: `row-${i}`, lateField: "appeared-late" }
        : { id: i, name: `row-${i}` },
    );
    const opened = await openInHost(JSON.stringify(rows), "late-cols.json");
    try {
      const table = new TableIndexHost();
      const res = await table.query(opened.access, {
        documentId: opened.info.documentId,
        targetPath: "$",
        sort: null,
        filters: [],
        timeWindow: null,
        filteredRowIndices: null,
      });
      expect(res.totalRows).toBe(rowCount);
      expect(res.columns.map((c) => c.key)).toEqual(["id", "name"]);

      const latePage = await table.rows(opened.access, res.queryId, TABLE_COLUMN_SAMPLE_ROWS, 20);
      expect(latePage.columns.map((c) => c.key)).toEqual(["id", "name", "lateField"]);
      expect(latePage.columns.find((c) => c.key === "lateField")?.late).toBe(true);
      const lateRow = latePage.rows.find((r) => r.rowIndex === TABLE_COLUMN_SAMPLE_ROWS + 5);
      expect(lateRow?.cells.lateField?.text).toBe("appeared-late");
    } finally {
      await opened.host.handle({ _tag: "close", documentId: opened.info.documentId });
    }
  });

  it("sorts view-only (numeric-aware + string fallback), filters per column, and respects filteredRowIndices", async () => {
    const data = [
      { id: 10, name: "zebra", score: "100" },
      { id: 2, name: "alpha", score: "20" },
      { id: 30, name: "Api-gateway", score: "3" },
      { id: 1, name: "beta-api", score: null },
    ];
    const opened = await openInHost(JSON.stringify(data), "sort-filter.json");
    try {
      const table = new TableIndexHost();

      const ascNum = await table.query(opened.access, {
        documentId: opened.info.documentId,
        targetPath: "$",
        sort: { column: "id", direction: "asc" },
        filters: [],
        timeWindow: null,
        filteredRowIndices: null,
      });
      const ascRows = await table.rows(opened.access, ascNum.queryId, 0, 10);
      expect(ascRows.rows.map((r) => r.cells.id?.text)).toEqual(["1", "2", "10", "30"]);

      // Numeric-aware string sorting: "3" < "20" < "100", null pushed last.
      const descScore = await table.query(opened.access, {
        documentId: opened.info.documentId,
        targetPath: "$",
        sort: { column: "score", direction: "desc" },
        filters: [],
        timeWindow: null,
        filteredRowIndices: null,
      });
      const scoreRows = await table.rows(opened.access, descScore.queryId, 0, 10);
      expect(scoreRows.rows.map((r) => r.cells.score?.text)).toEqual(["100", "20", "3", "null"]);

      // Per-column substring filter (case-insensitive) + filteredRowIndices.
      const filtered = await table.query(opened.access, {
        documentId: opened.info.documentId,
        targetPath: "$",
        sort: { column: "id", direction: "asc" },
        filters: [{ column: "name", query: "api" }],
        timeWindow: null,
        filteredRowIndices: [2],
      });
      expect(filtered.matchedRows).toBe(1);
      const filteredPage = await table.rows(opened.access, filtered.queryId, 0, 10);
      expect(filteredPage.rows[0]?.cells.name?.text).toBe("Api-gateway");

      // Document itself must remain completely unmutated (view-only).
      const root = await opened.access.root(opened.info.documentId);
      const docOrder = await opened.access.children(root.ref, 0, 10);
      const firstCell = await opened.access.rows(docOrder.nodes[0]?.ref as NodeRef, 0, 10, 64);
      expect(firstCell.rows.find((r) => r.key === "id")?.preview?.text).toBe("10");
    } finally {
      await opened.host.handle({ _tag: "close", documentId: opened.info.documentId });
    }
  });

  it("extracts HAR summaries cleanly with Hark -1 sizes, arbitrary key order, and timeline brush", async () => {
    expect(normalizeHarBodySize(-1, -1)).toBeNull();
    expect(normalizeHarBodySize(-1, 512)).toBe(512);
    expect(normalizeHarBodySize(256, -1)).toBe(256);

    const dummyRef: NodeRef = { documentId: 1, tapeId: 0, token: 1 };
    const outOfOrder = extractHarSummaryFromObject(0, dummyRef, {
      timings: { receive: 5, wait: 15, send: 1, ssl: -1, connect: -1, dns: -1, blocked: 2 },
      response: {
        bodySize: -1,
        content: { mimeType: "application/json; charset=utf-8", size: -1 },
        status: 201,
      },
      request: { url: "https://api.example.com/v1/items", method: "POST" },
      startedDateTime: "2026-01-01T00:00:00.000Z",
    });
    expect(outOfOrder.summary.method).toBe("POST");
    expect(outOfOrder.summary.status).toBe(201);
    expect(outOfOrder.summary.statusClass).toBe("2xx");
    expect(outOfOrder.summary.bodySize).toBeNull();
    expect(outOfOrder.summary.timings).toEqual({
      blocked: 2,
      dns: 0,
      connect: 0,
      ssl: 0,
      send: 1,
      wait: 15,
      receive: 5,
    });
    expect(outOfOrder.summary.timeMs).toBe(23);

    const harJson = JSON.stringify({
      log: {
        entries: [
          {
            startedDateTime: "2026-01-01T00:00:00.000Z",
            time: 100,
            request: { method: "GET", url: "https://example.com/api/one" },
            response: { status: 200, bodySize: -1, content: { size: -1, mimeType: "text/html" } },
            timings: { blocked: 10, dns: 10, connect: 20, ssl: 10, send: 5, wait: 40, receive: 15 },
          },
          {
            startedDateTime: "2026-01-01T00:00:01.000Z",
            time: 50,
            request: { method: "POST", url: "https://example.com/api/two" },
            response: { status: 502, content: { size: 128, mimeType: "application/json" } },
            timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 2, wait: 45, receive: 3 },
          },
          {
            startedDateTime: "2026-01-01T00:00:02.500Z",
            time: 20,
            request: { method: "GET", url: "https://example.com/static.js" },
            response: { status: 304, content: { size: 0, mimeType: "application/javascript" } },
            timings: { wait: 18, receive: 2 },
          },
        ],
        version: "1.2",
      },
    });
    const opened = await openInHost(harJson, "hark-order.har");
    try {
      const table = new TableIndexHost();
      const full = await table.query(opened.access, {
        documentId: opened.info.documentId,
        targetPath: "$.log.entries",
        sort: null,
        filters: [],
        timeWindow: null,
        filteredRowIndices: null,
      });
      expect(full.matchedRows).toBe(3);
      expect(full.harTimeline?.totalSpanMs).toBe(2520);

      const page = await table.rows(opened.access, full.queryId, 0, 10);
      expect(page.rows[0]?.har?.bodySize).toBeNull();
      expect(page.rows[1]?.har?.statusClass).toBe("5xx");

      // Brush window [900ms, 1200ms] matches only entry #1 (at 1000ms..1050ms).
      const brushed = await table.query(opened.access, {
        documentId: opened.info.documentId,
        targetPath: "$.log.entries",
        sort: null,
        filters: [{ column: "url", query: "api" }],
        timeWindow: { startMs: 900, endMs: 1200 },
        filteredRowIndices: null,
      });
      expect(brushed.matchedRows).toBe(1);
      const brushedPage = await table.rows(opened.access, brushed.queryId, 0, 10);
      expect(brushedPage.rows[0]?.har?.url).toBe("https://example.com/api/two");
    } finally {
      await opened.host.handle({ _tag: "close", documentId: opened.info.documentId });
    }
  });

  it("reflects inline scalar edits and undo/redo immediately across JSON and HAR", async () => {
    const opened = await openInHost(
      JSON.stringify([
        { name: "alpha", rank: 20 },
        { name: "beta", rank: 10 },
      ]),
      "editable.json",
    );
    const harOpened = await openInHost(
      JSON.stringify({
        log: {
          version: "1.2",
          entries: [
            {
              startedDateTime: "2026-01-01T00:00:00.000Z",
              time: 10,
              request: { method: "GET", url: "https://example.com/a" },
              response: { status: 200, content: { size: 5, mimeType: "text/plain" } },
            },
          ],
        },
      }),
      "editable.har",
    );

    try {
      const table = new TableIndexHost();
      const q1 = await table.query(opened.access, {
        documentId: opened.info.documentId,
        targetPath: "$",
        sort: { column: "rank", direction: "asc" },
        filters: [],
        timeWindow: null,
        filteredRowIndices: null,
      });
      const page1 = await table.rows(opened.access, q1.queryId, 0, 10);
      expect(page1.rows.map((r) => r.cells.name?.text)).toEqual(["beta", "alpha"]);
      const betaRankRef = page1.rows[0]?.cells.rank?.ref;
      expect(betaRankRef).not.toBeNull();

      await opened.host.handle({ _tag: "setValue", ref: betaRankRef as NodeRef, json: "99" });
      const q2 = await table.query(opened.access, {
        documentId: opened.info.documentId,
        targetPath: "$",
        sort: { column: "rank", direction: "asc" },
        filters: [],
        timeWindow: null,
        filteredRowIndices: null,
      });
      const page2 = await table.rows(opened.access, q2.queryId, 0, 10);
      expect(page2.rows.map((r) => r.cells.name?.text)).toEqual(["alpha", "beta"]);
      expect(page2.rows[1]?.cells.rank?.text).toBe("99");

      await opened.host.handle({ _tag: "undo", documentId: opened.info.documentId });
      const q3 = await table.query(opened.access, {
        documentId: opened.info.documentId,
        targetPath: "$",
        sort: { column: "rank", direction: "asc" },
        filters: [],
        timeWindow: null,
        filteredRowIndices: null,
      });
      const page3 = await table.rows(opened.access, q3.queryId, 0, 10);
      expect(page3.rows.map((r) => r.cells.name?.text)).toEqual(["beta", "alpha"]);

      // HAR inline edit on response.status
      const hq1 = await table.query(harOpened.access, {
        documentId: harOpened.info.documentId,
        targetPath: "$.log.entries",
        sort: null,
        filters: [],
        timeWindow: null,
        filteredRowIndices: null,
      });
      const hp1 = await table.rows(harOpened.access, hq1.queryId, 0, 10);
      const statusRef = hp1.rows[0]?.cells.status?.ref;
      expect(statusRef).not.toBeNull();
      await harOpened.host.handle({ _tag: "setValue", ref: statusRef as NodeRef, json: "503" });

      const hq2 = await table.query(harOpened.access, {
        documentId: harOpened.info.documentId,
        targetPath: "$.log.entries",
        sort: null,
        filters: [],
        timeWindow: null,
        filteredRowIndices: null,
      });
      const hp2 = await table.rows(harOpened.access, hq2.queryId, 0, 10);
      expect(hp2.rows[0]?.har?.status).toBe(503);
      expect(hp2.rows[0]?.har?.statusClass).toBe("5xx");
    } finally {
      await opened.host.handle({ _tag: "close", documentId: opened.info.documentId });
      await harOpened.host.handle({ _tag: "close", documentId: harOpened.info.documentId });
    }
  });

  describe("40k-row sort speed", () => {
    const ROW_COUNT = 40_398;
    const statuses = [200, 201, 204, 301, 400, 404, 500, 503];
    const entries = Array.from({ length: ROW_COUNT }, (_, i) => ({
      startedDateTime: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      time: (i * 17) % 500,
      request: { method: i % 3 === 0 ? "POST" : "GET", url: `https://api.example.com/r/${i}` },
      response: {
        status: statuses[i % statuses.length],
        content: { size: (i * 13) % 4096, mimeType: "application/json" },
      },
      timings: { wait: (i * 7) % 200, receive: 5 },
    }));
    const harPayload = JSON.stringify({ log: { version: "1.2", entries } });
    let openedRef: Awaited<ReturnType<typeof openInHost>> | null = null;

    afterAll(async () => {
      if (openedRef) {
        await openedRef.host.handle({ _tag: "close", documentId: openedRef.info.documentId });
      }
    });

    it("sorts 40,398 HAR rows by status under 500 ms", async () => {
      openedRef = await openInHost(harPayload, "40k.har");
      // Wait for background indexing to settle (measuring post-ready table query & sort speed).
      const root = await openedRef.access.root(openedRef.info.documentId);
      if (openedRef.access.node) await openedRef.access.node(root.ref);
      const table = new TableIndexHost();

      const t0 = performance.now();
      const result = await table.query(openedRef.access, {
        documentId: openedRef.info.documentId,
        targetPath: "$.log.entries",
        revision: 0,
        sort: null,
        filters: [],
        timeWindow: null,
        filteredRowIndices: null,
      });
      const coldMs = performance.now() - t0;

      const s0 = performance.now();
      const sortedResult = await table.query(openedRef.access, {
        documentId: openedRef.info.documentId,
        targetPath: "$.log.entries",
        revision: 0,
        sort: { column: "status", direction: "desc" },
        filters: [],
        timeWindow: null,
        filteredRowIndices: null,
      });
      const warmSortMs = performance.now() - s0;

      expect(result.totalRows).toBe(ROW_COUNT);
      expect(sortedResult.matchedRows).toBe(ROW_COUNT);

      const topPage = await table.rows(openedRef.access, sortedResult.queryId, 0, 10);
      expect(topPage.rows[0]?.har?.status).toBe(503);

      // Also verify pure permutation sort timing.
      const indices = Uint32Array.from({ length: ROW_COUNT }, (_, i) => i);
      const ranks = new Uint8Array(ROW_COUNT).fill(2);
      const nums = Float64Array.from(
        { length: ROW_COUNT },
        (_, i) => statuses[i % statuses.length] as number,
      );
      const strs = Array.from<string>({ length: ROW_COUNT });
      const p0 = performance.now();
      const sorted = sortPermutation(indices, { ranks, nums, strs }, "desc");
      const permMs = performance.now() - p0;

      expect(sorted.length).toBe(ROW_COUNT);
      expect(nums[sorted[0] as number]).toBe(503);
      expect(coldMs).toBeLessThan(2000);
      expect(warmSortMs).toBeLessThan(500);
      expect(permMs).toBeLessThan(500);
    });
  });

  it("extractHarTableRaw matches object extraction across escaped strings, big body text, and syntax errors", () => {
    const dummyRef: NodeRef = { documentId: 1, tapeId: 0, token: 1 };
    const obj = {
      pageref: "page_2",
      startedDateTime: "2026-05-01T12:34:56.789Z",
      time: 42.5,
      request: {
        method: "POST",
        url: 'https://example.test/api?q=hello&x="1"&slash=a/b',
        headers: [{ name: "X-Big", value: "x".repeat(4096) }],
      },
      response: {
        status: 201,
        bodySize: -1,
        content: {
          text: JSON.stringify({ ok: true, big: "y".repeat(8192) }),
          mimeType: "application/json; charset=utf-8",
          size: 8210,
        },
      },
      timings: { blocked: 1, dns: 2, connect: 5, ssl: 3, send: 1.5, wait: 25, receive: 10 },
    };
    const encoded = utf8.encode(JSON.stringify(obj));
    const raw = extractHarTableRaw(encoded);
    expect(raw).not.toBeNull();
    expect(raw?.pageref).toBe("page_2");
    expect(harRawToSummary(3, dummyRef, raw!)).toEqual(
      extractHarSummaryFromObject(3, dummyRef, obj),
    );

    // Verify JSON \u0026 and \/ escapes in raw wire bytes decode identically to JSON.parse.
    const rawEscaped = utf8.encode(
      '{"request":{"method":"GET","url":"https:\\/\\/a.test\\/p?x=1\\u0026y=2"},"response":{"status":200}}',
    );
    const parsedRawEscaped = extractHarTableRaw(rawEscaped);
    expect(parsedRawEscaped?.url).toBe("https://a.test/p?x=1&y=2");

    expect(extractHarTableRaw(utf8.encode("{broken: "))).toBeNull();
    expect(extractHarTableRaw(utf8.encode("[1,2,3]"))).toBeNull();
  });

  it("extractHarTableRawFromSource matches extractHarTableRaw on entries with late fields", async () => {
    const obj = {
      pageref: "page_9",
      request: { method: "PUT", url: "https://example.test/upload" },
      response: {
        status: 204,
        bodySize: 1234,
        content: { text: "z".repeat(40000), mimeType: "text/csv", size: 40000 },
      },
      startedDateTime: "2026-06-01T00:00:00.000Z",
      time: 88.2,
      timings: { blocked: 2, dns: -1, connect: 10, ssl: 5, send: 20, wait: 40, receive: 16.2 },
    };
    const encoded = utf8.encode(JSON.stringify(obj));
    const streamed = await extractHarTableRawFromSource(memorySource(encoded), 0, encoded.length);
    expect(streamed).toEqual(extractHarTableRaw(encoded));
  });

  it("parseIsoDateMsFast matches Date.parse across timezones and invalid dates", () => {
    const samples = [
      "2026-01-01T00:00:00.000Z",
      "2026-05-01T12:34:56.789Z",
      "2024-02-29T23:59:59.1Z",
      "2025-02-29T12:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-05-01T12:34:56.123456+02:30",
      "2026-05-01T12:34:56-05:00",
      "2026-05-01T12:34:56Z",
      "2026-05-01T12:34:56",
      "not-a-date",
    ];
    for (const s of samples) {
      const fast = parseIsoDateMsFast(s);
      const ref = Date.parse(s);
      if (Number.isNaN(ref)) expect(Number.isNaN(fast)).toBe(true);
      else expect(fast).toBe(ref);
    }
  });

  it("scanHarTableWindowColumnar scans entries across 64 KiB chunk straddlers", async () => {
    const entries = [
      {
        startedDateTime: "2026-05-01T10:00:00.100Z",
        time: 12,
        request: { method: "GET", url: "https://a.test/one" },
        response: {
          status: 200,
          bodySize: 10,
          content: { mimeType: "text/plain", size: 10, text: "a".repeat(32768) },
        },
      },
      {
        startedDateTime: "2026-05-01T10:00:01.200Z",
        time: 25,
        request: { method: "POST", url: "https://b.test/two" },
        response: {
          status: 201,
          bodySize: -1,
          content: { mimeType: "application/json", size: 20, text: "b".repeat(40000) },
        },
      },
      {
        startedDateTime: "2026-05-01T10:00:02.300Z",
        time: 5,
        request: { method: "DELETE", url: "https://c.test/three" },
        response: { status: 404, bodySize: 0, content: { mimeType: "text/html", size: 0 } },
      },
    ];
    const body = entries.map((e) => JSON.stringify(e)).join(", ");
    const bytes = utf8.encode(body);
    const src = memorySource(bytes);
    const cols = await scanHarTableWindowColumnar(src, 0, bytes.length, 64 * 1024, (s, from, to) =>
      s.read(from, to),
    );
    expect(cols.count).toBe(3);
    expect(cols.methods).toEqual(["GET", "POST", "DELETE"]);
    expect(cols.urls).toEqual(["https://a.test/one", "https://b.test/two", "https://c.test/three"]);
    expect(cols.nums[0]).toBe(200);
    expect(cols.nums[HAR_COL_STRIDE]).toBe(201);
    expect(cols.nums[2 * HAR_COL_STRIDE]).toBe(404);
  });

  it("resolves EngineHost HAR cell refs and columnar sorting across late response fields and edits", async () => {
    const bigHeaders = Array.from({ length: 120 }, (_, k) => ({
      name: `x-pad-${k}`,
      value: "v".repeat(200),
    }));
    const entries = [
      {
        startedDateTime: "2026-05-01T10:00:00.000Z",
        time: 40,
        request: { method: "POST", url: "https://user:pw@api.alpha.test:8443/v1/items?a=1#top" },
        response: {
          status: 201,
          headers: bigHeaders,
          content: { size: 512, mimeType: "application/json" },
          bodySize: 700,
        },
      },
      {
        startedDateTime: "2026-05-01T10:00:01.000Z",
        time: 90,
        request: { method: "GET", url: "https://beta.test/health" },
        response: { status: 503, bodySize: 128, content: { mimeType: "text/plain", size: 64 } },
      },
    ];
    const opened = await openInHost(
      JSON.stringify({ log: { version: "1.2", entries } }),
      "batch.har",
      "har",
    );
    try {
      const q = await opened.host.handle({
        _tag: "tableQuery",
        documentId: opened.info.documentId,
        targetPath: "$.log.entries",
        revision: 0,
        sort: { column: "status", direction: "desc" },
        filters: [{ column: "url", query: "test" }],
        timeWindow: null,
        filteredRowIndices: null,
      });
      expect(q.matchedRows).toBe(2);
      const page = await opened.host.handle({
        _tag: "tableRows",
        documentId: opened.info.documentId,
        queryId: q.queryId,
        from: 0,
        count: 10,
      });
      expect(page.rows.map((r) => r.har?.status)).toEqual([503, 201]);
      const second = page.rows[1]!;
      expect(second.har?.host).toBe("api.alpha.test:8443");
      expect(second.har?.bodySize).toBe(512);
      expect(second.cells.status?.editable).toBe(true);
      expect(second.cells.mimeType?.editable).toBe(true);
      expect(second.cells.url?.editable).toBe(true);

      await opened.host.handle({
        _tag: "setValue",
        ref: second.cells.status!.ref!,
        json: "202",
      });
      const qAfter = await opened.host.handle({
        _tag: "tableQuery",
        documentId: opened.info.documentId,
        targetPath: "$.log.entries",
        revision: 1,
        sort: { column: "status", direction: "asc" },
        filters: [],
        timeWindow: null,
        filteredRowIndices: null,
      });
      const pageAfter = await opened.host.handle({
        _tag: "tableRows",
        documentId: opened.info.documentId,
        queryId: qAfter.queryId,
        from: 0,
        count: 10,
      });
      expect(pageAfter.rows[0]?.har?.status).toBe(202);
    } finally {
      await opened.host.handle({ _tag: "close", documentId: opened.info.documentId });
    }
  });

  it("scanHarTableWindowColumnar streams tiny openStream chunks and Blob slices accurately", async () => {
    const entries = [
      {
        startedDateTime: "2026-05-01T10:00:00.100Z",
        time: 12,
        request: { method: "GET", url: "https://s.test/1" },
        response: { status: 200, content: { mimeType: "text/plain", size: 5, text: "hello" } },
      },
      {
        startedDateTime: "2026-05-01T10:00:01.200Z",
        time: 34,
        request: { method: "POST", url: "https://s.test/2" },
        response: {
          status: 404,
          bodySize: 19,
          content: { mimeType: "application/json", size: 19, text: "x".repeat(70000) },
        },
      },
      {
        startedDateTime: "2026-05-01T10:00:02.300Z",
        time: 7,
        request: { method: "PUT", url: "https://s.test/3" },
        response: { status: 500, bodySize: 2, content: { mimeType: "text/html", size: 2 } },
      },
    ];
    const body = entries.map((e) => JSON.stringify(e)).join(", ") + "]";
    const bytes = utf8.encode(body);
    const tinyStreamSrc: ByteSource = {
      ...memorySource(bytes),
      openStream: (start, end) => {
        let pos = start;
        return {
          nextInto: async (buffer, offset, maxLen) => {
            const take = Math.min(97, maxLen, end - pos);
            if (take <= 0) return { bytesRead: 0, buffer };
            new Uint8Array(buffer, offset, take).set(bytes.subarray(pos, pos + take));
            pos += take;
            return { bytesRead: take, buffer };
          },
          close: () => {},
        };
      },
    };
    const colsTiny = await scanHarTableWindowColumnar(
      tinyStreamSrc,
      0,
      bytes.length,
      64 * 1024,
      (s2, from, to) => s2.read(from, to),
    );
    expect(colsTiny.count).toBe(3);
    expect(colsTiny.methods).toEqual(["GET", "POST", "PUT"]);
    expect(colsTiny.nums[0]).toBe(200);
    expect(colsTiny.nums[HAR_COL_STRIDE]).toBe(404);
    expect(colsTiny.nums[2 * HAR_COL_STRIDE]).toBe(500);

    const blobSrc = blobSource(new Blob([bytes]));
    const colsBlob = await scanHarTableWindowColumnar(
      blobSrc,
      0,
      bytes.length,
      64 * 1024,
      (s2, from, to) => s2.read(from, to),
    );
    expect(colsBlob.count).toBe(3);
    expect(colsBlob.urls).toEqual(["https://s.test/1", "https://s.test/2", "https://s.test/3"]);
  });
});
