/**
 * JSON body shapes shared by the HAR and wide generators. `writeJsonArray`
 * streams a large array in pieces so no body is held whole. `escape` applies
 * JSON string escaping; stacking it n times is exactly what n levels of
 * stringification produce, and it composes over concatenated pieces because
 * JSON escaping is per character.
 */
import type { Prng } from "./prng.ts";
import type { Sink } from "./sink.ts";
import { isoDate, jwt, number, sentence, uuid, word } from "./text.ts";

export const escape = (text: string, depth: number) => {
  let out = text;
  for (let i = 0; i < depth; i++) out = JSON.stringify(out).slice(1, -1);
  return out;
};

export const record = (prng: Prng, id: number): Record<string, unknown> => ({
  id,
  uuid: uuid(prng),
  name: sentence(prng),
  email: `${word(prng)}.${word(prng)}@${word(prng)}.example`,
  active: prng.chance(0.7),
  score: number(prng),
  balance: number(prng),
  tags: [word(prng), word(prng), word(prng)].slice(0, prng.range(0, 3)),
  address: {
    city: word(prng),
    zip: String(10000 + prng.int(89999)),
    geo: [number(prng), number(prng)],
  },
  created: isoDate(1_700_000_000_000 + prng.int(1_000_000_000)),
  note: prng.chance(0.1) ? null : sentence(prng),
});

/** A JSON API response of about `bytes` bytes, as text. */
export const jsonResponse = (prng: Prng, bytes: number, withJwt: boolean) => {
  const items: Record<string, unknown>[] = [];
  let size = 0;
  let id = prng.int(100_000);
  while (size < bytes) {
    const item = record(prng, id++);
    items.push(item);
    size += 220;
  }
  return JSON.stringify({
    data: items,
    meta: {
      page: prng.int(50),
      perPage: items.length,
      total: prng.int(1_000_000),
      requestId: uuid(prng),
    },
    ...(withJwt ? { token: jwt(prng, 1_760_000_000 + prng.int(100_000)) } : {}),
  });
};

/** A JSON body whose `payload` is stringified JSON `depth` times over (1–3). */
export const stringifiedResponse = (prng: Prng, bytes: number, depth: number) => {
  let inner: unknown = { kind: "leaf", values: [number(prng), number(prng)], note: sentence(prng) };
  const names = ["leaf", "inner", "payload"];
  for (let level = 0; level < depth; level++) {
    const text = JSON.stringify(inner);
    inner =
      level === depth - 1
        ? {
            kind: "envelope",
            [names[level] as string]: text,
            body: jsonResponse(prng, Math.max(200, bytes - text.length - 400), false),
          }
        : { kind: names[level + 1], [names[level] as string]: text, id: uuid(prng) };
  }
  return JSON.stringify(inner);
};

export const ndjsonResponse = (prng: Prng, bytes: number) => {
  const lines: string[] = [];
  let size = 0;
  let id = 0;
  while (size < bytes) {
    const line = JSON.stringify({
      event: word(prng),
      id: id++,
      ts: 1_760_000_000_000 + prng.int(1_000_000),
      data: record(prng, id),
    });
    lines.push(line);
    size += line.length + 1;
  }
  return `${lines.join("\n")}\n`;
};

export const graphqlRequest = (prng: Prng) =>
  JSON.stringify({
    operationName: `Get${word(prng)}`,
    query: `query Get${word(prng)}($id: ID!, $first: Int) {\n  node(id: $id) {\n    id\n    ... on ${word(prng)} {\n      name\n      items(first: $first) { edges { node { id title } } }\n    }\n  }\n}`,
    variables: { id: uuid(prng), first: prng.range(5, 50) },
  });

export const formBody = (prng: Prng) =>
  new URLSearchParams({
    username: `${word(prng)}.${word(prng)}`,
    password: sentence(prng),
    remember: prng.chance(0.5) ? "on" : "off",
    csrf: uuid(prng),
    redirect: `/${word(prng)}/${word(prng)}?q=${word(prng)} ${word(prng)}&lang=fr`,
  }).toString();

/**
 * Streams a JSON array of `record`s of about `bytes` bytes to the sink, with the
 * text escaped `escapeDepth` times. Returns the number of bytes written.
 */
export const writeJsonArray = (sink: Sink, prng: Prng, bytes: number, escapeDepth: number) => {
  const start = sink.size();
  sink.write(escape("[", escapeDepth));
  let first = true;
  let id = 0;
  while (sink.size() - start < bytes) {
    const pieces: string[] = [];
    for (let i = 0; i < 512; i++) {
      pieces.push((first ? "" : ",") + JSON.stringify(record(prng, id++)));
      first = false;
    }
    sink.write(escape(pieces.join(""), escapeDepth));
  }
  sink.write(escape("]", escapeDepth));
  return sink.size() - start;
};
