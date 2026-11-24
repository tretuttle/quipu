import type { DesktopOpenFailure, DesktopOpenFailureReason } from "@quipu/contracts";
import { toastManager } from "../components/ui/toast";
import { stackedToast } from "../components/ui/toastHelpers";
import { useDocumentSession } from "./documentSession.ts";
import { OPEN_PICKER_TYPES } from "./documentFormats.ts";
import { pickFileHandle, supportsFilePicker } from "./fileSystemAccess.ts";
import { reopenRecent, useRecentDocuments } from "./recents.ts";

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

function chooseWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/**
 * "Open file…": the desktop's native dialog, else the File System Access
 * picker (which keeps a handle for recents), else an `<input type=file>`.
 */
export async function openWithDialog(): Promise<void> {
  const bridge = window.desktopBridge;
  if (bridge) {
    await bridge.openDocumentDialog();
    return;
  }
  const { openFile } = useDocumentSession.getState();
  if (supportsFilePicker()) {
    try {
      const handle = await pickFileHandle(OPEN_PICKER_TYPES);
      await openFile(await handle.getFile(), handle);
    } catch (error) {
      if (!isAbort(error)) throw error;
    }
    return;
  }
  const file = await chooseWithInput();
  if (file) await openFile(file, null);
}

/**
 * Reopens a recent document. When the browser wants permission again, a toast
 * offers the button whose click makes the request (it needs a user gesture that
 * no `await` has consumed); a refusal offers the picker instead.
 */
export async function openRecent(id: string): Promise<void> {
  const outcome = await reopenRecent(id);
  const { openFile } = useDocumentSession.getState();
  switch (outcome.kind) {
    case "desktop":
      return;
    case "file":
      await openFile(outcome.file, outcome.handle, { recentId: id });
      return;
    case "needs-permission": {
      const { handle, name } = outcome;
      toastManager.add(
        stackedToast({
          type: "info",
          title: `Quipu needs access to ${name}`,
          description: "The browser asks you to allow reading this file again.",
          actionProps: {
            children: "Allow access",
            onClick: () => {
              // No await before the request: it needs the click's user activation.
              void handle.requestPermission({ mode: "read" }).then(async (state) => {
                if (state === "granted")
                  await openFile(await handle.getFile(), handle, { recentId: id });
                else offerPicker(name, "denied", id);
              });
            },
          },
        }),
      );
      return;
    }
    case "denied":
    case "missing":
      offerPicker(outcome.name, outcome.kind, id);
  }
}

const UNOPENED_TITLES: Record<DesktopOpenFailureReason, (name: string) => string> = {
  denied: (name) => `Access to ${name} was not allowed`,
  missing: (name) => `${name} can't be found`,
  unreadable: (name) => `${name} can't be read`,
};

/** A file the desktop app could not open: the same notice as a recent the browser cannot read. */
export function offerOpenFailure(failure: DesktopOpenFailure) {
  offerPicker(failure.name, failure.reason, failure.id);
}

/**
 * A file that could not be read says so and offers the ways out: choose the file
 * again, or, for a recent document, take it off the list.
 */
function offerPicker(name: string, reason: DesktopOpenFailureReason, recentId?: string) {
  const id = toastManager.add(
    stackedToast({
      type: "warning",
      title: UNOPENED_TITLES[reason](name),
      description: "Choose the file again to open it.",
      actionProps: {
        children: "Choose the file",
        onClick: () => {
          void openWithDialog();
        },
      },
      ...(recentId === undefined
        ? {}
        : {
            data: {
              secondaryActionProps: {
                children: REMOVE_RECENT,
                onClick: () => {
                  toastManager.close(id);
                  void forgetRecent(recentId);
                },
              },
            },
          }),
    }),
  );
}

/** The label of the way out that takes a recent document off the list. */
export const REMOVE_RECENT = "Remove from recent documents";

export function forgetRecent(id: string) {
  return useRecentDocuments.getState().remove(id);
}
