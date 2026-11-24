import type { Decoded, Detection, NodeRef, NodeSummary } from "@quipu/contracts/engine";
import { describe, expect, it } from "vite-plus/test";

import { FRAMES_KEY, inspect, type InspectSource, VALUE_VIEW_BYTES } from "./inspection.ts";
import type { Selection } from "./treeModel.ts";

const ref = (token: number): NodeRef => ({ documentId: 1, tapeId: 0, token });
const node = (token: number, kind: NodeSummary["kind"], childCount = 0): NodeSummary => ({
  ref: ref(token),
  kind,
  range: { start: 0, end: 10 },
  span: { start: 0, end: 10 },
  key: null,
  childCount,
  childrenIndexed: true,
  settled: true,
});
const selection = (overrides: Partial<Selection> & Pick<Selection, "node">): Selection => ({
  id: `0.${overrides.node.ref.token}`,
  name: "value",
  path: ["root", "value"],
  detections: [],
  parent: null,
  index: null,
  decoded: false,
  ...overrides,
});

const jwtDetection: Detection = { kind: "jwt", label: "JWT · HS256", mime: null, structured: true };
const jsonDetection: Detection = { kind: "json", label: "JSON", mime: null, structured: true };
const decodedText = (kind: Decoded["kind"], text: string): Decoded => ({
  kind,
  label: kind,
  layers: [],
  mime: null,
  bytes: text.length,
  document: null,
  view: { _tag: "text", value: { text, truncated: false, bytes: text.length } },
});

const source = (overrides: Partial<InspectSource> = {}): InspectSource & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    text: async (r, limit) => {
      calls.push(`text:${r.token}:${limit}`);
      return { text: `value ${r.token}`, truncated: false, bytes: 7 };
    },
    decode: async (r, kind) => {
      calls.push(`decode:${r.token}:${kind}`);
      return decodedText(kind, `${kind} of ${r.token}`);
    },
    preview: async () => {
      throw new Error("not used");
    },
    frames: async (r, from, count) => {
      calls.push(`frames:${r.token}:${from}:${count}`);
      return { from, total: 0, frames: [] };
    },
    rows: async (r, from, count) => {
      calls.push(`rows:${r.token}:${from}:${count}`);
      return { from, total: 0, rows: [] };
    },
    ...overrides,
  };
};

describe("inspect", () => {
  it("reads a scalar's value up to the view limit and decodes every offered detection", async () => {
    const engine = source();
    const result = await inspect(
      engine,
      selection({ node: node(5, "string"), detections: [jwtDetection, jsonDetection] }),
    );
    expect(result.value).toEqual({ text: "value 5", truncated: false, bytes: 7 });
    expect(result.decodes.map((d) => [d.detection.kind, d.decoded?.kind, d.error])).toEqual([
      ["jwt", "jwt", null],
      ["json", "json", null],
    ]);
    expect(engine.calls).toContain(`text:5:${VALUE_VIEW_BYTES}`);
    expect(result.frames).toBeNull();
  });

  it("reports a decode that fails next to the ones that work", async () => {
    const engine = source({
      decode: async (r, kind) => {
        if (kind === "jwt") throw new Error("This is not a token.");
        return decodedText(kind, "{}");
      },
    });
    const result = await inspect(
      engine,
      selection({ node: node(5, "string"), detections: [jwtDetection, jsonDetection] }),
    );
    expect(result.decodes[0]).toMatchObject({ decoded: null, error: "This is not a token." });
    expect(result.decodes[1]?.decoded?.kind).toBe("json");
  });

  it("does not read a container as text, and lists its first members instead", async () => {
    const engine = source();
    const result = await inspect(engine, selection({ node: node(2, "object", 4) }));
    expect(result.value).toBeNull();
    expect(engine.calls).toEqual(["rows:2:0:50"]);
    const empty = source();
    await inspect(empty, selection({ node: node(3, "array", 0) }));
    expect(empty.calls).toEqual([]);
  });

  it("lists frames for the _webSocketMessages array and for one frame of it", async () => {
    const engine = source();
    await inspect(engine, selection({ node: node(7, "array", 40), name: FRAMES_KEY }));
    expect(engine.calls).toEqual(["frames:7:0:100"]);

    const single = source();
    await inspect(
      single,
      selection({
        node: node(9, "object", 4),
        index: 12,
        parent: { ref: ref(7), key: FRAMES_KEY },
      }),
    );
    expect(single.calls).toEqual(["frames:7:12:1"]);
  });

  it("leaves the frames out when the engine cannot list them, and keeps the rest", async () => {
    const engine = source({
      frames: async () => {
        throw new Error("no frames");
      },
    });
    const result = await inspect(
      engine,
      selection({ node: node(7, "array", 3), name: FRAMES_KEY }),
    );
    expect(result.frames).toBeNull();
    expect(result.value).toBeNull();
  });
});
