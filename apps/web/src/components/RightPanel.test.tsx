// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RightPanel } from "./RightPanel";
import { useRightPanelStore } from "../rightPanelStore";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useRightPanelStore.setState({ isOpen: true, activeTab: "inspector" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function tab(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (button) => (button.textContent ?? "").trim() === name,
  );
  if (!found) throw new Error(`No ${name} tab.`);
  return found;
}

function selectedTabs(): string[] {
  return [...container.querySelectorAll('[role="tab"][aria-selected="true"]')].map((button) =>
    (button.textContent ?? "").trim(),
  );
}

function panelText(): string {
  return container.querySelector('[role="tabpanel"]')?.textContent ?? "";
}

describe("right panel", () => {
  it("lists the Inspector and Source tabs, with the Inspector selected and its empty state showing", async () => {
    await act(() => root.render(<RightPanel />));

    const names = [...container.querySelectorAll('[role="tab"]')].map((button) =>
      (button.textContent ?? "").trim(),
    );
    expect(names).toEqual(["Inspector", "Source"]);
    expect(selectedTabs()).toEqual(["Inspector"]);
    expect(panelText()).toContain("Nothing to inspect");
  });

  it("shows the Source tab's empty state when it is selected", async () => {
    await act(() => root.render(<RightPanel />));

    await act(() => tab("Source").click());
    expect(selectedTabs()).toEqual(["Source"]);
    expect(panelText()).toContain("No source to show");
  });

  it("moves between tabs with the arrow keys, wrapping at both ends", async () => {
    await act(() => root.render(<RightPanel />));
    const press = (key: string) =>
      act(async () => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      });

    tab("Inspector").focus();
    await press("ArrowLeft");
    expect(selectedTabs()).toEqual(["Source"]);
    await press("ArrowRight");
    expect(selectedTabs()).toEqual(["Inspector"]);
    await press("End");
    expect(selectedTabs()).toEqual(["Source"]);
    await press("Home");
    expect(selectedTabs()).toEqual(["Inspector"]);
  });

  it("hides itself from the keyboard and assistive tech while closed", async () => {
    useRightPanelStore.setState({ isOpen: false });
    await act(() => root.render(<RightPanel />));

    const panel = container.querySelector("[data-right-panel]");
    expect(panel?.getAttribute("data-state")).toBe("closed");
    expect(panel?.hasAttribute("inert")).toBe(true);
  });
});
