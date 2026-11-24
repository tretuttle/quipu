// @effect-diagnostics nodeBuiltinImport:off - streams fixture files from disk; no Effect runtime is involved.
/**
 * Streams a fixture in 64 MiB windows and checks the spec it claims: size at or
 * above the stated minimum, the single ≥ 629,145,600-character base64 body
 * (har-2g), the presence of every DevTools-shaped feature, and the nesting
 * depth. Never holds the file; the longest-string scan tracks quote parity and
 * backslash escapes across windows. The bench runs it before measuring.
 */
import * as NodeFS from "node:fs";

import { type RequiredFixture } from "./fixtures.ts";

const FEATURES: ReadonlyArray<readonly [string, string]> = [
  ["_webSocketMessages", '"_webSocketMessages"'],
  ["base64 image", '"encoding":"base64"'],
  ["JWT", "Bearer eyJ"],
  ["form body", "application/x-www-form-urlencoded"],
  ["GraphQL", "operationName"],
  ["NDJSON", "application/x-ndjson"],
  // The leaf is stringified four times by the time it sits in the HAR `text`: 2^4 - 1 backslashes before its quote.
  ["nested 3-deep", `${"\\".repeat(15)}"leaf`],
  ["pages", '"pages":['],
  ["cookies", '"cookies":['],
  ["headers", '"headers":['],
  ["initiator", '"_initiator"'],
];

const WINDOW = 64 << 20;

export interface Verification {
  readonly ok: boolean;
  readonly lines: ReadonlyArray<string>;
  readonly longestString: number;
  readonly maxDepth: number;
}

export const verifyFixture = ({ path, size, fixture }: RequiredFixture): Verification => {
  const fd = NodeFS.openSync(path, "r");
  const buf = new Uint8Array(WINDOW + 4096);
  const needles = FEATURES.map(([label, text]) => ({
    label,
    bytes: Buffer.from(text, "utf8"),
    found: false,
  }));
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let longest = 0;
  let longestStart = -1;
  let maxDepth = 0;
  let depth = 0;
  let carry = 0;
  let position = 0;
  for (;;) {
    const n = NodeFS.readSync(fd, buf, carry, WINDOW, position);
    if (n === 0) break;
    const total = carry + n;
    const windowBase = position - carry;
    for (const needle of needles) {
      if (!needle.found && Buffer.from(buf.buffer, 0, total).indexOf(needle.bytes) >= 0)
        needle.found = true;
    }
    for (let i = carry; i < total; i++) {
      const b = buf[i] as number;
      if (inString) {
        if (escaped) escaped = false;
        else if (b === 0x5c) escaped = true;
        else if (b === 0x22) {
          inString = false;
          const length = windowBase + i - stringStart - 1;
          if (length > longest) {
            longest = length;
            longestStart = stringStart;
          }
        }
      } else if (b === 0x22) {
        inString = true;
        stringStart = windowBase + i;
      } else if (b === 0x7b || b === 0x5b) {
        depth++;
        if (depth > maxDepth) maxDepth = depth;
      } else if (b === 0x7d || b === 0x5d) depth--;
    }
    position += n;
    // Keep the last 4095 bytes so a needle straddling the window edge is still found.
    carry = Math.min(4095, total);
    buf.copyWithin(0, total - carry, total);
  }
  NodeFS.closeSync(fd);
  const lines = [
    `${fixture.name}: ${size} bytes (stated minimum ${fixture.minBytes}) ${size >= fixture.minBytes ? "OK" : "TOO SMALL"}`,
  ];
  let ok = size >= fixture.minBytes;
  if (fixture.shape === "har") {
    const bodyOk = longest >= fixture.bigBodyChars;
    ok &&= bodyOk;
    lines.push(
      `  longest string: ${longest} chars at byte ${longestStart} (needs ≥ ${fixture.bigBodyChars}) ${bodyOk ? "OK" : "FAIL"}`,
    );
    for (const needle of needles) {
      ok &&= needle.found;
      lines.push(`  ${needle.found ? "OK  " : "FAIL"} ${needle.label}`);
    }
  }
  if (fixture.shape === "deep") {
    const depthOk = maxDepth >= fixture.depth;
    ok &&= depthOk;
    lines.push(
      `  max nesting depth: ${maxDepth} (needs ${fixture.depth}) ${depthOk ? "OK" : "FAIL"}`,
    );
  }
  lines.push(`  ${fixture.name}: ${ok ? "PASS" : "FAIL"}`);
  return { ok, lines, longestString: longest, maxDepth };
};
