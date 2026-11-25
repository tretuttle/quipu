// @vitest-environment jsdom

import type { CodegenLanguage, Shape } from "@quipu/contracts/schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CodegenDialog } from "./CodegenDialog";
import { ProblemsPanel } from "./ProblemsPanel";
import { SchemaPanel } from "./SchemaPanel";

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

const SAMPLE_SHAPE: Shape = {
  samples: 2,
  nulls: 0,
  bools: 0,
  integers: 0,
  floats: 0,
  string: null,
  array: null,
  object: {
    count: 2,
    fields: [
      {
        name: "id",
        present: 2,
        shape: {
          samples: 2,
          nulls: 0,
          bools: 0,
          integers: 2,
          floats: 0,
          string: null,
          array: null,
          object: null,
        },
      },
      {
        name: "status",
        present: 3,
        shape: {
          samples: 3,
          nulls: 0,
          bools: 0,
          integers: 0,
          floats: 0,
          string: {
            count: 3,
            formats: [0, 0, 0, 0, 0],
            values: [
              { value: "paid", count: 2 },
              { value: "open", count: 1 },
            ],
          },
          array: null,
          object: null,
        },
      },
      {
        name: "note",
        present: 1,
        shape: {
          samples: 1,
          nulls: 0,
          bools: 0,
          integers: 0,
          floats: 0,
          string: { count: 1, formats: [0, 0, 0, 0, 0], values: null },
          array: null,
          object: null,
        },
      },
    ],
  },
};

describe("SchemaPanel", () => {
  it("renders inferred fields, presence, enums, and emits path queries on click", async () => {
    const onFieldClick = vi.fn();
    const onValidate = vi.fn();
    const onCodegen = vi.fn();

    await act(() =>
      root.render(
        <SchemaPanel
          shape={SAMPLE_SHAPE}
          onFieldClick={onFieldClick}
          onValidateWithSchema={onValidate}
          onGenerateTypes={onCodegen}
        />,
      ),
    );

    expect(container.textContent).toContain("2 samples");
    expect(container.textContent).toContain("100%");
    expect(container.textContent).toContain("50%");
    expect(container.textContent).toContain("paid");

    const idBtn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "id",
    );
    expect(idBtn).toBeDefined();
    await act(() => idBtn!.click());
    expect(onFieldClick).toHaveBeenCalledWith("$.id", "/id");

    const valBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Validate with Schema"),
    );
    await act(() => valBtn!.click());
    expect(onValidate).toHaveBeenCalledOnce();

    const genBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Generate Types"),
    );
    await act(() => genBtn!.click());
    expect(onCodegen).toHaveBeenCalledOnce();
  });
});

describe("ProblemsPanel", () => {
  it("pre-fills inferred schema, runs HAR validation, and jumps on failure click", async () => {
    const onValidate = vi.fn();
    const onSelectFailure = vi.fn();
    const inferredText = '{"type":"object"}';

    await act(() =>
      root.render(
        <ProblemsPanel
          inferredSchemaText={inferredText}
          isHar
          result={{
            valid: false,
            truncated: false,
            checkedEntries: 2,
            failures: [
              {
                pointer: "/order/id",
                keyword: "type",
                message: "expected integer, found string",
                entryIndex: 1,
              },
            ],
          }}
          onValidate={onValidate}
          onSelectFailure={onSelectFailure}
        />,
      ),
    );

    const useBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Use inferred"),
    );
    await act(() => useBtn!.click());

    const validateBtn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Validate",
    );
    await act(() => validateBtn!.click());
    expect(onValidate).toHaveBeenCalledWith(inferredText, {
      urlPattern: "",
      section: "response",
    });

    const failureRow = container.querySelector("[data-problems-list] button") as HTMLButtonElement;
    expect(failureRow.textContent).toContain("/order/id");
    expect(failureRow.textContent).toContain("Entry #1");
    await act(() => failureRow.click());
    expect(onSelectFailure).toHaveBeenCalledWith({
      pointer: "/order/id",
      keyword: "type",
      message: "expected integer, found string",
      entryIndex: 1,
    });
  });
});

describe("CodegenDialog", () => {
  it("switches all 9 language targets, updates root name, and copies output", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const generate = vi.fn(
      ({ language, rootName }: { language: CodegenLanguage; rootName: string }) => ({
        language,
        rootName,
        extension: language === "rust" ? "rs" : "ts",
        code: `// ${language}:${rootName}`,
      }),
    );

    await act(() =>
      root.render(
        <CodegenDialog open onOpenChange={() => {}} defaultRootName="Order" generate={generate} />,
      ),
    );

    const tabs = document.body.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(9);

    const rustTab = [...tabs].find((t) => t.textContent?.trim() === "Rust") as HTMLButtonElement;
    await act(() => rustTab.click());

    const preview = document.body.querySelector("[data-codegen-preview]");
    expect(preview?.textContent).toBe("// rust:Order");

    const copyBtn = [...document.body.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Copy"),
    ) as HTMLButtonElement;
    await act(() => copyBtn.click());
    expect(writeText).toHaveBeenCalledWith("// rust:Order");
  });
});
