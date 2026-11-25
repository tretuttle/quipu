// @vitest-environment jsdom

import type { HarDiffSummary, StructuralDiffResult } from "@quipu/contracts/diff";
import { act, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@legendapp/list/react", () => ({
  LegendList: forwardRef(function MockLegendList(
    props: {
      readonly data: ReadonlyArray<unknown>;
      readonly renderItem: (info: { item: unknown; index: number }) => React.ReactNode;
      readonly keyExtractor?: (item: unknown, index: number) => string;
    },
    ref,
  ) {
    useImperativeHandle(ref, () => ({ scrollIndexIntoView: () => {} }));
    return (
      <div>
        {props.data.map((item, index) => (
          <div key={props.keyExtractor ? props.keyExtractor(item, index) : index}>
            {props.renderItem({ item, index })}
          </div>
        ))}
      </div>
    );
  }),
}));

import { CompareView } from "./CompareView.tsx";
import { type CompareClient, CompareModel, type CompareTargetDocument } from "./compareModel.ts";

let root: Root;
let container: HTMLDivElement;

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

const DOC_A: CompareTargetDocument = {
  documentId: 1,
  name: "before.json",
  size: 100,
  format: "json",
};

const DOC_B: CompareTargetDocument = {
  documentId: 2,
  name: "after.json",
  size: 120,
  format: "json",
};

const STRUCTURAL_RESULT: StructuralDiffResult = {
  changes: [
    { kind: "changed", aToken: 1, bToken: 1, pathA: "/name", pathB: "/name" },
    { kind: "added", aToken: null, bToken: 2, pathA: null, pathB: "/extra" },
  ],
  counts: { same: 1, added: 1, removed: 0, changed: 1, moved: 0 },
  rows: [
    {
      id: "b:0",
      aToken: 0,
      bToken: 0,
      depth: 0,
      mark: "inside",
      kind: "object",
      key: null,
      index: null,
      value: "{ 2 keys }",
      wasValue: null,
      pointer: "",
      expandable: true,
      childCount: 2,
    },
    {
      id: "b:1",
      aToken: 1,
      bToken: 1,
      depth: 1,
      mark: "changed",
      kind: "string",
      key: "name",
      index: null,
      value: '"Ada L."',
      wasValue: '"Ada"',
      pointer: "/name",
      expandable: false,
      childCount: 0,
    },
    {
      id: "b:2",
      aToken: null,
      bToken: 2,
      depth: 1,
      mark: "added",
      kind: "true",
      key: "extra",
      index: null,
      value: "true",
      wasValue: null,
      pointer: "/extra",
      expandable: false,
      childCount: 0,
    },
  ],
};

describe("CompareView", () => {
  it("renders change counts, change sidebar, and steps changes with F7 / Shift+F7", async () => {
    const model = new CompareModel(DOC_A, {
      compareStructural: vi.fn().mockResolvedValue(STRUCTURAL_RESULT),
      compareHar: vi.fn(),
    });
    model.setPrecomputedResult(DOC_B, { structural: STRUCTURAL_RESULT });

    await act(() => root.render(<CompareView primary={DOC_A} model={model} />));

    const view = container.querySelector<HTMLElement>("[data-compare-view]")!;
    expect(view).toBeTruthy();
    expect(container.querySelector("[data-diff-counts]")?.textContent).toContain("+1");
    expect(container.querySelector("[data-diff-counts]")?.textContent).toContain("~1");

    const changeItems = container.querySelectorAll("[data-change-item]");
    expect(changeItems).toHaveLength(2);
    expect(changeItems[0]?.hasAttribute("data-active")).toBe(true);

    await act(async () => {
      view.dispatchEvent(new KeyboardEvent("keydown", { key: "F7", bubbles: true }));
    });
    expect(model.snapshot().activeChangeIndex).toBe(1);

    await act(async () => {
      view.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F7", shiftKey: true, bubbles: true }),
      );
    });
    expect(model.snapshot().activeChangeIndex).toBe(0);
  });

  it("supports inline clipboard paste to open a comparison target", async () => {
    const openTarget = vi.fn().mockResolvedValue(DOC_B);
    const compareStructural = vi.fn().mockResolvedValue(STRUCTURAL_RESULT);
    const client: CompareClient = {
      openTarget,
      compareStructural,
      compareHar: vi.fn(),
    };
    await act(() => root.render(<CompareView primary={DOC_A} client={client} />));

    const pasteBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Paste from clipboard"),
    );
    expect(pasteBtn).toBeTruthy();

    await act(async () => {
      pasteBtn!.click();
    });

    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, '{"name":"Ada L.","extra":true}');
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const submitBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Compare pasted text"),
    );
    await act(async () => {
      submitBtn!.click();
    });

    expect(openTarget).toHaveBeenCalledTimes(1);
    expect(compareStructural).toHaveBeenCalledWith(1, 2);
  });

  it("renders HAR request diff list with section chips, swap reference, and inline body diff", async () => {
    const harA: CompareTargetDocument = { documentId: 10, name: "a.har", size: 500, format: "har" };
    const harB: CompareTargetDocument = { documentId: 11, name: "b.har", size: 600, format: "har" };
    const harSummary: HarDiffSummary = {
      referenceIndex: 0,
      counts: { same: 0, added: 0, removed: 0, changed: 1 },
      entries: [
        {
          matchKey: "abc",
          groupId: 0,
          occurrence: 0,
          classification: "changed",
          method: "POST",
          url: "https://api.shop.test/v1/order/7",
          resourceType: "fetch",
          statusBefore: 200,
          statusAfter: 201,
          entryIndexBefore: 0,
          entryIndexAfter: 0,
          changedSections: ["headers", "status", "body"],
        },
      ],
    };
    const compareHar = vi.fn().mockResolvedValue(harSummary);
    const compareHarEntryBody = vi.fn().mockResolvedValue(STRUCTURAL_RESULT);
    const model = new CompareModel(harA, {
      compareStructural: vi.fn(),
      compareHar,
      compareHarEntryBody,
    });
    await model.setTarget(harB);

    await act(() => root.render(<CompareView primary={harA} model={model} />));

    const row = container.querySelector<HTMLElement>("[data-har-diff-row]");
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("POST");
    expect(row?.textContent).toContain("200 -> 201");
    expect(row?.textContent).toContain("https://api.shop.test/v1/order/7");
    expect(row?.textContent).toContain("headers");
    expect(row?.textContent).toContain("body");

    const toggleBtn = row?.querySelector<HTMLElement>('[role="button"]');
    await act(async () => {
      toggleBtn?.click();
    });
    expect(compareHarEntryBody).toHaveBeenCalledWith(10, 0, 11, 0);
    expect(container.textContent).toContain('(was "Ada")');

    const swapBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Swap ref"),
    );
    await act(async () => {
      swapBtn!.click();
    });
    expect(compareHar).toHaveBeenLastCalledWith(10, 11, "b");
  });
});
