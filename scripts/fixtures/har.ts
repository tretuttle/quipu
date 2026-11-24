/**
 * HAR generator that writes the fields and shapes Chrome DevTools exports.
 * Entries stream to the sink one at a time; the ≥ 600 MiB base64 body and the
 * big nested stringified bodies stream in pieces through a sentinel split so no
 * body is ever a whole string. Shapes and sizes come from ./distributions.ts.
 */
import { HAR } from "./distributions.ts";
import {
  escape,
  formBody,
  graphqlRequest,
  jsonResponse,
  ndjsonResponse,
  stringifiedResponse,
  writeJsonArray,
} from "./jsonBody.ts";
import type { Prng } from "./prng.ts";
import type { Sink } from "./sink.ts";
import { base64, hex, hosts, isoDate, jwt, prose, sentence, uuid, weighted, word } from "./text.ts";

export interface HarOptions {
  readonly sink: Sink;
  readonly prng: Prng;
  /** Stop adding entries once the file reaches this many bytes. */
  readonly targetBytes: number;
  /** Length in base64 characters of the single huge response body. */
  readonly bigBodyChars: number;
  /** Escaped byte sizes of the large nested stringified bodies, placed across the file. */
  readonly nestedBodyBytes: ReadonlyArray<number>;
}

const BODY_SENTINEL = "\u0000BODY\u0000";
const SENTINEL_JSON = JSON.stringify(BODY_SENTINEL).slice(1, -1);
const BASE64_PIECE_CHARS = 4 * 1024 * 1024;
const CAPTURE_START_MS = 1_791_704_400_000; // 2026-10-11T07:40:00Z
const EPOCH_SECONDS = 1_760_000_000;

const USER_AGENTS = [
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
];

type BodyKind = (typeof HAR.bodyKinds)[number]["value"] | "nested" | "bigBody";

/** What an entry is forced to carry so every file has each required feature at least once. */
interface Force {
  readonly post?: "graphql" | "application/x-www-form-urlencoded";
  readonly jwtHeader?: boolean;
  readonly stringifiedDepth?: number;
}

/** Features every HAR fixture carries, however small: forced in once if chance left them out. */
const REQUIRED: ReadonlyArray<{ readonly kind: BodyKind; readonly force: Force }> = [
  { kind: "websocket", force: {} },
  { kind: "image", force: {} },
  { kind: "ndjson", force: {} },
  { kind: "json", force: { stringifiedDepth: 3 } },
  { kind: "json", force: { post: "graphql" } },
  { kind: "json", force: { post: "application/x-www-form-urlencoded" } },
  { kind: "json", force: { jwtHeader: true } },
];

export const writeHar = ({
  sink,
  prng,
  targetBytes,
  bigBodyChars,
  nestedBodyBytes,
}: HarOptions) => {
  const pagePrng = prng.fork("pages");
  // Pages are known up front only in a real capture; here their count follows the byte target.
  const pageCount = Math.max(1, Math.round(targetBytes / (HAR.entriesPerPage.median * 33_000)));
  const pageHosts: string[][] = [];
  const pageRefs: string[] = [];
  let clock = CAPTURE_START_MS;
  sink.write(
    '{"log":{"version":"1.2","creator":{"name":"WebInspector","version":"537.36"},"pages":[',
  );
  for (let i = 0; i < pageCount; i++) {
    const id = `page_${i + 1}`;
    pageRefs.push(id);
    pageHosts.push(hosts(pagePrng, HAR.hostsPerPage));
    const page = {
      startedDateTime: isoDate(clock + i * 60_000),
      id,
      title: `https://${pageHosts[i]?.[0]}/${word(pagePrng)}/${word(pagePrng)}`,
      pageTimings: {
        onContentLoad: pagePrng.range(200, 2500) + pagePrng.float(),
        onLoad: pagePrng.range(800, 9000) + pagePrng.float(),
      },
    };
    sink.write((i === 0 ? "" : ",") + JSON.stringify(page));
  }
  sink.write('],"entries":[');

  let pageIndex = 0;
  let entryIndex = 0;
  let entriesLeftOnPage = 0;
  let bigBodyWritten = bigBodyChars === 0;
  const nestedQueue = nestedBodyBytes.map((bytes, i) => ({
    bytes,
    at: targetBytes * (0.1 + 0.15 * i),
  }));
  const seen = {
    websocket: false,
    image: false,
    ndjson: false,
    deep3: false,
    graphql: false,
    form: false,
    jwt: false,
  };
  const forced = [...REQUIRED];
  const nextEntry = (
    entryPrng: Prng,
    hostList: ReadonlyArray<string>,
    pageref: string,
    kind: BodyKind,
    nestedBytes: number | undefined,
    force: Force,
  ) => {
    const made = entry(entryPrng, hostList, pageref, clock, kind, nestedBytes, force);
    if (made.kind === "websocket") seen.websocket = true;
    if (made.kind === "image") seen.image = true;
    if (made.kind === "ndjson") seen.ndjson = true;
    if (made.stringifiedDepth >= 3) seen.deep3 = true;
    if (made.post === "graphql") seen.graphql = true;
    if (made.post === "application/x-www-form-urlencoded") seen.form = true;
    if (made.jwtHeader) seen.jwt = true;
    return made.value;
  };
  const missing = () =>
    forced.filter((f) =>
      f.kind === "websocket"
        ? !seen.websocket
        : f.kind === "image"
          ? !seen.image
          : f.kind === "ndjson"
            ? !seen.ndjson
            : f.force.stringifiedDepth !== undefined
              ? !seen.deep3
              : f.force.post === "graphql"
                ? !seen.graphql
                : f.force.post !== undefined
                  ? !seen.form
                  : !seen.jwt,
    );

  while (sink.size() < targetBytes || !bigBodyWritten || missing().length > 0) {
    if (entriesLeftOnPage === 0) {
      entriesLeftOnPage = prng.logNormal(HAR.entriesPerPage.median, HAR.entriesPerPage.sigma);
      pageIndex = Math.min(pageIndex + 1, pageRefs.length);
    }
    entriesLeftOnPage--;
    clock += prng.range(1, 400);
    const pageref = pageRefs[pageIndex - 1] ?? "page_1";
    const hostList = pageHosts[pageIndex - 1] ?? (pageHosts[0] as string[]);
    const size = sink.size();

    let kind: BodyKind = weighted(prng, HAR.bodyKinds);
    let nestedBytes: number | undefined;
    let force: Force = {};
    if (!bigBodyWritten && size >= targetBytes * 0.35) kind = "bigBody";
    else {
      const next = nestedQueue[0];
      if (next && size >= next.at) {
        nestedQueue.shift();
        kind = "nested";
        nestedBytes = next.bytes;
      } else if (size >= targetBytes) {
        // Past the target only the required features are still missing: force them in.
        const need = missing()[0];
        if (need) {
          kind = need.kind;
          force = need.force;
        }
      }
    }

    if (entryIndex > 0) sink.write(",");
    entryIndex++;
    const entryPrng = prng.fork(`entry-${entryIndex}`);
    if (kind === "bigBody") {
      writeBigBodyEntry(sink, entryPrng, hostList, pageref, clock, bigBodyChars);
      bigBodyWritten = true;
    } else if (kind === "nested" && nestedBytes !== undefined && nestedBytes > 65_536) {
      writeBigNestedEntry(sink, entryPrng, hostList, pageref, clock, nestedBytes);
    } else {
      sink.write(
        JSON.stringify(
          nextEntry(
            entryPrng,
            hostList,
            pageref,
            kind === "nested" ? "json" : kind,
            nestedBytes,
            force,
          ),
        ),
      );
    }
  }
  sink.write("]}}\n");
  return { entries: entryIndex, pages: pageRefs.length };
};

const headerPairs = (
  prng: Prng,
  names: ReadonlyArray<readonly [string, (p: Prng) => string]>,
  count: number,
) => {
  const out: { name: string; value: string }[] = [];
  for (let i = 0; i < Math.min(count, names.length); i++) {
    const [name, make] = names[i] as readonly [string, (p: Prng) => string];
    out.push({ name, value: make(prng) });
  }
  return out;
};

const REQUEST_HEADERS: ReadonlyArray<readonly [string, (p: Prng) => string]> = [
  [":authority", (p) => `${word(p)}.example`],
  [":method", () => "GET"],
  [":path", (p) => `/${word(p)}/${word(p)}`],
  [":scheme", () => "https"],
  [
    "accept",
    (p) =>
      p.pick([
        "*/*",
        "application/json, text/plain, */*",
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      ]),
  ],
  ["accept-encoding", () => "gzip, deflate, br, zstd"],
  [
    "accept-language",
    (p) => p.pick(["en-US,en;q=0.9", "fr-FR,fr;q=0.9,en;q=0.8", "ja,en-US;q=0.9"]),
  ],
  ["user-agent", (p) => p.pick(USER_AGENTS)],
  [
    "cookie",
    (p) => `session=${hex(p, 16)}; _ga=GA1.1.${p.int(1e9)}.${p.int(1e9)}; theme=${word(p)}`,
  ],
  ["referer", (p) => `https://${word(p)}.example/${word(p)}`],
  ["sec-ch-ua", () => '"Chromium";v="148", "Not-A.Brand";v="24"'],
  ["sec-ch-ua-mobile", () => "?0"],
  ["sec-ch-ua-platform", () => '"Linux"'],
  ["sec-fetch-dest", (p) => p.pick(["empty", "document", "script", "image"])],
  ["sec-fetch-mode", (p) => p.pick(["cors", "navigate", "no-cors"])],
  ["sec-fetch-site", (p) => p.pick(["same-origin", "cross-site", "same-site"])],
  ["x-request-id", (p) => uuid(p)],
  ["cache-control", () => "no-cache"],
  ["pragma", () => "no-cache"],
  ["priority", (p) => p.pick(["u=0, i", "u=1, i", "u=4"])],
  ["origin", (p) => `https://${word(p)}.example`],
];

const RESPONSE_HEADERS: ReadonlyArray<readonly [string, (p: Prng) => string]> = [
  [
    "content-type",
    (p) =>
      p.pick([
        "application/json; charset=utf-8",
        "text/html; charset=utf-8",
        "image/png",
        "application/javascript",
      ]),
  ],
  ["date", (p) => isoDate(CAPTURE_START_MS + p.int(1e8))],
  ["server", (p) => p.pick(["cloudflare", "nginx/1.27.2", "AmazonS3", "Vercel", "envoy"])],
  [
    "cache-control",
    (p) =>
      p.pick([
        "no-cache",
        "public, max-age=31536000, immutable",
        "private, max-age=0, must-revalidate",
      ]),
  ],
  ["etag", (p) => `W/"${hex(p, 12)}"`],
  ["content-encoding", (p) => p.pick(["br", "gzip", "zstd"])],
  ["vary", () => "Accept-Encoding, Origin"],
  ["x-request-id", (p) => uuid(p)],
  ["cf-ray", (p) => `${hex(p, 8)}-${p.pick(["SJC", "AMS", "NRT", "FRA"])}`],
  ["strict-transport-security", () => "max-age=63072000; includeSubDomains; preload"],
  [
    "content-security-policy",
    (p) => `default-src 'self'; script-src 'self' 'nonce-${hex(p, 8)}'; img-src * data:`,
  ],
  ["access-control-allow-origin", (p) => `https://${word(p)}.example`],
  ["x-content-type-options", () => "nosniff"],
  ["alt-svc", () => 'h3=":443"; ma=86400'],
  ["age", (p) => String(p.int(100_000))],
  ["via", (p) => `1.1 ${hex(p, 6)}.cloudfront.net (CloudFront)`],
  ["x-cache", (p) => p.pick(["Hit from cloudfront", "Miss from cloudfront"])],
  ["timing-allow-origin", () => "*"],
  [
    "report-to",
    (p) =>
      JSON.stringify({
        group: "cf-nel",
        max_age: 604800,
        endpoints: [{ url: `https://a.nel.${word(p)}.example/report/v4?s=${hex(p, 24)}` }],
      }),
  ],
  ["nel", () => '{"success_fraction":0,"report_to":"cf-nel","max_age":604800}'],
  ["x-powered-by", (p) => p.pick(["Next.js", "Express", "PHP/8.3.1"])],
  ["link", (p) => `</${word(p)}.css>; rel=preload; as=style`],
  ["content-length", (p) => String(p.int(1e6))],
  ["accept-ranges", () => "bytes"],
  ["last-modified", (p) => isoDate(CAPTURE_START_MS - p.int(1e9))],
  ["expires", (p) => isoDate(CAPTURE_START_MS + p.int(1e9))],
  ["x-frame-options", () => "SAMEORIGIN"],
  ["referrer-policy", () => "strict-origin-when-cross-origin"],
  ["permissions-policy", () => "camera=(), microphone=()"],
  ["cross-origin-resource-policy", () => "cross-origin"],
  ["x-xss-protection", () => "0"],
  [
    "set-cookie",
    (p) =>
      `session=${hex(p, 16)}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${isoDate(CAPTURE_START_MS + p.int(1e9))}`,
  ],
  ["cf-cache-status", (p) => p.pick(["HIT", "MISS", "DYNAMIC"])],
  ["x-served-by", (p) => `cache-${word(p)}-${hex(p, 2)}`],
  ["content-disposition", () => "inline"],
  ["x-amz-request-id", (p) => hex(p, 8).toUpperCase()],
  ["x-ratelimit-remaining", (p) => String(p.int(5000))],
];

const cookies = (prng: Prng, count: number) => {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      name: prng.pick(["session", "_ga", "_gid", "theme", "csrf", "locale", "ab_test", "consent"]),
      value: prng.chance(0.3) ? hex(prng, 16) : `${word(prng)}-${prng.int(1e6)}`,
      path: "/",
      domain: `.${word(prng)}.example`,
      expires: prng.chance(0.3) ? null : isoDate(CAPTURE_START_MS + prng.int(1e9)),
      httpOnly: prng.chance(0.5),
      secure: prng.chance(0.8),
      sameSite: prng.pick(["Lax", "Strict", "None"]),
    });
  }
  return out;
};

const request = (prng: Prng, hostList: ReadonlyArray<string>, kind: BodyKind, force: Force) => {
  const host = prng.pick(hostList);
  const pathLength = prng.quantile(HAR.urlLength);
  let path = "";
  while (path.length < pathLength * 0.6)
    path += `/${word(prng)}${prng.chance(0.3) ? `-${prng.int(10_000)}` : ""}`;
  const queryCount = prng.pick(HAR.queryParams);
  const query = Array.from({ length: queryCount }, () => ({
    name: word(prng),
    value: prng.chance(0.5) ? word(prng) : String(prng.int(1e6)),
  }));
  let method = force.post !== undefined ? "POST" : weighted(prng, HAR.methods);
  const postMime = force.post ?? (method === "POST" ? weighted(prng, HAR.postMime) : null);
  if (kind === "websocket") method = "GET";
  const url = `https://${host}${path}${query.length ? `?${query.map((q) => `${q.name}=${encodeURIComponent(q.value)}`).join("&")}` : ""}`;
  const headers = headerPairs(prng, REQUEST_HEADERS, prng.quantile(HAR.requestHeaders));
  const jwtHeader = force.jwtHeader === true || prng.chance(HAR.jwtShare);
  if (jwtHeader)
    headers.push({ name: "authorization", value: `Bearer ${jwt(prng, EPOCH_SECONDS)}` });
  const base = {
    method,
    url,
    httpVersion: prng.pick(["http/2.0", "h3", "HTTP/1.1"]),
    headers,
    queryString: query,
    cookies: cookies(prng, prng.pick(HAR.requestCookies)),
    headersSize: -1,
    bodySize: 0,
  };
  const meta = { post: postMime, jwtHeader };
  if (postMime === null) return { value: base, ...meta };
  if (postMime === "graphql") {
    const text = graphqlRequest(prng);
    return {
      value: { ...base, bodySize: text.length, postData: { mimeType: "application/json", text } },
      ...meta,
    };
  }
  if (postMime === "application/x-www-form-urlencoded") {
    const text = formBody(prng);
    return {
      value: {
        ...base,
        bodySize: text.length,
        postData: {
          mimeType: postMime,
          text,
          params: text.split("&").map((pair) => {
            const [name = "", value = ""] = pair.split("=");
            return { name, value };
          }),
        },
      },
      ...meta,
    };
  }
  const bytes = prng.quantile(
    postMime === "application/json"
      ? HAR.postDataBytes["application/json"]
      : HAR.postDataBytes["text/plain"],
  );
  const text =
    postMime === "application/json"
      ? JSON.stringify({ id: uuid(prng), action: word(prng), payload: prose(prng, bytes) })
      : prose(prng, bytes);
  return {
    value: { ...base, bodySize: text.length, postData: { mimeType: postMime, text } },
    ...meta,
  };
};

const responseBody = (
  prng: Prng,
  kind: BodyKind,
  nestedBytes: number | undefined,
  force: Force,
) => {
  const bytes = (key: keyof typeof HAR.bodyBytes) => prng.quantile(HAR.bodyBytes[key]);
  switch (kind) {
    case "json": {
      const depth =
        force.stringifiedDepth ??
        (nestedBytes === undefined ? weighted(prng, HAR.stringifiedDepth) : 3);
      const size = nestedBytes ?? bytes("json");
      return {
        mimeType: "application/json",
        text:
          depth === 0
            ? jsonResponse(prng, size, prng.chance(HAR.jwtShare * 20))
            : stringifiedResponse(prng, size, depth),
        stringifiedDepth: depth,
      };
    }
    case "ndjson":
      return { mimeType: "application/x-ndjson", text: ndjsonResponse(prng, bytes("ndjson")) };
    case "html": {
      const size = bytes("html");
      let html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${sentence(prng)}</title></head><body>`;
      while (html.length < size) html += `<p class="${word(prng)}">${sentence(prng)}</p>\n`;
      return { mimeType: "text/html", text: `${html}</body></html>` };
    }
    case "script": {
      const size = bytes("script");
      let js = "";
      while (js.length < size)
        js += `function ${word(prng)}_${prng.int(1000)}(a,b){return a+b*${prng.int(100)};} // ${sentence(prng)}\n`;
      return { mimeType: prng.pick(["text/javascript", "application/javascript"]), text: js };
    }
    case "css": {
      const size = bytes("css");
      let css = "";
      while (css.length < size)
        css += `.${word(prng)}-${prng.int(1000)}{color:#${hex(prng, 3)};margin:${prng.int(40)}px}\n`;
      return { mimeType: "text/css", text: css };
    }
    case "text":
      return { mimeType: "text/plain", text: prose(prng, bytes("text")) };
    case "image": {
      const size = Math.floor((bytes("image") * 3) / 4);
      return {
        mimeType: weighted(prng, HAR.imageMimes),
        text: base64(prng, size),
        encoding: "base64",
        size,
      };
    }
    case "font": {
      const size = Math.floor((bytes("font") * 3) / 4);
      return { mimeType: "font/woff2", text: base64(prng, size), encoding: "base64", size };
    }
    default:
      return { mimeType: "x-unknown", text: undefined };
  }
};

const timings = (prng: Prng) => {
  const connection = prng.chance(HAR.timings.connectionShare);
  const t = {
    blocked: prng.float() * 10,
    dns: connection ? prng.quantile(HAR.timings.dns) : -1,
    ssl: connection ? prng.quantile(HAR.timings.ssl) : -1,
    connect: connection ? prng.quantile(HAR.timings.connect) : -1,
    send: 0,
    wait: prng.quantile(HAR.timings.wait) + prng.float(),
    receive: prng.quantile(HAR.timings.receive) + prng.float(),
    _blocked_queueing: prng.float() * 5,
  };
  // DevTools sums blocked, dns, connect, send, wait and receive; ssl is inside connect.
  const time = [t.blocked, t.dns, t.connect, t.send, t.wait, t.receive].reduce(
    (sum, v) => sum + Math.max(0, v),
    0,
  );
  return { time, timings: t };
};

const RESOURCE_TYPES: Record<string, string> = {
  image: "image",
  script: "script",
  html: "document",
  css: "stylesheet",
  font: "font",
  websocket: "websocket",
  json: "xhr",
  ndjson: "fetch",
  text: "fetch",
  other: "other",
};

const entry = (
  prng: Prng,
  hostList: ReadonlyArray<string>,
  pageref: string,
  clock: number,
  kind: BodyKind,
  nestedBytes: number | undefined,
  force: Force = {},
) => {
  const { value: req, post, jwtHeader } = request(prng, hostList, kind, force);
  const forced =
    force.post !== undefined ||
    force.jwtHeader === true ||
    force.stringifiedDepth !== undefined ||
    kind === "ndjson" ||
    kind === "image" ||
    nestedBytes !== undefined;
  const status = kind === "websocket" ? 101 : forced ? 200 : weighted(prng, HAR.statuses);
  const body =
    status === 204 || status === 304 || status === 302 || status === 101
      ? { mimeType: "x-unknown", text: undefined }
      : responseBody(prng, kind, nestedBytes, force);
  const { time, timings: t } = timings(prng);
  const textSize = body.text === undefined ? 0 : Buffer.byteLength(body.text, "utf8");
  const out: Record<string, unknown> = {
    _initiator: prng.chance(0.5)
      ? {
          type: "script",
          stack: {
            callFrames: [
              {
                functionName: word(prng),
                scriptId: String(prng.int(1000)),
                url: `https://${prng.pick(hostList)}/${word(prng)}.js`,
                lineNumber: prng.int(5000),
                columnNumber: prng.int(200),
              },
            ],
          },
        }
      : {
          type: prng.pick(["parser", "other", "preload"]),
          url: req.url,
          lineNumber: prng.int(300),
        },
    _priority: prng.pick(["High", "Low", "Medium", "VeryHigh", "VeryLow"]),
    _resourceType: RESOURCE_TYPES[kind] ?? "other",
    ...(prng.chance(0.1) ? { _fromCache: prng.pick(["memory", "disk"]) } : {}),
    cache: {},
    connection: String(prng.int(100_000)),
    pageref,
    request: req,
    response: {
      status,
      statusText:
        status === 200
          ? "OK"
          : status === 101
            ? "Switching Protocols"
            : status === 302
              ? "Found"
              : status === 204
                ? "No Content"
                : status === 404
                  ? "Not Found"
                  : "",
      httpVersion: req.httpVersion,
      headers: headerPairs(prng, RESPONSE_HEADERS, prng.quantile(HAR.responseHeaders)),
      cookies: cookies(prng, prng.pick(HAR.responseCookies)),
      content: {
        size: "size" in body ? body.size : textSize,
        mimeType: body.mimeType,
        ...(body.text === undefined ? {} : { text: body.text }),
        ...("encoding" in body ? { encoding: body.encoding } : {}),
      },
      redirectURL:
        status === 301 || status === 302 || status === 303 || status === 307
          ? `https://${prng.pick(hostList)}/${word(prng)}`
          : "",
      headersSize: -1,
      bodySize: textSize,
      _transferSize: textSize + prng.int(800),
      _error: null,
    },
    serverIPAddress: `${prng.int(224)}.${prng.int(256)}.${prng.int(256)}.${prng.int(256)}`,
    startedDateTime: isoDate(clock),
    time,
    timings: t,
  };
  if (kind === "websocket") {
    const messages: Record<string, unknown>[] = [];
    const count = prng.range(HAR.webSocketMessages.min, HAR.webSocketMessages.max);
    let t0 = clock / 1000;
    for (let i = 0; i < count; i++) {
      t0 += prng.float() * 0.5;
      const binary = prng.chance(0.3);
      const size = prng.quantile(HAR.webSocketMessageBytes);
      messages.push({
        type: prng.chance(0.5) ? "send" : "receive",
        time: t0,
        opcode: binary ? 2 : 1,
        data: binary
          ? base64(prng, size)
          : JSON.stringify({
              type: word(prng),
              seq: i,
              payload: { id: uuid(prng), text: prose(prng, Math.max(8, size - 60)) },
            }),
      });
    }
    out._webSocketMessages = messages;
  }
  return {
    value: out,
    kind,
    post,
    jwtHeader,
    stringifiedDepth: "stringifiedDepth" in body ? body.stringifiedDepth : 0,
  };
};

/** Splits a serialized entry around the body sentinel: [head, tail]. */
const splitAtBody = (serialized: string): [string, string] => {
  const at = serialized.indexOf(SENTINEL_JSON);
  if (at < 0) throw new Error("body sentinel missing");
  return [serialized.slice(0, at), serialized.slice(at + SENTINEL_JSON.length)];
};

const writeBigBodyEntry = (
  sink: Sink,
  prng: Prng,
  hostList: ReadonlyArray<string>,
  pageref: string,
  clock: number,
  chars: number,
) => {
  const decodedBytes = Math.floor(chars / 4) * 3;
  const base = entry(prng, hostList, pageref, clock, "other", undefined).value;
  const response = base.response as Record<string, unknown>;
  base._resourceType = "media";
  response.status = 200;
  response.statusText = "OK";
  response.content = {
    size: decodedBytes,
    mimeType: HAR.giantBodyMime,
    text: BODY_SENTINEL,
    encoding: "base64",
  };
  response.bodySize = decodedBytes;
  response._transferSize = decodedBytes + 512;
  const [head, tail] = splitAtBody(JSON.stringify(base));
  sink.write(head);
  let remaining = chars;
  const bodyPrng = prng.fork("big-body");
  while (remaining > 0) {
    const pieceChars = Math.min(BASE64_PIECE_CHARS, remaining);
    const text = base64(bodyPrng, (pieceChars / 4) * 3);
    sink.write(text.slice(0, pieceChars));
    remaining -= pieceChars;
  }
  sink.write(tail);
};

const writeBigNestedEntry = (
  sink: Sink,
  prng: Prng,
  hostList: ReadonlyArray<string>,
  pageref: string,
  clock: number,
  bytes: number,
) => {
  const base = entry(prng, hostList, pageref, clock, "other", undefined).value;
  const response = base.response as Record<string, unknown>;
  response.status = 200;
  response.statusText = "OK";
  response.content = { size: bytes, mimeType: "application/json", text: BODY_SENTINEL };
  response.bodySize = bytes;
  const [head, tail] = splitAtBody(JSON.stringify(base));
  sink.write(head);
  // Body: {"kind":"envelope","payload":"<escaped big JSON array>","nested":<3-deep small>}
  // The body sits inside the HAR `text` string, so its text is escaped once and
  // the payload string twice.
  sink.write(escape('{"kind":"envelope","payload":"', 1));
  writeJsonArray(sink, prng.fork("big-nested"), bytes, 2);
  sink.write(escape(`","nested":${stringifiedResponse(prng, 600, 3)}}`, 1));
  sink.write(tail);
};
