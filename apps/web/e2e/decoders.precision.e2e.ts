// @effect-diagnostics nodeBuiltinImport:off - reads HAR fixtures from Node, outside any Effect runtime.
// @effect-diagnostics preferSchemaOverJson:off - the reference checks parse whole samples with JSON.parse on purpose: they are the independent answer the detectors are measured against.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { detectString, STRING_HEAD_BYTES, type StringContext } from "@quipu/core/detectString";
import { prettyGraphql } from "@quipu/core/graphqlPretty";
import { describe, expect, it } from "vite-plus/test";

import { buildDecoderSamples, PLANTED_PER_KIND } from "./decoderSamples";
import { REFERENCE_HAR_SAMPLES, referenceSamplesMissing, useSmallFixture } from "./fixtures";

type Kind = "json" | "jwt" | "base64" | "form" | "graphql" | "ndjson";
const KINDS: ReadonlyArray<Kind> = ["json", "jwt", "base64", "form", "graphql", "ndjson"];

const utf8 = new TextEncoder();

const isJsonContainer = (text: string) => {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null;
  } catch {
    return false;
  }
};

const fromBase64Url = (text: string) =>
  Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Independent of the detectors: a compact JWS whose first two segments decode to JSON objects. */
const referenceJwt = (text: string) => {
  const match = /^(?:Bearer )?([\w-]+)\.([\w-]+)\.([\w-]*)$/.exec(text.trim());
  if (!match) return false;
  return [match[1], match[2]].every((part) =>
    isJsonContainer(fromBase64Url(part ?? "").toString("utf8")),
  );
};

const printableText = (bytes: Buffer) => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 1024));
  } catch {
    return false;
  }
  const control = [...text].filter((c) => c < " " && !"\t\n\r\f".includes(c)).length;
  return text.length > 0 && control / text.length < 0.01;
};

/** Genuine base64: the object says so, a data: URL says so, or the whole string decodes to a known file or text. */
const referenceBase64 = (text: string, context: StringContext) => {
  if (context.encoding === "base64" && context.key === "text") return text.length > 0;
  if (/^data:[^,;]*;base64,/.test(text)) return true;
  const body = text.replace(/\s+/g, "");
  if (body.length < 24 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(body)) return false;
  if (body.replace(/=+$/, "").length % 4 === 1) return false;
  if (/^[0-9a-fA-F]+$/.test(body) || /^\d+$/.test(body)) return false;
  const bytes = fromBase64Url(body);
  const magic =
    (bytes[0] === 0x89 && bytes[1] === 0x50) ||
    (bytes[0] === 0xff && bytes[1] === 0xd8) ||
    (bytes[0] === 0x47 && bytes[1] === 0x49) ||
    (bytes[0] === 0x1f && bytes[1] === 0x8b);
  return magic || (bytes.length >= 8 && printableText(bytes));
};

/** What URLSearchParams would split into at least two `name=value` pairs, or a body declared as a form. */
const referenceForm = (text: string, context: StringContext) => {
  const segments = text
    .replace(/^\?/, "")
    .split("&")
    .filter((segment) => segment !== "");
  if (!segments.every((segment) => /^[\w.[\]%+~-]+=[\x21-\x7e]*$/.test(segment))) return false;
  if (context.mimeType?.startsWith("application/x-www-form-urlencoded"))
    return segments.length >= 1;
  return segments.length >= 2;
};

const referenceNdjson = (text: string) => {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length >= 2 && lines.every(isJsonContainer);
};

const referenceChecks: Record<Kind, (text: string, context: StringContext) => boolean> = {
  json: (text) => isJsonContainer(text) && !referenceNdjson(text),
  jwt: (text) => referenceJwt(text),
  base64: referenceBase64,
  form: referenceForm,
  graphql: (text) =>
    prettyGraphql(text) !== null &&
    /^\s*(?:#[^\n]*\n\s*)*(?:query|mutation|subscription|fragment)\b/.test(text),
  ndjson: (text) => referenceNdjson(text),
};

interface Tally {
  detected: number;
  confirmed: number;
  positives: number;
  found: number;
}
const empty = (): Record<Kind, Tally> =>
  Object.fromEntries(
    KINDS.map((k) => [k, { detected: 0, confirmed: 0, positives: 0, found: 0 }]),
  ) as Record<Kind, Tally>;

interface Measured {
  readonly total: Record<Kind, Tally>;
  readonly report: string;
}

/** Runs every detector over every string of the HARs (and the JSON inside them), against the reference checks. */
function measure(hars: ReadonlyArray<{ readonly name: string; readonly har: unknown }>): Measured {
  const total = empty();
  let strings = 0;
  const falsePositives: string[] = [];
  const rows: string[] = [];
  for (const { name, har } of hars) {
    const tally = empty();
    const stack: Array<{
      node: unknown;
      key: string | null;
      parent: Record<string, unknown> | null;
      depth: number;
    }> = [{ node: har, key: null, parent: null, depth: 0 }];
    while (stack.length > 0) {
      const { node, key, parent, depth } = stack.pop() as (typeof stack)[number];
      if (typeof node === "string") {
        strings++;
        const bytes = utf8.encode(node);
        const context: StringContext = {
          key,
          mimeType: typeof parent?.mimeType === "string" ? parent.mimeType : null,
          encoding: typeof parent?.encoding === "string" ? parent.encoding : null,
        };
        const found = new Set(
          detectString(
            bytes.subarray(0, STRING_HEAD_BYTES),
            bytes.length > STRING_HEAD_BYTES,
            context,
          ).map((d) => d.kind),
        );
        for (const kind of KINDS) {
          const positive = referenceChecks[kind](node, context);
          const hit = found.has(kind);
          if (hit) tally[kind].detected++;
          if (positive) tally[kind].positives++;
          if (hit && positive) {
            tally[kind].confirmed++;
            tally[kind].found++;
          } else if (hit && falsePositives.length < 400) {
            falsePositives.push(
              `${name} ${kind} ${key ?? ""} :: ${node.slice(0, 100).replace(/\s+/g, " ")}`,
            );
          }
        }
        // The tree opens stringified JSON on demand, so what is inside it is in scope too.
        if (found.has("json") && depth < 3 && node.length < 4_000_000) {
          try {
            stack.push({ node: JSON.parse(node.trim()), key, parent, depth: depth + 1 });
          } catch {
            // Detection said JSON from a prefix; the reference check above already counted it.
          }
        }
      } else if (Array.isArray(node)) {
        for (const child of node) stack.push({ node: child, key, parent, depth });
      } else if (typeof node === "object" && node !== null) {
        const record = node as Record<string, unknown>;
        for (const [k, v] of Object.entries(record))
          stack.push({ node: v, key: k, parent: record, depth });
      }
    }
    rows.push(
      `${name.padEnd(14)} ${KINDS.map((k) => `${k} ${tally[k].confirmed}/${tally[k].detected}`).join("  ")}`,
    );
    for (const kind of KINDS) {
      total[kind].detected += tally[kind].detected;
      total[kind].confirmed += tally[kind].confirmed;
      total[kind].positives += tally[kind].positives;
      total[kind].found += tally[kind].found;
    }
  }
  const table = [
    "| decoder | detected | confirmed | precision | reference positives | recall |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...KINDS.map((k) => {
      const t = total[k];
      return `| ${k} | ${t.detected} | ${t.confirmed} | ${(precision(t) * 100).toFixed(2)} % | ${t.positives} | ${(recall(t) * 100).toFixed(2)} % |`;
    }),
  ].join("\n");
  const report = `detection precision over ${hars.length} HARs, ${strings} strings\n\n${table}\n\n${rows.join("\n")}\n\nfalse positives (first ${Math.min(40, falsePositives.length)}):\n${falsePositives.slice(0, 40).join("\n")}\n`;
  console.log(report);
  return { total, report };
}

const precision = (t: Tally) => (t.detected === 0 ? 1 : t.confirmed / t.detected);
const recall = (t: Tally) => (t.positives === 0 ? 1 : t.found / t.positives);

/** The minimum recall for every decoder, and the minimum precision where none is stricter. */
const FLOOR = 0.95;
const PRECISION_FLOOR: Record<Kind, number> = {
  json: 0.98,
  jwt: 1,
  base64: 0.98,
  form: FLOOR,
  graphql: 1,
  ndjson: 1,
};

function expectAboveTheFloor({ total }: Measured) {
  for (const kind of KINDS) {
    expect
      .soft(precision(total[kind]), `${kind} precision`)
      .toBeGreaterThanOrEqual(PRECISION_FLOOR[kind]);
    expect.soft(recall(total[kind]), `${kind} recall`).toBeGreaterThanOrEqual(FLOOR);
  }
}

const readHar = (path: string): unknown => JSON.parse(NodeFS.readFileSync(path, "utf8"));

describe("detection on synthetic HAR samples", () => {
  const harOneMegabyte = useSmallFixture("har-1m.har");

  it("is above the floor for every decoder, on the planted samples and a generated capture", () => {
    const measured = measure([
      { name: "planted", har: buildDecoderSamples(0x51_55_49_50) },
      { name: "har-1m", har: readHar(harOneMegabyte()) },
    ]);
    if (process.env.QUIPU_PRECISION_OUT)
      NodeFS.writeFileSync(`${process.env.QUIPU_PRECISION_OUT}.synthetic`, measured.report);
    // A floor over a handful of positives says nothing: every kind is there in numbers.
    for (const kind of KINDS)
      expect
        .soft(measured.total[kind].positives, `${kind} positives`)
        .toBeGreaterThanOrEqual(PLANTED_PER_KIND);
    expectAboveTheFloor(measured);
  }, 120_000);
});

/** The 12 real captures in `QUIPU_HAR_SAMPLES`: Playwright recordHar of public pages. */
describe.skipIf(referenceSamplesMissing !== null)("detection on the 12 real HAR captures", () => {
  it("is above the floor for every decoder, and prints the table", () => {
    const files = NodeFS.readdirSync(REFERENCE_HAR_SAMPLES)
      .filter((f) => f.endsWith(".har"))
      .sort();
    expect(files.length).toBe(12);
    const measured = measure(
      files.map((file) => ({
        name: file.replace(/\.har$/, ""),
        har: readHar(NodePath.join(REFERENCE_HAR_SAMPLES, file)),
      })),
    );
    if (process.env.QUIPU_PRECISION_OUT)
      NodeFS.writeFileSync(process.env.QUIPU_PRECISION_OUT, measured.report);
    expectAboveTheFloor(measured);
    expect(measured.total.graphql.positives).toBe(14);
  }, 120_000);
});
