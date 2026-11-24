/**
 * Synthetic decoder samples: a DevTools-shaped HAR built from a seed, with
 * enough strings of every kind a decoder detects to make a 95 % floor mean
 * something, and the near misses a detector is likely to take for one (hex
 * ids, dotted names, long identifiers in the base64 alphabet, a single
 * `key=value`, prose that says "query"). Everything is made here from the
 * fixture generator's seeded text, so the samples hold no third-party data and
 * are the same on every machine.
 */
import {
  jsonResponse,
  ndjsonResponse,
  formBody,
  graphqlRequest,
} from "../../../scripts/fixtures/jsonBody.ts";
import { createPrng, type Prng } from "../../../scripts/fixtures/prng.ts";
import { base64, hex, jwt, prose, sentence, uuid, word } from "../../../scripts/fixtures/text.ts";

/** Strings of each kind the builder plants, at the least. */
export const PLANTED_PER_KIND = 30;

const ISSUED_AT = 1_760_000_000;
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];

/** Bytes that start with a file signature, then random. */
const fileBytes = (prng: Prng, head: ReadonlyArray<number>, size: number) =>
  Buffer.concat([Buffer.from(head), Buffer.from(base64(prng, size), "base64")]);

interface Entry {
  request: {
    method: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
    cookies: Array<{ name: string; value: string }>;
    queryString: Array<{ name: string; value: string }>;
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    headers: Array<{ name: string; value: string }>;
    cookies: Array<{ name: string; value: string }>;
    content: { size: number; mimeType: string; text?: string; encoding?: string };
  };
}

/** Near misses: strings no decoder should claim, in the shapes that look most like one. */
const nearMisses = (prng: Prng): string[] => [
  uuid(prng),
  hex(prng, 16),
  hex(prng, 32),
  String(prng.int(1e12)),
  new Date(Date.UTC(2026, prng.int(12), 1 + prng.int(28))).toISOString(),
  `https://${word(prng)}.example/${word(prng)}?${word(prng)}=${word(prng)}&page=${prng.int(9)}`,
  `${word(prng)}.${prng.int(3000)}.${word(prng)}`,
  `${word(prng)}=${word(prng)}`,
  `${word(prng)}${word(prng)}${word(prng)}${word(prng)}${word(prng)}`.slice(0, 40).padEnd(28, "x"),
  `query the ${word(prng)} index for ${word(prng)} and ${word(prng)}`,
  `{"${word(prng)}": ${prng.int(100)}, "${word(prng)}": "${word(prng)}"`,
  sentence(prng),
  `max-age=${prng.int(1e6)}, ${word(prng)}`,
  `"${word(prng)}";v="${prng.int(200)}"`,
];

const NAMES = ["Cart", "Viewer", "Product", "Order", "Search", "Feed", "Account", "Review"];

/** A query or mutation whose names are GraphQL names, as a JSON request body. */
const graphqlOperation = (prng: Prng) => {
  const name = `${prng.pick(NAMES)}${prng.pick(NAMES)}`;
  const type = prng.pick(NAMES);
  const query = prng.chance(0.3)
    ? `mutation Update${name}($id: ID!, $input: ${type}Input!) {\n  update${type}(id: $id, input: $input) {\n    id\n    updatedAt\n  }\n}`
    : `query Get${name}($id: ID!, $first: Int = ${prng.range(5, 50)}) {\n  node(id: $id) {\n    id\n    ... on ${type} {\n      name\n      items(first: $first) { edges { node { id title } } }\n    }\n  }\n}`;
  return JSON.stringify({ operationName: `Get${name}`, query, variables: { id: uuid(prng) } });
};

const entry = (url: string): Entry => ({
  request: { method: "GET", url, headers: [], cookies: [], queryString: [] },
  response: {
    status: 200,
    headers: [],
    cookies: [],
    content: { size: 0, mimeType: "x-unknown" },
  },
});

/** A HAR with at least {@link PLANTED_PER_KIND} strings of each decoder's kind among its near misses. */
export function buildDecoderSamples(seed: number): unknown {
  const prng = createPrng(seed);
  const entries: Entry[] = [];
  const host = () => `https://${word(prng)}.example`;
  for (let i = 0; i < PLANTED_PER_KIND; i++) {
    // JSON in a response body, and a JWT in the request that asked for it.
    const api = entry(`${host()}/api/${word(prng)}`);
    api.request.headers.push(
      { name: "authorization", value: `Bearer ${jwt(prng, ISSUED_AT)}` },
      { name: "x-request-id", value: uuid(prng) },
    );
    const json = jsonResponse(prng, 400 + prng.int(1200), false);
    api.response.content = { size: json.length, mimeType: "application/json", text: json };
    api.response.cookies.push({ name: "session", value: hex(prng, 16) });
    entries.push(api);

    // A GraphQL operation inside a JSON request body. The generator's own request names its
    // operation after any word, emoji included, which is not GraphQL: it stays as a near miss.
    const graph = entry(`${host()}/graphql`);
    graph.request.method = "POST";
    graph.request.postData = { mimeType: "application/json", text: graphqlOperation(prng) };
    entries.push(graph);
    const generated = entry(`${host()}/graphql`);
    generated.request.method = "POST";
    generated.request.postData = { mimeType: "application/json", text: graphqlRequest(prng) };
    entries.push(generated);

    // A form post, and a query-string-shaped value with no declared type.
    const form = entry(`${host()}/login`);
    form.request.method = "POST";
    form.request.postData = {
      mimeType: "application/x-www-form-urlencoded",
      text: formBody(prng),
    };
    form.request.headers.push({
      name: "x-tracking",
      value: `utm_source=${word(prng)}&utm_medium=${word(prng)}&utm_campaign=${prng.int(1e4)}`,
    });
    entries.push(form);

    // NDJSON events.
    const stream = entry(`${host()}/events`);
    // Two calls, so the body is at least two lines: one line is a JSON document as much as a stream.
    const ndjson = ndjsonResponse(prng, 1) + ndjsonResponse(prng, 300 + prng.int(600));
    stream.response.content = {
      size: ndjson.length,
      mimeType: "application/x-ndjson",
      text: ndjson,
    };
    entries.push(stream);

    // base64: a declared image body, a data: URL and text carried as base64 in a cookie.
    const image = entry(`${host()}/img/${word(prng)}.png`);
    const png = fileBytes(prng, PNG_HEAD, 200 + prng.int(800));
    image.response.content = {
      size: png.length,
      mimeType: "image/png",
      text: png.toString("base64"),
      encoding: "base64",
    };
    image.response.headers.push({
      name: "link",
      value: `data:image/jpeg;base64,${fileBytes(prng, JPEG_HEAD, 96).toString("base64")}`,
    });
    image.response.cookies.push({
      name: "prefs",
      value: Buffer.from(`${sentence(prng)} ${sentence(prng)}`).toString("base64"),
    });
    entries.push(image);

    // Near misses everywhere a string can sit.
    const misses = entry(`${host()}/${word(prng)}`);
    for (const value of nearMisses(prng)) {
      misses.request.headers.push({ name: `x-${word(prng)}`, value });
      misses.request.queryString.push({ name: word(prng), value: nearMisses(prng)[prng.int(14)]! });
    }
    const text = prose(prng, 300);
    misses.response.content = { size: text.length, mimeType: "text/plain", text };
    entries.push(misses);
  }
  return {
    log: {
      version: "1.2",
      creator: { name: "WebInspector", version: "537.36" },
      pages: [],
      entries,
    },
  };
}
