import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  CHILDREN_PAGE_LIMIT,
  ChildrenPage,
  DocumentNotOpenError,
  EngineError,
  EngineReplyEnvelope,
  EngineRequest,
  EngineRequestEnvelope,
  EngineResult,
  IndexProgress,
  MAX_ERROR_DETAIL_LENGTH,
  MAX_KEY_BYTES,
  MAX_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PATH_RESULTS,
  MAX_PATH_TEXT_LENGTH,
  MAX_PREVIEW_BYTES,
  MAX_QUERY_CHARS,
  MAX_SLICE_BYTES,
  NodeSummary,
  SliceTooLargeError,
  type NodeSummary as NodeSummaryType,
} from "./engine.ts";

const options = { arbitrary: { runs: 200 } };

describe("engine node schemas", () => {
  const decodeNode = Schema.decodeUnknownExit(NodeSummary);
  const encodeNode = Schema.encodeUnknownExit(NodeSummary);

  it.prop(
    "a node summary survives the worker boundary",
    [NodeSummary],
    ([node]) => {
      const encoded = encodeNode(node);
      expect(Exit.isSuccess(encoded)).toBe(true);
      if (Exit.isSuccess(encoded)) {
        expect(decodeNode(structuredClone(encoded.value))).toEqual(Exit.succeed(node));
      }
    },
    options,
  );

  it.prop(
    "a children page round-trips with every node intact",
    [ChildrenPage],
    ([page]) => {
      const encoded = Schema.encodeUnknownSync(ChildrenPage)(page);
      expect(Schema.decodeUnknownSync(ChildrenPage)(structuredClone(encoded) as unknown)).toEqual(
        page,
      );
    },
    options,
  );

  it.prop(
    "index progress round-trips",
    [IndexProgress],
    ([progress]) => {
      expect(Schema.decodeSync(IndexProgress)(Schema.encodeSync(IndexProgress)(progress))).toEqual(
        progress,
      );
    },
    options,
  );

  it("rejects offsets that are negative or fractional", () => {
    const ref = { documentId: 1, tapeId: 0, token: 0 };
    const base = {
      ref,
      kind: "string",
      key: null,
      childCount: 0,
      childrenIndexed: true,
      settled: true,
      span: { start: 0, end: 4 },
    };
    expect(Exit.isFailure(decodeNode({ ...base, range: { start: -1, end: 4 } }))).toBe(true);
    expect(Exit.isFailure(decodeNode({ ...base, range: { start: 0.5, end: 4 } }))).toBe(true);
    expect(
      Exit.isFailure(decodeNode({ ...base, kind: "bigint", range: { start: 0, end: 4 } })),
    ).toBe(true);
    expect(Exit.isSuccess(decodeNode({ ...base, range: { start: 0, end: 4 } }))).toBe(true);
  });

  it("rejects a byte range that ends before it starts", () => {
    const ref = { documentId: 1, tapeId: 0, token: 0 };
    const base = {
      ref,
      kind: "string",
      childCount: 0,
      childrenIndexed: true,
      settled: true,
      span: { start: 4, end: 4 },
    };
    expect(Exit.isFailure(decodeNode({ ...base, key: null, range: { start: 10, end: 4 } }))).toBe(
      true,
    );
    expect(
      Exit.isFailure(
        decodeNode({ ...base, key: { start: 9, end: 2 }, range: { start: 10, end: 14 } }),
      ),
    ).toBe(true);
    expect(Exit.isSuccess(decodeNode({ ...base, key: null, range: { start: 4, end: 4 } }))).toBe(
      true,
    );
  });

  it("decodes a children page at the cap and refuses one node more", () => {
    const decodePage = Schema.decodeUnknownExit(ChildrenPage);
    const node = (token: number): NodeSummaryType => ({
      ref: { documentId: 1, tapeId: 0, token },
      kind: "number",
      range: { start: token * 2, end: token * 2 + 1 },
      span: { start: token * 2, end: token * 2 + 1 },
      key: null,
      childCount: 0,
      childrenIndexed: true,
      settled: true,
    });
    const nodes = Array.from({ length: CHILDREN_PAGE_LIMIT }, (_, index) => node(index + 1));
    const full = decodePage({ from: 0, total: 5_000_000, nodes });
    expect(Exit.isSuccess(full)).toBe(true);
    if (Exit.isSuccess(full)) expect(full.value.nodes).toHaveLength(CHILDREN_PAGE_LIMIT);
    expect(
      Exit.isFailure(
        decodePage({ from: 0, total: 5_000_000, nodes: [...nodes, node(CHILDREN_PAGE_LIMIT + 1)] }),
      ),
    ).toBe(true);
  });
});

describe("engine results", () => {
  it("bound every collection and string the engine returns", () => {
    const decode = <Tag extends keyof typeof EngineResult>(tag: Tag, value: unknown) =>
      Schema.decodeUnknownExit(EngineResult[tag])(value);
    const node = {
      ref: { documentId: 1, tapeId: 0, token: 1 },
      kind: "number",
      range: { start: 0, end: 1 },
      span: { start: 0, end: 1 },
      key: null,
      childCount: 0,
      childrenIndexed: true,
      settled: true,
    };
    const matches = Array.from({ length: MAX_PATH_RESULTS }, () => ({
      node,
      label: "",
      preview: "1",
      path: "$[0]",
    }));
    const paths = (results: ReadonlyArray<unknown>) =>
      decode("pathQuery", { total: results.length, complete: true, results });
    expect(Exit.isSuccess(paths(matches))).toBe(true);
    expect(Exit.isFailure(paths([...matches, matches[0]]))).toBe(true);
    const long = [{ ...matches[0], path: "$" + ".k".repeat(MAX_PATH_TEXT_LENGTH) }];
    expect(Exit.isFailure(paths(long))).toBe(true);

    const row = { node, key: null, preview: { text: "1", truncated: false, bytes: 1 } };
    const rows = (count: number) =>
      decode("rows", { from: 0, total: 5_000_000, rows: Array.from({ length: count }, () => row) });
    expect(Exit.isSuccess(rows(CHILDREN_PAGE_LIMIT))).toBe(true);
    expect(Exit.isFailure(rows(CHILDREN_PAGE_LIMIT + 1))).toBe(true);

    const entry = (url: string) => ({
      entries: null,
      from: 0,
      total: 1,
      pages: [],
      items: [{ ref: node.ref, host: null, pageref: null, method: "GET", url, status: 200 }],
    });
    expect(Exit.isSuccess(decode("harEntries", entry("u".repeat(MAX_PREVIEW_BYTES))))).toBe(true);
    expect(Exit.isFailure(decode("harEntries", entry("u".repeat(MAX_PREVIEW_BYTES + 1))))).toBe(
      true,
    );

    const text = (length: number) => ({ text: "x".repeat(length), truncated: true, bytes: length });
    expect(Exit.isSuccess(decode("text", text(MAX_SLICE_BYTES)))).toBe(true);
    expect(Exit.isFailure(decode("text", text(MAX_SLICE_BYTES + 1)))).toBe(true);

    expect(Exit.isSuccess(decode("keyText", "k".repeat(MAX_KEY_BYTES)))).toBe(true);
    expect(Exit.isFailure(decode("keyText", "k".repeat(MAX_KEY_BYTES + 1)))).toBe(true);

    for (const tag of ["slice", "stringHead", "decodeBase64Head"] as const) {
      expect(Exit.isSuccess(decode(tag, new Uint8Array(MAX_SLICE_BYTES))), tag).toBe(true);
      expect(Exit.isFailure(decode(tag, new Uint8Array(MAX_SLICE_BYTES + 1))), tag).toBe(true);
    }

    const info = (name: string, note: string | null = null) => ({
      documentId: 1,
      name,
      size: 2 ** 31,
      format: "yaml",
      structure: "converted",
      editable: false,
      note,
      recovered: 0,
      journalUnavailable: null,
    });
    expect(Exit.isSuccess(decode("open", info("n".repeat(MAX_NAME_LENGTH))))).toBe(true);
    expect(Exit.isFailure(decode("open", info("n".repeat(MAX_NAME_LENGTH + 1))))).toBe(true);
    expect(Exit.isSuccess(decode("open", info("a.yaml", "w".repeat(MAX_NOTE_LENGTH))))).toBe(true);
    expect(Exit.isFailure(decode("open", info("a.yaml", "w".repeat(MAX_NOTE_LENGTH + 1))))).toBe(
      true,
    );
  });
});

describe("engine requests", () => {
  const decodeRequest = Schema.decodeUnknownExit(EngineRequest);
  const ref = { documentId: 1, tapeId: 0, token: 7 };

  it("accepts every request tag the engine serves and nothing else", () => {
    const requests: ReadonlyArray<unknown> = [
      { _tag: "capabilities" },
      { _tag: "open", source: new Blob(["{}"]), name: "a.json" },
      { _tag: "close", documentId: 1 },
      { _tag: "root", documentId: 1 },
      { _tag: "node", ref },
      { _tag: "children", ref, from: 0, count: CHILDREN_PAGE_LIMIT },
      { _tag: "rows", ref, from: 0, count: CHILDREN_PAGE_LIMIT, previewBytes: MAX_PREVIEW_BYTES },
      { _tag: "harEntries", documentId: 1, from: 0, count: CHILDREN_PAGE_LIMIT },
      { _tag: "text", ref, limit: MAX_SLICE_BYTES },
      { _tag: "keyText", ref },
      { _tag: "slice", documentId: 1, tapeId: 0, range: { start: 0, end: 10 } },
      {
        _tag: "search",
        documentId: 1,
        query: { mode: "literal", text: "application/json", caseSensitive: true },
      },
      { _tag: "searchHits", documentId: 1, searchId: 1, from: 0, to: 100, limit: 50 },
      { _tag: "searchLit", documentId: 1, searchId: 1, ranges: [{ start: 0, end: 4 }] },
      { _tag: "searchHit", documentId: 1, searchId: 1, index: -1 },
      { _tag: "searchSeek", documentId: 1, searchId: 1, offset: 10 },
      { _tag: "searchClose", documentId: 1, searchId: 1 },
      { _tag: "pathQuery", documentId: 1, path: "$..url", limit: 100 },
      { _tag: "jq", ref, program: ".a", timeoutMs: 1000 },
      { _tag: "expandNested", ref },
      { _tag: "largestStrings", documentId: 1, limit: 8 },
      { _tag: "stringHead", ref, bytes: 65536 },
      { _tag: "decodeBase64Head", ref, decodedBytes: 65536 },
      { _tag: "editState", documentId: 1 },
      { _tag: "exportTargets", documentId: 1 },
      {
        _tag: "convert",
        documentId: 1,
        to: "yaml",
        settings: { indent: 2, columns: "first", nested: "json" },
        sink: { _tag: "writable", stream: new WritableStream() },
      },
      { _tag: "setValue", ref, json: '"knot"' },
      { _tag: "setKey", ref, key: "cord" },
      {
        _tag: "replaceBytes",
        documentId: 1,
        tapeId: 0,
        range: { start: 2, end: 6 },
        bytes: new Uint8Array([0x31]),
      },
      { _tag: "undo", documentId: 1 },
      { _tag: "redo", documentId: 1 },
      { _tag: "logicalSlice", documentId: 1, tapeId: 0, range: { start: 0, end: 10 } },
      {
        _tag: "save",
        documentId: 1,
        sink: { _tag: "writable", stream: new WritableStream() },
        indent: 2,
      },
      {
        _tag: "save",
        documentId: 1,
        sink: { _tag: "writable", stream: new WritableStream() },
        indent: null,
      },
      { _tag: "transform", ref, transform: { _tag: "format", indent: 2 } },
      { _tag: "transform", ref, transform: { _tag: "minify" } },
      { _tag: "transform", ref, transform: { _tag: "sortKeys", descending: false } },
      { _tag: "transform", ref, transform: { _tag: "sortArray", field: "id", descending: true } },
    ];
    for (const request of requests) {
      const decoded = decodeRequest(request);
      expect(Exit.isSuccess(decoded), `${(request as { _tag: string })._tag}`).toBe(true);
      if (Exit.isSuccess(decoded)) expect(decoded.value._tag in EngineResult).toBe(true);
    }
    expect(Exit.isFailure(decodeRequest({ _tag: "parse", ref }))).toBe(true);
    expect(Exit.isFailure(decodeRequest({ _tag: "open", source: "{}", name: "a.json" }))).toBe(
      true,
    );
  });

  it("bounds a children page and a slice", () => {
    expect(
      Exit.isFailure(
        decodeRequest({ _tag: "children", ref, from: 0, count: CHILDREN_PAGE_LIMIT + 1 }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(decodeRequest({ _tag: "children", ref, from: 0, count: 0 }))).toBe(true);
    expect(
      Exit.isFailure(decodeRequest({ _tag: "largestStrings", documentId: 1, limit: 65 })),
    ).toBe(true);
    expect(Exit.isFailure(decodeRequest({ _tag: "text", ref, limit: MAX_SLICE_BYTES + 1 }))).toBe(
      true,
    );
    expect(
      Exit.isFailure(
        decodeRequest({
          _tag: "rows",
          ref,
          from: 0,
          count: CHILDREN_PAGE_LIMIT,
          previewBytes: MAX_PREVIEW_BYTES + 1,
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeRequest({
          _tag: "harEntries",
          documentId: 1,
          from: 0,
          count: CHILDREN_PAGE_LIMIT + 1,
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeRequest({
          _tag: "search",
          documentId: 1,
          query: { mode: "literal", text: "", caseSensitive: true },
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeRequest({
          _tag: "searchHits",
          documentId: 1,
          searchId: 1,
          from: 0,
          to: 1,
          limit: 100_000,
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeRequest({ _tag: "pathQuery", documentId: 1, path: "$", limit: 1_000_000 }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(decodeRequest({ _tag: "jq", ref, program: ".", timeoutMs: 10 }))).toBe(
      true,
    );
    const sink = { _tag: "writable", stream: new WritableStream() };
    expect(Exit.isFailure(decodeRequest({ _tag: "save", documentId: 1, sink, indent: 9 }))).toBe(
      true,
    );
    expect(
      Exit.isFailure(
        decodeRequest({
          _tag: "save",
          documentId: 1,
          sink: { _tag: "fileHandle", handle: {} },
          indent: 2,
        }),
      ),
    ).toBe(true);
    const slice = (start: number, end: number) =>
      decodeRequest({ _tag: "slice", documentId: 1, tapeId: 0, range: { start, end } });
    expect(Exit.isSuccess(slice(1024, 1024 + MAX_SLICE_BYTES))).toBe(true);
    expect(Exit.isFailure(slice(1024, 1024 + MAX_SLICE_BYTES + 1))).toBe(true);
    expect(Exit.isFailure(slice(1024, 1023))).toBe(true);
  });

  it("bounds what a search may ask for and what a file may be called", () => {
    const search = (text: string) =>
      decodeRequest({
        _tag: "search",
        documentId: 1,
        query: { mode: "literal", text, caseSensitive: true },
      });
    expect(Exit.isFailure(search(""))).toBe(true);
    expect(Exit.isSuccess(search("a".repeat(MAX_QUERY_CHARS)))).toBe(true);
    expect(Exit.isFailure(search("a".repeat(MAX_QUERY_CHARS + 1)))).toBe(true);
    const open = (name: string) => decodeRequest({ _tag: "open", source: new Blob(["{}"]), name });
    expect(Exit.isSuccess(open("n".repeat(MAX_NAME_LENGTH)))).toBe(true);
    expect(Exit.isFailure(open("n".repeat(MAX_NAME_LENGTH + 1)))).toBe(true);
  });

  it("wraps requests and replies in envelopes the other side can decode", () => {
    const envelope = Schema.decodeSync(EngineRequestEnvelope)({
      id: 3,
      request: { _tag: "node", ref },
    });
    expect(envelope.request._tag).toBe("node");
    const ok = Schema.decodeSync(EngineReplyEnvelope)({
      id: 3,
      ok: true,
      result: "anything",
    });
    expect(ok.ok).toBe(true);
    const failed = Schema.decodeSync(EngineReplyEnvelope)({
      id: 3,
      ok: false,
      error: { _tag: "DocumentNotOpenError", documentId: 9 },
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).toBeInstanceOf(DocumentNotOpenError);
      expect(failed.error.message).toBe("Document 9 is not open in the engine.");
    }
  });
});

describe("engine errors", () => {
  it("encode to plain objects and decode back to the same class", () => {
    const error = new SliceTooLargeError({ bytes: 70_000_000, limit: MAX_SLICE_BYTES });
    const wire = structuredClone(Schema.encodeUnknownSync(EngineError)(error));
    expect(wire).toStrictEqual({
      _tag: "SliceTooLargeError",
      bytes: 70_000_000,
      limit: MAX_SLICE_BYTES,
    });
    const decoded = Schema.decodeSync(EngineError)(wire);
    expect(decoded).toBeInstanceOf(SliceTooLargeError);
    expect(decoded.message).toBe("A 70000000-byte slice exceeds the 67108864-byte limit.");
  });

  it("refuse a worker failure whose detail was not cut", () => {
    const decode = Schema.decodeUnknownExit(EngineError);
    const wire = (detail: string) => ({ _tag: "EngineWorkerError", detail });
    expect(Exit.isSuccess(decode(wire("e".repeat(MAX_ERROR_DETAIL_LENGTH))))).toBe(true);
    expect(Exit.isFailure(decode(wire("e".repeat(MAX_ERROR_DETAIL_LENGTH + 1))))).toBe(true);
  });
});
