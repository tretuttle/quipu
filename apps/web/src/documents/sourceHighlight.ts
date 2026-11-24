import type { SourceRow } from "@quipu/contracts/engine";
import type { SyntaxTable } from "@quipu/shared/syntaxTable";
import type { ThemeAppearance } from "@quipu/shared/themePalettes";

import { buildSourceViewTheme } from "../syntaxSourceTheme";
import type { ColorSpan } from "./sourceWindow";

/** Files up to this size are highlighted by shiki; bigger ones are colored from the index. */
export const SHIKI_MAX_BYTES = 1024 * 1024;

/**
 * Shiki's tokens for a whole small document, by line. Rows of the source view
 * are looked up by their line number and the column they start at.
 */
export interface LineTokens {
  readonly colorsForRow: (row: SourceRow) => ReadonlyArray<ColorSpan>;
}

const LONE_CARRIAGE_RETURN = /\r(?!\n)/;

/**
 * Highlights `text` with shiki's `grammar` (JSON unless the file is another
 * format) and the source-view theme for `table`: pierre's theme with the table
 * applied to the JSON scopes, through the app's shared highlighter. Resolves to
 * null for a text shiki would break into different lines than the engine does
 * (a bare carriage return).
 */
export async function highlightSmallDocument(
  text: string,
  table: SyntaxTable,
  appearance: ThemeAppearance,
  grammar = "json",
): Promise<LineTokens | null> {
  if (LONE_CARRIAGE_RETURN.test(text)) return null;
  const theme = buildSourceViewTheme(appearance, table);
  // Loaded here, not at the top: a document too big for shiki never pays for it.
  const { getSyntaxHighlighterPromise } = await import("../lib/syntaxHighlighting");
  const highlighter = await getSyntaxHighlighterPromise(grammar, theme);
  const { tokens } = highlighter.codeToTokens(text, { lang: grammar, theme: theme.name });
  const lineStarts: number[] = [];
  for (const line of tokens) {
    const first = line[0];
    lineStarts.push(first === undefined ? -1 : first.offset);
  }
  const foreground = table.foreground;
  return {
    colorsForRow: (row) => {
      if (row.line === null || row.column === null) return [];
      const line = tokens[row.line - 1];
      const lineStart = lineStarts[row.line - 1];
      if (line === undefined || lineStart === undefined || lineStart < 0) return [];
      const spans: ColorSpan[] = [];
      for (const token of line) {
        const from = token.offset - lineStart - row.column;
        const to = from + token.content.length;
        if (to <= 0 || from >= row.text.length) continue;
        spans.push({
          from: Math.max(0, from),
          to: Math.min(row.text.length, to),
          color: (token.color ?? foreground).toLowerCase(),
        });
      }
      return spans;
    },
  };
}
