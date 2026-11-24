import type {
  Decoded,
  ImagePreview,
  NodeRef,
  RowsPage,
  WebSocketFrame,
} from "@quipu/contracts/engine";
import { startTransition, useEffect, useState, useSyncExternalStore } from "react";

import { nodeBlocker, startNodeEdit, useNodeEditor } from "~/documents/documentEdits";
import { useDocumentSession } from "~/documents/documentSession";
import {
  type DecodedEntry,
  type Inspection,
  inspect,
  type InspectSource,
} from "~/documents/inspection";
import { NodeEditor } from "./edit/NodeEditor";
import type { TreeModel } from "~/documents/treeModel";
import { formatBytes } from "~/lib/formatBytes";
import { syntaxVariableFor } from "~/syntaxCssVariables";
import { cn } from "~/lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type Load =
  | { readonly phase: "loading"; readonly id: string }
  | { readonly phase: "ready"; readonly inspection: Inspection }
  | { readonly phase: "failed"; readonly id: string; readonly message: string };

/**
 * The right panel's Inspector: the selected row's value,
 * and for a string that decodes, the decoded view: an image, the parts of a
 * JWT with the signature marked not verified, form fields, a pretty GraphQL
 * document, NDJSON lines, WebSocket frames. Everything it shows comes from the
 * engine in bounded slices; an image is drawn from a Blob URL as an `<img>`,
 * never inline, so an SVG cannot run anything.
 */
export function Inspector({
  tree,
  source,
}: {
  readonly tree: TreeModel;
  readonly source: InspectSource;
}) {
  const selection = useSyncExternalStore(tree.subscribe, tree.selection);
  const [load, setLoad] = useState<Load | null>(null);
  const session = useDocumentSession((state) => state.session);
  const document =
    session.phase === "open" && session.document.tree === tree ? session.document : null;
  const editing = useNodeEditor((state) =>
    state.request?.surface === "inspector" ? state.request : null,
  );

  useEffect(() => {
    if (selection === null) return;
    let live = true;
    inspect(source, selection).then(
      (inspection) => {
        // A transition: a big decoded view must not hold up the tree rows arriving for the same value.
        if (live) startTransition(() => setLoad({ phase: "ready", inspection }));
      },
      (error: unknown) => {
        if (live) {
          setLoad({
            phase: "failed",
            id: selection.id,
            message: error instanceof Error ? error.message : "The value could not be read.",
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [source, selection]);

  if (selection === null) return null;
  const bytes = selection.node.span.end - selection.node.span.start;
  const target = {
    node: selection.node,
    rowId: selection.id,
    decoded: selection.decoded || tree.isInsideDecoded(selection.id),
  };
  // What cannot be edited shows no edit action; the commands say why.
  const canEditValue = nodeBlocker(document, target, "value") === null;
  const canRename = nodeBlocker(document, target, "key") === null;
  const editingHere =
    editing !== null &&
    editing.ref.tapeId === selection.node.ref.tapeId &&
    editing.ref.token === selection.node.ref.token;
  const current =
    load !== null && (load.phase === "ready" ? load.inspection.id : load.id) === selection.id;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-inspector=""
      aria-label="Inspector"
      role="region"
    >
      <header className="flex shrink-0 flex-col gap-1 border-b px-3 py-2">
        <h3 className="truncate font-medium text-foreground text-sm">{selection.name}</h3>
        <Tooltip>
          <TooltipTrigger render={<p className="truncate text-muted-foreground text-xs" />}>
            {selection.path.join(" › ")}
          </TooltipTrigger>
          <TooltipPopup side="bottom">{selection.path.join(" › ")}</TooltipPopup>
        </Tooltip>
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <Badge variant="outline" size="sm">
            {selection.node.kind}
          </Badge>
          <span>{formatBytes(bytes)}</span>
          {selection.node.kind === "object" || selection.node.kind === "array" ? (
            <span>
              {selection.node.childCount} {selection.node.kind === "object" ? "keys" : "items"}
            </span>
          ) : null}
          {canEditValue || canRename ? (
            <span className="ms-auto flex items-center gap-1">
              {canRename ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => startNodeEdit(target, "key", "inspector")}
                >
                  Rename
                </Button>
              ) : null}
              {canEditValue ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => startNodeEdit(target, "value", "inspector")}
                >
                  Edit
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
      </header>
      {editingHere ? (
        <NodeEditor
          request={editing}
          variant={editing.mode === "key" ? "inline" : "panel"}
          className="shrink-0 border-b px-3 py-2"
        />
      ) : null}
      {!current || load === null || load.phase === "loading" ? (
        <div
          role="status"
          className="flex items-center gap-2 px-3 py-3 text-muted-foreground text-xs"
        >
          <Spinner size="xs" />
          Reading…
        </div>
      ) : load.phase === "failed" ? (
        <p role="alert" className="px-3 py-3 text-destructive-foreground text-xs">
          {load.message}
        </p>
      ) : (
        <InspectionView
          inspection={load.inspection}
          source={source}
          unit={selection.node.kind === "object" ? "key" : "item"}
        />
      )}
    </div>
  );
}

function Section({
  title,
  children,
  hint,
}: {
  readonly title: string;
  readonly hint?: string | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <section role="region" aria-label={title} className="flex flex-col gap-1.5 border-b px-3 py-2">
      {/* The title wraps between words rather than being cut; the hint keeps to one line. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <h4 className="min-w-0 break-words font-medium text-foreground text-xs">{title}</h4>
        {hint ? (
          <span className="shrink-0 whitespace-nowrap text-muted-foreground text-xs">{hint}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Mono({
  text,
  truncated,
  className,
}: {
  readonly text: string;
  readonly truncated?: boolean;
  readonly className?: string;
}) {
  return (
    <>
      <pre
        className={cn(
          "max-h-72 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-foreground",
          className,
        )}
      >
        {text}
      </pre>
      {truncated ? (
        <p className="text-muted-foreground text-xs">Showing the start of a longer value.</p>
      ) : null}
    </>
  );
}

function InspectionView({
  inspection,
  source,
  unit,
}: {
  readonly inspection: Inspection;
  readonly source: InspectSource;
  readonly unit: "key" | "item";
}) {
  const { value, decodes, frames, members } = inspection;
  return (
    <>
      {value !== null ? (
        <Section
          title="Value"
          hint={value.truncated ? `first ${formatBytes(value.text.length)}` : undefined}
        >
          <Mono text={value.text} truncated={value.truncated} />
        </Section>
      ) : null}
      {decodes.map((entry) => (
        <Decode
          key={`${inspection.id}:${entry.detection.kind}`}
          entry={entry}
          nodeRef={inspection.ref}
          source={source}
        />
      ))}
      {frames !== null ? <Frames frames={frames.frames} total={frames.total} /> : null}
      {members !== null && members.rows.length > 0 ? <Members page={members} unit={unit} /> : null}
    </>
  );
}

/** An object's or array's first members, key and value, colored as the tree colors them. */
function Members({ page, unit }: { readonly page: RowsPage; readonly unit: "key" | "item" }) {
  const more = page.total - page.rows.length;
  return (
    <Section
      title={unit === "key" ? "Members" : "Items"}
      hint={more > 0 ? `first ${page.rows.length} of ${page.total}` : undefined}
    >
      <ol data-inspector-members="" className="flex flex-col gap-0.5 font-mono text-xs">
        {page.rows.map((row, index) => (
          <li key={`${row.node.ref.tapeId}.${row.node.ref.token}`} className="flex min-w-0 gap-1.5">
            <span
              className="shrink-0"
              style={{
                color:
                  row.key === null
                    ? `var(${syntaxVariableFor("bracket", 0, "array")})`
                    : `var(${syntaxVariableFor("key", 1, "object")})`,
              }}
            >
              {row.key ?? String(page.from + index)}
            </span>
            <span className="shrink-0 text-muted-foreground/60">:</span>
            <span className="min-w-0 truncate" style={{ color: memberPaint(row) }}>
              {memberText(row)}
            </span>
          </li>
        ))}
      </ol>
      {more > 0 ? (
        <p className="text-muted-foreground text-xs">
          {more} more {more === 1 ? unit : `${unit}s`}.
        </p>
      ) : null}
    </Section>
  );
}

const memberCount = new Intl.NumberFormat("en-US");

/** What a member row shows: a scalar's first bytes, or the size of a container. */
function memberText(row: RowsPage["rows"][number]): string {
  const { node } = row;
  if (node.kind === "object") return `{} ${memberCount.format(node.childCount)} keys`;
  if (node.kind === "array") return `[] ${memberCount.format(node.childCount)} items`;
  const text = (row.preview?.text ?? "").replace(/\s+/g, " ");
  const cut = row.preview?.truncated === true ? "…" : "";
  return node.kind === "string" ? `"${text}${cut}"` : `${text}${cut}`;
}

function memberPaint(row: RowsPage["rows"][number]): string {
  const container = row.key === null ? "array" : "object";
  switch (row.node.kind) {
    case "string":
      return `var(${syntaxVariableFor("string", 0, container)})`;
    case "number":
      return `var(${syntaxVariableFor("number", 0, container)})`;
    case "true":
    case "false":
    case "null":
      return `var(${syntaxVariableFor("literal", 0, container)})`;
    default:
      return "var(--muted-foreground)";
  }
}

function Decode({
  entry,
  nodeRef,
  source,
}: {
  readonly entry: DecodedEntry;
  readonly nodeRef: NodeRef;
  readonly source: InspectSource;
}) {
  const { detection, decoded, error } = entry;
  if (decoded === null) {
    return (
      <Section title={`Decoded: ${detection.label}`}>
        <p role="alert" className="text-destructive-foreground text-xs">
          {error ?? "This value could not be decoded."}
        </p>
      </Section>
    );
  }
  const layers = decoded.layers.length > 0 ? decoded.layers.join(" → ") : null;
  // The hint adds what the title does not already say: the size, and layers or a type it leaves out.
  const extra = [layers, decoded.mime].filter(
    (part): part is string => part !== null && !decoded.label.includes(part),
  );
  return (
    <Section
      title={`Decoded: ${decoded.label}`}
      hint={[...extra, formatBytes(decoded.bytes)].join(" · ")}
    >
      <DecodedBody decoded={decoded} source={source} nodeRef={nodeRef} />
    </Section>
  );
}

function DecodedBody({
  decoded,
  source,
  nodeRef,
}: {
  readonly decoded: Decoded;
  readonly source: InspectSource;
  readonly nodeRef: NodeRef;
}) {
  const view = decoded.view;
  switch (view._tag) {
    case "text":
      return <Mono text={view.value.text} truncated={view.value.truncated} />;
    case "image":
      return <ImageView source={source} nodeRef={nodeRef} mime={view.mime} bytes={view.bytes} />;
    case "binary":
      return (
        <div data-binary-summary="" className="flex flex-col gap-1.5 text-xs">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Type</dt>
            <dd className="min-w-0 break-words font-mono text-foreground">{view.mime}</dd>
            <dt className="text-muted-foreground">Size</dt>
            <dd className="font-mono text-foreground">{formatBytes(view.bytes)}</dd>
          </dl>
          <span className="text-muted-foreground">First bytes</span>
          {/* A dump keeps its columns: rows scroll sideways instead of wrapping inside a byte. */}
          <pre
            data-hex-dump=""
            className="max-h-72 overflow-auto whitespace-pre rounded-md bg-muted/50 p-2 font-mono text-foreground leading-relaxed"
          >
            {view.hex}
          </pre>
        </div>
      );
    case "jwt":
      return (
        <div className="flex flex-col gap-2">
          <JwtPart title="Header" text={view.header.text} />
          <JwtPart title="Payload" text={view.payload.text} />
          <div role="group" aria-label="Signature" className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-foreground text-xs">Signature</span>
              <Badge variant="warning" size="sm">
                not verified
              </Badge>
            </div>
            <p className="font-mono text-muted-foreground text-xs break-all">
              {view.signature === "" ? "(empty)" : view.signature}
            </p>
            <p className="text-muted-foreground text-xs">
              {view.signatureBytes} bytes. Quipu decodes the token; it never checks the signature.
            </p>
          </div>
        </div>
      );
    case "form":
      return (
        <>
          <table className="w-full table-fixed border-collapse text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="w-2/5 pb-1 font-medium">Name</th>
                <th className="pb-1 font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {withKeys(view.fields, (field) => `${field.name}=${field.value}`).map(
                ([key, field]) => (
                  <tr key={key} className="border-t align-top">
                    <td className="py-1 pe-2 font-mono break-all text-foreground">{field.name}</td>
                    <td className="py-1 font-mono break-all text-foreground">{field.value}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
          {view.total > view.fields.length ? (
            <p className="text-muted-foreground text-xs">
              {view.total - view.fields.length} more fields.
            </p>
          ) : null}
        </>
      );
    case "lines":
      return (
        <>
          <ol className="flex flex-col gap-0.5">
            {withKeys(view.lines, (line) => line).map(([key, line], index) => (
              <li key={key} className="flex gap-2 font-mono text-xs">
                <span className="w-8 shrink-0 text-end text-muted-foreground">{index + 1}</span>
                <span className="min-w-0 break-all text-foreground">{line}</span>
              </li>
            ))}
          </ol>
          {view.total > view.lines.length ? (
            <p className="text-muted-foreground text-xs">
              {view.total - view.lines.length} more lines.
            </p>
          ) : null}
        </>
      );
  }
}

/** Pairs each item with a key that is unique among them, however often its content repeats. */
function withKeys<T>(items: ReadonlyArray<T>, content: (item: T) => string) {
  const seen = new Map<string, number>();
  return items.map((item): [string, T] => {
    const text = content(item);
    const n = seen.get(text) ?? 0;
    seen.set(text, n + 1);
    return [`${text}#${n}`, item];
  });
}

function JwtPart({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <div role="group" aria-label={title} className="flex flex-col gap-1">
      <span className="font-medium text-foreground text-xs">{title}</span>
      <Mono text={text} />
    </div>
  );
}

type PreviewLoad =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly url: string; readonly preview: ImagePreview }
  | { readonly phase: "failed"; readonly message: string };

/** Draws an image from a Blob URL; the URL is revoked when the selection moves on. */
function ImageView({
  source,
  nodeRef,
  mime,
  bytes,
}: {
  readonly source: InspectSource;
  readonly nodeRef: NodeRef;
  readonly mime: string;
  readonly bytes: number;
}) {
  const [state, setState] = useState<PreviewLoad>({ phase: "loading" });
  const [drawn, setDrawn] = useState<"unknown" | "ok" | "broken">("unknown");
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    source.preview(nodeRef).then(
      (preview) => {
        if (!live) return;
        url = URL.createObjectURL(preview.blob);
        setState({ phase: "ready", url, preview });
      },
      (error: unknown) => {
        if (live) {
          setState({
            phase: "failed",
            message: error instanceof Error ? error.message : "The image could not be read.",
          });
        }
      },
    );
    return () => {
      live = false;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [source, nodeRef]);

  if (state.phase === "loading") {
    return (
      <div role="status" className="flex items-center gap-2 text-muted-foreground text-xs">
        <Spinner size="xs" />
        Decoding {mime}…
      </div>
    );
  }
  if (state.phase === "failed") {
    return (
      <p role="alert" className="text-muted-foreground text-xs">
        {state.message} ({mime}, {formatBytes(bytes)})
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="scrollbar-gutter-both flex max-h-80 items-center justify-center overflow-auto rounded-md bg-muted/50 p-2">
        <img
          src={state.url}
          alt={`Decoded ${mime}, ${formatBytes(bytes)}`}
          className="max-h-72 max-w-full object-contain"
          onLoad={() => setDrawn("ok")}
          onError={() => setDrawn("broken")}
        />
      </div>
      {drawn === "broken" ? (
        <p role="alert" className="text-muted-foreground text-xs">
          The browser could not draw this {mime}.
        </p>
      ) : null}
    </div>
  );
}

const frameArrow = (frame: WebSocketFrame) =>
  frame.direction === "send" ? "↑" : frame.direction === "receive" ? "↓" : "·";

function Frames({
  frames,
  total,
}: {
  readonly frames: ReadonlyArray<WebSocketFrame>;
  readonly total: number;
}) {
  return (
    <Section title="WebSocket frames" hint={`${frames.length} of ${total}`}>
      <ol className="flex flex-col gap-1">
        {frames.map((frame) => (
          <FrameRow key={frame.index} frame={frame} />
        ))}
      </ol>
    </Section>
  );
}

/** A frame's text shows three lines until it is opened. */
const FRAME_PREVIEW_CLAMP = "line-clamp-3";
const utf8 = new TextEncoder();

function FrameRow({ frame }: { readonly frame: WebSocketFrame }) {
  const [open, setOpen] = useState(false);
  // The engine sends the first bytes of the payload; past them the text goes on in the file.
  const previewBytes = utf8.encode(frame.preview).length;
  const cut = frame.opcode !== 2 && previewBytes < frame.size;
  const text = cut ? `${frame.preview}…` : frame.preview;
  const long = cut || text.length > 160 || text.includes("\n");
  return (
    <li
      data-frame={frame.index}
      className="flex min-w-0 flex-col gap-0.5 rounded-md bg-muted/50 px-2 py-1 text-xs"
    >
      {/* One line: the type and size never wrap; a long type is the part that gives way. */}
      <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-muted-foreground">
        <span aria-hidden="true">{frameArrow(frame)}</span>
        <span className="text-foreground">
          {frame.direction === "unknown" ? "frame" : frame.direction}
        </span>
        <span>{frame.opcode === 2 ? "binary" : "text"}</span>
        {frame.mime !== null ? <span className="min-w-0 truncate">{frame.mime}</span> : null}
        <span data-frame-size="" className="shrink-0">
          {formatBytes(frame.size)}
        </span>
        {frame.detections[0] ? (
          <Badge variant="outline" size="sm" className="shrink-0">
            {frame.detections[0].label}
          </Badge>
        ) : null}
        {frame.time !== null ? (
          <span className="ms-auto shrink-0 font-mono">{timeOf(frame.time)}</span>
        ) : null}
      </div>
      {text !== "" ? (
        <>
          <p
            data-frame-text=""
            className={cn(
              "whitespace-pre-wrap break-words font-mono text-foreground",
              !open && long && FRAME_PREVIEW_CLAMP,
            )}
          >
            {text}
          </p>
          {long ? (
            <Button
              size="xs"
              variant="ghost"
              className="self-start"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? "Show less" : "Show more"}
            </Button>
          ) : null}
          {open && cut ? (
            <p className="text-muted-foreground">
              The first {formatBytes(previewBytes)} of {formatBytes(frame.size)}. Select the frame's
              data in the tree to read all of it.
            </p>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

/** `HH:MM:SS.mmm` UTC of a DevTools timestamp (seconds since the epoch). */
const timeOf = (seconds: number) => new Date(seconds * 1000).toISOString().slice(11, 23);
