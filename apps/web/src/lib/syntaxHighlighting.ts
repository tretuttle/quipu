import {
  getSharedHighlighter,
  registerCustomTheme,
  type DiffsHighlighter,
  type HighlighterTypes,
  type SupportedLanguages,
  type ThemeRegistration,
} from "@pierre/diffs";

/**
 * Always highlight with the Oniguruma WASM engine — the JS regex engine can
 * backtrack catastrophically and hang the tokenizing thread. The shared
 * highlighter is a first-caller-wins singleton, so every creation site must
 * pass this value.
 */
const PREFERRED_HIGHLIGHTER: HighlighterTypes = "shiki-wasm";

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();
const registeredThemes = new Set<string>();

/**
 * The shared highlighter loaded with one language and one theme. The source
 * view registers its own theme (pierre plus the syntax table,
 * `buildSourceViewTheme`) under a name that encodes its table, so each table
 * is registered once and cached.
 */
export function getSyntaxHighlighterPromise(
  language: string,
  theme: { readonly name: string },
): Promise<DiffsHighlighter> {
  const key = `${language}:${theme.name}`;
  const cached = highlighterPromiseCache.get(key);
  if (cached) return cached;

  if (!registeredThemes.has(theme.name)) {
    registeredThemes.add(theme.name);
    registerCustomTheme(theme.name, () => Promise.resolve(theme as unknown as ThemeRegistration));
  }
  const promise = getSharedHighlighter({
    themes: [theme.name],
    langs: [language as SupportedLanguages],
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
  }).catch((error: unknown) => {
    highlighterPromiseCache.delete(key);
    throw error;
  });
  highlighterPromiseCache.set(key, promise);
  return promise;
}
