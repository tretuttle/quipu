/**
 * Encoded values for the decoder tests, built from parts so each test can say
 * what it expects. Every fixture is a real encoding of a known value: a valid
 * PNG, a real gzip stream, JWTs with a fixed made-up signature, form bodies written
 * with `encodeURIComponent`.
 */
const utf8 = new TextEncoder();

export const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

export const toBase64Url = (bytes: Uint8Array) =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** A 1×1 transparent PNG: the smallest real image, 68 bytes. */
export const PNG_1X1 = fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);

export const SVG_TEXT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>';

/** A JPEG header followed by filler: enough to be named a JPEG, not enough to draw. */
export const jpegLike = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  for (let i = 11; i < size; i++) bytes[i] = (i * 31) & 0xff;
  return bytes;
};

export const gzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** A compact JWS with an HS256 header and a made-up signature. */
export const jwt = (
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  signature: Uint8Array = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff),
) =>
  [
    toBase64Url(utf8.encode(JSON.stringify(header))),
    toBase64Url(utf8.encode(JSON.stringify(payload))),
    toBase64Url(signature),
  ].join(".");

export const SAMPLE_JWT = jwt(
  { alg: "HS256", typ: "JWT" },
  { sub: "1234567890", name: "Ada Lovelace", iat: 1516239022, exp: 1916239022 },
);

export const formBody = (pairs: ReadonlyArray<readonly [string, string]>) =>
  pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%20/g, "+")}`)
    .join("&");

export const GRAPHQL_QUERY =
  "query Products($first: Int!, $after: String) { products(first: $first, after: $after) { edges { node { id title price { amount currencyCode } } } pageInfo { hasNextPage endCursor } } }";

export const ndjsonBody = (rows: ReadonlyArray<unknown>) =>
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

/** A DevTools-shaped HAR holding one of each decodable value. */
export const decoderHar = async () => {
  const gz = await gzip(utf8.encode(JSON.stringify({ gzipped: true, rows: [1, 2, 3] })));
  const form = formBody([
    ["grant_type", "password"],
    ["username", "ada@example.com"],
    ["scope", "read write"],
    ["note", "100% a/b"],
  ]);
  const graphqlBody = JSON.stringify({
    operationName: "Products",
    query: GRAPHQL_QUERY,
    variables: { first: 2 },
  });
  const nested = JSON.stringify({
    status: "ok",
    inner: JSON.stringify({ deep: [1, 2, { x: "y" }] }),
  });
  const entry = (
    url: string,
    request: Record<string, unknown>,
    content: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => ({
    request: { method: "POST", url, headers: [], ...request },
    response: { status: 200, headers: [], content },
    ...extra,
  });
  const frames = [
    { type: "send", time: 1.5, opcode: 1, data: JSON.stringify({ op: "subscribe", ch: "trades" }) },
    { type: "receive", time: 1.75, opcode: 1, data: JSON.stringify({ ch: "trades", px: 61000.5 }) },
    { type: "receive", time: 1.8, opcode: 2, data: toBase64(PNG_1X1) },
    { type: "receive", time: 2, opcode: 1, data: "plain ping" },
  ];
  const har = {
    log: {
      version: "1.2",
      creator: { name: "WebInspector", version: "537.36" },
      entries: [
        entry(
          "https://example.test/login",
          {
            headers: [{ name: "Authorization", value: `Bearer ${SAMPLE_JWT}` }],
            postData: { mimeType: "application/x-www-form-urlencoded", text: form },
          },
          { size: 12, mimeType: "application/json", text: nested },
        ),
        entry(
          "https://example.test/graphql",
          { postData: { mimeType: "application/json", text: graphqlBody } },
          { size: 4, mimeType: "application/json", text: '{"data":null}' },
        ),
        entry(
          "https://example.test/logo.png",
          { method: "GET" },
          {
            size: PNG_1X1.length,
            mimeType: "image/png",
            text: toBase64(PNG_1X1),
            encoding: "base64",
          },
        ),
        entry(
          "https://example.test/icon.svg",
          { method: "GET" },
          {
            size: SVG_TEXT.length,
            mimeType: "image/svg+xml",
            text: toBase64(utf8.encode(SVG_TEXT)),
            encoding: "base64",
          },
        ),
        entry(
          "https://example.test/data.json.gz",
          { method: "GET" },
          { size: gz.length, mimeType: "application/gzip", text: toBase64(gz), encoding: "base64" },
        ),
        entry(
          "https://example.test/events",
          { method: "GET" },
          {
            size: 40,
            mimeType: "application/x-ndjson",
            text: ndjsonBody([
              { id: 1, kind: "a" },
              { id: 2, kind: "b" },
              { id: 3, kind: "c" },
            ]),
          },
        ),
        entry(
          "wss://example.test/stream",
          { method: "GET" },
          { size: 0, mimeType: "x-unknown" },
          { _webSocketMessages: frames, _resourceType: "websocket" },
        ),
        entry(
          "https://example.test/mark.svg",
          { method: "GET" },
          { size: SVG_TEXT.length, mimeType: "image/svg+xml", text: SVG_TEXT },
        ),
      ],
    },
  };
  return { text: JSON.stringify(har), har, form, graphqlBody, nested, frames, gzipped: gz };
};
