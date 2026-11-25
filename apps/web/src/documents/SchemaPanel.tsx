import {
  DEFAULT_MAX_ENUM,
  STRING_FORMATS,
  type FieldShape,
  type ObjectShape,
  type Shape,
  type StringFormat,
  type StringShape,
} from "@quipu/contracts/schema";
import {
  BracesIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Code2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";

export interface SchemaPanelProps {
  readonly shape: Shape | null;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly maxEnum?: number;
  readonly onInfer?: () => void;
  readonly onFieldClick?: (pathQuery: string, pointer: string) => void;
  readonly onValidateWithSchema?: () => void;
  readonly onGenerateTypes?: () => void;
}

const ENUM_IDENT_RE = /^\p{L}[\p{L}\p{N}_.-]*$/u;

function detectFormat(s: StringShape): StringFormat | null {
  for (let i = 0; i < STRING_FORMATS.length; i++) {
    if (s.formats[i] === s.count && s.count > 0) return STRING_FORMATS[i] ?? null;
  }
  return null;
}

function detectEnums(s: StringShape, maxEnum: number): ReadonlyArray<string> | null {
  if (s.values === null) return null;
  if (
    s.values.length < 2 ||
    s.values.length > maxEnum ||
    s.count < 3 ||
    s.values.length >= s.count ||
    detectFormat(s) !== null
  ) {
    return null;
  }
  for (const entry of s.values) {
    if (!ENUM_IDENT_RE.test(entry.value)) return null;
  }
  return s.values.map((entry) => entry.value);
}

function formatShapeType(shape: Shape): string {
  const parts: string[] = [];
  if (shape.bools > 0) parts.push("boolean");
  if (shape.floats > 0) parts.push("number");
  else if (shape.integers > 0) parts.push("integer");
  if (shape.string !== null) {
    const fmt = detectFormat(shape.string);
    parts.push(fmt !== null ? `string (${fmt})` : "string");
  }
  if (shape.array !== null) {
    parts.push(`array<${formatShapeType(shape.array.items)}>`);
  }
  if (shape.object !== null) {
    parts.push(`object (${shape.object.fields.length})`);
  }
  if (shape.nulls > 0) parts.push("null");
  if (parts.length === 0) return "any";
  return parts.join(" | ");
}

type PathStep = { readonly kind: "key"; readonly name: string } | { readonly kind: "items" };

function buildPathQuery(steps: ReadonlyArray<PathStep>): string {
  let out = "$";
  for (const step of steps) {
    if (step.kind === "items") {
      out += "[*]";
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(step.name)) {
      out += `.${step.name}`;
    } else {
      out += `[${JSON.stringify(step.name)}]`;
    }
  }
  return out;
}

function buildPointer(steps: ReadonlyArray<PathStep>): string {
  if (steps.length === 0) return "";
  return steps
    .map((step) =>
      step.kind === "items" ? "/*" : `/${step.name.replaceAll("~", "~0").replaceAll("/", "~1")}`,
    )
    .join("");
}

function presencePercent(present: number, total: number): string {
  if (total <= 0) return "0%";
  const pct = Math.round((present / total) * 100);
  return `${pct}%`;
}

export function SchemaPanel({
  shape,
  loading = false,
  error = null,
  maxEnum = DEFAULT_MAX_ENUM,
  onInfer,
  onFieldClick,
  onValidateWithSchema,
  onGenerateTypes,
}: SchemaPanelProps) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-schema-panel=""
      aria-label="Inferred schema"
      role="region"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="font-medium text-foreground text-sm">Schema</span>
        {shape !== null ? (
          <Badge variant="outline" size="sm">
            {shape.samples} {shape.samples === 1 ? "sample" : "samples"}
          </Badge>
        ) : null}
        <div className="ms-auto flex items-center gap-1">
          {onInfer ? (
            <Button size="xs" variant="ghost" onClick={onInfer} disabled={loading}>
              <RefreshCwIcon aria-hidden className="size-3.5" />
              {shape === null ? "Infer" : "Refresh"}
            </Button>
          ) : null}
          {onValidateWithSchema ? (
            <Button
              size="xs"
              variant="outline"
              onClick={onValidateWithSchema}
              disabled={shape === null}
            >
              <ShieldCheckIcon aria-hidden className="size-3.5" />
              Validate with Schema
            </Button>
          ) : null}
          {onGenerateTypes ? (
            <Button size="xs" variant="outline" onClick={onGenerateTypes} disabled={shape === null}>
              <Code2Icon aria-hidden className="size-3.5" />
              Generate Types
            </Button>
          ) : null}
        </div>
      </header>

      {error !== null ? (
        <div className="shrink-0 p-3">
          <Alert variant="error">
            <AlertTitle>Schema inference failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {loading ? (
        <div
          role="status"
          className="flex items-center gap-2 px-3 py-4 text-muted-foreground text-xs"
        >
          <Spinner size="xs" />
          Inferring schema…
        </div>
      ) : shape === null ? (
        <div className="scrollbar-gutter-both flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pb-(--workspace-topbar-height)">
          <div className="flex max-w-xs flex-col items-center gap-2 text-center">
            <BracesIcon aria-hidden className="size-5 text-icon-muted" />
            <h3 className="font-medium text-foreground text-sm">No schema inferred</h3>
            <p className="text-xs leading-normal text-muted-foreground">
              Infer field types, formats, enums, and requiredness from this document.
            </p>
            {onInfer ? (
              <Button size="xs" variant="outline" onClick={onInfer}>
                Infer schema
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 p-3">
            <ShapeNodeCard
              label="Root"
              shape={shape}
              steps={[]}
              depth={0}
              maxEnum={maxEnum}
              onFieldClick={onFieldClick}
            />
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function ShapeNodeCard({
  label,
  shape,
  steps,
  depth,
  maxEnum,
  onFieldClick,
}: {
  readonly label: string;
  readonly shape: Shape;
  readonly steps: ReadonlyArray<PathStep>;
  readonly depth: number;
  readonly maxEnum: number;
  readonly onFieldClick?: ((pathQuery: string, pointer: string) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(depth < 3);

  const renderObjectFields = (obj: ObjectShape, parentSteps: ReadonlyArray<PathStep>) => {
    if (obj.fields.length === 0) {
      return <p className="px-2 py-1 text-muted-foreground text-xs">Empty object</p>;
    }
    return (
      <div className="flex flex-col divide-y divide-border/60">
        {obj.fields.map((field) => (
          <FieldRow
            key={field.name}
            field={field}
            parentObject={obj}
            steps={[...parentSteps, { kind: "key", name: field.name }]}
            depth={depth + 1}
            maxEnum={maxEnum}
            onFieldClick={onFieldClick}
          />
        ))}
      </div>
    );
  };

  if (shape.object !== null) {
    return (
      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-medium text-foreground text-xs hover:text-primary"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{label}</span>
          </button>
          <Badge variant="outline" size="sm">
            object · {shape.object.count}
          </Badge>
        </div>
        {expanded ? renderObjectFields(shape.object, steps) : null}
      </section>
    );
  }

  if (shape.array !== null) {
    const itemSteps: ReadonlyArray<PathStep> = [...steps, { kind: "items" }];
    return (
      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-medium text-foreground text-xs hover:text-primary"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{label}</span>
          </button>
          <Badge variant="outline" size="sm">
            array [{shape.array.minLen}..{shape.array.maxLen}]
          </Badge>
        </div>
        {expanded ? (
          <div className="p-2">
            <ShapeNodeCard
              label="Items"
              shape={shape.array.items}
              steps={itemSteps}
              depth={depth + 1}
              maxEnum={maxEnum}
              onFieldClick={onFieldClick}
            />
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-2.5 py-2 text-xs">
      <span className="font-medium text-foreground">{label}</span>
      <Badge variant="secondary" size="sm">
        {formatShapeType(shape)}
      </Badge>
    </div>
  );
}

function FieldRow({
  field,
  parentObject,
  steps,
  depth,
  maxEnum,
  onFieldClick,
}: {
  readonly field: FieldShape;
  readonly parentObject: ObjectShape;
  readonly steps: ReadonlyArray<PathStep>;
  readonly depth: number;
  readonly maxEnum: number;
  readonly onFieldClick?: ((pathQuery: string, pointer: string) => void) | undefined;
}) {
  const [nestedOpen, setNestedOpen] = useState(false);
  const pathQuery = buildPathQuery(steps);
  const pointer = buildPointer(steps);
  const required = field.present === parentObject.count;
  const pct = presencePercent(field.present, parentObject.count);
  const enumVals = field.shape.string !== null ? detectEnums(field.shape.string, maxEnum) : null;
  const hasNested =
    field.shape.object !== null ||
    (field.shape.array !== null &&
      (field.shape.array.items.object !== null || field.shape.array.items.array !== null));

  return (
    <div className="flex flex-col px-2.5 py-1.5" data-schema-field={pointer}>
      <div className="flex flex-wrap items-center gap-1.5">
        {hasNested ? (
          <button
            type="button"
            aria-label={`Toggle ${field.name}`}
            aria-expanded={nestedOpen}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setNestedOpen((prev) => !prev)}
          >
            {nestedOpen ? (
              <ChevronDownIcon aria-hidden className="size-3.5" />
            ) : (
              <ChevronRightIcon aria-hidden className="size-3.5" />
            )}
          </button>
        ) : null}
        <button
          type="button"
          className="min-w-0 truncate text-left font-mono text-foreground text-xs hover:text-primary hover:underline"
          onClick={() => onFieldClick?.(pathQuery, pointer)}
        >
          {field.name}
        </button>
        <Badge variant="secondary" size="sm">
          {formatShapeType(field.shape)}
        </Badge>
        <span className="ms-auto flex items-center gap-1 text-muted-foreground text-xs">
          <span>{pct}</span>
          {required ? (
            <Badge variant="outline" size="sm">
              required
            </Badge>
          ) : null}
        </span>
      </div>
      {enumVals !== null ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {enumVals.slice(0, 3).map((val) => (
            <Badge key={val} variant="outline" size="sm">
              {val}
            </Badge>
          ))}
          {enumVals.length > 3 ? (
            <span className="text-muted-foreground text-xs">+{enumVals.length - 3}</span>
          ) : null}
        </div>
      ) : null}
      {hasNested && nestedOpen ? (
        <div className="mt-2 pl-3">
          <ShapeNodeCard
            label={field.name}
            shape={field.shape}
            steps={steps}
            depth={depth}
            maxEnum={maxEnum}
            onFieldClick={onFieldClick}
          />
        </div>
      ) : null}
    </div>
  );
}
