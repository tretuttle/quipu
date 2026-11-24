import { MAX_HIT_RANGES, type ByteRange } from "@quipu/contracts/engine";
import { useEffect, useMemo, useRef, useState } from "react";

import type { MapSnapshot } from "../../documents/mapModel";
import type { HitSet } from "../../documents/searchStore";
import { nodeBytes } from "../../documents/selectionStore";
import type { TreeModel } from "../../documents/treeModel";

/** A row holds a hit, holds none, or is not known yet (a range, a group, or an answer on its way). */
export type MapRowMark = "hit" | "dim" | null;

/** How a node shows during a search: lit, dimmed, or neither; and the same for each of its rows. */
export interface MapNodeMarks {
  readonly lit: boolean;
  readonly dim: boolean;
  readonly rows: ReadonlyArray<MapRowMark>;
}

/** The marks of every node on the map; a new identity whenever any of them changes. */
export type MapSearchMarks = ReadonlyMap<string, MapNodeMarks>;

interface Answers {
  readonly searchId: number;
  readonly lit: ReadonlySet<string>;
  readonly asked: ReadonlySet<string>;
}

const NONE: Answers = { searchId: -1, lit: new Set(), asked: new Set() };

/**
 * Which nodes and rows of the map hold a hit of the active search. Every tree
 * node the map shows (a node or a row) is asked about once per search, by its
 * bytes from key to the end of its value, so a collapsed container lights when
 * a hit is inside it and the rows leading to a hit light all the way down.
 * A range of an array or a HAR host, page or range has no bytes of its own:
 * it lights when the node it opened into holds a hit, and is never dimmed
 * while closed. Null while nothing is searched.
 */
export function useMapSearchMarks(
  hitSet: HitSet | null,
  snapshot: MapSnapshot,
  tree: TreeModel,
): MapSearchMarks | null {
  const [answers, setAnswers] = useState<Answers>(NONE);
  // Ids asked of the engine for the current search, answered or not, so each is asked once.
  const asking = useRef<{ searchId: number; ids: Set<string> }>({ searchId: -1, ids: new Set() });

  useEffect(() => {
    if (hitSet === null) return;
    const searchId = hitSet.searchId;
    if (asking.current.searchId !== searchId) asking.current = { searchId, ids: new Set() };
    const asked = asking.current.ids;
    const wanted: Array<readonly [string, ByteRange]> = [];
    const want = (treeId: string | null) => {
      // A decoded value's offsets are not the file's: search does not reach inside it.
      if (treeId === null || asked.has(treeId) || tree.isInsideDecoded(treeId)) return;
      const summary = tree.summaryOf(treeId);
      if (summary === undefined) return;
      asked.add(treeId);
      wanted.push([treeId, nodeBytes(summary)]);
    };
    for (const node of snapshot.nodes) {
      want(node.treeId);
      for (const row of node.rows) want(row.treeId);
    }
    if (wanted.length === 0) return;
    void (async () => {
      for (let from = 0; from < wanted.length; from += MAX_HIT_RANGES) {
        const slice = wanted.slice(from, from + MAX_HIT_RANGES);
        let lit: ReadonlyArray<boolean>;
        try {
          lit = await hitSet.isLit(slice.map(([, range]) => range));
        } catch {
          // Those rows stay unmarked; the next search asks again.
          return;
        }
        if (asking.current.searchId !== searchId) return;
        setAnswers((current) => {
          const base = current.searchId === searchId ? current : { ...NONE, searchId };
          const nextLit = new Set(base.lit);
          const nextAsked = new Set(base.asked);
          slice.forEach(([id], index) => {
            nextAsked.add(id);
            if (lit[index] === true) nextLit.add(id);
          });
          return { searchId, lit: nextLit, asked: nextAsked };
        });
      }
    })();
  }, [hitSet, snapshot, tree]);

  return useMemo(() => {
    if (hitSet === null) return null;
    const known = answers.searchId === hitSet.searchId ? answers : NONE;
    const marks = new Map<string, MapNodeMarks>();
    const markOf = (treeId: string | null): MapRowMark =>
      treeId === null || !known.asked.has(treeId) ? null : known.lit.has(treeId) ? "hit" : "dim";
    // Parents come before children in the snapshot: walk it backwards so a
    // range or group row can take the mark of the node it opened.
    for (let i = snapshot.nodes.length - 1; i >= 0; i -= 1) {
      const node = snapshot.nodes[i]!;
      const rows = node.rows.map((row): MapRowMark => {
        const own = markOf(row.treeId);
        if (own !== null) return own;
        const child = row.expanded && row.childId !== null ? marks.get(row.childId) : undefined;
        return child?.lit ? "hit" : child?.dim ? "dim" : null;
      });
      const own = markOf(node.treeId);
      const lit = own === "hit" || rows.includes("hit");
      const dim =
        !lit && (own === "dim" || (rows.length > 0 && rows.every((row) => row === "dim")));
      marks.set(node.id, { lit, dim, rows });
    }
    return marks;
  }, [hitSet, answers, snapshot]);
}
