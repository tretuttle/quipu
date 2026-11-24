import type { ConvertFormat, ConvertSettings, ExportTarget } from "@quipu/contracts/engine";
import { FileOutputIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";

import { DOCUMENT_FORMATS, EXPORT_FORMATS } from "./documentFormats.ts";
import { getDocumentFileClient, type OpenDocument } from "./documentSession.ts";
import { useExportDialog } from "./exportDialogStore.ts";
import { viewFocusTarget } from "./viewFocus.ts";
import { pointerToPath } from "./jsonPointer.ts";
import { type ExportOutcome, exportOpenDocument } from "./saveDocument.ts";

const INDENTS: ReadonlyArray<readonly [number, string]> = [
  [2, "2 spaces"],
  [4, "4 spaces"],
  [0, "Minified"],
];
const COLUMNS: ReadonlyArray<readonly [ConvertSettings["columns"], string]> = [
  ["first", "From the first 1,024 rows"],
  ["full", "From every row"],
];
const NESTED: ReadonlyArray<readonly [ConvertSettings["nested"], string]> = [
  ["json", "Written as JSON text"],
  ["error", "Not allowed"],
];

type Refusal = Extract<ExportOutcome, { kind: "refused" }>;

/** One labeled select of the dialog's options. */
function OptionSelect<Value extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: Value;
  readonly options: ReadonlyArray<readonly [Value, string]>;
  readonly onChange: (value: Value) => void;
}) {
  const current = options.find(([option]) => option === value)?.[1] ?? "";
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-foreground">{label}</span>
      <Select
        value={String(value)}
        onValueChange={(next) => {
          const found = options.find(([option]) => String(option) === next);
          if (found) onChange(found[0]);
        }}
      >
        <SelectTrigger size="sm" className="w-56 shrink-0" aria-label={label}>
          <SelectValue>{current}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {options.map(([option, text]) => (
            <SelectItem hideIndicator key={String(option)} value={String(option)}>
              {text}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/**
 * Export: a target format the document can be written in (the others listed
 * with the reason they cannot), the converter's options for it, then the same
 * destinations as Save As. The conversion runs in the engine's workers; a
 * refusal names the node or the line it stopped at.
 */
export function ExportDialog({ document }: { readonly document: OpenDocument }) {
  const open = useExportDialog((state) => state.open);
  const setOpen = useExportDialog((state) => state.setOpen);
  return (
    <Dialog open={open} onOpenChange={(next) => setOpen(next)}>
      {/* Closing gives the keyboard back to the view it came from. */}
      <DialogPopup className="max-w-md" finalFocus={() => viewFocusTarget() ?? true}>
        {/* Mounted per opening, so every opening asks the engine afresh and starts clean. */}
        {open ? <ExportForm document={document} onClose={() => setOpen(false)} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function ExportForm({
  document,
  onClose,
}: {
  readonly document: OpenDocument;
  readonly onClose: () => void;
}) {
  const [targets, setTargets] = useState<ReadonlyArray<ExportTarget> | null>(null);
  const [format, setFormat] = useState<ConvertFormat | null>(null);
  const [indent, setIndent] = useState(2);
  const [columns, setColumns] = useState<ConvertSettings["columns"]>("first");
  const [nested, setNested] = useState<ConvertSettings["nested"]>("json");
  const [running, setRunning] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  useEffect(() => {
    let current = true;
    void getDocumentFileClient(document.documentId)
      .exportTargets()
      .then((list) => {
        if (!current) return;
        setTargets(list);
        // Records whose keys the first rows miss need the header read from every row.
        if (list.some((t) => t.advice !== null)) setColumns("full");
        setFormat((chosen) => {
          if (chosen !== null && list.some((t) => t.format === chosen && t.available))
            return chosen;
          const preferred = list.find((t) => t.available && t.format !== document.format);
          return (preferred ?? list.find((t) => t.available))?.format ?? null;
        });
      })
      .catch(() => {
        if (current) setTargets([]);
      });
    return () => {
      current = false;
    };
  }, [document.documentId, document.format]);

  const target = targets?.find((t) => t.format === format) ?? null;
  const unavailable = targets?.filter((t) => !t.available) ?? [];

  const run = async () => {
    if (format === null) return;
    setRunning(true);
    setRefusal(null);
    try {
      const outcome = await exportOpenDocument(format, { indent, columns, nested });
      if (outcome.kind === "done") onClose();
      else if (outcome.kind === "refused") setRefusal(outcome);
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Export {document.name}</DialogTitle>
        <DialogDescription>
          Write the document in another format. It stays open as it is.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {targets === null ? (
          <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="xs" />
            Checking available formats…
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-foreground">Format</span>
              <Select
                value={format ?? ""}
                onValueChange={(next) => {
                  const found = targets.find((t) => t.format === next && t.available);
                  if (found) {
                    setFormat(found.format);
                    setRefusal(null);
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-56 shrink-0" aria-label="Format">
                  <SelectValue>
                    {format === null ? "None" : DOCUMENT_FORMATS[format].label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {EXPORT_FORMATS.map((option) => {
                    const entry = targets.find((t) => t.format === option);
                    return (
                      <SelectItem
                        hideIndicator
                        key={option}
                        value={option}
                        disabled={entry?.available !== true}
                      >
                        {DOCUMENT_FORMATS[option].label}
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            </div>
            {format === "json" ? (
              <OptionSelect
                label="Indentation"
                value={indent}
                options={INDENTS}
                onChange={setIndent}
              />
            ) : null}
            {format === "csv" || format === "tsv" ? (
              <>
                <OptionSelect
                  label="Columns"
                  value={columns}
                  options={COLUMNS}
                  onChange={setColumns}
                />
                <OptionSelect
                  label="Nested values"
                  value={nested}
                  options={NESTED}
                  onChange={setNested}
                />
                {target?.advice ? (
                  <p data-export-advice="" className="text-muted-foreground text-xs">
                    {target.advice}
                  </p>
                ) : null}
              </>
            ) : null}
            {unavailable.length > 0 ? (
              <ul
                aria-label="Formats that cannot hold this document"
                className="flex flex-col gap-1"
              >
                {unavailable.map((t) => (
                  <li key={t.format} className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {DOCUMENT_FORMATS[t.format].label}:
                    </span>{" "}
                    {t.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
        {refusal !== null ? (
          <Alert aria-live="polite" variant="error">
            <AlertTitle>
              Could not export to {format === null ? "this format" : DOCUMENT_FORMATS[format].label}
            </AlertTitle>
            <AlertDescription>
              {refusal.message}
              {refusal.pointer !== null ? (
                <span className="block font-mono">At {pointerToPath(refusal.pointer)}</span>
              ) : refusal.line !== null ? (
                <span className="block">At line {refusal.line}</span>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={running || target === null || !target.available}
          onClick={() => void run()}
        >
          {running ? <Spinner size="xs" /> : <FileOutputIcon />}
          Export…
        </Button>
      </DialogFooter>
    </>
  );
}
