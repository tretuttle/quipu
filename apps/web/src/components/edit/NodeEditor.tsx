import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  editNode,
  type NodeEditRequest,
  openDocument,
  stopNodeEdit,
  useNodeEditor,
} from "~/documents/documentEdits";
import { editorText, editorValue } from "~/documents/editorValue";
import { returnFocusToView } from "~/documents/viewFocus";
import { formatBytes } from "~/lib/formatBytes";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";

/** The most an editor loads; a bigger value is changed with a transform or a smaller node. */
const EDITOR_LIMIT_BYTES = 1024 * 1024;

type Loaded =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly initial: string }
  | { readonly phase: "failed"; readonly message: string };

/**
 * The value and key editor every view opens: a single line in a tree row or
 * over a Source view token (`inline`), several lines with Apply and Cancel in
 * the Inspector (`panel`). Text that is one JSON value becomes that value and
 * any other text a string; the type it will write is shown while typing. Text
 * that starts like JSON and is not valid is not written: the editor says why and
 * offers to save it as text. Enter commits and Escape cancels; leaving an inline
 * editor commits too.
 */
export function NodeEditor({
  request,
  variant,
  size = "compact",
  className,
}: {
  readonly request: NodeEditRequest;
  readonly variant: "inline" | "panel";
  /** `row`: a single-line field as tall as a map row, so the editor covers only its row. */
  readonly size?: "compact" | "row";
  readonly className?: string;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ phase: "loading" });
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const done = useRef(false);
  // What had the keyboard when the editor opened (a tree row, the Source view, a map node,
  // the Inspector's Edit button) gets it back when the editor closes, committed or not.
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement ? active : null;
    return () => {
      const back = opener.current;
      // After the editor has left the page, so the keyboard is known to be lost.
      queueMicrotask(() => returnFocusToView(back));
    };
  }, []);
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    const document = openDocument();
    if (document === null || document.documentId !== request.documentId) return;
    const read =
      request.mode === "key"
        ? document.edits.keyText(request.ref)
        : document.edits.text(request.ref, EDITOR_LIMIT_BYTES).then((value) => {
            if (value.truncated) {
              throw new Error(
                `This value holds ${formatBytes(value.bytes)}; values up to ${formatBytes(EDITOR_LIMIT_BYTES)} are edited here.`,
              );
            }
            return editorText(request.kind, value.text);
          });
    read.then(
      (initial) => {
        if (!live) return;
        setLoaded({ phase: "ready", initial });
        setText(initial);
      },
      (failure: unknown) => {
        if (live)
          setLoaded({
            phase: "failed",
            message: failure instanceof Error ? failure.message : "The value could not be read.",
          });
      },
    );
    return () => {
      live = false;
    };
  }, [request]);

  useEffect(() => {
    if (loaded.phase !== "ready") return;
    const field = fieldRef.current;
    field?.focus({ preventScroll: true });
    field?.select();
  }, [loaded.phase]);

  const isCurrent = () => useNodeEditor.getState().request === request;
  const cancel = () => {
    done.current = true;
    if (isCurrent()) stopNodeEdit();
  };
  const value = request.mode === "key" ? null : editorValue(text);
  const commit = async (asText = false) => {
    if (done.current || busy || loaded.phase !== "ready") return;
    if (text === loaded.initial) {
      cancel();
      return;
    }
    // Not written until the user fixes it or keeps it as text; the field keeps what was typed.
    if (value !== null && !value.valid && !asText) {
      setError(value.problem);
      return;
    }
    setBusy(true);
    const outcome = await editNode(
      { ref: request.ref, rowId: request.rowId },
      value === null
        ? { kind: "key", key: text }
        : { kind: "value", json: value.valid ? value.json : value.asText },
    );
    setBusy(false);
    if (outcome.ok) {
      cancel();
      return;
    }
    setError(outcome.message);
    fieldRef.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // The editor owns the keyboard: no row, tree or source handler sees these keys.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const submits = variant === "panel" ? event.metaKey || event.ctrlKey : !event.shiftKey;
    if (!submits) return;
    event.preventDefault();
    void commit();
  };

  const type = value === null ? "key" : value.valid ? value.type : "not valid";
  const offerText = error !== null && value !== null && !value.valid;
  const multiline =
    variant === "panel" ||
    request.kind === "object" ||
    request.kind === "array" ||
    (loaded.phase === "ready" && loaded.initial.includes("\n"));
  const label = request.mode === "key" ? "Key" : "Value";

  return (
    <div
      data-node-editor={variant}
      data-editor-type={type}
      className={cn("flex min-w-0 flex-col gap-1", className)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {loaded.phase === "loading" ? (
        <span role="status" className="flex items-center gap-2 text-muted-foreground text-xs">
          <Spinner size="xs" />
          Reading…
        </span>
      ) : loaded.phase === "failed" ? (
        <div className="flex items-center gap-2">
          <p role="alert" className="min-w-0 flex-1 text-destructive-foreground text-xs">
            {loaded.message}
          </p>
          <Button size="xs" variant="outline" onClick={cancel}>
            Close
          </Button>
        </div>
      ) : (
        <>
          <div className="flex min-w-0 items-start gap-1.5">
            {multiline ? (
              <Textarea
                ref={fieldRef}
                aria-label={label}
                aria-invalid={error !== null || undefined}
                size="sm"
                font="mono"
                value={text}
                disabled={busy}
                spellCheck={false}
                onChange={(event) => {
                  setText(event.target.value);
                  setError(null);
                }}
                onKeyDown={onKeyDown}
                onBlur={variant === "inline" ? () => void commit() : undefined}
              />
            ) : (
              <Input
                ref={fieldRef}
                nativeInput
                aria-label={label}
                aria-invalid={error !== null || undefined}
                size={size}
                font="mono"
                value={text}
                disabled={busy}
                spellCheck={false}
                onChange={(event) => {
                  setText(event.target.value);
                  setError(null);
                }}
                onKeyDown={onKeyDown}
                onBlur={() => void commit()}
              />
            )}
            <Badge
              variant="outline"
              size="sm"
              className={cn("shrink-0", size === "row" ? "mt-0.5" : "mt-1")}
              data-editor-type-badge=""
            >
              {type}
            </Badge>
          </div>
          {error !== null ? (
            <div className="flex items-start gap-2">
              <p role="alert" className="min-w-0 flex-1 text-destructive-foreground text-xs">
                {error}
              </p>
              {offerText ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  // Keeps the field's focus, so leaving the field does not try to write first.
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => void commit(true)}
                >
                  Save as text
                </Button>
              ) : null}
            </div>
          ) : null}
          {variant === "panel" ? (
            <div className="flex items-center justify-end gap-2">
              <Button size="xs" variant="outline" onClick={cancel} disabled={busy}>
                Cancel
              </Button>
              <Button size="xs" onClick={() => void commit()} disabled={busy}>
                Apply
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
