import { Button } from "../ui/button";
import { Input } from "../ui/input";

const INTERFACE_PREVIEW_FIELD_VALUE = "Quipu keeps nested JSON readable";

/**
 * The interface font on real controls: a heading, body copy, a button and a
 * live input. Everything inherits `--font-sans` and the interface size, so a
 * family or size change reflows it as it will the rest of the app.
 */
export function InterfaceFontPreview() {
  return (
    <div
      className="mt-1 mb-2 space-y-2 rounded-lg border border-border bg-background px-3 py-3"
      aria-label="Interface font preview"
      role="group"
    >
      <p className="text-sm font-medium text-foreground">Settings and panels</p>
      <p className="text-xs text-muted-foreground">
        0O 1lI — the quick brown fox jumps over the lazy dog.
      </p>
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          aria-label="Interface font sample field"
          defaultValue={INTERFACE_PREVIEW_FIELD_VALUE}
        />
        <Button size="sm" variant="outline">
          Apply
        </Button>
      </div>
    </div>
  );
}

type CodePreviewToken = readonly [text: string, variable: string | null];

// A short document in the code font, colored with the syntax table the source
// view and the map use, so family, size and theme all show here.
const CODE_PREVIEW_LINES: ReadonlyArray<ReadonlyArray<CodePreviewToken>> = [
  [["{", "--syntax-brace"]],
  [
    ["  ", null],
    ['"', "--syntax-key-quotes"],
    ["name", "--syntax-key-1"],
    ['"', "--syntax-key-quotes"],
    [": ", "--syntax-colon"],
    ['"', "--syntax-string-quotes"],
    ["quipu", "--syntax-string"],
    ['"', "--syntax-string-quotes"],
    [",", "--syntax-comma-object"],
  ],
  [
    ["  ", null],
    ['"', "--syntax-key-quotes"],
    ["knots", "--syntax-key-1"],
    ['"', "--syntax-key-quotes"],
    [": ", "--syntax-colon"],
    ["[", "--syntax-bracket"],
    ["3", "--syntax-number"],
    [", ", "--syntax-comma-array"],
    ["0.5", "--syntax-number"],
    [", ", "--syntax-comma-array"],
    ["true", "--syntax-literal-array"],
    ["]", "--syntax-bracket"],
    [",", "--syntax-comma-object"],
  ],
  [
    ["  ", null],
    ['"', "--syntax-key-quotes"],
    ["glyphs", "--syntax-key-1"],
    ['"', "--syntax-key-quotes"],
    [": ", "--syntax-colon"],
    ['"', "--syntax-string-quotes"],
    ["0O 1lI", "--syntax-string"],
    ['"', "--syntax-string-quotes"],
  ],
  [["}", "--syntax-brace"]],
];

/** A small JSON document in the code font and the code size. */
export function CodeFontPreview() {
  return (
    <pre
      aria-label="Code font preview"
      className="mt-1 mb-2 overflow-x-auto rounded-lg border border-border bg-code px-3 py-2 font-mono text-code-foreground"
      data-code-font-preview=""
      role="group"
      style={{ fontSize: "var(--font-size-code)" }}
    >
      {CODE_PREVIEW_LINES.map((tokens, line) => (
        // The sample is fixed, so a line's position is its identity.
        <div key={`line-${String(line)}`}>
          {tokens.map(([text, variable], index) => (
            <span
              key={`${String(index)}-${text}`}
              style={variable === null ? undefined : { color: `var(${variable})` }}
            >
              {text}
            </span>
          ))}
        </div>
      ))}
    </pre>
  );
}
