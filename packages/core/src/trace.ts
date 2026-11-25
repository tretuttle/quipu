import {
  MAX_TRACE_OCCURRENCES,
  type TraceEntryGroup,
  type TraceOccurrence,
  type TraceResult,
  type TraceSectionKind,
} from "@quipu/contracts/deepSearch";
import type { NodePath, NodeRef, NodeSummary } from "@quipu/contracts/engine";

import { QUOTE } from "./bytes.ts";
import {
  type DecodedLeafOccurrence,
  decodeUtf8Strict,
  type DeepSearchOutcome,
  extractDecodedValueOccurrences,
  formatJsonPointerSegment,
  inspectBase64Raw,
  unescapeJsonStringContent,
} from "./deepSearch.ts";
const TRACE_BATCH = 32;

export interface TraceEntryMeta {
  readonly method: string | null;
  readonly url: string | null;
  readonly status: number | null;
}

export interface TraceHostAccess {
  readonly format: "json" | "har" | "text";
  readonly runDeepSearch: (text: string) => Promise<DeepSearchOutcome>;
  readonly nodeAt: (offset: number) => Promise<NodePath>;
  readonly readLogicalRange: (start: number, end: number) => Promise<Uint8Array>;
  readonly keyText: (ref: NodeRef) => Promise<string>;
  readonly entryMeta?: (entryRef: NodeRef) => Promise<TraceEntryMeta>;
}

const isScalarKind = (kind: NodeSummary["kind"]) =>
  kind === "string" || kind === "number" || kind === "true" || kind === "false" || kind === "null";

const classifyHarSection = (entrySegments: ReadonlyArray<string>): TraceSectionKind => {
  const top = entrySegments[0];
  const sub = entrySegments[1];
  if (top === "request") {
    if (sub === "headers") return "request.headers";
    if (sub === "queryString") return "request.queryString";
    if (sub === "postData") return "request.postData";
    if (sub === "cookies") return "cookies";
  }
  if (top === "response") {
    if (sub === "headers") return "response.headers";
    if (sub === "content") return "response.content";
    if (sub === "cookies") return "cookies";
  }
  return "other";
};

const pathSegments = async (
  access: TraceHostAccess,
  path: NodePath["path"],
): Promise<ReadonlyArray<string>> => {
  const segments: string[] = [];
  for (let i = 1; i < path.length; i++) {
    const step = path[i]!;
    if (step.node.key !== null) segments.push(await access.keyText(step.node.ref));
    else if (step.index !== null) segments.push(String(step.index));
  }
  return segments;
};

const toPointer = (segments: ReadonlyArray<string>) =>
  segments.length === 0 ? "" : `/${segments.map((s) => formatJsonPointerSegment(s)).join("/")}`;

/**
 * Traces every exact whole-value occurrence of `value` across the document
 * (including inside nested/encoded payloads), reading through logical-read paths
 * so live edits are reflected immediately.
 */
export const traceExactValue = async (
  access: TraceHostAccess,
  value: string,
): Promise<TraceResult> => {
  const isHar = access.format === "har";
  if (value.length === 0) {
    return { value, total: 0, truncated: false, isHar, occurrences: [], harGroups: [] };
  }

  const outcome = await access.runDeepSearch(value);
  const candidateStarts: number[] = [];
  const seenOffsets = new Set<number>();

  const hitCount = outcome.hits.length / 2;
  for (let i = 0; i < hitCount; i++) {
    const s = outcome.hits[i * 2] as number;
    if (!seenOffsets.has(s)) {
      seenOffsets.add(s);
      candidateStarts.push(s);
    }
  }
  for (const ann of outcome.annotations) {
    if (!seenOffsets.has(ann.range.start)) {
      seenOffsets.add(ann.range.start);
      candidateStarts.push(ann.range.start);
    }
  }
  candidateStarts.sort((a, b) => a - b);

  const occurrences: TraceOccurrence[] = [];
  const seenKeys = new Set<string>();
  const entryRefs = new Map<number, NodeRef>();
  let truncated = outcome.count > hitCount;

  const processCandidate = async (offset: number): Promise<void> => {
    if (occurrences.length >= MAX_TRACE_OCCURRENCES) {
      truncated = true;
      return;
    }
    const found = await access.nodeAt(offset);
    if (found.path.length === 0) return;
    const leafStep = found.path[found.path.length - 1]!;
    const leaf = leafStep.node;
    if (!isScalarKind(leaf.kind)) return;
    // Ignore hits that landed inside an object's member key rather than its value.
    if (offset < leaf.span.start || offset >= leaf.span.end) return;

    const raw = await access.readLogicalRange(leaf.span.start, leaf.span.end);
    if (raw.length === 0) return;

    const segments = await pathSegments(access, found.path);
    let entryIndex: number | null = null;
    let section: TraceSectionKind | null = null;
    let entryPointer = toPointer(segments);

    if (
      isHar &&
      segments[0] === "log" &&
      segments[1] === "entries" &&
      found.path[3]?.index != null
    ) {
      entryIndex = found.path[3].index;
      entryRefs.set(entryIndex, found.path[3].node.ref);
      const entrySegs = segments.slice(3);
      section = classifyHarSection(entrySegs);
      entryPointer = toPointer(entrySegs);
    }

    const pushOcc = (occ: TraceOccurrence) => {
      const dedupKey = `${leaf.span.start}:${occ.pointer}`;
      if (seenKeys.has(dedupKey)) return;
      seenKeys.add(dedupKey);
      if (occurrences.length >= MAX_TRACE_OCCURRENCES) {
        truncated = true;
        return;
      }
      occurrences.push(occ);
    };

    if (leaf.kind !== "string") {
      const decodedRaw = decodeUtf8Strict(raw);
      if (decodedRaw !== null) {
        const text = decodedRaw.trim();
        if (text === value) {
          pushOcc({
            range: leaf.span,
            ref: leaf.ref,
            pointer: entryPointer,
            decodeChain: [],
            entryIndex,
            section,
            snippet: text,
          });
        }
      }
      return;
    }

    if (raw.length < 2 || raw[0] !== QUOTE || raw[raw.length - 1] !== QUOTE) return;
    const unescaped = unescapeJsonStringContent(raw.subarray(1, raw.length - 1));
    const str = decodeUtf8Strict(unescaped);
    if (str === null) return;

    if (str === value) {
      pushOcc({
        range: leaf.span,
        ref: leaf.ref,
        pointer: entryPointer,
        decodeChain: [],
        entryIndex,
        section,
        snippet: str.slice(0, 320),
      });
      return;
    }

    const hinted =
      isHar &&
      section === "response.content" &&
      entryPointer === "/response/content/text" &&
      inspectBase64Raw(unescaped, true).ok;

    const decoded: DecodedLeafOccurrence[] = [];
    await extractDecodedValueOccurrences(unescaped, true, value, "", [], 0, decoded, hinted);
    for (const match of decoded) {
      pushOcc({
        range: leaf.span,
        ref: leaf.ref,
        pointer: `${entryPointer}${match.pointer}`,
        decodeChain: match.decodeChain,
        entryIndex,
        section,
        snippet: match.snippet,
      });
    }
  };

  for (
    let i = 0;
    i < candidateStarts.length && occurrences.length < MAX_TRACE_OCCURRENCES;
    i += TRACE_BATCH
  ) {
    const batch = candidateStarts.slice(i, i + TRACE_BATCH);
    await Promise.all(batch.map((offset) => processCandidate(offset)));
  }

  occurrences.sort((a, b) => a.range.start - b.range.start || a.pointer.localeCompare(b.pointer));
  let harGroups: TraceEntryGroup[] = [];
  if (isHar) {
    const byEntry = new Map<number, TraceOccurrence[]>();
    for (const occ of occurrences) {
      if (occ.entryIndex === null) continue;
      let list = byEntry.get(occ.entryIndex);
      if (!list) {
        list = [];
        byEntry.set(occ.entryIndex, list);
      }
      list.push(occ);
    }
    const indices = [...byEntry.keys()].sort((a, b) => a - b);
    harGroups = await Promise.all(
      indices.map(async (entryIndex): Promise<TraceEntryGroup> => {
        const ref = entryRefs.get(entryIndex);
        const meta =
          ref && access.entryMeta
            ? await access.entryMeta(ref)
            : { method: null, url: null, status: null };
        return {
          entryIndex,
          method: meta.method,
          url: meta.url,
          status: meta.status,
          occurrences: byEntry.get(entryIndex) ?? [],
        };
      }),
    );
  }

  return {
    value,
    total: occurrences.length,
    truncated,
    isHar,
    occurrences,
    harGroups,
  };
};
