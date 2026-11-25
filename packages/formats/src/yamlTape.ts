/**
 * YAML onto the tape: the whole text is parsed with the `yaml` package and every
 * node's range is mapped to UTF-8 byte offsets in the original file. The tape is
 * the resolved document: an alias is expanded in place (its children keep the
 * ranges of the anchor's source), and YAML 1.1 merge keys (`<<`) are expanded
 * with the mapping's own keys winning over merged keys, so a consumer sees what
 * `yaml.parse(..., { merge: true })` returns. Keys keep their own byte range in
 * `keyEnds`, parallel to the tape, because the tape stores only a key's start.
 */
import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  type Node as YamlNode,
  type Document,
  parseAllDocuments,
} from "yaml";
import {
  KIND_ARRAY,
  KIND_FALSE,
  KIND_NULL,
  KIND_NUMBER,
  KIND_OBJECT,
  KIND_STRING,
  KIND_TRUE,
  NO_KEY,
  TapeBuilder,
} from "@quipu/core/tape";

import { FormatSyntaxError } from "./errors.ts";
import { ByteOffsets, decodeLargeText, TEXT_FORMAT_LIMIT } from "./textDocument.ts";
import { FormatTooLargeError } from "./errors.ts";

export interface TextIndex {
  readonly tape: TapeBuilder;
  /** End (exclusive) of each token's key, parallel to the tape; 0 where there is no key. */
  readonly keyEnds: Uint32Array;
  /** Documents in the stream (YAML only; 1 otherwise). */
  readonly documents: number;
}

type Range = readonly [number, number, number];
type MapEntry = readonly [YamlNode | null | undefined, YamlNode | null | undefined];

interface Frame {
  readonly token: number;
  /** Remaining child entries: [keyNode | undefined, valueNode]. */
  readonly entries: Array<MapEntry>;
  next: number;
  last: number;
  count: number;
  /** Anchors on the path from the root, to refuse an alias to an ancestor. */
  readonly ancestors: ReadonlySet<YamlNode>;
}

const kindOf = (value: unknown) => {
  if (value === null || value === undefined) return KIND_NULL;
  if (typeof value === "boolean") return value ? KIND_TRUE : KIND_FALSE;
  if (typeof value === "number" || typeof value === "bigint") return KIND_NUMBER;
  return KIND_STRING;
};

const isMergeKey = (key: YamlNode | null | undefined): boolean => {
  if (key === null || key === undefined || !isScalar(key)) return false;
  if (typeof key.value === "symbol") return key.value.description === "<<";
  return (
    key.value === "<<" &&
    key.type === "PLAIN" &&
    (!key.tag || key.tag === "tag:yaml.org,2002:merge")
  );
};

const resolveMergeSources = (
  value: YamlNode | null | undefined,
  doc: Document.Parsed,
  ancestors: ReadonlySet<YamlNode>,
): ReadonlyArray<ReturnType<typeof isMap> extends never ? never : YamlNode> | null => {
  const resolveMap = (node: YamlNode | null | undefined) => {
    const target = node && isAlias(node) ? node.resolve(doc) : node;
    if (!target || !isMap(target) || ancestors.has(target as YamlNode)) return null;
    return target as YamlNode;
  };
  const direct = resolveMap(value);
  if (direct) return [direct];
  if (value && isSeq(value)) {
    const maps: YamlNode[] = [];
    for (const item of value.items) {
      const m = resolveMap(item as YamlNode);
      if (!m) return null;
      maps.push(m);
    }
    return maps;
  }
  return null;
};

const expandMapEntries = (
  items: ReadonlyArray<{ readonly key: unknown; readonly value: unknown }>,
  doc: Document.Parsed,
  ancestors: ReadonlySet<YamlNode>,
): MapEntry[] => {
  const seen = new Set<unknown>();
  for (const pair of items) {
    const key = pair.key as YamlNode | null | undefined;
    if (!isMergeKey(key) && key && isScalar(key)) seen.add(key.value);
  }
  const entries: MapEntry[] = [];
  for (const pair of items) {
    const key = pair.key as YamlNode | null | undefined;
    const value = pair.value as YamlNode | null | undefined;
    if (isMergeKey(key)) {
      const sources = resolveMergeSources(value, doc, ancestors);
      if (sources) {
        for (const source of sources) {
          if (!isMap(source)) continue;
          for (const merged of source.items) {
            const mk = merged.key as YamlNode | null | undefined;
            if (mk && isScalar(mk)) {
              if (seen.has(mk.value)) continue;
              seen.add(mk.value);
            }
            entries.push([mk, merged.value as YamlNode]);
          }
        }
        continue;
      }
    }
    entries.push([key, value]);
  }
  return entries;
};

/** Indexes YAML bytes; throws FormatSyntaxError on a parse error and FormatTooLargeError past the limit. */
export const indexYaml = (bytes: Uint8Array): TextIndex => {
  if (bytes.length > TEXT_FORMAT_LIMIT) {
    throw new FormatTooLargeError({
      format: "yaml",
      bytes: bytes.length,
      limit: TEXT_FORMAT_LIMIT,
    });
  }
  const text = decodeLargeText(bytes);
  const map = new ByteOffsets(text, bytes.length);
  const docs = parseAllDocuments(text, { prettyErrors: false, merge: true }) as Document.Parsed[];
  for (const doc of docs) {
    const error = doc.errors[0];
    if (error) {
      throw new FormatSyntaxError({
        format: "yaml",
        offset: map.at(error.pos[0]),
        detail: error.code,
      });
    }
  }
  const tape = new TapeBuilder(1024);
  let keyEnds = new Uint32Array(1024);
  const setKeyEnd = (token: number, end: number) => {
    if (token >= keyEnds.length) {
      const next = new Uint32Array(Math.max(token + 1, keyEnds.length * 2));
      next.set(keyEnds);
      keyEnds = next;
    }
    keyEnds[token] = end;
  };

  const rangeOf = (node: YamlNode | null | undefined, fallback: number): Range => {
    const r = node?.range;
    if (!r) return [fallback, fallback, fallback];
    return [r[0], r[1], r[2]];
  };

  /** Pushes the token for a node and, for a collection, returns its frame (the walk fills it in). */
  const open = (
    node: YamlNode | null | undefined,
    parent: number,
    keyStart: number,
    keyEnd: number,
    parentFrame: Frame | undefined,
    fallback: number,
  ): Frame | undefined => {
    let target: YamlNode | null | undefined = node;
    let aliasRange: Range | undefined;
    const ancestors = parentFrame?.ancestors ?? new Set<YamlNode>();
    if (target && isAlias(target)) {
      aliasRange = rangeOf(target, fallback);
      const resolved = target.resolve(docOf(target));
      if (!resolved || ancestors.has(resolved as YamlNode)) {
        // An alias to something that contains it, or to nothing: keep the alias text as a string.
        const t = tape.push(KIND_STRING, map.at(aliasRange[0]), parent, keyStart);
        tape.setEnd(t, map.at(aliasRange[1]));
        setKeyEnd(t, keyEnd);
        return undefined;
      }
      target = resolved as YamlNode;
    }
    const r = aliasRange ?? rangeOf(target, fallback);
    const start = map.at(r[0]);
    if (target && isMap(target)) {
      const t = tape.push(KIND_OBJECT, start, parent, keyStart);
      setKeyEnd(t, keyEnd);
      tape.setEnd(t, map.at(r[1]));
      const nextAncestors = new Set([...ancestors, target]);
      return {
        token: t,
        entries: expandMapEntries(target.items, currentDoc, nextAncestors),
        next: 0,
        last: -1,
        count: 0,
        ancestors: nextAncestors,
      };
    }
    if (target && isSeq(target)) {
      const t = tape.push(KIND_ARRAY, start, parent, keyStart);
      setKeyEnd(t, keyEnd);
      tape.setEnd(t, map.at(r[1]));
      return {
        token: t,
        entries: target.items.map((item) => [undefined, item as YamlNode] as const),
        next: 0,
        last: -1,
        count: 0,
        ancestors: new Set([...ancestors, target]),
      };
    }
    const value =
      target && isScalar(target)
        ? target.value
        : target === null || target === undefined
          ? null
          : String(target);
    const t = tape.push(kindOf(value), start, parent, keyStart);
    setKeyEnd(t, keyEnd);
    tape.setEnd(t, map.at(r[1]));
    return undefined;
  };

  let currentDoc = docs[0] as Document.Parsed;
  const docOf = (_node: YamlNode) => currentDoc;

  const walk = (
    rootNode: YamlNode | null | undefined,
    doc: Document.Parsed,
    parent: number,
    prevSibling: { last: number },
  ) => {
    // Aliases resolve inside their own document.
    currentDoc = doc;
    const rootFrame = open(rootNode, parent, NO_KEY, 0, undefined, 0);
    const token = tape.count - 1;
    if (parent >= 0) {
      if (prevSibling.last >= 0)
        tape.setNext(prevSibling.last, rootFrame ? rootFrame.token : token);
      prevSibling.last = rootFrame ? rootFrame.token : token;
    }
    if (!rootFrame) return;
    const stack: Frame[] = [rootFrame];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as Frame;
      if (frame.next >= frame.entries.length) {
        tape.setChildCount(frame.token, frame.count);
        stack.pop();
        continue;
      }
      const [keyNode, valueNode] = frame.entries[frame.next++] as MapEntry;
      let keyStart = NO_KEY;
      let keyEnd = 0;
      if (keyNode !== undefined) {
        const kr = rangeOf(keyNode, 0);
        keyStart = map.at(kr[0]);
        keyEnd = map.at(kr[1]);
      }
      const fallback =
        keyNode !== undefined
          ? rangeOf(keyNode, 0)[1]
          : rangeOf(frame.entries[frame.next - 1]?.[1], 0)[0];
      const child = open(valueNode, frame.token, keyStart, keyEnd, frame, fallback);
      const childToken = child ? child.token : tape.count - 1;
      if (frame.last >= 0) tape.setNext(frame.last, childToken);
      frame.last = childToken;
      frame.count++;
      if (child) stack.push(child);
    }
  };

  void isPair;
  const prev = { last: -1 };
  if (docs.length <= 1) {
    const doc = docs[0];
    walk(doc?.contents as YamlNode | null | undefined, doc as Document.Parsed, -1, prev);
    if (tape.count === 0) tape.push(KIND_NULL, 0, -1, NO_KEY);
  } else {
    const root = tape.push(KIND_ARRAY, 0, -1, NO_KEY);
    tape.setEnd(root, bytes.length);
    const siblings = { last: -1 };
    for (const doc of docs) walk(doc.contents as YamlNode | null, doc, root, siblings);
    tape.setChildCount(root, docs.length);
  }
  if (tape.count > 0 && tape.end(0) === 0) tape.setEnd(0, bytes.length);
  return { tape, keyEnds: keyEnds.slice(0, tape.count), documents: Math.max(1, docs.length) };
};
