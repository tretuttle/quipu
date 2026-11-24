// @effect-diagnostics nodeBuiltinImport:off - writes and inspects fixture files in a temp directory.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SEED,
  fixtureByName,
  fixtureProblem,
  requireFixture,
  writeSidecar,
} from "./fixtures.ts";
import { ensureFixture, generateFixture } from "./generate.ts";
import { verifyFixture } from "./verify.ts";

const MiB = 1024 * 1024;
const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "quipu-fixtures-"));
afterAll(() => {
  NodeFS.rmSync(dir, { recursive: true, force: true });
});

const sha256 = (path: string) => {
  const hash = NodeCrypto.createHash("sha256");
  hash.update(NodeFS.readFileSync(path));
  return hash.digest("hex");
};

describe("the fixture generator", () => {
  it("writes the same bytes for the same seed, and different bytes for another", () => {
    const spec = { ...fixtureByName("har-1m.har"), name: "a.har" };
    const a = generateFixture(spec, NodePath.join(dir, "a.har"), 1);
    const b = generateFixture({ ...spec, name: "b.har" }, NodePath.join(dir, "b.har"), 1);
    const c = generateFixture({ ...spec, name: "c.har" }, NodePath.join(dir, "c.har"), 2);
    expect(a.bytes).toBe(b.bytes);
    expect(c.bytes).toBeGreaterThanOrEqual(MiB);
    expect(sha256(NodePath.join(dir, "a.har"))).toBe(sha256(NodePath.join(dir, "b.har")));
    expect(sha256(NodePath.join(dir, "c.har"))).not.toBe(sha256(NodePath.join(dir, "a.har")));
    expect(a.bytes).toBeGreaterThanOrEqual(MiB);
  });

  it("writes a DevTools-shaped HAR that parses and carries every required feature", () => {
    const out = NodePath.join(dir, "har-1m.har");
    const { bytes } = generateFixture(fixtureByName("har-1m.har"), out, 3);
    const required = requireFixture("har-1m.har", dir);
    expect(required.size).toBe(bytes);
    const verification = verifyFixture(required);
    expect(verification.lines.join("\n")).toContain("PASS");
    expect(verification.ok).toBe(true);
    expect(verification.longestString).toBeGreaterThanOrEqual(128 * 1024);
    const har = JSON.parse(NodeFS.readFileSync(out, "utf8")) as {
      log: {
        version: string;
        creator: { name: string };
        pages: unknown[];
        entries: Array<Record<string, unknown>>;
      };
    };
    expect(har.log.version).toBe("1.2");
    expect(har.log.creator.name).toBe("WebInspector");
    expect(har.log.pages.length).toBeGreaterThanOrEqual(1);
    expect(har.log.entries.length).toBeGreaterThan(20);
    const entry = har.log.entries[0] as Record<string, unknown>;
    for (const key of [
      "_initiator",
      "_priority",
      "_resourceType",
      "cache",
      "connection",
      "pageref",
      "request",
      "response",
      "serverIPAddress",
      "startedDateTime",
      "time",
      "timings",
    ]) {
      expect(entry, key).toHaveProperty(key);
    }
    const media = har.log.entries.find((e) => e._resourceType === "media") as {
      response: { content: { encoding: string; text: string } };
    };
    expect(media.response.content.encoding).toBe("base64");
    expect(media.response.content.text.length).toBe(128 * 1024);
    const sockets = har.log.entries.filter((e) => Array.isArray(e._webSocketMessages));
    expect(sockets.length).toBeGreaterThan(0);
  });

  it("writes the wide array and the deep document to spec", () => {
    const wide = NodePath.join(dir, "json-1m-wide.json");
    generateFixture(fixtureByName("json-1m-wide.json"), wide, 1);
    const parsedWide = JSON.parse(NodeFS.readFileSync(wide, "utf8")) as Array<{ id: number }>;
    expect(parsedWide.length).toBeGreaterThan(5000);
    expect(parsedWide[parsedWide.length - 1]?.id).toBe(parsedWide.length - 1);
    const deep = NodePath.join(dir, "json-deep.json");
    generateFixture(fixtureByName("json-deep.json"), deep, 1);
    const verification = verifyFixture(requireFixture("json-deep.json", dir));
    expect(verification.ok).toBe(true);
    expect(verification.maxDepth).toBe(100_000);
  });

  it("refuses a missing, undersized or ungenerated file", () => {
    expect(() => requireFixture("har-50m.har", dir)).toThrow(/missing/);
    const stub = NodePath.join(dir, "har-50m.har");
    NodeFS.writeFileSync(stub, "{}");
    expect(() => requireFixture("har-50m.har", dir)).toThrow(/below its stated/);
    // A sparse file of the stated size (`truncate -s`) is not a fixture either.
    NodeFS.truncateSync(stub, 50 * MiB);
    expect(() => requireFixture("har-50m.har", dir)).toThrow(/sidecar/);
    writeSidecar(stub, { name: "har-50m.har", bytes: 1, seed: 1 });
    expect(() => requireFixture("har-50m.har", dir)).toThrow(/sidecar/);
    writeSidecar(stub, { name: "har-50m.har", bytes: 50 * MiB, seed: 1 });
    expect(requireFixture("har-50m.har", dir).size).toBe(50 * MiB);
  });

  it("names the command that generates a fixture in every reason it refuses one", () => {
    const empty = NodeFS.mkdtempSync(NodePath.join(dir, "empty-"));
    expect(fixtureProblem("har-2g.har", empty)).toMatch(
      /missing.*run: vp run fixtures har-2g\.har$/,
    );
    NodeFS.writeFileSync(NodePath.join(empty, "har-2g.har"), "{}");
    expect(fixtureProblem("har-2g.har", empty)).toMatch(
      /below its stated.*run: vp run fixtures har-2g\.har$/,
    );
    NodeFS.truncateSync(NodePath.join(empty, "har-2g.har"), 2 * 1024 * MiB);
    expect(fixtureProblem("har-2g.har", empty)).toMatch(
      /sidecar.*run: vp run fixtures har-2g\.har$/,
    );
  });
});

describe("a fixture a test needs", () => {
  it("is generated with the default seed into the scratch directory when the cache has none", () => {
    const cache = NodeFS.mkdtempSync(NodePath.join(dir, "cache-"));
    const scratch = NodePath.join(dir, "scratch-a");
    const got = ensureFixture("har-1m.har", scratch, cache);
    expect(got.path).toBe(NodePath.join(scratch, "har-1m.har"));
    expect(got.size).toBeGreaterThanOrEqual(MiB);
    // The same bytes `vp run fixtures har-1m.har` writes.
    const reference = NodePath.join(dir, "reference-har-1m.har");
    generateFixture(fixtureByName("har-1m.har"), reference, DEFAULT_SEED);
    expect(sha256(got.path)).toBe(sha256(reference));
    // A second call reuses what the first one wrote.
    const before = NodeFS.statSync(got.path).mtimeMs;
    expect(ensureFixture("har-1m.har", scratch, cache).path).toBe(got.path);
    expect(NodeFS.statSync(got.path).mtimeMs).toBe(before);
  });

  it("comes from the cache when the cache has a generated copy", () => {
    const cache = NodeFS.mkdtempSync(NodePath.join(dir, "cache-"));
    generateFixture(
      fixtureByName("json-1m-wide.json"),
      NodePath.join(cache, "json-1m-wide.json"),
      9,
    );
    const scratch = NodePath.join(dir, "scratch-b");
    expect(ensureFixture("json-1m-wide.json", scratch, cache).path).toBe(
      NodePath.join(cache, "json-1m-wide.json"),
    );
    expect(NodeFS.existsSync(scratch)).toBe(false);
  });

  it("is never a multi-gigabyte file generated on demand", () => {
    const cache = NodeFS.mkdtempSync(NodePath.join(dir, "cache-"));
    const scratch = NodePath.join(dir, "scratch-c");
    expect(() => ensureFixture("har-2g.har", scratch, cache)).toThrow(
      /too big to generate on demand; run: vp run fixtures har-2g\.har/,
    );
    expect(NodeFS.existsSync(scratch)).toBe(false);
  });
});
