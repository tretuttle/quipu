import {
  CHILDREN_PAGE_LIMIT,
  type DecoderKind,
  type NodeRef,
  type NodeSummary,
  NotDecodableError,
  SliceTooLargeError,
} from "@quipu/contracts/engine";
import { afterAll, describe, expect, it } from "@effect/vitest";

import { EngineHost } from "./document.ts";
import { createLocalPool } from "./localPool.ts";
import {
  decoderHar,
  GRAPHQL_QUERY,
  gzip,
  PNG_1X1,
  SAMPLE_JWT,
  SVG_TEXT,
  toBase64,
} from "./testing/decoderSamples.ts";

const platform = { workers: 4, crossOriginIsolated: true, createPool: createLocalPool };
const utf8 = new TextEncoder();

const sample = await decoderHar();
const host = new EngineHost(platform, { regionBytes: 4096 });
const opened = host.handle({
  _tag: "open",
  source: new Blob([sample.text]),
  name: "decoders.har",
});
afterAll(async () => {
  await host.handle({ _tag: "close", documentId: (await opened).documentId }).catch(() => null);
});

const children = async (node: NodeSummary) =>
  (await host.handle({ _tag: "children", ref: node.ref, from: 0, count: CHILDREN_PAGE_LIMIT }))
    .nodes;

/** Follows object keys and array indexes from the root, the way a user opens rows. */
const at = async (...path: Array<string | number>) => {
  const { documentId } = await opened;
  let node = await host.handle({ _tag: "root", documentId });
  for (const step of path) {
    const kids = await children(node);
    if (typeof step === "number") {
      node = kids[step] as NodeSummary;
    } else {
      let found: NodeSummary | undefined;
      for (const kid of kids) {
        if ((await host.handle({ _tag: "keyText", ref: kid.ref })) === step) found = kid;
      }
      if (!found) throw new Error(`no member ${step}`);
      node = found;
    }
  }
  return node;
};

const entryAt = (i: number, ...rest: Array<string | number>) => at("log", "entries", i, ...rest);
const detect = async (node: NodeSummary) => host.handle({ _tag: "detect", ref: node.ref });
const decode = (node: NodeSummary, kind: DecoderKind) =>
  host.handle({ _tag: "decode", ref: node.ref, kind });
const textOf = async (ref: NodeRef) =>
  (await host.handle({ _tag: "text", ref, limit: 1 << 20 })).text;
const memberText = async (node: NodeSummary, key: string) => {
  for (const kid of await children(node)) {
    if ((await host.handle({ _tag: "keyText", ref: kid.ref })) === key) return textOf(kid.ref);
  }
  throw new Error(`no member ${key}`);
};

describe("decoders in the engine", () => {
  it("names a bearer JWT, decodes its parts, and marks the signature not verified", async () => {
    const headers = await entryAt(0, "request", "headers");
    const authorization = (await children(headers))[0] as NodeSummary;
    const value = (await children(authorization))[1] as NodeSummary;
    expect(await textOf(value.ref)).toBe(`Bearer ${SAMPLE_JWT}`);
    expect(await detect(value)).toEqual([
      { kind: "jwt", label: "JWT · HS256", mime: null, structured: true },
    ]);

    const decoded = await decode(value, "jwt");
    expect(decoded.view).toMatchObject({
      _tag: "jwt",
      algorithm: "HS256",
      verified: false,
      signatureBytes: 32,
      signature: SAMPLE_JWT.split(".")[2],
    });
    if (decoded.view._tag !== "jwt") throw new Error("not a jwt view");
    expect(decoded.view.payload.text).toContain('"name": "Ada Lovelace"');
    // The tree shows the three parts as children of the string's row.
    const parts = await children(decoded.document!.root);
    const names = await Promise.all(parts.map((p) => host.handle({ _tag: "keyText", ref: p.ref })));
    expect(names).toEqual(["header", "payload", "signature"]);
    expect(await textOf(parts[2]!.ref)).toBe("not verified (32 bytes)");
    expect(await memberText(parts[0]!, "alg")).toBe("HS256");
  });

  it("decodes a URL-encoded form body into fields and into child members", async () => {
    const body = await entryAt(0, "request", "postData", "text");
    expect(await detect(body)).toEqual([
      { kind: "form", label: "form", mime: null, structured: true },
    ]);
    const decoded = await decode(body, "form");
    expect(decoded.view).toEqual({
      _tag: "form",
      total: 4,
      fields: [
        { name: "grant_type", value: "password" },
        { name: "username", value: "ada@example.com" },
        { name: "scope", value: "read write" },
        { name: "note", value: "100% a/b" },
      ],
    });
    const members = await children(decoded.document!.root);
    expect(await Promise.all(members.map((m) => textOf(m.ref)))).toEqual([
      "password",
      "ada@example.com",
      "read write",
      "100% a/b",
    ]);
  });

  it("expands stringified JSON, three levels deep, one level at a time", async () => {
    const text = await entryAt(0, "response", "content", "text");
    expect((await detect(text)).map((d) => d.kind)).toEqual(["json"]);
    const first = await decode(text, "json");
    expect(first.document?.root.kind).toBe("object");
    expect(first.view).toMatchObject({ _tag: "text" });
    const inner = (await children(first.document!.root))[1] as NodeSummary;
    expect(await host.handle({ _tag: "keyText", ref: inner.ref })).toBe("inner");
    expect((await detect(inner)).map((d) => d.kind)).toEqual(["json"]);
    const second = await decode(inner, "json");
    const deep = (await children(second.document!.root))[0] as NodeSummary;
    expect(deep.kind).toBe("array");
    expect(deep.childCount).toBe(3);
  });

  it("pretty-prints a GraphQL query inside a JSON request body", async () => {
    const body = await entryAt(1, "request", "postData", "text");
    const expanded = await decode(body, "json");
    const query = (await children(expanded.document!.root))[1] as NodeSummary;
    expect(await host.handle({ _tag: "keyText", ref: query.ref })).toBe("query");
    const found = await detect(query);
    expect(found).toEqual([
      { kind: "graphql", label: "GraphQL · query Products", mime: null, structured: true },
    ]);
    const decoded = await decode(query, "graphql");
    if (decoded.view._tag !== "text") throw new Error("not text");
    expect(decoded.view.value.text.split("\n").slice(0, 3)).toEqual([
      "query Products($first: Int!, $after: String) {",
      "  products(first: $first, after: $after) {",
      "    edges {",
    ]);
    expect(decoded.view.value.text.length).toBeGreaterThan(GRAPHQL_QUERY.length);
  });

  it("previews a base64 PNG as an image and says what it is", async () => {
    const text = await entryAt(2, "response", "content", "text");
    const found = await detect(text);
    expect(found).toEqual([
      { kind: "base64", label: "base64 · image/png", mime: "image/png", structured: false },
    ]);
    const decoded = await decode(text, "base64");
    expect(decoded.view).toEqual({ _tag: "image", mime: "image/png", bytes: PNG_1X1.length });
    expect(decoded.layers).toEqual(["base64"]);
    const preview = await host.handle({ _tag: "preview", ref: text.ref });
    expect(preview.mime).toBe("image/png");
    expect(preview.blob.type).toBe("image/png");
    expect(Array.from(new Uint8Array(await preview.blob.arrayBuffer()))).toEqual(
      Array.from(PNG_1X1),
    );
  });

  it("previews an SVG as an image, typed image/svg+xml", async () => {
    const text = await entryAt(3, "response", "content", "text");
    const decoded = await decode(text, "base64");
    expect(decoded.view).toEqual({
      _tag: "image",
      mime: "image/svg+xml",
      bytes: utf8.encode(SVG_TEXT).length,
    });
    const preview = await host.handle({ _tag: "preview", ref: text.ref });
    expect(preview.blob.type).toBe("image/svg+xml");
    expect(await preview.blob.text()).toBe(SVG_TEXT);
  });

  it("previews an SVG body held as text as an image, drawn from a Blob and not inline", async () => {
    const text = await entryAt(7, "response", "content", "text");
    expect(await detect(text)).toEqual([
      { kind: "svg", label: "SVG image", mime: "image/svg+xml", structured: false },
    ]);
    const decoded = await decode(text, "svg");
    expect(decoded.view).toEqual({
      _tag: "image",
      mime: "image/svg+xml",
      bytes: utf8.encode(SVG_TEXT).length,
    });
    const preview = await host.handle({ _tag: "preview", ref: text.ref });
    expect(preview.blob.type).toBe("image/svg+xml");
    expect(await preview.blob.text()).toBe(SVG_TEXT);
  });

  it("inflates a gzip body inside base64 and shows the JSON it holds as children", async () => {
    const text = await entryAt(4, "response", "content", "text");
    const decoded = await decode(text, "base64");
    expect(decoded.layers).toEqual(["base64", "gzip"]);
    expect(decoded.mime).toBe("application/json");
    const root = decoded.document!.root;
    expect(root.kind).toBe("object");
    const members = await children(root);
    expect(
      await Promise.all(members.map((m) => host.handle({ _tag: "keyText", ref: m.ref }))),
    ).toEqual(["gzipped", "rows"]);
  });

  it("splits an NDJSON body into lines, each a document of its own", async () => {
    const text = await entryAt(5, "response", "content", "text");
    expect((await detect(text)).map((d) => d.kind)).toEqual(["ndjson"]);
    const decoded = await decode(text, "ndjson");
    expect(decoded.view).toEqual({
      _tag: "lines",
      total: 3,
      lines: ['{"id":1,"kind":"a"}', '{"id":2,"kind":"b"}', '{"id":3,"kind":"c"}'],
    });
    const lines = await children(decoded.document!.root);
    expect(lines.length).toBe(3);
    expect(await memberText(lines[2]!, "kind")).toBe("c");
  });

  it("lists WebSocket frames with direction, opcode, size and what each carries", async () => {
    const messages = await entryAt(6, "_webSocketMessages");
    const page = await host.handle({ _tag: "frames", ref: messages.ref, from: 0, count: 10 });
    expect(page.total).toBe(4);
    expect(page.frames.map((f) => [f.direction, f.opcode, f.preview.slice(0, 18)])).toEqual([
      ["send", 1, '{"op":"subscribe",'],
      ["receive", 1, '{"ch":"trades","px'],
      ["receive", 2, ""],
      ["receive", 1, "plain ping"],
    ]);
    expect(page.frames[0]?.detections.map((d) => d.kind)).toEqual(["json"]);
    expect(page.frames[2]).toMatchObject({ mime: "image/png", size: PNG_1X1.length });
    expect(page.frames[3]?.detections).toEqual([]);
    expect(page.frames[0]?.time).toBe(1.5);
  });

  it("refuses to decode what a string is not", async () => {
    const url = await entryAt(0, "request", "url");
    expect(await detect(url)).toEqual([]);
    await expect(decode(url, "jwt")).rejects.toBeInstanceOf(NotDecodableError);
    await expect(decode(url, "base64")).rejects.toBeInstanceOf(NotDecodableError);
  });

  it("returns one document for repeated expansions of the same value", async () => {
    const text = await entryAt(0, "response", "content", "text");
    const a = await decode(text, "json");
    const b = await decode(text, "json");
    expect(b.document?.root.ref).toEqual(a.document?.root.ref);
  });
});

/** A HAR-shaped document whose one string is built from 3 MiB pieces of base64, never one JS string. */
const bigBase64Har = (head: Uint8Array, megabytes: number) => {
  const piece = new Uint8Array(3 * 1024 * 1024);
  const parts: BlobPart[] = [
    '{"log":{"entries":[{"response":{"content":{"mimeType":"image/png","encoding":"base64","text":"',
  ];
  const first = piece.slice();
  first.set(head);
  parts.push(toBase64(first));
  for (let i = 1; i < megabytes / 3; i++) parts.push(toBase64(piece));
  parts.push('"}}}]}}');
  return new Blob(parts);
};

describe("decoders refuse what is too big, and say so", () => {
  const big = new EngineHost(platform, { regionBytes: 8 * 1024 * 1024 });
  const content = async (source: Blob) => {
    const info = await big.handle({ _tag: "open", source, name: "big.har" });
    const root = await big.handle({ _tag: "root", documentId: info.documentId });
    const walk = async (node: NodeSummary, key: string) => {
      const page = await big.handle({ _tag: "children", ref: node.ref, from: 0, count: 8 });
      for (const kid of page.nodes) {
        if ((await big.handle({ _tag: "keyText", ref: kid.ref })) === key) return kid;
      }
      throw new Error(key);
    };
    const log = await walk(root, "log");
    const entries = await walk(log, "entries");
    const entry = (await big.handle({ _tag: "children", ref: entries.ref, from: 0, count: 1 }))
      .nodes[0]!;
    const response = await walk(entry, "response");
    const body = await walk(response, "content");
    return { info, text: await walk(body, "text") };
  };

  it("shows a 72 MiB image's type and size but will not make a preview of it", async () => {
    const { text } = await content(bigBase64Har(PNG_1X1, 72));
    const decoded = await big.handle({ _tag: "decode", ref: text.ref, kind: "base64" });
    expect(decoded.mime).toBe("image/png");
    expect(decoded.document).toBeNull();
    expect(decoded.bytes).toBeGreaterThan(70 * 1024 * 1024);
    await expect(big.handle({ _tag: "preview", ref: text.ref })).rejects.toBeInstanceOf(
      SliceTooLargeError,
    );
  }, 60_000);

  it("stops inflating a gzip bomb at the limit", async () => {
    const bomb = await gzip(new Uint8Array(70 * 1024 * 1024));
    const source = new Blob([
      '{"log":{"entries":[{"response":{"content":{"mimeType":"application/gzip","encoding":"base64","text":"',
      toBase64(bomb),
      '"}}}]}}',
    ]);
    const { text } = await content(source);
    await expect(
      big.handle({ _tag: "decode", ref: text.ref, kind: "base64" }),
    ).rejects.toBeInstanceOf(SliceTooLargeError);
  }, 60_000);
});

describe("data: URLs", () => {
  const png = toBase64(PNG_1X1);
  const json = toBase64(utf8.encode('{"page":2,"size":10}'));
  const own = new EngineHost(platform, { regionBytes: 4096 });
  // As a serializer writes them: one with its `/` escaped, as PHP does.
  const source = `{"icon":"data:image/png;base64,${png}","escaped":"data:image\\/png;base64,${png}","cursor":"data:application/json;base64,${json}","plain":"data:text/plain,hello%20world"}`;
  const document = own.handle({ _tag: "open", source: new Blob([source]), name: "urls.json" });
  afterAll(async () => {
    await own.handle({ _tag: "close", documentId: (await document).documentId }).catch(() => null);
  });

  const member = async (key: string) => {
    const root = await own.handle({ _tag: "root", documentId: (await document).documentId });
    const kids = (
      await own.handle({ _tag: "children", ref: root.ref, from: 0, count: CHILDREN_PAGE_LIMIT })
    ).nodes;
    for (const kid of kids) {
      if ((await own.handle({ _tag: "keyText", ref: kid.ref })) === key) return kid;
    }
    throw new Error(`no member ${key}`);
  };

  it("decodes the payload after the comma, with the type the URL names, and previews an image", async () => {
    for (const key of ["icon", "escaped"]) {
      const node = await member(key);
      const decoded = await own.handle({ _tag: "decode", ref: node.ref, kind: "base64" });
      expect(decoded.label, key).toBe("base64 · image/png");
      expect(decoded.view, key).toEqual({
        _tag: "image",
        mime: "image/png",
        bytes: PNG_1X1.length,
      });
      const preview = await own.handle({ _tag: "preview", ref: node.ref });
      expect(Array.from(new Uint8Array(await preview.blob.arrayBuffer())), key).toEqual(
        Array.from(PNG_1X1),
      );
    }
  });

  it("shows JSON held in a data: URL as text, and as a document of its own", async () => {
    const node = await member("cursor");
    const decoded = await own.handle({ _tag: "decode", ref: node.ref, kind: "base64" });
    expect(decoded.mime).toBe("application/json");
    expect(decoded.view._tag).toBe("text");
    expect(decoded.view._tag === "text" ? decoded.view.value.text : "").toContain('"page": 2');
    expect(decoded.document).not.toBeNull();
  });

  it("offers nothing for a data: URL that is not base64", async () => {
    const node = await member("plain");
    expect(await own.handle({ _tag: "detect", ref: node.ref })).toEqual([]);
  });
});
