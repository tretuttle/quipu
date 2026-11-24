import {
  SYNTAX_KEY_DEPTH_SLOTS,
  type SyntaxContainerKind,
  type SyntaxTable,
  type SyntaxTokenKind,
} from "@quipu/shared/syntaxTable";

/**
 * The syntax table as CSS custom properties on the document root, so the map
 * paints a node's rows with `fill="var(--syntax-…)"` and never a color
 * literal. The theme code writes them beside the palette; switching themes
 * recolors the map the way it recolors the source view, because both read the
 * same table.
 */
const SYNTAX_VARIABLES = {
  foreground: "--syntax-foreground",
  keyQuotes: "--syntax-key-quotes",
  stringBody: "--syntax-string",
  stringQuotes: "--syntax-string-quotes",
  escape: "--syntax-escape",
  number: "--syntax-number",
  literalInObject: "--syntax-literal-object",
  literalInArray: "--syntax-literal-array",
  brace: "--syntax-brace",
  bracket: "--syntax-bracket",
  colon: "--syntax-colon",
  commaInObject: "--syntax-comma-object",
  commaInArray: "--syntax-comma-array",
} as const satisfies Record<Exclude<keyof SyntaxTable, "keyBody">, string>;

const keyVariable = (slot: number) => `--syntax-key-${slot + 1}`;

export function applySyntaxVariables(root: HTMLElement, table: SyntaxTable): void {
  for (const [field, variable] of Object.entries(SYNTAX_VARIABLES) as Array<
    [keyof typeof SYNTAX_VARIABLES, string]
  >) {
    root.style.setProperty(variable, table[field]);
  }
  for (let slot = 0; slot < SYNTAX_KEY_DEPTH_SLOTS; slot += 1) {
    root.style.setProperty(keyVariable(slot), table.keyBody[slot] ?? table.foreground);
  }
}

/**
 * The variable a token paints with, mirroring `syntaxColor`: keys by the
 * number of enclosing objects (depth 1 is a key of the top-level object),
 * literals and commas by their container.
 */
export function syntaxVariableFor(
  kind: SyntaxTokenKind,
  depth: number,
  container: SyntaxContainerKind,
): string {
  switch (kind) {
    case "key":
      return keyVariable(Math.min(Math.max(Math.trunc(depth), 1), SYNTAX_KEY_DEPTH_SLOTS) - 1);
    case "keyQuote":
      return SYNTAX_VARIABLES.keyQuotes;
    case "string":
      return SYNTAX_VARIABLES.stringBody;
    case "stringQuote":
      return SYNTAX_VARIABLES.stringQuotes;
    case "escape":
      return SYNTAX_VARIABLES.escape;
    case "number":
      return SYNTAX_VARIABLES.number;
    case "literal":
      return container === "array"
        ? SYNTAX_VARIABLES.literalInArray
        : SYNTAX_VARIABLES.literalInObject;
    case "brace":
      return SYNTAX_VARIABLES.brace;
    case "bracket":
      return SYNTAX_VARIABLES.bracket;
    case "colon":
      return SYNTAX_VARIABLES.colon;
    case "comma":
      return container === "array" ? SYNTAX_VARIABLES.commaInArray : SYNTAX_VARIABLES.commaInObject;
    case "whitespace":
      return SYNTAX_VARIABLES.foreground;
  }
}
