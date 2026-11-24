import {
  SYNTAX_KEY_DEPTH_SLOTS,
  type SyntaxKeyBodyColors,
  type SyntaxTable,
} from "@quipu/shared/syntaxTable";

/**
 * Resolves a VS Code theme's `tokenColors` into a SyntaxTable by matching the
 * scope stacks shiki's JSON grammar produces, with the same TextMate
 * scope-selector semantics shiki uses (`@shikijs/vscode-textmate` 10.0.2:
 * parseTheme, resolveParsedThemeRules, ThemeTrieElement, and
 * _scopePathMatchesParentScopes). The matcher is reimplemented here so that
 * importing a theme does not pull the highlighter and its grammar into the page;
 * syntaxTable.test.ts compares it with shiki token by token.
 */

export type TokenColorRule = Readonly<{
  name?: string;
  scope?: string | ReadonlyArray<string>;
  settings?: Readonly<{ foreground?: string; background?: string; fontStyle?: string }>;
}>;

export type SyntaxThemeSource = Readonly<{
  /** VS Code `tokenColors`. A `settings` array (TextMate's name for it) is read too. */
  tokenColors?: ReadonlyArray<TokenColorRule>;
  settings?: ReadonlyArray<TokenColorRule>;
  colors?: Readonly<Record<string, unknown>>;
  type?: string;
}>;

type ParsedRule = {
  scope: string;
  parentScopes: ReadonlyArray<string> | null;
  index: number;
  foreground: string | null;
};

type TrieRule = {
  scopeDepth: number;
  parentScopes: ReadonlyArray<string>;
  foreground: string | null;
};

const HEX_COLOR_PATTERNS = [
  /^#[0-9a-f]{6}$/i,
  /^#[0-9a-f]{8}$/i,
  /^#[0-9a-f]{3}$/i,
  /^#[0-9a-f]{4}$/i,
];

// shiki's last resort when a theme names neither an editor foreground nor a
// scope-less rule (@shikijs/primitive normalizeTheme).
const FALLBACK_FOREGROUND = { light: "#333333", dark: "#bbbbbb" } as const;

function isValidHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_PATTERNS.some((pattern) => pattern.test(value));
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareStringArrays(
  a: ReadonlyArray<string> | null,
  b: ReadonlyArray<string> | null,
): number {
  if (a === null && b === null) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a.length !== b.length) return a.length - b.length;
  for (let index = 0; index < a.length; index += 1) {
    const result = compareStrings(a[index]!, b[index]!);
    if (result !== 0) return result;
  }
  return 0;
}

function parseTokenColors(rules: ReadonlyArray<TokenColorRule>): ParsedRule[] {
  const parsed: ParsedRule[] = [];
  for (let index = 0; index < rules.length; index += 1) {
    const entry = rules[index];
    if (!entry || typeof entry !== "object" || !entry.settings) continue;
    let scopes: ReadonlyArray<string>;
    if (typeof entry.scope === "string") {
      scopes = entry.scope.replace(/^,+/, "").replace(/,+$/, "").split(",");
    } else if (Array.isArray(entry.scope)) {
      scopes = entry.scope.filter((scope): scope is string => typeof scope === "string");
    } else {
      scopes = [""];
    }
    const foreground = isValidHexColor(entry.settings.foreground)
      ? entry.settings.foreground
      : null;
    for (const rawScope of scopes) {
      const segments = rawScope.trim().split(" ");
      const scope = segments[segments.length - 1]!;
      const parentScopes = segments.length > 1 ? segments.slice(0, -1).toReversed() : null;
      parsed.push({ scope, parentScopes, index, foreground });
    }
  }
  return parsed;
}

function matchesScope(scopeName: string, scopePattern: string): boolean {
  return (
    scopePattern === scopeName ||
    (scopeName.startsWith(scopePattern) && scopeName[scopePattern.length] === ".")
  );
}

/**
 * `scopes` is the token's stack, outermost first; the scope being colored is
 * excluded and `depth` is the index of its parent.
 */
function scopePathMatchesParentScopes(
  scopes: ReadonlyArray<string>,
  parentIndex: number,
  parentScopes: ReadonlyArray<string>,
): boolean {
  if (parentScopes.length === 0) return true;
  let cursor = parentIndex;
  for (let index = 0; index < parentScopes.length; index += 1) {
    let scopePattern = parentScopes[index]!;
    let scopeMustMatch = false;
    if (scopePattern === ">") {
      if (index === parentScopes.length - 1) return false;
      index += 1;
      scopePattern = parentScopes[index]!;
      scopeMustMatch = true;
    }
    while (cursor >= 0) {
      if (matchesScope(scopes[cursor]!, scopePattern)) break;
      if (scopeMustMatch) return false;
      cursor -= 1;
    }
    if (cursor < 0) return false;
    cursor -= 1;
  }
  return true;
}

class ThemeTrieElement {
  private readonly children = new Map<string, ThemeTrieElement>();

  constructor(
    private readonly mainRule: TrieRule,
    private readonly rulesWithParentScopes: TrieRule[] = [],
  ) {}

  private static compareBySpecificity(a: TrieRule, b: TrieRule): number {
    if (a.scopeDepth !== b.scopeDepth) return b.scopeDepth - a.scopeDepth;
    let aIndex = 0;
    let bIndex = 0;
    for (;;) {
      if (a.parentScopes[aIndex] === ">") aIndex += 1;
      if (b.parentScopes[bIndex] === ">") bIndex += 1;
      if (aIndex >= a.parentScopes.length || bIndex >= b.parentScopes.length) break;
      const lengthDifference = b.parentScopes[bIndex]!.length - a.parentScopes[aIndex]!.length;
      if (lengthDifference !== 0) return lengthDifference;
      aIndex += 1;
      bIndex += 1;
    }
    return b.parentScopes.length - a.parentScopes.length;
  }

  match(scope: string): TrieRule[] {
    if (scope !== "") {
      const dotIndex = scope.indexOf(".");
      const head = dotIndex === -1 ? scope : scope.slice(0, dotIndex);
      const tail = dotIndex === -1 ? "" : scope.slice(dotIndex + 1);
      const child = this.children.get(head);
      if (child) return child.match(tail);
    }
    return [...this.rulesWithParentScopes, this.mainRule].sort(
      ThemeTrieElement.compareBySpecificity,
    );
  }

  insert(
    scopeDepth: number,
    scope: string,
    parentScopes: ReadonlyArray<string> | null,
    foreground: string | null,
  ): void {
    if (scope === "") {
      this.insertHere(scopeDepth, parentScopes, foreground);
      return;
    }
    const dotIndex = scope.indexOf(".");
    const head = dotIndex === -1 ? scope : scope.slice(0, dotIndex);
    const tail = dotIndex === -1 ? "" : scope.slice(dotIndex + 1);
    let child = this.children.get(head);
    if (!child) {
      child = new ThemeTrieElement(
        { ...this.mainRule },
        this.rulesWithParentScopes.map((rule) => ({ ...rule })),
      );
      this.children.set(head, child);
    }
    child.insert(scopeDepth + 1, tail, parentScopes, foreground);
  }

  private insertHere(
    scopeDepth: number,
    parentScopes: ReadonlyArray<string> | null,
    foreground: string | null,
  ): void {
    if (parentScopes === null) {
      this.mainRule.scopeDepth = scopeDepth;
      if (foreground !== null) this.mainRule.foreground = foreground;
      return;
    }
    for (const rule of this.rulesWithParentScopes) {
      if (compareStringArrays(rule.parentScopes, parentScopes) === 0) {
        rule.scopeDepth = scopeDepth;
        if (foreground !== null) rule.foreground = foreground;
        return;
      }
    }
    this.rulesWithParentScopes.push({
      scopeDepth,
      parentScopes,
      foreground: foreground ?? this.mainRule.foreground,
    });
  }
}

/** A theme as shiki's grammar sees it: default foreground plus the scope trie. */
export type ScopeColorTheme = Readonly<{
  /** The foreground of a scope stack no rule colors, lowercase. */
  foreground: string;
  /** The color of a token with this scope stack, outermost scope first. */
  colorOf: (scopes: ReadonlyArray<string>) => string;
}>;

/**
 * Builds the matcher for a theme. Mirrors shiki's normalizeTheme (default
 * foreground from the first scope-less rule, else editor.foreground, else the
 * VS Code fallback for the theme type) and vscode-textmate's rule resolution.
 */
function createScopeColorTheme(theme: SyntaxThemeSource): ScopeColorTheme {
  const rules: ReadonlyArray<TokenColorRule> = theme.tokenColors ?? theme.settings ?? [];
  const type = theme.type === "light" ? "light" : "dark";

  const globalRule = rules.find((rule) => !rule.name && !rule.scope);
  let foreground = globalRule?.settings?.foreground;
  if (!foreground) {
    const editorForeground = theme.colors?.["editor.foreground"];
    if (typeof editorForeground === "string" && editorForeground) foreground = editorForeground;
  }
  if (!foreground) foreground = FALLBACK_FOREGROUND[type];

  const first = rules[0];
  const settings: TokenColorRule[] = [...rules];
  if (!(first?.settings && !first.scope)) {
    settings.unshift({ settings: { foreground } });
  }

  const parsed = parseTokenColors(settings);
  parsed.sort(
    (a, b) =>
      compareStrings(a.scope, b.scope) ||
      compareStringArrays(a.parentScopes, b.parentScopes) ||
      a.index - b.index,
  );

  let defaultForeground = "#000000";
  while (parsed.length >= 1 && parsed[0]!.scope === "") {
    const incoming = parsed.shift()!;
    if (incoming.foreground !== null) defaultForeground = incoming.foreground;
  }
  defaultForeground = defaultForeground.toLowerCase();

  const root = new ThemeTrieElement({ scopeDepth: 0, parentScopes: [], foreground: null });
  for (const rule of parsed) {
    root.insert(0, rule.scope, rule.parentScopes, rule.foreground);
  }

  return {
    foreground: defaultForeground,
    colorOf(scopes) {
      let color = defaultForeground;
      for (let index = 0; index < scopes.length; index += 1) {
        const effective = root
          .match(scopes[index]!)
          .find((rule) => scopePathMatchesParentScopes(scopes, index - 1, rule.parentScopes));
        if (effective?.foreground != null) color = effective.foreground.toLowerCase();
      }
      return color;
    },
  };
}

const DICTIONARY = "meta.structure.dictionary.json";
const DICTIONARY_VALUE = "meta.structure.dictionary.value.json";
const ARRAY = "meta.structure.array.json";
const ROOT = "source.json";

/** `source.json` and the scopes of a member of the object at `depth`. */
function dictionaryChain(depth: number): string[] {
  const chain = [ROOT, DICTIONARY];
  for (let level = 1; level < depth; level += 1) chain.push(DICTIONARY_VALUE, DICTIONARY);
  return chain;
}

/**
 * The scope stacks the JSON grammar assigns (@shikijs/langs 4.2.0 json.mjs),
 * each one for a token at the shallowest object that has it, except keys,
 * which are resolved at every depth.
 */
function keyBodyScopes(depth: number): string[] {
  return [...dictionaryChain(depth), "string.json", "support.type.property-name.json"];
}

const inObjectValue = [...dictionaryChain(1), DICTIONARY_VALUE];
const inArrayValue = [...inObjectValue, ARRAY];
const KEY_STRING = [...dictionaryChain(1), "string.json", "support.type.property-name.json"];

const JSON_SCOPE_STACKS = {
  keyQuotes: [...KEY_STRING, "punctuation.support.type.property-name.begin.json"],
  stringBody: [...inObjectValue, "string.quoted.double.json"],
  stringQuotes: [
    ...inObjectValue,
    "string.quoted.double.json",
    "punctuation.definition.string.begin.json",
  ],
  escape: [...inObjectValue, "string.quoted.double.json", "constant.character.escape.json"],
  number: [...inObjectValue, "constant.numeric.json"],
  literalInObject: [...inObjectValue, "constant.language.json"],
  literalInArray: [...inArrayValue, "constant.language.json"],
  brace: [...dictionaryChain(1), "punctuation.definition.dictionary.begin.json"],
  bracket: [...inArrayValue, "punctuation.definition.array.begin.json"],
  colon: [...inObjectValue, "punctuation.separator.dictionary.key-value.json"],
  commaInObject: [...inObjectValue, "punctuation.separator.dictionary.pair.json"],
  commaInArray: [...inArrayValue, "punctuation.separator.array.json"],
} as const;

/** Resolves every entry of the table for a theme's rules. */
export function resolveSyntaxTable(theme: SyntaxThemeSource): SyntaxTable {
  const matcher = createScopeColorTheme(theme);
  const keyBody: string[] = [];
  for (let depth = 1; depth <= SYNTAX_KEY_DEPTH_SLOTS; depth += 1) {
    keyBody.push(matcher.colorOf(keyBodyScopes(depth)));
  }
  const colorOf = (scopes: ReadonlyArray<string>) => matcher.colorOf(scopes);
  return {
    foreground: matcher.foreground,
    keyBody: keyBody as unknown as SyntaxKeyBodyColors,
    keyQuotes: colorOf(JSON_SCOPE_STACKS.keyQuotes),
    stringBody: colorOf(JSON_SCOPE_STACKS.stringBody),
    stringQuotes: colorOf(JSON_SCOPE_STACKS.stringQuotes),
    escape: colorOf(JSON_SCOPE_STACKS.escape),
    number: colorOf(JSON_SCOPE_STACKS.number),
    literalInObject: colorOf(JSON_SCOPE_STACKS.literalInObject),
    literalInArray: colorOf(JSON_SCOPE_STACKS.literalInArray),
    brace: colorOf(JSON_SCOPE_STACKS.brace),
    bracket: colorOf(JSON_SCOPE_STACKS.bracket),
    colon: colorOf(JSON_SCOPE_STACKS.colon),
    commaInObject: colorOf(JSON_SCOPE_STACKS.commaInObject),
    commaInArray: colorOf(JSON_SCOPE_STACKS.commaInArray),
  };
}
