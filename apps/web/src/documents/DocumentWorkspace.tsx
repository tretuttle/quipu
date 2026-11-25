import { type ByteRange, CHILDREN_PAGE_LIMIT } from "@quipu/contracts/engine";
import { FileIcon, FileUpIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { formatBytes } from "~/lib/formatBytes";
import { MapView } from "~/components/map/MapView";
import { MapStatus } from "~/components/map/mapStatus";
import { useDocumentView } from "~/documentViewStore";
import { DecodeMenu } from "./DecodeMenu.tsx";
import { useDecodePreferences } from "./decodePreferences.ts";
import { CodegenDialog } from "./CodegenDialog.tsx";
import { CompareView } from "./CompareView.tsx";
import {
  codegen,
  createCompareClient,
  getTableSource,
  type OpenDocument,
  readNodeChildren,
  useDocumentSession,
} from "./documentSession.ts";
import { structuredFormatNames } from "./formatNames.ts";
import { filterRowIndicesByHits, useMatchFilterStore } from "./hitFilter.ts";
import { focusViewWhenReady } from "./viewFocus.ts";
import { ExportDialog } from "./ExportDialog.tsx";
import { forgetRecent, openWithDialog, REMOVE_RECENT } from "./openDocument.ts";
import { useProblemFocus } from "./problemFocus.ts";
import { SourceView } from "./LazySourceView.tsx";
import { QueryBar } from "./QueryBar.tsx";
import { useSchemaStore } from "./schemaStore.ts";
import { selectedNodeId, useSelectionStore } from "./selectionStore.ts";
import { TableView } from "./TableView.tsx";
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

const TABLE_RANGE_SCAN_LIMIT = 50_000;

const defaultRootTypeName = (name: string): string => {
  const words = name
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return "Root";
  const joined = words.map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`).join("");
  return /^[A-Za-z_]/.test(joined) ? joined : `Doc${joined}`;
};

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

  const matchFilterEnabled = useMatchFilterStore((state) => state.enabled);
  const matchedIds = useMatchFilterStore((state) => state.matchedIds);
  const hitRanges = useMatchFilterStore((state) => state.hitRanges);
  useEffect(() => {
    tree?.setMatchFilter(matchFilterEnabled ? matchedIds : null);
  }, [tree, matchFilterEnabled, matchedIds]);

  const filterKey =
    matchFilterEnabled && view === "table" && tree !== null && hitRanges.length > 0
      ? `${document.documentId}:${document.revision}:${hitRanges.length}:${hitRanges[0]!.start}`
      : null;
  const [tableRowsState, setTableRowsState] = useState<{
    readonly key: string;
    readonly rows: ReadonlyArray<number>;
  } | null>(null);
  const tableFilteredRows: ReadonlyArray<number> | null =
    !matchFilterEnabled || view !== "table" || tree === null
      ? null
      : hitRanges.length === 0
        ? []
        : tableRowsState?.key === filterKey
          ? tableRowsState.rows
          : null;
  useEffect(() => {
    if (filterKey === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const discovered = await getTableSource().targets(document.documentId);
        if (cancelled) return;
        const target =
          discovered.targets.find((t) => t.path === discovered.recommendedPath) ??
          discovered.targets[0] ??
          null;
        if (target === null || target.rowCount === 0) {
          setTableRowsState({ key: filterKey, rows: [] });
          return;
        }
        if (target.rowCount <= TABLE_RANGE_SCAN_LIMIT) {
          const rowRanges: Array<ByteRange | null> = [];
          for (let from = 0; from < target.rowCount; from += CHILDREN_PAGE_LIMIT) {
            const page = await readNodeChildren(
              target.ref,
              from,
              Math.min(CHILDREN_PAGE_LIMIT, target.rowCount - from),
            );
            if (cancelled) return;
            for (const child of page.nodes) rowRanges.push(child.span);
          }
          setTableRowsState({
            key: filterKey,
            rows: filterRowIndicesByHits(rowRanges, hitRanges),
          });
          return;
        }
        const rowIndices = new Set<number>();
        for (const hit of hitRanges) {
          const found = await document.source.nodeAt(hit.start).catch(() => null);
          if (cancelled) return;
          if (found === null) continue;
          const targetIdx = found.path.findIndex(
            (step) =>
              step.node.ref.tapeId === target.ref.tapeId &&
              step.node.ref.token === target.ref.token,
          );
          const elementStep = targetIdx >= 0 ? found.path[targetIdx + 1] : undefined;
          if (elementStep?.index !== null && elementStep?.index !== undefined) {
            const single = filterRowIndicesByHits([elementStep.node.span], hitRanges);
            if (single.length > 0) rowIndices.add(elementStep.index);
          }
        }
        setTableRowsState({
          key: filterKey,
          rows: [...rowIndices].sort((a, b) => a - b),
        });
      } catch {
        // Leave unfiltered rows on transient cancellation/reload error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [document, filterKey, hitRanges]);

  const codegenOpen = useSchemaStore((state) => state.codegenOpen);
  const schemaShape = useSchemaStore((state) => state.shape);

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
      ) : view === "table" ? (
        <TableView
          key={document.documentId}
          document={document}
          source={getTableSource()}
          filteredRowIndices={tableFilteredRows}
        />
      ) : view === "compare" ? (
        <CompareView
          key={document.documentId}
          primary={{
            documentId: document.documentId,
            name: document.name,
            size: document.size,
            format: document.format,
          }}
          client={createCompareClient()}
        />
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
      {tree !== null ? (
        <CodegenDialog
          open={codegenOpen}
          onOpenChange={(open) => useSchemaStore.getState().setCodegenOpen(open)}
          defaultRootName={defaultRootTypeName(document.name)}
          generate={async (options) => {
            const shape =
              schemaShape ?? (await useSchemaStore.getState().infer(document, undefined, false));
            return codegen(
              { documentId: document.documentId, tapeId: 0, token: 0 },
              options,
              shape ?? undefined,
            );
          }}
        />
      ) : null}
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
