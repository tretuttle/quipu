import { afterAll, describe, expect, it } from "@effect/vitest";

import { runDeepSearch } from "./deepSearch.ts";
import { EngineHost } from "./document.ts";
import { createLocalPool } from "./localPool.ts";
import { DEFAULT_CHUNK_OPTIONS } from "./search.ts";
import { buildSampleHarBytes } from "./testing/smallHarFixture.ts";

const utf8 = new TextEncoder();

const gzipBytes = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
};

const toBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const openPoolFor = async (bytes: Uint8Array, workers = 4) => {
  const pool = createLocalPool(workers);
  const copy = bytes.slice();
  await pool.broadcast({
    type: "open",
    sourceId: 1,
    spec: { kind: "memory", buffer: copy.buffer, byteOffset: 0, byteLength: copy.byteLength },
  });
  return pool;
};

const searchDeep = async (
  bytes: Uint8Array,
  needle: string,
  options?: { readonly chunkBytes?: number; readonly workers?: number; readonly regex?: boolean },
) => {
  const pool = await openPoolFor(bytes, options?.workers ?? 4);
  try {
    return await runDeepSearch(
      pool,
      { sourceId: 1, size: bytes.byteLength, decode: true },
      options?.regex
        ? { kind: "regex", source: needle, flags: "iu" }
        : { kind: "literal", needle: utf8.encode(needle), caseSensitive: false },
      {
        chunkBytes: options?.chunkBytes ?? 8 * 1024 * 1024,
        chunk: DEFAULT_CHUNK_OPTIONS,
        budgetMs: null,
        maxSkipped: 8,
        maxRetained: 262_144,
        isCancelled: () => false,
      },
    );
  } finally {
    pool.terminate();
  }
};

describe("deep-decode search", () => {
  it("matches base64 -> json payloads and emits decodeChain and snippet", async () => {
    const payload = JSON.stringify({ token: "tok_hark_smoke", ok: true });
    const doc = utf8.encode(
      JSON.stringify({
        meta: { payloadB64: toBase64(utf8.encode(payload)) },
        other: { payloadB64: toBase64(utf8.encode('{"secret":"b64_secret_4419z"}')) },
      }),
    );

    const res1 = await searchDeep(doc, "tok_hark_smoke");
    expect(res1.count).toBe(1);
    expect(res1.annotations).toHaveLength(1);
    expect(res1.annotations[0]?.decodeChain).toEqual(["base64", "json"]);
    expect(res1.annotations[0]?.snippet).toContain("tok_hark_smoke");

    const res2 = await searchDeep(doc, "b64_secret_4419z");
    expect(res2.count).toBe(1);
    expect(res2.annotations[0]?.decodeChain).toEqual(["base64", "json"]);
  });

  it("matches base64url payloads without padding", async () => {
    const payload = JSON.stringify({ user: "alice_b64url>>>???~~~", role: "reviewer" });
    const doc = utf8.encode(JSON.stringify({ encoded: toBase64Url(utf8.encode(payload)) }));

    const res = await searchDeep(doc, "alice_b64url");
    expect(res.count).toBe(1);
    expect(res.annotations[0]?.decodeChain).toEqual(["base64url", "json"]);
  });

  it("matches gzip + base64 payloads via DecompressionStream", async () => {
    const gz = await gzipBytes(utf8.encode(JSON.stringify({ secret: "gz_canary_9912" })));
    const doc = utf8.encode(JSON.stringify({ body: toBase64(gz) }));

    const res = await searchDeep(doc, "gz_canary_9912");
    expect(res.count).toBe(1);
    expect(res.annotations[0]?.decodeChain).toEqual(["base64", "gzip", "json"]);
  });

  it("matches JWT payload claims (including Bearer prefix)", async () => {
    const header = toBase64Url(utf8.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
    const payload = toBase64Url(
      utf8.encode(JSON.stringify({ sub: "usr_jwt_7741", scope: "read" })),
    );
    const jwt = `Bearer ${header}.${payload}.sig_placeholder_123456`;
    const doc = utf8.encode(JSON.stringify({ auth: jwt }));

    const res = await searchDeep(doc, "usr_jwt_7741");
    expect(res.count).toBe(1);
    expect(res.annotations[0]?.decodeChain).toEqual(["jwt", "json"]);
  });

  it("matches up to 8x nested stringified JSON and enforces max_stringify = 8", async () => {
    let wrapped8 = JSON.stringify({ secret: "nest_8_canary" });
    for (let i = 0; i < 8; i++) wrapped8 = JSON.stringify(wrapped8);
    // Construct a raw JSON document whose string value needs 8 json-string unwraps.
    const doc8 = utf8.encode(`{"deep":${JSON.stringify(wrapped8)}}`);
    const res8 = await searchDeep(doc8, '"secret":"nest_8_canary"');
    expect(res8.count).toBe(1);
    expect(res8.annotations[0]?.decodeChain).toEqual([
      "json-string",
      "json-string",
      "json-string",
      "json-string",
      "json-string",
      "json-string",
      "json-string",
      "json-string",
      "json",
    ]);

    // 9x nested stringification exceeds max_stringify = 8 for escaped quotes.
    let wrapped9 = JSON.stringify({ secret: "nest_9_canary" });
    for (let i = 0; i < 9; i++) wrapped9 = JSON.stringify(wrapped9);
    const doc9 = utf8.encode(`{"deep":${JSON.stringify(wrapped9)}}`);
    const res9 = await searchDeep(doc9, '"secret":"nest_9_canary"');
    expect(res9.count).toBe(0);
  });

  it("matches candidates split across chunk boundaries without duplicates", async () => {
    const payload = JSON.stringify({ user: "split_boundary_usr_42", extra: "x".repeat(64) });
    const b64 = toBase64(utf8.encode(payload));
    const doc = utf8.encode(
      JSON.stringify({
        pad: "0123456789abcdef0123456789abcdef",
        splitHere: b64,
        tail: "done",
      }),
    );

    const res = await searchDeep(doc, "split_boundary_usr_42", { chunkBytes: 48, workers: 4 });
    expect(res.count).toBe(1);
    expect(res.annotations).toHaveLength(1);
    expect(res.annotations[0]?.decodeChain).toEqual(["base64", "json"]);
  });

  it("ignores non-UTF-8 binary base64 payloads", async () => {
    const binary = new Uint8Array(64);
    binary[0] = 0x7b; // '{' followed by invalid UTF-8 bytes
    binary[1] = 0xff;
    binary[2] = 0xfe;
    binary[3] = 0x80;
    for (let i = 4; i < binary.length; i++) binary[i] = 0x41;
    const doc = utf8.encode(JSON.stringify({ blob: toBase64(binary) }));

    const res = await searchDeep(doc, "AAAA");
    expect(res.count).toBe(0);
    expect(res.annotations).toHaveLength(0);
  });

  it("handles encoding:base64 plain text HAR content (hark-order shape)", async () => {
    const har = {
      log: {
        entries: [
          {
            request: { method: "GET", url: "https://api.example.com/smoke" },
            response: {
              status: 200,
              content: {
                size: -1,
                mimeType: "application/json",
                text: toBase64(utf8.encode(JSON.stringify({ token: "tok_hark_smoke", ok: true }))),
                encoding: "base64",
              },
            },
          },
        ],
        version: "1.2",
      },
    };
    const res = await searchDeep(utf8.encode(JSON.stringify(har)), "tok_hark_smoke");
    expect(res.count).toBe(1);
    expect(res.annotations[0]?.decodeChain).toEqual(["base64", "json"]);
  });
});

describe("deep-decode search on sample 147-entry HAR", () => {
  const bytes = buildSampleHarBytes();
  const host = new EngineHost(
    { workers: 4, crossOriginIsolated: true, createPool: createLocalPool },
    { regionBytes: 256 * 1024 },
  );
  const opened = host.handle({ _tag: "open", source: new Blob([bytes]), name: "small.har" });

  afterAll(async () => {
    await host.handle({ _tag: "close", documentId: (await opened).documentId }).catch(() => null);
  });

  it("finds 2/2 hits for usr_8c41f0a9d2e7 including base64 -> json-string -> json-string -> json", async () => {
    const { documentId } = await opened;

    // Plain search keeps zero-regression 1/2 behavior.
    const plain = await host.handle({
      _tag: "search",
      documentId,
      query: { mode: "literal", text: "usr_8c41f0a9d2e7", caseSensitive: false },
    });
    expect(plain.count).toBe(1);

    // Deep search finds 2/2 and emits the exact decodeChain for entry 21.
    const deep = await host.deepSearch(documentId, {
      mode: "literal",
      text: "usr_8c41f0a9d2e7",
      caseSensitive: false,
      deep: true,
    });
    expect(deep.count).toBe(2);
    expect(
      deep.annotations.some(
        (ann) =>
          ann.decodeChain.join(" -> ") === "base64 -> json-string -> json-string -> json" &&
          ann.snippet.includes("usr_8c41f0a9d2e7"),
      ),
    ).toBe(true);
  });

  it("does not double-count sess_Q7mX4zR9kP2vLw8NbT3cYh6D (4/4 hits) and finds triple-escaped NW-2024-118734", async () => {
    const { documentId } = await opened;

    const sess = await host.deepSearch(documentId, {
      mode: "literal",
      text: "sess_Q7mX4zR9kP2vLw8NbT3cYh6D",
      caseSensitive: true,
      deep: true,
    });
    expect(sess.count).toBe(4);

    const triple = await host.deepSearch(documentId, {
      mode: "literal",
      text: "NW-2024-118734",
      caseSensitive: true,
      deep: true,
    });
    expect(triple.count).toBe(3);
    expect(
      triple.annotations.some(
        (ann) => ann.decodeChain.join(" -> ") === "json-string -> json-string -> json",
      ),
    ).toBe(true);
  });
});
