import type { SearchMode } from "@quipu/contracts/engine";

import { syntaxVariableFor } from "../syntaxCssVariables";
import type { ViewRow } from "./treeModel.ts";

/**
 * What a tree row's key and value paint with: the syntax table's variables,
 * the same per-type colors the source view and the map use, so a theme
 * recolors all three alike. Nothing here is a color literal.
 */
export function treeValuePaint(row: ViewRow): string {
  if (row.kind === "text") return "var(--foreground)";
  if (row.kind !== "node" || row.node === null) return "var(--muted-foreground)";
  const container = row.container ?? "root";
  switch (row.node.kind) {
    case "string":
      return `var(${syntaxVariableFor("string", 0, container)})`;
    case "number":
      return `var(${syntaxVariableFor("number", 0, container)})`;
    case "true":
    case "false":
    case "null":
      return `var(${syntaxVariableFor("literal", 0, container)})`;
    // A container's summary (`{} 3 keys`) is the tree's own text, not a token of the file.
    default:
      return "var(--muted-foreground)";
  }
}

export function treeKeyPaint(row: ViewRow): string {
  if (row.kind === "chunk" || row.kind === "text") return "var(--muted-foreground)";
  if (row.parentId === null) return "var(--foreground)";
  // An array element's index is punctuation, not a key.
  if (row.container === "array") return `var(${syntaxVariableFor("bracket", 0, "array")})`;
  return `var(${syntaxVariableFor("key", row.objectDepth, "object")})`;
}

/** The query a finished search ran, as the bar sent it to the engine. */
export interface SearchedQuery {
  readonly text: string;
  readonly mode: SearchMode;
  readonly caseSensitive: boolean;
}

/** A run of a label: matched text or not. */
export interface LabelPart {
  readonly text: string;
  readonly match: boolean;
}

/** ASCII letters fold and nothing else, as the engine's literal search folds them. */
const foldAscii = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/**
 * Splits a row's label (its key or its value preview, at most a few hundred
 * characters on screen) into the parts the search matched. The engine has
 * already said the row holds a hit; this only finds where in the visible text
 * it sits, so the row can mark it the way the source view does.
 */
export function matchParts(label: string, query: SearchedQuery | null): ReadonlyArray<LabelPart> {
  if (query === null || query.text === "" || label === "") return [{ text: label, match: false }];
  const ranges: Array<[number, number]> = [];
  if (query.mode === "literal") {
    const haystack = query.caseSensitive ? label : foldAscii(label);
    const needle = query.caseSensitive ? query.text : foldAscii(query.text);
    for (
      let at = haystack.indexOf(needle);
      at >= 0;
      at = haystack.indexOf(needle, at + needle.length)
    ) {
      ranges.push([at, at + needle.length]);
    }
  } else {
    let pattern: RegExp;
    try {
      pattern = new RegExp(query.text, query.caseSensitive ? "gu" : "giu");
    } catch {
      return [{ text: label, match: false }];
    }
    for (const found of label.matchAll(pattern)) {
      if (found[0].length === 0) continue;
      ranges.push([found.index, found.index + found[0].length]);
    }
  }
  if (ranges.length === 0) return [{ text: label, match: false }];
  const parts: LabelPart[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: label.slice(at, start), match: false });
    parts.push({ text: label.slice(start, end), match: true });
    at = end;
  }
  if (at < label.length) parts.push({ text: label.slice(at), match: false });
  return parts;
}
