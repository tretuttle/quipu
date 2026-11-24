import { createFileRoute } from "@tanstack/react-router";

import { DocumentEditControls } from "../components/edit/DocumentEditControls";
import { SortFieldDialog } from "../components/edit/SortFieldDialog";
import { RightPanel } from "../components/RightPanel";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspaceHeader } from "../components/WorkspaceHeader";
import { DocumentFileActions } from "../documents/DocumentFileActions";
import { DocumentWorkspace } from "../documents/DocumentWorkspace";
import { useDocumentSession } from "../documents/documentSession";
import { AVAILABLE_DOCUMENT_VIEWS, useDocumentView } from "../documentViewStore";

export const Route = createFileRoute("/")({
  component: IndexRouteView,
});

function IndexRouteView() {
  const session = useDocumentSession((state) => state.session);
  const view = useDocumentView((state) => state.view);
  const setView = useDocumentView((state) => state.setView);
  // A text document has no outline: its only view is the source.
  const hasStructure = session.phase === "open" && session.document.tree !== null;
  const name =
    session.phase === "open"
      ? session.document.name
      : session.phase === "empty"
        ? null
        : session.name;
  return (
    <SidebarInset className="h-dvh min-h-0 flex-row overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-content-area="">
        <WorkspaceHeader
          document={
            name === null
              ? null
              : {
                  name,
                  view: hasStructure ? view : "source",
                  dirty: session.phase === "open" && session.document.edit.dirty,
                }
          }
          onViewChange={setView}
          views={hasStructure || session.phase !== "open" ? AVAILABLE_DOCUMENT_VIEWS : ["source"]}
          documentActions={
            <>
              {session.phase === "open" ? (
                <DocumentFileActions document={session.document} />
              ) : null}
              <DocumentEditControls />
            </>
          }
        />
        <DocumentWorkspace />
      </div>
      <RightPanel />
      <SortFieldDialog />
    </SidebarInset>
  );
}
