// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { requestConfirmDialog, resetConfirmDialogForTests } from "../confirmDialog";
import { ConfirmDialogHost } from "./ConfirmDialogHost";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetConfirmDialogForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="alertdialog"]');
}

function button(name: string): HTMLButtonElement {
  const found = [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (candidate) => (candidate.textContent ?? "").trim() === name,
  );
  if (!found) throw new Error(`The dialog has no ${name} button.`);
  return found;
}

function request(
  message: string,
  options: Parameters<typeof requestConfirmDialog>[1] = { confirmLabel: "Continue" },
) {
  const result = requestConfirmDialog(message, options);
  if (!result) throw new Error("Expected a mounted confirmation host.");
  return result;
}

describe("confirmation dialog", () => {
  it("asks nothing, and shows nothing, when no host is mounted", () => {
    expect(requestConfirmDialog("Delete everything?", { confirmLabel: "Delete" })).toBeUndefined();
    expect(dialog()).toBeNull();
  });

  it("shows the question as its title with the rest of the message under it", async () => {
    await act(() => root.render(<ConfirmDialogHost />));
    let answer: Promise<boolean> | undefined;
    await act(async () => {
      answer = request("Clear caches?\nThe next open will rebuild them.", {
        confirmLabel: "Clear",
      });
    });

    expect(dialog()?.textContent).toContain("Clear caches?");
    expect(dialog()?.textContent).toContain("The next open will rebuild them.");
    expect(button("Cancel")).toBeTruthy();
    // The confirming button names the action, never a bare "Confirm".
    expect(button("Clear")).toBeTruthy();
    await act(() => button("Cancel").click());
    await expect(answer).resolves.toBe(false);
  });

  it("puts focus on Cancel, so Enter cannot confirm by accident", async () => {
    await act(() => root.render(<ConfirmDialogHost />));
    await act(async () => {
      void request("Delete this document?", { confirmLabel: "Delete", variant: "destructive" });
    });

    await vi.waitFor(() => expect(document.activeElement).toBe(button("Cancel")));
  });

  it("hands the confirming button back as true and closes the dialog", async () => {
    await act(() => root.render(<ConfirmDialogHost />));
    let answer: Promise<boolean> | undefined;
    await act(async () => {
      answer = request("Continue?");
    });

    await act(() => button("Continue").click());
    await expect(answer).resolves.toBe(true);
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });

  it("shows queued questions one after another, each with its own answer", async () => {
    await act(() => root.render(<ConfirmDialogHost />));
    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    await act(async () => {
      first = request("Delete the board?");
      second = request("Delete its drawings too?");
    });

    expect(dialog()?.textContent).toContain("Delete the board?");
    expect(dialog()?.textContent).not.toContain("Delete its drawings too?");

    await act(() => button("Cancel").click());
    await expect(first).resolves.toBe(false);
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Delete its drawings too?"));

    await act(() => button("Continue").click());
    await expect(second).resolves.toBe(true);
  });

  it("cancels the open question and the queued ones when the host goes away", async () => {
    await act(() => root.render(<ConfirmDialogHost />));
    let open: Promise<boolean> | undefined;
    let queued: Promise<boolean> | undefined;
    await act(async () => {
      open = request("Delete the board?");
      queued = request("Delete its drawings too?");
    });
    expect(dialog()).not.toBeNull();

    await act(() => root.render(null));
    await expect(Promise.all([open, queued])).resolves.toEqual([false, false]);
    expect(dialog()).toBeNull();
  });
});
