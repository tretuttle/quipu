import pierreDark from "@pierre/theme/pierre-dark";
import pierreLight from "@pierre/theme/pierre-light";
import { SYNTAX_KEY_DEPTH_SLOTS, type SyntaxTable } from "@quipu/shared/syntaxTable";
import type { ThemeAppearance } from "@quipu/shared/themePalettes";

import type { TokenColorRule } from "./syntaxTableResolver";

/**
 * A shiki theme registration for the source view. It starts from
 * @pierre/theme's pierre-light or pierre-dark, which paint everything but
 * JSON, and appends rules that paint the JSON scopes from the syntax table, so
 * the source view agrees with the map and the structural-index painter that
 * read the same table.
 */
export type SourceViewTheme = Readonly<{
  name: string;
  displayName: string;
  type: ThemeAppearance;
  colors: Readonly<Record<string, string>>;
  tokenColors: ReadonlyArray<TokenColorRule>;
}>;

const ROOT = "source.json";
const DICTIONARY = "meta.structure.dictionary.json";
const DICTIONARY_VALUE = "meta.structure.dictionary.value.json";
const ARRAY = "meta.structure.array.json";

function rule(name: string, scopes: ReadonlyArray<string>, foreground: string): TokenColorRule {
  return { name: `quipu syntax: ${name}`, scope: scopes, settings: { foreground } };
}

/**
 * A selector that names the scope being colored in full, so it outranks every
 * pierre rule on a shorter prefix of it. Where pierre has a rule on the same
 * scope, the parents make this one more specific, or identical, in which case
 * the later rule wins (vscode-textmate acceptOverwrite).
 */
function selectorsFor(parents: string, scopes: ReadonlyArray<string>): string[] {
  return scopes.map((scope) => `${parents} ${scope}`);
}

function dictionaryChain(depth: number): string {
  const chain = [ROOT, DICTIONARY];
  for (let level = 1; level < depth; level += 1) chain.push(DICTIONARY_VALUE, DICTIONARY);
  return chain.join(" ");
}

function jsonRules(table: SyntaxTable): TokenColorRule[] {
  const rules: TokenColorRule[] = [];
  // Descendant selectors may skip scopes, so the selector for depth N also
  // matches every deeper stack, and more parents outrank fewer: depth 9 holds
  // for 9 and beyond, exactly as a theme's own "level 8" rule does.
  for (let depth = 1; depth <= SYNTAX_KEY_DEPTH_SLOTS; depth += 1) {
    rules.push(
      rule(
        `key body at depth ${depth}`,
        [`${dictionaryChain(depth)} support.type.property-name.json`],
        table.keyBody[depth - 1]!,
      ),
    );
  }
  rules.push(
    rule(
      "key quotes",
      selectorsFor(ROOT, [
        "punctuation.support.type.property-name.begin.json",
        "punctuation.support.type.property-name.end.json",
      ]),
      table.keyQuotes,
    ),
    rule("string body", selectorsFor(ROOT, ["string.quoted.double.json"]), table.stringBody),
    rule(
      "string quotes",
      selectorsFor(ROOT, [
        "punctuation.definition.string.begin.json",
        "punctuation.definition.string.end.json",
      ]),
      table.stringQuotes,
    ),
    rule("escape", selectorsFor(ROOT, ["constant.character.escape.json"]), table.escape),
    rule("number", selectorsFor(ROOT, ["constant.numeric.json"]), table.number),
    // A document that is a bare `true` has no container; the table paints it
    // as an object value (syntaxColor's "root"). The array rule below has more
    // specific parents, so it still wins inside arrays.
    rule(
      "literal in object",
      [`${ROOT} ${DICTIONARY_VALUE} > constant.language.json`, `${ROOT} constant.language.json`],
      table.literalInObject,
    ),
    rule("literal in array", [`${ROOT} ${ARRAY} > constant.language.json`], table.literalInArray),
    rule(
      "brace",
      selectorsFor(ROOT, [
        "punctuation.definition.dictionary.begin.json",
        "punctuation.definition.dictionary.end.json",
      ]),
      table.brace,
    ),
    rule(
      "bracket",
      selectorsFor(ROOT, [
        "punctuation.definition.array.begin.json",
        "punctuation.definition.array.end.json",
      ]),
      table.bracket,
    ),
    rule(
      "colon",
      selectorsFor(ROOT, ["punctuation.separator.dictionary.key-value.json"]),
      table.colon,
    ),
    rule(
      "comma in object",
      selectorsFor(ROOT, ["punctuation.separator.dictionary.pair.json"]),
      table.commaInObject,
    ),
    rule(
      "comma in array",
      selectorsFor(ROOT, ["punctuation.separator.array.json"]),
      table.commaInArray,
    ),
  );
  return rules;
}

// FNV-1a over the table's JSON. shiki keys registered themes by name, so two
// tables must not share one.
function tableFingerprint(table: SyntaxTable): string {
  const text = JSON.stringify(table);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * pierre-light or pierre-dark with the table applied to the JSON scopes. The
 * result is a plain theme object a shiki highlighter can load; its name
 * encodes the appearance and the table so a changed table registers fresh.
 */
export function buildSourceViewTheme(
  appearance: ThemeAppearance,
  table: SyntaxTable,
): SourceViewTheme {
  const base = appearance === "dark" ? pierreDark : pierreLight;
  return {
    name: `quipu-source-${appearance}-${tableFingerprint(table)}`,
    displayName: `Quipu source (${appearance})`,
    type: appearance,
    colors: { ...base.colors, "editor.foreground": table.foreground },
    tokenColors: [
      ...base.tokenColors,
      // A scope-less rule sets the default foreground; the last one wins.
      { name: "quipu syntax: foreground", settings: { foreground: table.foreground } },
      ...jsonRules(table),
    ],
  };
}
