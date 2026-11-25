// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { WorkspaceHeader } from "./WorkspaceHeader";
import type { DocumentView } from "./DocumentViewToggle";

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

async function render(node: React.ReactElement) {
  await act(() => root.render(node));
}

function viewToggle(): HTMLElement | null {
  return container.querySelector('[aria-label="Document view"]');
}

function viewLabels(): string[] {
  return [...(viewToggle()?.querySelectorAll("button") ?? [])].map((button) =>
    (button.textContent ?? "").trim(),
  );
}

describe("workspace header", () => {
  it("shows no view toggle while no document is open", async () => {
    await render(<WorkspaceHeader document={null} />);

    expect(viewToggle()).toBeNull();
    expect(container.textContent).toContain("Documents");
  });

  it("shows the six views, with the open document's view selected, once one is open", async () => {
    await render(<WorkspaceHeader document={{ name: "trace.har", view: "source" }} />);

    expect(viewLabels()).toEqual(["Map", "Tree", "Table", "Compare", "Source", "ER"]);
    const pressed = [...(viewToggle()?.querySelectorAll("button") ?? [])]
      .filter((button) => button.getAttribute("aria-pressed") === "true")
      .map((button) => (button.textContent ?? "").trim());
    expect(pressed).toEqual(["Source"]);
  });

  it("names the document in the breadcrumb as the current page", async () => {
    await render(<WorkspaceHeader document={{ name: "trace.har", view: "map" }} />);

    const trail = container.querySelector('nav[aria-label="Workspace breadcrumb"]');
    expect(trail?.textContent).toContain("Documents");
    expect(trail?.querySelector('[aria-current="page"]')?.textContent).toBe("trace.har");
  });

  it("reports the view the user picks, and keeps the current one when it is pressed again", async () => {
    const picked: DocumentView[] = [];
    await render(
      <WorkspaceHeader
        document={{ name: "trace.har", view: "map" }}
        onViewChange={(view) => picked.push(view)}
      />,
    );

    const buttons = [...(viewToggle()?.querySelectorAll("button") ?? [])];
    const byLabel = (label: string) =>
      buttons.find((button) => (button.textContent ?? "").trim() === label);
    await act(() => byLabel("Table")?.click());
    await act(() => byLabel("Map")?.click());

    expect(picked).toEqual(["table"]);
  });

  it("always offers the right-panel toggle, and reflects whether the panel is open", async () => {
    await render(<WorkspaceHeader document={null} />);

    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Toggle right panel"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    await act(() => toggle?.click());
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
  });
});
