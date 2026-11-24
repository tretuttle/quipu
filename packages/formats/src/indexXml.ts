/**
 * Indexes XML onto the engine's tape through a pool of format workers: a lexical
 * pass chains each region's entry state from the one before it, then regions are
 * structured in parallel and adopted in file order (docs/internals/formats.md,
 * "XML"). Adoption is sequential and cheap: every token arrives with its level,
 * and the parent, sibling and child-count links come from three per-level arrays.
 */
import { KIND_OBJECT, NO_KEY, TapeBuilder, type TapeBuffers } from "@quipu/core/tape";
import { SegmentedTape } from "@quipu/core/segmentedTape";
import type { SourceSpec } from "@quipu/core/source";

import { defaultGeometry, type FormatJob, type FormatJobResult } from "./jobs.ts";
import type { FormatPool } from "./pool.ts";
import { XML_INITIAL_ENTRY, type XmlEntry } from "./xmlTape.ts";

export const DEFAULT_XML_TOKEN_BUDGET = 16_000_000;

export interface XmlIndex {
  readonly tape: SegmentedTape;
  /** The deepest level on the tape (document = 0, root element = 1). */
  readonly maxLevel: number;
  readonly regions: number;
}

export interface XmlIndexOptions {
  readonly regionBytes?: number;
  readonly tokenBudget?: number;
}

const LEVEL_LADDER = [1 << 20, 16, 8, 4, 3, 2, 1, 0];

let nextSourceId = 1 << 24;

type RegionOut = Extract<FormatJobResult, { closes: number[] }>;

export const indexXmlDocument = async (
  pool: FormatPool<FormatJob, FormatJobResult>,
  input: { readonly spec: SourceSpec; readonly size: number },
  options: XmlIndexOptions = {},
): Promise<XmlIndex> => {
  const geometry = defaultGeometry(options.regionBytes);
  const sourceId = nextSourceId++;
  const size = input.size;
  const budget = options.tokenBudget ?? DEFAULT_XML_TOKEN_BUDGET;
  await pool.broadcast({ type: "open", sourceId, spec: input.spec });
  try {
    const tape = new SegmentedTape();
    const documentBuilder = new TapeBuilder(1);
    documentBuilder.push(KIND_OBJECT, 0, -1, NO_KEY);
    documentBuilder.setEnd(0, size);
    tape.appendSegment(documentBuilder.detach(), (p) => p);
    if (size === 0) return { tape, maxLevel: 1 << 20, regions: 0 };
    const regions = Math.ceil(size / geometry.regionBytes);

    // Pass 1, chained: a region's lexical pass needs the exit state of the one before it.
    const entries: (XmlEntry | undefined)[] = Array.from({ length: regions });
    entries[0] = XML_INITIAL_ENTRY;
    const waiters: Array<(() => void) | undefined> = Array.from({ length: regions });
    const entryFor = (k: number) =>
      new Promise<XmlEntry>((resolve) => {
        const known = entries[k];
        if (known) resolve(known);
        else waiters[k] = () => resolve(entries[k] as XmlEntry);
      });

    const structured: (RegionOut | undefined)[] = Array.from({ length: regions });
    let maxLevel = LEVEL_LADDER[LEVEL_LADDER.length - 1] as number;
    let levelDecided!: () => void;
    const levelPromise = new Promise<void>((resolve) => {
      levelDecided = resolve;
    });

    const structureRegion = async (worker: number, k: number, entry: XmlEntry, level: number) =>
      (await pool.call(worker, {
        type: "xmlRegion",
        sourceId,
        region: k,
        geometry,
        entry,
        maxLevel: level,
      })) as RegionOut;

    const loop = async (worker: number) => {
      for (let k = worker; k < regions; k += pool.size) {
        const entry = await entryFor(k);
        const lexed = (await pool.call(worker, {
          type: "xmlLex",
          sourceId,
          region: k,
          geometry,
          entry,
        })) as { exit: XmlEntry };
        if (k + 1 < regions) {
          entries[k + 1] = lexed.exit;
          waiters[k + 1]?.();
          waiters[k + 1] = undefined;
        }
        if (k === 0) {
          // The eager level is decided on region 0, from its token density.
          const span = Math.min(size, geometry.regionBytes);
          let decided: RegionOut | undefined;
          for (const level of LEVEL_LADDER) {
            const result = await structureRegion(worker, 0, entry, level);
            const last = level === LEVEL_LADDER[LEVEL_LADDER.length - 1];
            if ((result.buffers.count / span) * size <= budget || last) {
              maxLevel = level;
              decided = result;
              break;
            }
          }
          structured[0] = decided;
          levelDecided();
        } else {
          await levelPromise;
          structured[k] = await structureRegion(worker, k, entry, maxLevel);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(pool.size, regions) }, (_, w) => loop(w)));

    // Adoption in file order.
    let openAt = new Int32Array(64).fill(-1);
    let lastChild = new Int32Array(64).fill(-1);
    openAt[0] = 0;
    for (let k = 0; k < regions; k++) {
      const region = structured[k] as RegionOut;
      const base = tape.count;
      const buffers: TapeBuffers = region.buffers;
      const n = buffers.count;
      const levels = new Int32Array(buffers.parent);
      const nexts = new Int32Array(buffers.next);
      const counts = new Uint32Array(buffers.childCount);
      const kinds = new Uint8Array(buffers.kind);
      // Elements that were open at entry and close here: ends, in token order.
      let ci = 0;
      const closes = region.closes;
      const inheritedCounts = new Map<number, number>();
      const applyCloses = (upTo: number) => {
        while (ci < closes.length && (closes[ci] as number) <= upTo) {
          const level = closes[ci + 1] as number;
          const end = closes[ci + 2] as number;
          const g = openAt[level] as number;
          if (g >= 0) tape.setEnd(g, end);
          openAt[level] = -1;
          lastChild[level] = -1;
          ci += 3;
        }
      };
      const deferredNext: number[] = [];
      // Children counted but not on the tape belong to the container open at entry at the cut level.
      if (region.cutInherited > 0 && maxLevel < openAt.length) {
        const holder = openAt[maxLevel] as number;
        if (holder >= 0) tape.setChildCount(holder, tape.childCount(holder) + region.cutInherited);
      }
      for (let i = 0; i < n; i++) {
        applyCloses(i);
        const level = levels[i] as number;
        if (level + 1 >= openAt.length) {
          const grown = new Int32Array(openAt.length * 2).fill(-1);
          grown.set(openAt);
          openAt = grown;
          const lc = new Int32Array(grown.length).fill(-1);
          lc.set(lastChild);
          lastChild = lc;
        }
        const parent = openAt[level - 1] as number;
        levels[i] = parent;
        const g = base + i;
        const prev = lastChild[level - 1] as number;
        if (prev >= 0) {
          if (prev >= base) nexts[prev - base] = i;
          else deferredNext.push(prev, g);
        }
        lastChild[level - 1] = g;
        if (parent >= base) counts[parent - base] = (counts[parent - base] as number) + 1;
        else inheritedCounts.set(parent, (inheritedCounts.get(parent) ?? 0) + 1);
        if (kinds[i] === KIND_OBJECT) {
          openAt[level] = g;
          lastChild[level] = -1;
        }
      }
      applyCloses(Number.POSITIVE_INFINITY);
      tape.appendSegment(buffers, (p) => p);
      for (let d = 0; d < deferredNext.length; d += 2) {
        tape.setNext(deferredNext[d] as number, deferredNext[d + 1] as number);
      }
      for (const [token, extra] of inheritedCounts) {
        tape.setChildCount(token, tape.childCount(token) + extra);
      }
    }
    return { tape, maxLevel, regions };
  } finally {
    await pool.broadcast({ type: "close", sourceId });
  }
};
