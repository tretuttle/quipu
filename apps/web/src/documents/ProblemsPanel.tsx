import type {
  HarValidationFilter,
  HarValidationSection,
  SchemaFailure,
  ValidationResult,
} from "@quipu/contracts/schema";
import { AlertCircleIcon, CheckCircle2Icon, FileUpIcon, PlayIcon, Trash2Icon } from "lucide-react";
import { type ChangeEvent, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";

const MAX_SCHEMA_FILE_BYTES = 8 * 1024 * 1024;

async function readBoundedTextFile(file: File): Promise<string> {
  if (file.size > MAX_SCHEMA_FILE_BYTES) {
    throw new Error("Schema files must be 8 MiB or smaller.");
  }
  const reader = file
    .slice(0, MAX_SCHEMA_FILE_BYTES)
    .stream()
    .pipeThrough(new TextDecoderStream())
    .getReader();
  const chunks: string[] = [];
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    chunks.push(step.value);
  }
  return chunks.join("");
}

export interface ProblemsPanelProps {
  readonly initialSchemaText?: string;
  readonly inferredSchemaText?: string | null;
  readonly isHar?: boolean;
  readonly validating?: boolean;
  readonly schemaError?: string | null;
  readonly result?: ValidationResult | null;
  readonly onValidate: (schemaText: string, filter?: HarValidationFilter) => void;
  readonly onClear?: () => void;
  readonly onSelectFailure?: (failure: SchemaFailure) => void;
}

export function ProblemsPanel({
  initialSchemaText = "",
  inferredSchemaText = null,
  isHar = false,
  validating = false,
  schemaError = null,
  result = null,
  onValidate,
  onClear,
  onSelectFailure,
}: ProblemsPanelProps) {
  const [schemaText, setSchemaText] = useState(initialSchemaText);
  const [fileError, setFileError] = useState<string | null>(null);
  const [urlPattern, setUrlPattern] = useState("");
  const [section, setSection] = useState<HarValidationSection>("response");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setFileError(null);
    void readBoundedTextFile(file).then(
      (content) => {
        setSchemaText(content);
      },
      (err: unknown) => {
        setFileError(err instanceof Error ? err.message : "Could not read schema file.");
      },
    );
  };

  const runValidation = () => {
    if (isHar) {
      onValidate(schemaText, { urlPattern, section });
    } else {
      onValidate(schemaText);
    }
  };

  const handleClear = () => {
    setSchemaText("");
    setFileError(null);
    onClear?.();
  };

  const displayedError = fileError ?? schemaError;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-problems-panel=""
      aria-label="Schema problems"
      role="region"
    >
      <header className="flex shrink-0 flex-col gap-2 border-b border-border p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-foreground text-sm">Problems</span>
          <div className="ms-auto flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.schema.json,application/json"
              className="hidden"
              aria-label="Load schema file"
              onChange={handleFileChange}
            />
            <Button size="xs" variant="outline" onClick={() => fileInputRef.current?.click()}>
              <FileUpIcon aria-hidden className="size-3.5" />
              Load file
            </Button>
            {inferredSchemaText !== null ? (
              <Button size="xs" variant="outline" onClick={() => setSchemaText(inferredSchemaText)}>
                Use inferred
              </Button>
            ) : null}
            {onClear ? (
              <Button size="xs" variant="ghost" onClick={handleClear} aria-label="Clear schema">
                <Trash2Icon aria-hidden className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </div>

        <Textarea
          size="sm"
          font="mono"
          rows={5}
          aria-label="JSON Schema"
          placeholder="Paste a local JSON Schema (remote $ref is refused)"
          spellCheck={false}
          value={schemaText}
          onChange={(event) => setSchemaText(event.currentTarget.value)}
        />

        {isHar ? (
          <div className="flex items-center gap-1.5">
            <Input
              size="compact"
              font="mono"
              className="min-w-0 flex-1"
              aria-label="HAR URL filter"
              placeholder="URL filter (substring, *glob, or /regex/)"
              value={urlPattern}
              onChange={(event) => setUrlPattern(event.currentTarget.value)}
            />
            <ToggleGroup
              aria-label="HAR body section"
              value={[section]}
              onValueChange={(next) => {
                const picked = next[0];
                if (picked === "response" || picked === "request") {
                  setSection(picked);
                }
              }}
            >
              <ToggleGroupItem value="response">Response</ToggleGroupItem>
              <ToggleGroupItem value="request">Request</ToggleGroupItem>
            </ToggleGroup>
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          <Button
            size="xs"
            onClick={runValidation}
            disabled={validating || schemaText.trim().length === 0}
          >
            {validating ? <Spinner size="xs" /> : <PlayIcon aria-hidden className="size-3.5" />}
            {validating ? "Validating…" : "Validate"}
          </Button>

          {result !== null ? (
            <div className="ms-auto flex items-center gap-1.5 text-xs">
              {result.valid ? (
                <Badge variant="success" size="sm">
                  <CheckCircle2Icon aria-hidden className="size-3" />
                  Valid
                </Badge>
              ) : (
                <Badge variant="error" size="sm">
                  <AlertCircleIcon aria-hidden className="size-3" />
                  {result.failures.length} {result.failures.length === 1 ? "problem" : "problems"}
                </Badge>
              )}
              {isHar ? (
                <span className="text-muted-foreground">
                  {result.checkedEntries} {result.checkedEntries === 1 ? "entry" : "entries"}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      {displayedError !== null ? (
        <div className="shrink-0 p-3">
          <Alert variant="error" data-schema-error="">
            <AlertTitle>Schema rejected</AlertTitle>
            <AlertDescription>{displayedError}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {result !== null && result.truncated ? (
        <div className="shrink-0 px-3 pt-2">
          <Alert variant="warning">
            <AlertDescription>
              Showing the first {result.failures.length} problems.
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      {result === null ? (
        <div className="scrollbar-gutter-both flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pb-(--workspace-topbar-height)">
          <p className="max-w-xs text-center text-muted-foreground text-xs">
            Load a local JSON Schema file or paste one above to check this document.
          </p>
        </div>
      ) : result.failures.length === 0 ? (
        <div className="scrollbar-gutter-both flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pb-(--workspace-topbar-height)">
          <p className="text-center text-muted-foreground text-xs">No schema problems found.</p>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col divide-y divide-border/60" data-problems-list="">
            {result.failures.map((failure) => (
              <li
                key={`${failure.entryIndex ?? "doc"}\0${failure.pointer}\0${failure.keyword}\0${failure.message}`}
              >
                <button
                  type="button"
                  className="flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-accent/50"
                  onClick={() => onSelectFailure?.(failure)}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-mono text-foreground text-xs">
                      {failure.pointer || "(root)"}
                    </span>
                    <Badge variant="outline" size="sm">
                      {failure.keyword}
                    </Badge>
                    {failure.entryIndex !== undefined ? (
                      <Badge variant="secondary" size="sm">
                        Entry #{failure.entryIndex}
                      </Badge>
                    ) : null}
                  </div>
                  <span className="text-muted-foreground text-xs">{failure.message}</span>
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}
