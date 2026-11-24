import type { ThemeAppearance } from "./themePalettes.js";

/**
 * The colors a JSON document is painted with, one per kind of token the JSON
 * grammar tells apart. A theme's TextMate rules pick a color by the whole
 * scope stack shiki produces, so the table is resolved per stack at import
 * time (apps/web/src/syntaxTableResolver.ts) and stored beside the workbench
 * colors. The source view, the map, and the structural-index painter all read
 * this one table, which is what keeps them in agreement.
 *
 * Every color is a lowercase hex string, alpha kept, exactly as shiki reports
 * it.
 */
export type SyntaxTable = Readonly<{
  /** Whitespace, and anything the theme's rules leave uncolored. */
  foreground: string;
  /**
   * Key body by count of enclosing objects: index 0 is depth 1 (a key of the
   * top-level object), index 7 is depth 8, and index 8 is depth 9 and deeper.
   * Tokyo Night colors keys by depth; most themes use one color throughout.
   */
  keyBody: SyntaxKeyBodyColors;
  keyQuotes: string;
  stringBody: string;
  stringQuotes: string;
  /** A backslash escape, in a key or in a string. */
  escape: string;
  number: string;
  /** `true`, `false`, and `null` as the value of an object member. */
  literalInObject: string;
  /** `true`, `false`, and `null` as an array element. */
  literalInArray: string;
  /** `{` and `}`. */
  brace: string;
  /** `[` and `]`. */
  bracket: string;
  colon: string;
  /** A comma between object members. */
  commaInObject: string;
  /** A comma between array elements. */
  commaInArray: string;
}>;

export const SYNTAX_KEY_DEPTH_SLOTS = 9;

export type SyntaxKeyBodyColors = Readonly<
  [string, string, string, string, string, string, string, string, string]
>;

export type SyntaxTokenKind =
  | "key"
  | "keyQuote"
  | "string"
  | "stringQuote"
  | "escape"
  | "number"
  | "literal"
  | "brace"
  | "bracket"
  | "colon"
  | "comma"
  | "whitespace";

/**
 * The container a token sits in. `root` is a value that is the whole
 * document, which has no container.
 */
export type SyntaxContainerKind = "object" | "array" | "root";

/**
 * A theme's tables, one per appearance it was imported for. A paired
 * light/dark theme carries both. T3 Code's theme file format has no such
 * field, so it is omitted from a theme and from its exported file when absent.
 */
export type ThemeSyntax = Readonly<Partial<Record<ThemeAppearance, SyntaxTable>>>;

const SYNTAX_TABLE_COLOR_KEYS = [
  "foreground",
  "keyQuotes",
  "stringBody",
  "stringQuotes",
  "escape",
  "number",
  "literalInObject",
  "literalInArray",
  "brace",
  "bracket",
  "colon",
  "commaInObject",
  "commaInArray",
] as const;

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSyntaxColor(value: unknown): string | null {
  if (typeof value !== "string" || !HEX_COLOR.test(value)) return null;
  return value.toLowerCase();
}

/** Reads a stored or imported table. Returns null unless every color is a hex string. */
function parseSyntaxTable(value: unknown): SyntaxTable | null {
  if (!isRecord(value)) return null;
  const colors: Record<string, string> = {};
  for (const key of SYNTAX_TABLE_COLOR_KEYS) {
    const color = parseSyntaxColor(value[key]);
    if (color === null) return null;
    colors[key] = color;
  }
  const rawKeyBody = value.keyBody;
  if (!Array.isArray(rawKeyBody) || rawKeyBody.length !== SYNTAX_KEY_DEPTH_SLOTS) return null;
  const keyBody: string[] = [];
  for (const entry of rawKeyBody) {
    const color = parseSyntaxColor(entry);
    if (color === null) return null;
    keyBody.push(color);
  }
  return {
    foreground: colors.foreground!,
    keyBody: keyBody as unknown as SyntaxKeyBodyColors,
    keyQuotes: colors.keyQuotes!,
    stringBody: colors.stringBody!,
    stringQuotes: colors.stringQuotes!,
    escape: colors.escape!,
    number: colors.number!,
    literalInObject: colors.literalInObject!,
    literalInArray: colors.literalInArray!,
    brace: colors.brace!,
    bracket: colors.bracket!,
    colon: colors.colon!,
    commaInObject: colors.commaInObject!,
    commaInArray: colors.commaInArray!,
  };
}

/**
 * Reads the `syntax` field of a stored theme or theme file. A value that is
 * not an object of valid tables yields undefined, so a malformed field drops
 * back to the pierre fallback rather than failing the theme.
 */
export function parseThemeSyntax(value: unknown): ThemeSyntax | undefined {
  if (!isRecord(value)) return undefined;
  const syntax: Partial<Record<ThemeAppearance, SyntaxTable>> = {};
  for (const appearance of ["light", "dark"] as const) {
    if (value[appearance] === undefined) continue;
    const table = parseSyntaxTable(value[appearance]);
    if (table === null) return undefined;
    syntax[appearance] = table;
  }
  return Object.keys(syntax).length > 0 ? syntax : undefined;
}

/**
 * The color of one token. `depth` is the number of objects enclosing the
 * token, counting the object a key belongs to (a key of the top-level object
 * is depth 1). Only keys read it. `container` is the container the token sits
 * in; only literals and commas read it.
 */
export function syntaxColor(
  table: SyntaxTable,
  kind: SyntaxTokenKind,
  depth: number,
  container: SyntaxContainerKind,
): string {
  switch (kind) {
    case "key": {
      const slot = Math.min(Math.max(Math.trunc(depth), 1), SYNTAX_KEY_DEPTH_SLOTS) - 1;
      return table.keyBody[slot] ?? table.foreground;
    }
    case "keyQuote":
      return table.keyQuotes;
    case "string":
      return table.stringBody;
    case "stringQuote":
      return table.stringQuotes;
    case "escape":
      return table.escape;
    case "number":
      return table.number;
    case "literal":
      return container === "array" ? table.literalInArray : table.literalInObject;
    case "brace":
      return table.brace;
    case "bracket":
      return table.bracket;
    case "colon":
      return table.colon;
    case "comma":
      return container === "array" ? table.commaInArray : table.commaInObject;
    case "whitespace":
      return table.foreground;
  }
}

/**
 * The resolved JSON colors of `@pierre/theme` 2.0.0's pierre-dark and
 * pierre-light. They are what a theme without `tokenColors` falls back to.
 * apps/web/src/syntaxTable.test.ts resolves both themes and fails if these
 * drift from the real theme files.
 */
export const PIERRE_DARK_SYNTAX_TABLE: SyntaxTable = {
  foreground: "#fafafa",
  keyBody: [
    "#ff855e",
    "#ff855e",
    "#ff855e",
    "#ff855e",
    "#ff855e",
    "#ff855e",
    "#ff855e",
    "#ff855e",
    "#ff855e",
  ],
  keyQuotes: "#ff855e",
  stringBody: "#5ecc71",
  stringQuotes: "#5ecc71",
  escape: "#61d5c0",
  number: "#68cdf2",
  literalInObject: "#68cdf2",
  literalInArray: "#08c0ef",
  brace: "#636363",
  bracket: "#636363",
  colon: "#636363",
  commaInObject: "#636363",
  commaInArray: "#636363",
};

export const PIERRE_LIGHT_SYNTAX_TABLE: SyntaxTable = {
  foreground: "#0a0a0a",
  keyBody: [
    "#d5512f",
    "#d5512f",
    "#d5512f",
    "#d5512f",
    "#d5512f",
    "#d5512f",
    "#d5512f",
    "#d5512f",
    "#d5512f",
  ],
  keyQuotes: "#d5512f",
  stringBody: "#199f43",
  stringQuotes: "#199f43",
  escape: "#16a994",
  number: "#1ca1c7",
  literalInObject: "#1ca1c7",
  literalInArray: "#08c0ef",
  brace: "#636363",
  bracket: "#636363",
  colon: "#636363",
  commaInObject: "#636363",
  commaInArray: "#636363",
};

const PIERRE_SYNTAX_TABLES: Readonly<Record<ThemeAppearance, SyntaxTable>> = {
  light: PIERRE_LIGHT_SYNTAX_TABLE,
  dark: PIERRE_DARK_SYNTAX_TABLE,
};

/** The table a theme paints JSON with for an appearance: its own, else pierre's. */
export function syntaxTableForAppearance(
  syntax: ThemeSyntax | undefined,
  appearance: ThemeAppearance,
): SyntaxTable {
  return syntax?.[appearance] ?? PIERRE_SYNTAX_TABLES[appearance];
}
