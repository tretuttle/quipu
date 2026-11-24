import { DesktopDocumentMessage } from "@quipu/contracts";
import * as Schema from "effect/Schema";
import { FileIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { isEditableFocused } from "../lib/editableFocus";
import { useDocumentSession } from "./documentSession.ts";
import { handleOfDroppedItem } from "./fileSystemAccess.ts";
import { useRecentDocuments } from "./recents.ts";
import { offerOpenFailure } from "./openDocument.ts";
import { desktopReopenId, reopenAfterReload } from "./reopenOnLoad.ts";

const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;

interface Area {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The page's main column, where the empty state sits; the drop card centers on it. */
function contentArea(): Area | null {
  const rect = document.querySelector("[data-content-area]")?.getBoundingClientRect();
  return rect === undefined
    ? null
    : { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}
const isDesktopDocument = Schema.is(DesktopDocumentMessage);

/**
 * Every way a document gets in that is not a menu: a file dropped on the
 * window, text pasted anywhere that is not a field, and on the desktop the
 * files the main process opened (dialog, command line, "Open with", a recent),
 * which the preload posts to the window with the port that reads each one.
 * Mounted once, beside the shell's command host.
 */
export function DocumentOpenHost() {
  // Null while nothing is dragged over the window; the area to center on while something is.
  const [dragging, setDragging] = useState<{ readonly area: Area | null } | null>(null);

  useEffect(() => {
    void useRecentDocuments.getState().hydrate();
    void reopenAfterReload();
    // Capture phase: the page must accept the drag before anything inside it can refuse.
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDragging((current) => current ?? { area: contentArea() });
    };
    const leave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragging(null);
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setDragging(null);
      const file = event.dataTransfer?.files[0];
      if (!file) return;
      // The handle is read in the event: a DataTransferItem is dead after it.
      const handle = handleOfDroppedItem(event.dataTransfer?.items[0]);
      void handle.then((resolved) => useDocumentSession.getState().openFile(file, resolved));
    };
    // On Linux, releasing the middle button pastes the primary selection: the
    // browser fires `paste` inside the same task as that release. A middle drag
    // pans the canvas, so that paste must never open a document. The mark lasts
    // until the next task, which a message posted now starts. Both the pointer
    // and the mouse release mark it: a page that cancels `pointerdown` gets no
    // `mouseup`, and the browser still pastes.
    let middleRelease = false;
    const clearMiddleRelease = new MessageChannel();
    clearMiddleRelease.port1.addEventListener("message", () => {
      middleRelease = false;
    });
    clearMiddleRelease.port1.start();
    const release = (event: MouseEvent) => {
      if (event.button !== 1) return;
      middleRelease = true;
      clearMiddleRelease.port2.postMessage(null);
    };
    const paste = (event: ClipboardEvent) => {
      // A field still takes the middle-click paste: the browser inserts it there.
      if (event.defaultPrevented || isEditableFocused(event.target) || middleRelease) return;
      const file = event.clipboardData?.files[0];
      if (file) {
        event.preventDefault();
        void useDocumentSession.getState().openFile(file, null);
        return;
      }
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text.length === 0) return;
      event.preventDefault();
      void useDocumentSession.getState().openPastedText(text);
    };
    window.addEventListener("dragenter", over, true);
    window.addEventListener("dragover", over, true);
    window.addEventListener("dragleave", leave, true);
    window.addEventListener("drop", drop, true);
    document.addEventListener("paste", paste);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("mouseup", release, true);
    return () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("mouseup", release, true);
      clearMiddleRelease.port1.close();
      window.removeEventListener("dragenter", over, true);
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("dragleave", leave, true);
      window.removeEventListener("drop", drop, true);
      document.removeEventListener("paste", paste);
    };
  }, []);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const arrived = (event: MessageEvent<unknown>) => {
      const port = event.ports[0];
      if (event.source !== window || port === undefined || !isDesktopDocument(event.data)) return;
      void useDocumentSession.getState().openDesktopDocument(event.data.document, port);
    };
    window.addEventListener("message", arrived);
    const stopFailures = bridge.onDocumentOpenFailed(offerOpenFailure);
    // The page is listening: the main process may hand over what it has waiting, or
    // open again the document this window had before a reload.
    bridge.documentsReady(desktopReopenId());
    return () => {
      window.removeEventListener("message", arrived);
      stopFailures();
    };
  }, []);

  return (
    <>
      {dragging !== null ? (
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-50 bg-background/80">
          <div
            className="absolute inset-0 flex items-center justify-center p-6"
            data-drop-card-area=""
            style={dragging.area ?? undefined}
          >
            <div
              className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-10 py-8 text-sm text-foreground"
              data-drop-card=""
            >
              <FileIcon className="size-5 text-muted-foreground" />
              Drop a file to open it
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
