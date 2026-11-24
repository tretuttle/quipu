import { FileIcon, FileUpIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { formatBytes } from "~/lib/formatBytes";
import { MapView } from "~/components/map/MapView";
import { MapStatus } from "~/components/map/mapStatus";
import { useDocumentView } from "~/documentViewStore";
import { DecodeMenu } from "./DecodeMenu.tsx";
import { useDecodePreferences } from "./decodePreferences.ts";
import { type OpenDocument, useDocumentSession } from "./documentSession.ts";
import { structuredFormatNames } from "./formatNames.ts";
import { focusViewWhenReady } from "./viewFocus.ts";
import { ExportDialog } from "./ExportDialog.tsx";
import { forgetRecent, openWithDialog, REMOVE_RECENT } from "./openDocument.ts";
import { useProblemFocus } from "./problemFocus.ts";
import { SourceView } from "./LazySourceView.tsx";
import { QueryBar } from "./QueryBar.tsx";
import { selectedNodeId, useSelectionStore } from "./selectionStore.ts";
import { TreeView } from "./TreeView.tsx";

/** What fills the page under the header: the empty state, a progress line, an error, or the view. */
export function DocumentWorkspace() {
  const session = useDocumentSession((state) => state.session);

  switch (session.phase) {
    case "empty":
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-(--workspace-topbar-height)">
          <div className="flex max-w-xs flex-col items-center gap-3 text-center">
            <h1 className="font-medium text-foreground text-sm">No document open</h1>
            <p className="text-xs leading-normal text-muted-foreground/80">
              Drop a file on the window, paste text, or open a file. Any file opens;{" "}
              {structuredFormatNames} show their structure.
            </p>
            <Button size="sm" variant="outline" onClick={() => void openWithDialog()}>
              <FileUpIcon />
              Open file…
            </Button>
          </div>
        </div>
      );
    case "opening":
      return (
        <div
          role="status"
          className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
        >
          <Spinner size="sm" />
          Opening {session.name}…
        </div>
      );
    case "error":
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <div role="alert" className="flex max-w-sm flex-col items-center gap-2 text-center">
            <h1 className="font-medium text-foreground text-sm">Could not open {session.name}</h1>
            <p className="text-xs text-muted-foreground">{session.message}</p>
            {/* The ways out: the file from disk again, or the recent that no longer opens off the list. */}
            <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={() => void openWithDialog()}>
                <FileUpIcon />
                Open file…
              </Button>
              {session.recentId === null ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const id = session.recentId as string;
                    void forgetRecent(id).then(() => useDocumentSession.getState().closeDocument());
                  }}
                >
                  {REMOVE_RECENT}
                </Button>
              )}
            </div>
          </div>
        </div>
      );
    case "open":
      return <OpenDocumentView document={session.document} />;
  }
}

function OpenDocumentView({ document }: { readonly document: OpenDocument }) {
  const view = useDocumentView((state) => state.view);
  const tree = document.tree;
  // The Inspector shows the shared selection, whichever view made it.
  const selection = useSelectionStore((state) => state.selection);
  const selectedId =
    tree !== null && selectedNodeId(selection, document.documentId) !== null && selection !== null
      ? tree.rowIdOf(selection.ref)
      : null;
  useEffect(() => {
    if (tree !== null && selectedId !== null) tree.select(selectedId);
  }, [tree, selectedId]);
  // Automatic decoding is a preference over every document; the tree applies it as values are detected.
  const autoDecode = useDecodePreferences((state) => state.auto);
  useEffect(() => {
    tree?.setAutoDecode(autoDecode);
  }, [tree, autoDecode]);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-document-workspace=""
      data-document-format={document.format}
      data-dirty={document.edit.dirty ? "" : undefined}
    >
      <FocusViewOnOpen key={document.documentId} />
      <QueryBar document={document} />
      {/* An empty file says so on its own; it has no place to point a problem at. */}
      {document.problem !== null && document.size > 0 ? (
        <ProblemNotice document={document} />
      ) : null}
      {/* An empty file has nothing to show; a document with no structure shows its text. */}
      {document.size === 0 ? (
        <EmptyFile name={document.name} />
      ) : tree === null || view === "source" ? (
        <SourceView key={document.documentId} document={document} />
      ) : view === "map" ? (
        <MapView key={document.documentId} document={{ ...document, tree }} />
      ) : (
        <TreeView key={document.documentId} model={tree} queries={document.queries} />
      )}
      <div className="flex shrink-0 items-center gap-3 border-t px-4 py-1.5 text-xs text-muted-foreground">
        <span>{formatBytes(document.size)}</span>
        {view === "map" && tree !== null ? <MapStatus /> : null}
        {/* Why a file of a known format shows as text. A read-only format says so once, in the
            header's format chip. */}
        {document.note !== null && document.structure === "none" ? (
          <span role="note">{document.note}</span>
        ) : null}
        {document.indexing ? (
          <span role="status" className="flex items-center gap-1.5">
            <Spinner size="xs" />
            Indexing…
          </span>
        ) : null}
        {document.edit.replaying ? (
          <span role="status" className="flex items-center gap-1.5">
            <Spinner size="xs" />
            Restoring unsaved edits…
          </span>
        ) : document.tree === null ? (
          <span data-read-only="">Read-only</span>
        ) : document.edit.dirty ? (
          <span data-unsaved="">Unsaved changes</span>
        ) : null}
        {tree !== null ? (
          <span className="ms-auto">
            <DecodeMenu tree={tree} />
          </span>
        ) : null}
      </div>
      <ExportDialog document={document} />
    </div>
  );
}

/**
 * A document that is not valid JSON says so for as long as it is open, in every
 * view: the tree and map are what the index could read around the problem. The
 * check runs when the file opens; once the document is edited the notice says
 * so, since a fix made here is only checked when the saved file opens again.
 */
function ProblemNotice({ document }: { readonly document: OpenDocument }) {
  const problem = document.problem;
  if (problem === null) return null;
  const edited = document.revision > 0;
  return (
    <div className="shrink-0 px-4 pt-2">
      <Alert variant="error" data-document-problem="">
        <TriangleAlertIcon />
        <AlertTitle>{problem.message}</AlertTitle>
        <AlertDescription>
          {edited
            ? "Found when the file was opened; edits are not checked again. Save, then open the file again to check it."
            : "The Tree and Map views show the file up to this point."}
          {problem.readsAsJsonc ? " Comments and trailing commas are allowed in JSONC." : ""}
        </AlertDescription>
        <AlertAction>
          {problem.readsAsJsonc ? (
            <Button size="xs" variant="outline" onClick={() => void document.reopenAs("jsonc")}>
              Open as JSONC
            </Button>
          ) : null}
          {/* The offset is the file's: an edit before it would move it. */}
          {edited ? null : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                useProblemFocus.getState().show(document.documentId, problem.offset);
                useDocumentView.getState().setView("source");
              }}
            >
              Show in source
            </Button>
          )}
        </AlertAction>
      </Alert>
    </div>
  );
}

/** A file of zero bytes: nothing to show in any view, which is worth saying. */
function EmptyFile({ name }: { readonly name: string }) {
  return (
    <div
      role="status"
      data-empty-file=""
      className="flex min-h-0 flex-1 items-center justify-center px-6 pb-(--workspace-topbar-height)"
    >
      <div className="flex max-w-xs flex-col items-center gap-2 text-center">
        <FileIcon aria-hidden className="size-5 text-icon-muted" />
        <h2 className="font-medium text-foreground text-sm">{name} is empty</h2>
        <p className="text-xs leading-normal text-muted-foreground/80">
          The file has no content to show.
        </p>
      </div>
    </div>
  );
}

/** A document that opens takes the keyboard into its view, unless the keyboard is already somewhere. */
function FocusViewOnOpen() {
  useEffect(() => focusViewWhenReady(), []);
  return null;
}
