// @vitest-environment jsdom

import type { TraceOccurrence, TraceResult } from "@quipu/contracts/deepSearch";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { computeTraceArcs } from "../components/map/TraceArcs.tsx";
import {
  computeAncestorClosure,
  filterIdsByHits,
  filterRowIndicesByHits,
  useDeepHitStore,
  useMatchFilterStore,
} from "./hitFilter.ts";
import type { MapSnapshot } from "./mapModel.ts";
import { TracePanel } from "./TracePanel.tsx";

describe("hitFilter helpers", () => {
  it("computes exact ancestor closure without unrelated siblings", () => {
    const parents = new Map<string, string | null>([
      ["root", null],
      ["a", "root"],
      ["a1", "a"],
      ["a2", "a"],
      ["b", "root"],
      ["b1", "b"],
    ]);
    const closure = computeAncestorClosure(["a2"], (id) => parents.get(id));
    expect([...closure].sort()).toEqual(["a", "a2", "root"]);
  });

  it("filters flat table row indices by overlapping hit ranges", () => {
    const rowRanges = [
      { start: 0, end: 20 },
      { start: 21, end: 40 },
      { start: 41, end: 60 },
      null,
      { start: 61, end: 100 },
    ];
    const hits = [
      { start: 25, end: 30 },
      { start: 70, end: 75 },
    ];
    expect(filterRowIndicesByHits(rowRanges, hits)).toEqual([1, 4]);
    expect(filterIdsByHits(["r0", "r1", "r2"], (id) => id, new Set(["r1"]))).toEqual(["r1"]);
  });

  it("manages match filter and deep hit annotation stores", () => {
    useMatchFilterStore.getState().clear();
    useMatchFilterStore.getState().setMatchedIds(new Set(["n1"]));
    useMatchFilterStore.getState().toggle();
    expect(useMatchFilterStore.getState().enabled).toBe(true);
    expect([...useMatchFilterStore.getState().matchedIds]).toEqual(["n1"]);
    useMatchFilterStore.getState().clear();
    expect(useMatchFilterStore.getState().enabled).toBe(false);

    useDeepHitStore.getState().setAnnotations(1, [
      {
        range: { start: 100, end: 180 },
        decodeChain: ["base64", "json-string", "json"],
        snippet: '{"id":"usr_1"}',
      },
    ]);
    expect(
      useDeepHitStore.getState().annotationForRange({ start: 100, end: 180 })?.decodeChain,
    ).toEqual(["base64", "json-string", "json"]);
    expect(useDeepHitStore.getState().annotationForRange({ start: 10, end: 20 })).toBeNull();
  });
});

describe("TracePanel and TraceArcs", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders honest wording, HAR grouping, clickable occurrences, and Clear action", async () => {
    const occurrences: TraceOccurrence[] = [
      {
        range: { start: 10, end: 40 },
        ref: { documentId: 1, tapeId: 0, token: 5 },
        pointer: "/response/content/text/session/token",
        decodeChain: ["json"],
        entryIndex: 3,
        section: "response.content",
        snippet: "sess_Q7",
      },
      {
        range: { start: 200, end: 230 },
        ref: { documentId: 1, tapeId: 0, token: 12 },
        pointer: "/request/headers/8/value",
        decodeChain: [],
        entryIndex: 10,
        section: "request.headers",
        snippet: "sess_Q7",
      },
    ];
    const result: TraceResult = {
      value: "sess_Q7",
      total: 2,
      truncated: false,
      isHar: true,
      occurrences,
      harGroups: [
        {
          entryIndex: 3,
          method: "POST",
          url: "https://example.com/login",
          status: 200,
          occurrences: [occurrences[0]!],
        },
        {
          entryIndex: 10,
          method: "GET",
          url: "https://example.com/me",
          status: 200,
          occurrences: [occurrences[1]!],
        },
      ],
    };
    const onSelect = vi.fn();
    const onClear = vi.fn();

    await act(() =>
      root.render(<TracePanel result={result} onSelectOccurrence={onSelect} onClear={onClear} />),
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Every place this exact value appears");
    expect(text).not.toContain("sent back");
    expect(text).toContain("2 occurrences");
    expect(text).toContain("#3");
    expect(text).toContain("#10");

    const buttons = [...container.querySelectorAll<HTMLButtonElement>("[data-trace-occurrence]")];
    expect(buttons).toHaveLength(2);
    await act(() => {
      buttons[0]!.click();
    });
    expect(onSelect).toHaveBeenCalledWith(occurrences[0]);

    const clearBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Clear",
    )!;
    await act(() => {
      clearBtn.click();
    });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("computes transient SVG arcs between visible origin and target map nodes", () => {
    const snapshot: MapSnapshot = {
      version: 1,
      nodes: [
        {
          id: "0.1",
          kind: "object",
          parentId: null,
          title: "root",
          subtitle: "2 keys",
          rows: [],
          anchor: 0,
          keyDepth: 1,
          treeId: "0.1",
          width: 200,
          height: 80,
          level: 1,
          position: 1,
          setSize: 1,
          expandable: true,
          expanded: true,
          decoded: false,
          preview: null,
        },
        {
          id: "0.2",
          kind: "object",
          parentId: "0.1",
          title: "target",
          subtitle: "1 key",
          rows: [],
          anchor: 28,
          keyDepth: 2,
          treeId: "0.2",
          width: 200,
          height: 80,
          level: 2,
          position: 1,
          setSize: 1,
          expandable: true,
          expanded: true,
          decoded: false,
          preview: null,
        },
      ],
      byId: new Map(),
      childrenOf: new Map(),
      positions: new Map([
        ["0.1", { x: 0, y: 0 }],
        ["0.2", { x: 300, y: 120 }],
      ]),
      bounds: { x: 0, y: 0, width: 500, height: 200 },
      grouping: null,
      laidOutGrouping: null,
      locations: new Map([
        ["0.1", { nodeId: "0.1", rowIndex: null }],
        ["0.2", { nodeId: "0.2", rowIndex: null }],
      ]),
      rowLocations: new Map(),
      charWidth: 7.2,
    };
    for (const node of snapshot.nodes) {
      (snapshot.byId as Map<string, typeof node>).set(node.id, node);
    }
    const occurrences: TraceOccurrence[] = [
      {
        range: { start: 10, end: 20 },
        ref: { documentId: 1, tapeId: 0, token: 1 },
        pointer: "/a",
        decodeChain: [],
        entryIndex: null,
        section: null,
        snippet: "v",
      },
      {
        range: { start: 50, end: 60 },
        ref: { documentId: 1, tapeId: 0, token: 2 },
        pointer: "/b",
        decodeChain: [],
        entryIndex: null,
        section: null,
        snippet: "v",
      },
    ];
    const arcs = computeTraceArcs({ start: 10, end: 20 }, occurrences, snapshot);
    expect(arcs).toHaveLength(1);
    expect(arcs[0]?.fromNodeId).toBe("0.1");
    expect(arcs[0]?.toNodeId).toBe("0.2");
    expect(arcs[0]?.path).toContain("M 100 40 Q");
  });
});
