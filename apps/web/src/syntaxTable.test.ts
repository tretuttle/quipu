import pierreDark from "@pierre/theme/pierre-dark";
import pierreLight from "@pierre/theme/pierre-light";
import {
  PIERRE_DARK_SYNTAX_TABLE,
  PIERRE_LIGHT_SYNTAX_TABLE,
  syntaxColor,
  syntaxTableForAppearance,
  type SyntaxContainerKind,
  type SyntaxTable,
  type SyntaxTokenKind,
} from "@quipu/shared/syntaxTable";
import { BUILT_IN_THEMES } from "@quipu/shared/themePalettes";
import { parse as parseJsonc } from "jsonc-parser";
import { createHighlighter } from "shiki";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import catppuccinMochaSource from "./testFixtures/open-vsx/theme-catppuccin-mocha.json?raw";
import draculaSource from "./testFixtures/open-vsx/theme-dracula.json?raw";
import nordSource from "./testFixtures/open-vsx/theme-nord.json?raw";
import tokyoNightSource from "./testFixtures/open-vsx/theme-tokyo-night.json?raw";
import { buildSourceViewTheme } from "./syntaxSourceTheme";
import { resolveSyntaxTable } from "./syntaxTableResolver";
import { parseThemeFile, serializeThemeFile, type ThemeDefinition } from "./themePalette";
import { parseVsCodeThemeFile } from "./vscodeThemeImport";

type Appearance = "light" | "dark";
type CharacterStyle = Readonly<{
  kind: SyntaxTokenKind;
  depth: number;
  container: SyntaxContainerKind;
}>;

/**
 * An independent reader of JSON text. It never calls shiki: it walks the
 * grammar of JSON and says, for every character, what the structural index
 * would say about it (token kind, enclosing-object depth, container kind).
 * Newlines carry no style.
 */
function styleCharacters(text: string): Array<CharacterStyle | null> {
  const styles: Array<CharacterStyle | null> = Array.from({ length: text.length }, () => null);
  let position = 0;

  const paint = (start: number, end: number, style: CharacterStyle) => {
    for (let index = start; index < end; index += 1) {
      if (text[index] !== "\n") styles[index] = style;
    }
  };
  const skipWhitespace = () => {
    while (position < text.length && " \t\r\n".includes(text[position]!)) {
      if (text[position] !== "\n") {
        styles[position] = { kind: "whitespace", depth: 0, container: "root" };
      }
      position += 1;
    }
  };
  const readString = (
    body: SyntaxTokenKind,
    quote: SyntaxTokenKind,
    depth: number,
    container: SyntaxContainerKind,
  ) => {
    const style = (kind: SyntaxTokenKind): CharacterStyle => ({ kind, depth, container });
    paint(position, position + 1, style(quote));
    position += 1;
    while (text[position] !== '"') {
      if (text[position] === "\\") {
        const length = text[position + 1] === "u" ? 6 : 2;
        paint(position, position + length, style("escape"));
        position += length;
      } else {
        paint(position, position + 1, style(body));
        position += 1;
      }
    }
    paint(position, position + 1, style(quote));
    position += 1;
  };
  const readValue = (depth: number, container: SyntaxContainerKind) => {
    skipWhitespace();
    const here = text[position]!;
    if (here === "{") {
      const objectDepth = depth + 1;
      paint(position, position + 1, { kind: "brace", depth: objectDepth, container });
      position += 1;
      skipWhitespace();
      while (text[position] !== "}") {
        readString("key", "keyQuote", objectDepth, "object");
        skipWhitespace();
        paint(position, position + 1, { kind: "colon", depth: objectDepth, container: "object" });
        position += 1;
        readValue(objectDepth, "object");
        skipWhitespace();
        if (text[position] === ",") {
          paint(position, position + 1, { kind: "comma", depth: objectDepth, container: "object" });
          position += 1;
          skipWhitespace();
        }
      }
      paint(position, position + 1, { kind: "brace", depth: objectDepth, container });
      position += 1;
    } else if (here === "[") {
      paint(position, position + 1, { kind: "bracket", depth, container });
      position += 1;
      skipWhitespace();
      while (text[position] !== "]") {
        readValue(depth, "array");
        skipWhitespace();
        if (text[position] === ",") {
          paint(position, position + 1, { kind: "comma", depth, container: "array" });
          position += 1;
          skipWhitespace();
        }
      }
      paint(position, position + 1, { kind: "bracket", depth, container });
      position += 1;
    } else if (here === '"') {
      readString("string", "stringQuote", depth, container);
    } else {
      const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
        text.slice(position),
      );
      if (!match) throw new Error(`Unexpected ${here} at ${position}`);
      const kind = /^[-\d]/.test(match[0]) ? "number" : "literal";
      paint(position, position + match[0].length, { kind, depth, container });
      position += match[0].length;
    }
  };

  readValue(0, "root");
  skipWhitespace();
  return styles;
}

function paintFromTable(text: string, table: SyntaxTable): Array<string | null> {
  return styleCharacters(text).map((style) =>
    style ? syntaxColor(table, style.kind, style.depth, style.container) : null,
  );
}

const DOCUMENTS: Readonly<Record<string, string>> = {
  "nesting and arrays of literals": `{
  "name": "quipu",
  "tags": ["a", "b", true, false, null, 1, -2.5e+3, 0.25],
  "meta": {
    "ok": true,
    "none": null,
    "list": [[1, 2], [true], {"deep": [null, {"inner": false}]}]
  },
  "empty": {},
  "nothing": [],
  "blank": ""
}`,
  "escapes in keys and strings": `{"quote\\"key":"line\\nbreak \\u00e9 \\\\ \\/ \\t","café":"𐍈 café","text":"{\\"a\\":true,\\"b\\":[null]}","true":"true","1":1,"{":"}","":""}`,
  "objects ten deep": `{
  "a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": {"i": {"j": {
    "k": true,
    "list": [{"z": null, "y": [false]}],
    "m": {"n": 1}
  }}}}}}}}}}
}`,
  "minified capture with a stringified body": `{"log":{"version":"1.2","entries":[{"request":{"method":"GET","headers":[{"name":"a","value":"b"}]},"response":{"status":200,"content":{"mimeType":"application/json","text":"{\\"a\\":true,\\"list\\":[1,null]}"}},"cache":{},"time":-1}]}}`,
  "an array as the whole document": `[true, {"x": [false, null]}, "s", 0, [[], {}]]`,
};

// A bare value is the whole document: no container decides its color.
const ROOT_VALUE_DOCUMENTS: Readonly<Record<string, string>> = {
  "a string": `"top \\n level"`,
  "a number": `-12.5e3`,
  "a literal": `true`,
};

function readTheme(source: string): Record<string, unknown> {
  const value: unknown = parseJsonc(source, [], { allowTrailingComma: true });
  if (typeof value !== "object" || value === null) throw new Error("theme is not an object");
  return value as Record<string, unknown>;
}

type Palette = Readonly<{
  label: string;
  /** The shiki theme highlighting the same document the table must match. */
  shikiTheme: Record<string, unknown>;
  appearance: Appearance;
  table: SyntaxTable;
  definition: ThemeDefinition | null;
}>;

const IMPORTED_THEMES = [
  { label: "Dracula", source: draculaSource, appearance: "dark" },
  { label: "Catppuccin Mocha", source: catppuccinMochaSource, appearance: "dark" },
  { label: "Nord", source: nordSource, appearance: "dark" },
  { label: "Tokyo Night", source: tokyoNightSource, appearance: "dark" },
] as const;

function pierreThemeFor(appearance: Appearance): Record<string, unknown> {
  return (appearance === "dark" ? pierreDark : pierreLight) as unknown as Record<string, unknown>;
}

// The seven built-in palettes: the stock Graphite look (no installed theme) and
// the six themes Quipu ships. None carries token colors, so each falls back to
// pierre for the appearance that is active.
const BUILT_IN_PALETTES: ReadonlyArray<Palette> = (
  [null, ...BUILT_IN_THEMES] as ReadonlyArray<ThemeDefinition | null>
).flatMap((definition) =>
  (["light", "dark"] as const).map((appearance) => ({
    label: `${definition?.label ?? "Graphite"} (${appearance})`,
    shikiTheme: pierreThemeFor(appearance),
    appearance,
    table: syntaxTableForAppearance(definition?.syntax, appearance),
    definition,
  })),
);

const IMPORTED_PALETTES: ReadonlyArray<Palette> = IMPORTED_THEMES.map((theme) => {
  const raw = readTheme(theme.source);
  const definition = parseVsCodeThemeFile(raw);
  return {
    label: theme.label,
    shikiTheme: raw,
    appearance: theme.appearance,
    table: syntaxTableForAppearance(definition.syntax, theme.appearance),
    definition,
  };
});

const ALL_PALETTES = [...BUILT_IN_PALETTES, ...IMPORTED_PALETTES];

let highlighter: Awaited<ReturnType<typeof createHighlighter>>;
const registeredThemes = new Map<string, string>();

function themeNameFor(palette: Palette, variant: "own" | "source-view"): string {
  const key = `${palette.label}:${variant}`;
  const name = registeredThemes.get(key);
  if (!name) throw new Error(`theme ${key} was not registered`);
  return name;
}

function shikiColors(text: string, themeName: string): Array<string | null> {
  const { tokens } = highlighter.codeToTokens(text, { lang: "json", theme: themeName });
  const colors: Array<string | null> = Array.from({ length: text.length }, () => null);
  // A token's offset is an index into the whole string, not into its line.
  for (const line of tokens) {
    for (const token of line) {
      const to = token.offset + token.content.length;
      for (let index = token.offset; index < to; index += 1) {
        colors[index] = (token.color ?? "").toLowerCase();
      }
    }
  }
  return colors;
}

beforeAll(async () => {
  const sourceViewThemes = ALL_PALETTES.map((palette) => ({
    palette,
    theme: buildSourceViewTheme(palette.appearance, palette.table),
  }));
  const ownThemes = ALL_PALETTES.map((palette, index) => ({
    palette,
    theme: { ...palette.shikiTheme, name: `own-${index}` },
  }));
  highlighter = await createHighlighter({
    themes: [
      ...ownThemes.map((entry) => entry.theme),
      ...sourceViewThemes.map((entry) => entry.theme),
    ] as never,
    langs: ["json"],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
  for (const { palette, theme } of ownThemes) {
    registeredThemes.set(`${palette.label}:own`, theme.name as string);
  }
  for (const { palette, theme } of sourceViewThemes) {
    registeredThemes.set(`${palette.label}:source-view`, theme.name);
  }
});

function mismatches(text: string, palette: Palette, variant: "own" | "source-view") {
  const expected = paintFromTable(text, palette.table);
  const actual = shikiColors(text, themeNameFor(palette, variant));
  const found: string[] = [];
  let compared = 0;
  expected.forEach((color, index) => {
    if (color === null) return;
    compared += 1;
    if (actual[index] !== color) {
      found.push(
        `${palette.label} ${JSON.stringify(text[index])}@${index}: table ${color}, shiki ${actual[index]}`,
      );
    }
  });
  return { found, compared };
}

describe("resolving a theme's token colors", () => {
  it("falls back to the colors pierre-dark and pierre-light paint JSON with", () => {
    expect(resolveSyntaxTable(pierreDark)).toEqual(PIERRE_DARK_SYNTAX_TABLE);
    expect(resolveSyntaxTable(pierreLight)).toEqual(PIERRE_LIGHT_SYNTAX_TABLE);
  });

  it("colors Tokyo Night's keys by how many objects enclose them", () => {
    const table = syntaxTableForAppearance(IMPORTED_PALETTES[3]!.definition?.syntax, "dark");

    expect(table.keyBody).toEqual([
      "#7aa2f7",
      "#0db9d7",
      "#7dcfff",
      "#bb9af7",
      "#e0af68",
      "#0db9d7",
      "#73daca",
      "#f7768e",
      "#9ece6a",
    ]);
    expect(syntaxColor(table, "key", 1, "object")).toBe("#7aa2f7");
    expect(syntaxColor(table, "key", 9, "object")).toBe("#9ece6a");
    expect(syntaxColor(table, "key", 40, "object")).toBe("#9ece6a");
  });

  it("tells quotes, escapes, and literals apart where a theme does", () => {
    const [, , nord] = IMPORTED_PALETTES.slice(0, 4).map((palette) => palette.table) as [
      SyntaxTable,
      SyntaxTable,
      SyntaxTable,
      SyntaxTable,
    ];
    const dracula = IMPORTED_PALETTES[0]!.table;
    const pierre = PIERRE_DARK_SYNTAX_TABLE;

    expect(dracula.keyBody[0]).toBe("#8be9fd");
    expect(dracula.keyQuotes).toBe("#8be9fe");
    expect(dracula.stringBody).toBe("#f1fa8c");
    expect(dracula.stringQuotes).toBe("#e9f284");
    expect(dracula.colon).toBe("#ff79c6");
    expect(nord.number).toBe("#b48ead");
    expect(nord.literalInObject).toBe("#81a1c1");
    expect(pierre.literalInObject).toBe("#68cdf2");
    expect(pierre.literalInArray).toBe("#08c0ef");
    expect(syntaxColor(pierre, "literal", 2, "array")).toBe("#08c0ef");
    expect(syntaxColor(pierre, "literal", 2, "object")).toBe("#68cdf2");
  });
});

describe("a theme's syntax table in its theme record", () => {
  it("is captured when the theme file is imported, beside the colors", () => {
    const tokyoNight = IMPORTED_PALETTES[3]!.definition!;

    expect(Object.keys(tokyoNight.syntax ?? {})).toEqual(["dark"]);
    expect(tokyoNight.syntax?.dark?.keyBody[1]).toBe("#0db9d7");
    expect(tokyoNight.colors).not.toHaveProperty("syntax");
  });

  it("survives an export and import of the theme file", () => {
    const tokyoNight = IMPORTED_PALETTES[3]!.definition!;
    const exported = serializeThemeFile(tokyoNight);
    const file = JSON.parse(exported) as Record<string, unknown>;

    expect(Object.keys(file).at(-1)).toBe("syntax");
    expect(parseThemeFile(file).syntax).toEqual(tokyoNight.syntax);
    expect(serializeThemeFile(parseThemeFile(file))).toBe(exported);
  });

  it("is left out of the exported file when the theme has none", () => {
    const withoutTokens = parseVsCodeThemeFile({
      name: "Plain",
      type: "dark",
      colors: { "editor.background": "#101820", "editor.foreground": "#e0e0e0" },
    });

    expect(withoutTokens.syntax).toBeUndefined();
    expect(Object.keys(JSON.parse(serializeThemeFile(withoutTokens)))).not.toContain("syntax");
  });

  it("drops a malformed table instead of failing the import", () => {
    const file = {
      version: 1,
      name: "Broken table",
      appearance: "dark",
      colors: { canvas: "#101820" },
      syntax: { dark: { foreground: "not a color" } },
    };

    expect(parseThemeFile(file).syntax).toBeUndefined();
  });
});

describe("the syntax table paints what shiki paints", () => {
  const documentCases = Object.entries(DOCUMENTS).flatMap(([name, text]) =>
    ALL_PALETTES.map((palette) => [palette.label, name, palette, text] as const),
  );

  it.each(documentCases)("%s, %s", (_label, _name, palette, text) => {
    const own = mismatches(text, palette, "own");

    expect(own.found).toEqual([]);
    expect(own.compared).toBeGreaterThan(40);
  });

  it.each(documentCases)(
    "%s through the source view's theme, %s",
    (_label, _name, palette, text) => {
      const sourceView = mismatches(text, palette, "source-view");

      expect(sourceView.found).toEqual([]);
    },
  );

  const rootCases = Object.entries(ROOT_VALUE_DOCUMENTS).flatMap(([name, text]) =>
    ALL_PALETTES.map((palette) => [palette.label, name, palette, text] as const),
  );

  it.each(rootCases)("%s, a document that is only %s", (_label, _name, palette, text) => {
    expect(mismatches(text, palette, "own").found).toEqual([]);
    expect(mismatches(text, palette, "source-view").found).toEqual([]);
  });

  it("compares every non-newline character of every document under every palette", () => {
    const expected =
      ALL_PALETTES.length *
      Object.values(DOCUMENTS).reduce((sum, text) => sum + text.replaceAll("\n", "").length, 0);
    let compared = 0;
    for (const palette of ALL_PALETTES) {
      for (const text of Object.values(DOCUMENTS)) {
        compared += mismatches(text, palette, "own").compared;
      }
    }

    expect(ALL_PALETTES).toHaveLength((1 + BUILT_IN_THEMES.length) * 2 + 4);
    expect(compared).toBe(expected);
  });
});
