/**
 * Seeded sample documents for the engine's tests: HAR-shaped files with the
 * features the 2 GiB fixture has (headers, cookies, nested stringified bodies
 * three levels deep, base64 bodies, JWTs, escapes and non-ASCII text), wide
 * arrays and deep documents. Everything derives from the seed, and documents are
 * assembled from pieces so a 50 MiB sample never passes through one string.
 */
export interface Prng {
  readonly nextU32: () => number;
  readonly float: () => number;
  readonly int: (n: number) => number;
  readonly range: (lo: number, hi: number) => number;
  readonly pick: <T>(items: ReadonlyArray<T>) => T;
  readonly chance: (p: number) => boolean;
}

const splitmix32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
};

const rotl = (x: number, k: number) => (x << k) | (x >>> (32 - k));

/** xoshiro128** seeded through splitmix32: the same seed gives the same bytes everywhere. */
export const createPrng = (seed: number): Prng => {
  const mix = splitmix32(seed);
  let s0 = mix();
  let s1 = mix();
  let s2 = mix();
  let s3 = mix();
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;
  const nextU32 = () => {
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);
    return result;
  };
  const float = () => nextU32() / 4294967296;
  const int = (n: number) => Math.floor(float() * n);
  const range = (lo: number, hi: number) => lo + int(hi - lo + 1);
  const pick = <T>(items: ReadonlyArray<T>): T => {
    const item = items[int(items.length)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  };
  const chance = (p: number) => float() < p;
  return { nextU32, float, int, range, pick, chance };
};

const WORDS = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "quipu",
  "khipu",
  "cord",
  "knot",
  "café",
  "naïve",
  "résumé",
  "東京",
  "Zürich",
  "🙂",
  "🚀",
  "données",
];
const UNSAFE = ['"', "\\", "\n", "\t", "/", "\u0001", "é", "😀", "<", "&", "\r", "\b", "\f"];

const word = (prng: Prng) => prng.pick(WORDS);

/** A sentence that often carries characters JSON must escape. */
const sentence = (prng: Prng) => {
  const n = prng.range(2, 9);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(word(prng));
  const base = parts.join(" ");
  return prng.chance(0.3) ? `${base} ${prng.pick(UNSAFE)}${word(prng)}${prng.pick(UNSAFE)}` : base;
};

const number = (prng: Prng) => {
  switch (prng.int(7)) {
    case 0:
      return prng.int(1_000_000);
    case 1:
      return -prng.int(10_000);
    case 2:
      return Math.round(prng.float() * 1e6) / 1e3;
    case 3:
      return Number((prng.float() * 1e-5).toExponential(4));
    case 4:
      return prng.int(2) === 0 ? 0 : 1;
    case 5:
      return -prng.float();
    default:
      return Math.round(prng.float() * 1e9);
  }
};

const hex = (prng: Prng, bytes: number) => {
  let out = "";
  for (let i = 0; i < bytes; i++) out += (prng.nextU32() & 0xff).toString(16).padStart(2, "0");
  return out;
};

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const base64Text = (prng: Prng, chars: number) => {
  let out = "";
  for (let i = 0; i < chars; i++) out += BASE64[prng.int(64)];
  return out;
};

/** Decodes the base64 `base64Text` produces, for expectations. */
export const decodeBase64Text = (text: string) => {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const c of text) {
    const v = BASE64.indexOf(c);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
};

const jwt = (prng: Prng) =>
  `eyJ${base64Text(prng, 20)}.eyJ${base64Text(prng, 60)}.${base64Text(prng, 43)}`;

const record = (prng: Prng, id: number): Record<string, unknown> => ({
  id,
  name: sentence(prng),
  email: `${word(prng)}.${word(prng)}@${word(prng)}.example`,
  active: prng.chance(0.7),
  score: number(prng),
  tags: [word(prng), word(prng), word(prng)].slice(0, prng.range(0, 3)),
  address: {
    city: word(prng),
    zip: `${10000 + prng.int(89999)}`,
    geo: [number(prng), number(prng)],
  },
  note: prng.chance(0.1) ? null : sentence(prng),
  empty: prng.chance(0.2) ? {} : [],
});

/** A JSON API response of about `bytes` bytes. */
const jsonResponse = (prng: Prng, bytes: number) => {
  const items: Record<string, unknown>[] = [];
  let size = 0;
  let id = prng.int(100_000);
  while (size < bytes) {
    items.push(record(prng, id++));
    size += 220;
  }
  return JSON.stringify({
    data: items,
    meta: { page: prng.int(50), total: prng.int(1e6) },
    token: jwt(prng),
  });
};

/**
 * A body whose `payload` is stringified JSON whose `inner` is stringified JSON
 * whose `leaf` is stringified JSON: three levels inside the body, four counting
 * the HAR `text` field.
 */
const nestedResponse = (prng: Prng, bytes: number) => {
  const leaf = JSON.stringify({
    kind: "leaf",
    values: [number(prng), number(prng)],
    note: sentence(prng),
  });
  const inner = JSON.stringify({ kind: "inner", leaf, items: [record(prng, 1), record(prng, 2)] });
  const payload = JSON.stringify({
    kind: "payload",
    inner,
    body: jsonResponse(prng, Math.max(200, bytes - 1200)),
  });
  return JSON.stringify({
    kind: "envelope",
    payload,
    receivedAt: `2026-10-11T07:40:${prng.int(60).toString().padStart(2, "0")}Z`,
  });
};

const header = (prng: Prng) => ({
  name: prng.pick([
    "content-type",
    "cache-control",
    "etag",
    "set-cookie",
    "authorization",
    "x-request-id",
  ]),
  value: prng.chance(0.2) ? `Bearer ${jwt(prng)}` : sentence(prng),
});

const cookie = (prng: Prng) => ({
  name: prng.pick(["session", "_ga", "theme", "csrf"]),
  value: hex(prng, 12),
  path: "/",
  httpOnly: prng.chance(0.5),
  secure: prng.chance(0.8),
  expires: null,
});

export interface HarOptions {
  /** Stop once the text reaches about this many bytes. */
  readonly targetBytes: number;
  /** Escaped byte sizes of the big nested stringified bodies, placed across the file. */
  readonly nestedBodyBytes?: ReadonlyArray<number>;
  /** Characters of one big base64 body. */
  readonly bigBodyChars?: number;
}

const entry = (prng: Prng, index: number, kind: string, nestedBytes: number) => {
  const headers = Array.from({ length: prng.range(3, 12) }, () => header(prng));
  const body =
    kind === "json"
      ? { mimeType: "application/json", text: jsonResponse(prng, prng.range(200, 6000)) }
      : kind === "nested"
        ? { mimeType: "application/json", text: nestedResponse(prng, nestedBytes) }
        : kind === "image"
          ? {
              mimeType: "image/png",
              text: base64Text(prng, prng.range(64, 4000) & ~3),
              encoding: "base64",
            }
          : kind === "ndjson"
            ? {
                mimeType: "application/x-ndjson",
                text: `${JSON.stringify(record(prng, 1))}\n${JSON.stringify(record(prng, 2))}\n`,
              }
            : kind === "form"
              ? {
                  mimeType: "text/plain",
                  text: `user=${word(prng)}&q=${encodeURIComponent(sentence(prng))}`,
                }
              : { mimeType: "text/plain" };
  const out: Record<string, unknown> = {
    _initiator: { type: prng.pick(["parser", "script", "other"]), lineNumber: prng.int(500) },
    _priority: prng.pick(["High", "Low"]),
    _resourceType: kind === "image" ? "image" : kind === "websocket" ? "websocket" : "xhr",
    cache: {},
    pageref: `page_${1 + (index >> 8)}`,
    request: {
      method: kind === "form" ? "POST" : "GET",
      url: `https://${word(prng)}.example/${word(prng)}/${index}?q=${word(prng)}`,
      httpVersion: "http/2.0",
      headers,
      queryString: [{ name: "q", value: word(prng) }],
      cookies: Array.from({ length: prng.range(0, 4) }, () => cookie(prng)),
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: prng.pick([200, 200, 204, 302, 404]),
      statusText: "OK",
      httpVersion: "http/2.0",
      headers: Array.from({ length: prng.range(4, 14) }, () => header(prng)),
      cookies: [],
      content: { size: 0, ...body },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1,
      _transferSize: prng.int(1e5),
      _error: null,
    },
    serverIPAddress: `10.${prng.int(256)}.${prng.int(256)}.${prng.int(256)}`,
    startedDateTime: "2026-10-11T07:40:00.000Z",
    time: prng.float() * 500,
    timings: {
      blocked: -1,
      dns: -1,
      ssl: -1,
      connect: -1,
      send: 0,
      wait: prng.float() * 100,
      receive: prng.float() * 10,
      _blocked_queueing: -1,
    },
  };
  if (kind === "websocket") {
    out._webSocketMessages = Array.from({ length: prng.range(2, 6) }, (_, i) => ({
      type: prng.chance(0.5) ? "send" : "receive",
      time: 1_760_000_000 + i,
      opcode: 1,
      data: JSON.stringify({ seq: i, text: sentence(prng) }),
    }));
  }
  return JSON.stringify(out);
};

const KINDS = ["none", "json", "json", "image", "ndjson", "form", "websocket", "nested", "none"];

/** A DevTools-shaped HAR as UTF-8 bytes. */
export const harSample = (prng: Prng, options: HarOptions): Uint8Array<ArrayBuffer> => {
  const encoder = new TextEncoder();
  const pieces: Uint8Array[] = [];
  let size = 0;
  const push = (text: string) => {
    const bytes = encoder.encode(text);
    pieces.push(bytes);
    size += bytes.byteLength;
  };
  const nestedQueue = [...(options.nestedBodyBytes ?? [])].map((bytes, i) => ({
    bytes,
    at: options.targetBytes * (0.1 + 0.2 * i),
  }));
  let bigBodyWritten = options.bigBodyChars === undefined;
  push('{"log":{"version":"1.2","creator":{"name":"WebInspector","version":"537.36"},"pages":[');
  push(
    JSON.stringify({
      startedDateTime: "2026-10-11T07:40:00.000Z",
      id: "page_1",
      title: "https://quipu.example/",
      pageTimings: { onContentLoad: 1200.5, onLoad: 3400.25 },
    }),
  );
  push('],"entries":[');
  let index = 0;
  while (size < options.targetBytes || !bigBodyWritten) {
    if (index > 0) push(",");
    let kind = prng.pick(KINDS);
    let nestedBytes = 2000;
    const next = nestedQueue[0];
    if (!bigBodyWritten && size >= options.targetBytes * 0.5) {
      // The big body entry: its text is one base64 string, written in pieces.
      const head = entry(prng, index, "none", 0);
      const marker = '"content":{"size":0,"mimeType":"text/plain"}';
      const at = head.indexOf(marker);
      push(
        head.slice(0, at) +
          '"content":{"size":0,"mimeType":"video/mp4","encoding":"base64","text":"',
      );
      let remaining = options.bigBodyChars as number;
      while (remaining > 0) {
        const n = Math.min(1 << 20, remaining);
        push(base64Text(prng, n));
        remaining -= n;
      }
      push('"}' + head.slice(at + marker.length));
      bigBodyWritten = true;
      index++;
      continue;
    }
    if (next && size >= next.at) {
      nestedQueue.shift();
      kind = "nested";
      nestedBytes = next.bytes;
    }
    push(entry(prng, index, kind, nestedBytes));
    index++;
  }
  push("]}}\n");
  const out = new Uint8Array(size);
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.byteLength;
  }
  return out;
};

/** One array of small flat objects, `count` of them. */
export const wideSample = (prng: Prng, count: number): Uint8Array<ArrayBuffer> => {
  const encoder = new TextEncoder();
  const pieces: Uint8Array[] = [encoder.encode("[")];
  let size = 1;
  for (let at = 0; at < count; at += 1024) {
    const parts: string[] = [];
    for (let i = at; i < Math.min(count, at + 1024); i++) {
      parts.push(
        (i === 0 ? "" : ",") +
          JSON.stringify({
            id: i,
            name: `${word(prng)} ${word(prng)}`,
            active: prng.chance(0.7),
            score: number(prng),
            tags: prng.chance(0.5) ? [word(prng)] : [],
          }),
      );
    }
    const bytes = encoder.encode(parts.join(""));
    pieces.push(bytes);
    size += bytes.byteLength;
  }
  const tail = encoder.encode("]\n");
  pieces.push(tail);
  size += tail.byteLength;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.byteLength;
  }
  return out;
};

/** `depth` nested levels alternating objects and arrays, built in a loop. */
export const deepSample = (depth: number, padBytes = 0): Uint8Array<ArrayBuffer> => {
  const pad = padBytes > 0 ? `"pad":${JSON.stringify("x".repeat(padBytes))},` : "";
  const open: string[] = [];
  const close: string[] = [];
  for (let level = 0; level < depth; level++) {
    open.push(level % 2 === 0 ? `{${pad}"id":${level},"child":` : "[");
    close.push(level % 2 === 0 ? "}" : "]");
  }
  close.reverse();
  return new TextEncoder().encode(
    `${open.join("")}"leaf"${close.join("")}\n`,
  ) as Uint8Array<ArrayBuffer>;
};
