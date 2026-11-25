import type { Box, Point } from "@quipu/canvas/geometry";
import type { MapLayout, MapLayoutNode } from "@quipu/canvas/mapLayout";
import type {
  Decoded,
  DecoderKind,
  Detection,
  HarEntriesPage,
  HarEntrySummary,
  NodeKind,
  NodeRef,
  NodeSummary,
  PathStep,
} from "@quipu/contracts/engine";

import { formatBytes } from "../lib/formatBytes.ts";
import { CHUNK_SIZE, type Entry, type TreeModel } from "./treeModel.ts";

/**
 * Node geometry in world units. Text is monospace, so a row's width is its
 * length times one character's width, which the view measures in the font it
 * draws with (`setCharWidth`); 7.2 is 12 px of a typical monospace font.
 */
export const MAP_ROW_HEIGHT = 20;
export const MAP_HEADER_HEIGHT = 28;
export const MAP_NODE_PADDING = 10;
/** The image a decoded base64 or SVG value shows under its rows, in world units. */
export const MAP_PREVIEW_HEIGHT = 120;
export const MAP_CHAR_WIDTH = 7.2;
const MAP_NODE_MIN_WIDTH = 180;
const MAP_NODE_MAX_WIDTH = 460;
/** Room a row needs besides its text: the padding on both sides and the chevron column. */
const ROW_CHROME = MAP_NODE_PADDING * 2 + 16;
/** A node lists this many rows, then a row that shows the next page of them. */
export const MAP_ROW_PAGE = 100;
const MORE_PREFIX = "more:";
/** A value keeps at least this many characters however long its key and badge are. */
const VALUE_MIN_CHARS = 12;
const KEY_MAX_CHARS = 40;
const VALUE_MAX_CHARS = 56;
/** A decoded binary value shows this many characters of its first bytes in hex. */
const HEX_MAX_CHARS = 47;
/** A group listing more than this many hosts, pages or requests lists ranges of this size instead, as arrays do. */
const GROUP_ROW_LIMIT = CHUNK_SIZE;
/** "Expand all" opens this many more containers per call (the tree's limit is on rows). */
const MAP_EXPAND_ALL_LIMIT = 5000;
/** The HAR grouping asks for entries in pages of this size. */
const HAR_PAGE = 1024;
/** Tree changes within this window rebuild the map once (an expand-all loads thousands of containers). */
const REBUILD_DELAY_MS = 40;

/** `line`: one line of a decoded text value (a GraphQL document), which has no node behind it. */
export type MapRowKind = NodeKind | "chunk" | "group" | "pending" | "line" | "more";

export interface MapRow {
  readonly key: string;
  readonly value: string;
  readonly kind: MapRowKind;
  /** The container the row sits in: literals and commas take their color from it. */
  readonly container: "object" | "array";
  /** The map node this row opens into when expanded, or null. */
  readonly childId: string | null;
  readonly expandable: boolean;
  readonly expanded: boolean;
  /** The tree id of the row's own node (a scalar or a collapsed container), for selection. */
  readonly treeId: string | null;
  /** What the value decodes as (`JWT · HS256`), when detection found something. */
  readonly badge: string | null;
  /** The row is part of a decoded value, not bytes of the file. */
  readonly decoded: boolean;
}

/** `decoded`: what a string decodes to (nested JSON, a JWT, a form, lines of text, an image). */
export type MapNodeKind = "object" | "array" | "chunk" | "capture" | "host" | "page" | "decoded";

/** What a decoded value that is not a tree shows: an image drawn from the engine's bytes. */
export interface MapPreview {
  readonly ref: NodeRef;
  readonly mime: string;
}

export interface MapNode {
  readonly id: string;
  readonly kind: MapNodeKind;
  readonly parentId: string | null;
  readonly title: string;
  readonly subtitle: string;
  readonly rows: ReadonlyArray<MapRow>;
  /** Offset from the parent's top of the row that names this node. */
  readonly anchor: number;
  /** Objects enclosing this node's keys, counting itself when it is one (1: the top-level object's keys). */
  readonly keyDepth: number;
  /** The tree node this map node stands for; null for a host or page group. */
  readonly treeId: string | null;
  readonly width: number;
  readonly height: number;
  /** 1-based depth in the map, and this node's place among its sibling nodes (ARIA). */
  readonly level: number;
  readonly position: number;
  readonly setSize: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  /** The node is a decoded value or lies inside one: its rows are not bytes of the file. */
  readonly decoded: boolean;
  /** An image to draw under the rows, for a decoded image. */
  readonly preview: MapPreview | null;
}

export interface GroupingProgress {
  readonly loaded: number;
  readonly total: number | null;
}

export interface MapSnapshot {
  readonly version: number;
  /** Depth first, parents before children. */
  readonly nodes: ReadonlyArray<MapNode>;
  readonly byId: ReadonlyMap<string, MapNode>;
  readonly childrenOf: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Top-left of every node from the last committed layout; a node may be absent for one tick. */
  readonly positions: ReadonlyMap<string, Point>;
  readonly bounds: Box | null;
  /**
   * How far the HAR grouping has read `log.entries`, with `total` null until
   * the first page says how many there are; null for a JSON document.
   */
  readonly grouping: GroupingProgress | null;
  /**
   * The grouping as the committed layout (`positions`, `bounds`) saw it: a
   * frame meant for the settled capture waits for this, not for `grouping`,
   * which runs one layout ahead.
   */
  readonly laidOutGrouping: GroupingProgress | null;
  /** One character's width in world units: where the view puts a value after its key. */
  readonly charWidth: number;
  /** Where each tree node shows: a whole node, or one row of a node. */
  readonly locations: ReadonlyMap<string, MapLocation>;
  /** The row every tree node is listed on, open or closed: where an attachment falls back to. */
  readonly rowLocations: ReadonlyMap<string, MapLocation>;
}

/** Where a selected tree node shows on the map: a whole node, or one row of a node. */
export interface MapLocation {
  readonly nodeId: string;
  readonly rowIndex: number | null;
}

export interface MapLayoutRunner {
  readonly layout: (nodes: ReadonlyArray<MapLayoutNode>) => Promise<MapLayout>;
  readonly dispose?: () => void;
}

/** Makes a runner when the model starts; the worker lives only while the map is shown. */
export type MapLayoutRunnerFactory = () => MapLayoutRunner;

export interface MapSource {
  readonly harEntries: (documentId: number, from: number, count: number) => Promise<HarEntriesPage>;
  /** Decodes a value the tree gives no rows (an image, binary data) for its preview card. */
  readonly decode?: (ref: NodeRef, kind: DecoderKind) => Promise<Decoded>;
}

/** A preview card's decode: in flight, done, or failed with the engine's message. */
type PreviewDecode =
  | { readonly phase: "loading" }
  | { readonly phase: "done"; readonly decoded: Decoded }
  | { readonly phase: "failed"; readonly message: string };

interface HarPageGroup {
  readonly id: string;
  readonly hostId: string;
  readonly pageref: string | null;
  readonly title: string;
  readonly entries: HarEntrySummary[];
}

interface HarHostGroup {
  readonly id: string;
  readonly host: string;
  readonly pages: Map<string, HarPageGroup>;
  count: number;
}

const count = new Intl.NumberFormat("en-US");

const CAPTURE_ID = "har:capture";
const RANGE_PREFIX = "har:range:";
/** The range of a group's list that starts at `from`: `har:range:<from>:<group id>`. */
const rangeId = (ownerId: string, from: number) => `${RANGE_PREFIX}${from}:${ownerId}`;
function parseRangeId(id: string): { ownerId: string; from: number } | null {
  if (!id.startsWith(RANGE_PREFIX)) return null;
  const colon = id.indexOf(":", RANGE_PREFIX.length);
  if (colon < 0) return null;
  return { from: Number(id.slice(RANGE_PREFIX.length, colon)), ownerId: id.slice(colon + 1) };
}
const plural = (n: number, unit: string) => `${count.format(n)} ${unit}${n === 1 ? "" : "s"}`;

/** What a host, a page or the capture lists: its items as rows, and how to name them. */
interface GroupList {
  readonly size: number;
  readonly unit: string;
  readonly container: "object" | "array";
  readonly rows: (from: number, to: number) => MapRow[];
}
const hostId = (host: string) => `har:host:${host}`;
const pageId = (host: string, pageref: string | null) => `har:page:${host}|${pageref ?? ""}`;
const NO_HOST = "(no host)";
const NO_PAGE = "(no page)";

const nodeId = (ref: NodeRef) => `${ref.tapeId}.${ref.token}`;

const isContainerKind = (kind: NodeKind) => kind === "object" || kind === "array";

/**
 * Characters a monospace font draws two columns wide (CJK, Hangul, fullwidth
 * forms, emoji), and ones it draws with no width (variation selectors, the
 * zero-width joiner): a row is sized in columns, not in characters.
 */
const WIDE =
  /[\u1100-\u115F\u2600-\u27BF\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
const ZERO_WIDTH = /[\u200B-\u200D\uFE00-\uFE0F]/u;
const columnsOf = (character: string) =>
  ZERO_WIDTH.test(character) ? 0 : WIDE.test(character) ? 2 : 1;

/** How many monospace columns `text` takes on screen. */
export function textColumns(text: string): number {
  let columns = 0;
  for (const character of text) columns += columnsOf(character);
  return columns;
}

/** `text` cut to at most `max` columns, with an ellipsis when it was cut. */
function truncate(text: string, max: number): string {
  if (textColumns(text) <= max) return text;
  let kept = "";
  let columns = 0;
  for (const character of text) {
    const width = columnsOf(character);
    if (columns + width > max - 1) break;
    kept += character;
    columns += width;
  }
  return `${kept}…`;
}

function containerSummary(node: NodeSummary): string {
  const unit = node.kind === "object" ? "key" : "item";
  const symbol = node.kind === "object" ? "{}" : "[]";
  if (!node.settled) return `${symbol} …`;
  return `${symbol} ${count.format(node.childCount)} ${unit}${node.childCount === 1 ? "" : "s"}`;
}

function pathOf(url: string | null): string {
  if (url === null) return "";
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(url);
  return match ? match[1] || "/" : url;
}

/** Characters a row's badge takes after its value, with the gap and the badge's own padding. */
const badgeChars = (badge: string | null) => (badge === null ? 0 : textColumns(badge) + 3);

/** Node width from its longest row, within the limits; a preview adds its image's height. */
function sizeNode(
  title: string,
  subtitle: string,
  rows: ReadonlyArray<MapRow>,
  preview: MapPreview | null,
  charWidth: number,
) {
  let chars = textColumns(title) + 2 + textColumns(subtitle);
  for (const row of rows) {
    const length =
      textColumns(row.key) +
      (row.key && row.value ? 2 : 0) +
      textColumns(row.value) +
      badgeChars(row.badge);
    if (length > chars) chars = length;
  }
  const width = Math.min(
    MAP_NODE_MAX_WIDTH,
    Math.max(MAP_NODE_MIN_WIDTH, Math.ceil(chars * charWidth + ROW_CHROME)),
  );
  const height =
    MAP_HEADER_HEIGHT +
    rows.length * MAP_ROW_HEIGHT +
    (preview === null ? 0 : MAP_PREVIEW_HEIGHT + MAP_NODE_PADDING) +
    MAP_NODE_PADDING / 2;
  return { width, height };
}

const mapRow = (fields: Pick<MapRow, "key" | "value" | "kind"> & Partial<MapRow>): MapRow => ({
  container: "object",
  childId: null,
  expandable: false,
  expanded: false,
  treeId: null,
  badge: null,
  decoded: false,
  ...fields,
});

/**
 * The map's view of a document: the tree model's open containers as nodes with
 * their rows, a HAR capture grouped host → page → entry, deterministic node
 * sizes, and the layout the runner returns. Plain mutable state with a version,
 * read through `useSyncExternalStore`; a rebuild is coalesced per task so an
 * "expand all" of thousands of containers does not rebuild once per container.
 */
export class MapModel {
  private readonly tree: TreeModel;
  private readonly makeRunner: MapLayoutRunnerFactory;
  private runner: MapLayoutRunner | null = null;
  private readonly source: MapSource | null;
  private readonly documentId: number;
  private readonly format: "json" | "har";
  private readonly listeners = new Set<() => void>();
  private readonly expandedGroups = new Set<string>();
  /** One character's width in world units, measured by the view in the font it draws with. */
  private charWidth = MAP_CHAR_WIDTH;
  /** How many rows each node lists before its "show more" row, past the first page. */
  private readonly rowLimits = new Map<string, number>();
  /** Tree ids a reveal asked to see: a node lists rows far enough to show them. */
  private wanted: ReadonlySet<string> = new Set();
  /** Decodes of the preview cards opened so far, by the string's tree id. */
  private readonly previews = new Map<string, PreviewDecode>();
  private readonly rowCache = new Map<
    string,
    { entries: ReadonlyArray<Entry> | undefined; rows: ReadonlyArray<MapRow> }
  >();
  private har: {
    logId: string;
    entriesId: string | null;
    entriesTotal: number;
    loaded: number;
    hosts: Map<string, HarHostGroup>;
    pageTitles: Map<string, string>;
    pages: ReadonlyArray<{ id: string | null; title: string | null }>;
    entryIndex: Map<string, number>;
    /** The page group every entry is listed in, by the entry's tree id. */
    entryPage: Map<string, HarPageGroup>;
    /** Every host and page by its map id. */
    groups: Map<string, HarHostGroup | HarPageGroup>;
  } | null = null;
  private snapshot: MapSnapshot;
  private readonly rebuildDelayMs: number;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  /** While a bulk expansion runs, rebuilds wait for it: one map, not one per container loaded. */
  private suspended = 0;
  private layoutInFlight = false;
  private layoutDirty = false;
  /** The engine could not group this capture: it shows as the JSON it is. */
  private groupingFailed = false;
  /**
   * The grouping read every entry the engine had counted while it was still
   * indexing: it reads on once the tree says `log` is settled.
   */
  private groupingWaitsForIndex = false;
  /** The generation whose grouping is reading pages, so one runs at a time. */
  private groupingRunning: number | null = null;
  /** The grouping read its first page before the tree listed `log`, and starts again when it does. */
  private groupingWaitsForLog = false;
  /** Bumped by every start and stop: work from an earlier run stops at the next await. */
  private generation = 0;
  private unsubscribe: (() => void) | null = null;
  private matchFilter: ReadonlySet<string> | null = null;
  version = 0;

  constructor(
    tree: TreeModel,
    options: {
      readonly documentId: number;
      readonly format: "json" | "har";
      readonly layout: MapLayoutRunnerFactory;
      readonly source?: MapSource;
      /** How long tree changes coalesce before a rebuild; tests pass 0. */
      readonly rebuildDelayMs?: number;
    },
  ) {
    this.tree = tree;
    this.makeRunner = options.layout;
    this.rebuildDelayMs = options.rebuildDelayMs ?? REBUILD_DELAY_MS;
    this.source = options.source ?? null;
    this.documentId = options.documentId;
    this.format = options.format;
    this.snapshot = {
      version: 0,
      nodes: [],
      byId: new Map(),
      childrenOf: new Map(),
      positions: new Map(),
      bounds: null,
      grouping: null,
      laidOutGrouping: null,
      locations: new Map(),
      rowLocations: new Map(),
      charWidth: MAP_CHAR_WIDTH,
    };
  }

  /**
   * Follows the tree, lays out and (for a HAR) groups the capture. `stop`
   * undoes it; a stopped model can start again, which is what React's strict
   * effects do to a memoized instance.
   */
  start(): void {
    if (this.unsubscribe !== null) return;
    this.generation += 1;
    this.runner = this.makeRunner();
    this.layoutInFlight = false;
    this.layoutDirty = false;
    this.unsubscribe = this.tree.subscribe(() => {
      // The first page of entries can come back before the tree lists `log`: group once it does.
      if (this.groupingWaitsForLog && this.logId() !== null) {
        this.groupingWaitsForLog = false;
        void this.loadGrouping(this.generation);
      }
      if (this.groupingWaitsForIndex && this.logSettled()) {
        this.groupingWaitsForIndex = false;
        void this.loadGrouping(this.generation);
      }
      this.scheduleRebuild();
    });
    this.rebuild();
    // A grouping a stop cut short goes on from where it was.
    if (
      this.format === "har" &&
      this.source !== null &&
      (this.har === null || this.har.loaded < this.har.entriesTotal)
    ) {
      void this.loadGrouping(this.generation);
    }
  }

  stop(): void {
    if (this.unsubscribe === null) return;
    this.generation += 1;
    if (this.rebuildTimer !== null) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    this.unsubscribe();
    this.unsubscribe = null;
    this.runner?.dispose?.();
    this.runner = null;
  }

  private get active() {
    return this.unsubscribe !== null;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  /** Filters the map to matching nodes + ancestors, or `null` to restore all nodes and rows. */
  setMatchFilter(matchedIds: ReadonlySet<string> | null): void {
    this.matchFilter = matchedIds;
    if (this.active) this.rebuild();
  }

  getMatchFilter(): ReadonlySet<string> | null {
    return this.matchFilter;
  }

  /**
   * Where something attached to map node `id` (an arrow end, a note) is drawn:
   * the node itself while it shows; otherwise the row that names it in its
   * nearest shown ancestor, or that ancestor's card, and the map's root as a
   * last resort. Expanded again, the node is found again.
   */
  attachmentLocation(id: string): MapLocation | null {
    const snapshot = this.snapshot;
    for (let at: string | undefined = id, step = 0; at !== undefined && step < 10_000; step += 1) {
      if (snapshot.byId.has(at)) return { nodeId: at, rowIndex: null };
      const row = snapshot.rowLocations.get(at);
      if (row !== undefined) return row;
      at = this.groupParentOf(at) ?? this.tree.parentOf(at);
    }
    const root = snapshot.nodes[0];
    return root === undefined ? null : { nodeId: root.id, rowIndex: null };
  }

  /** The group a HAR host, page or range sits in; undefined for anything else. */
  private groupParentOf(id: string): string | undefined {
    if (this.har === null) return undefined;
    const range = parseRangeId(id);
    if (range !== null) return range.ownerId;
    const group = this.har.groups.get(id);
    if (group === undefined) return undefined;
    return "host" in group ? CAPTURE_ID : group.hostId;
  }

  /** Where a tree node shows on the map, or null when nothing drawn stands for it. */
  locate(treeId: string): MapLocation | null {
    return this.snapshot.locations.get(treeId) ?? null;
  }

  /**
   * The width of one character of the map's monospace font at 12 px, as the
   * view measured it: nodes are sized and rows truncated to it, so no text
   * runs past its node whatever the font.
   */
  setCharWidth(width: number): void {
    if (!(width > 0) || Math.abs(width - this.charWidth) < 0.01) return;
    this.charWidth = width;
    // Values are truncated to the room a row has: list them again.
    this.rowCache.clear();
    if (this.active) this.rebuild();
  }

  /** Characters of key, value and badge that fit in a row of the widest node. */
  private get rowMaxChars(): number {
    return Math.floor((MAP_NODE_MAX_WIDTH - ROW_CHROME) / this.charWidth);
  }

  /** The node's title and subtitle, shortened to fit the widest node. */
  private fitHeader(title: string, subtitle: string) {
    const room = this.rowMaxChars;
    const shownTitle = truncate(title, Math.max(8, room - 2 - Math.min(textColumns(subtitle), 16)));
    return {
      title: shownTitle,
      subtitle: truncate(subtitle, room - textColumns(shownTitle) - 2),
    };
  }

  /**
   * A node's rows up to its limit, then one row that lists the next page: a
   * 1,000-item range is 100 rows tall, not 1,000, so an expanded document
   * keeps a shape at a far zoom. A row a reveal asked for raises the limit.
   */
  private capRows(nodeId: string, rows: ReadonlyArray<MapRow>): ReadonlyArray<MapRow> {
    let limit = this.rowLimits.get(nodeId) ?? MAP_ROW_PAGE;
    if (rows.length <= limit) return rows;
    if (this.wanted.size > 0) {
      for (let index = rows.length - 1; index >= limit; index -= 1) {
        const id = rows[index]?.treeId ?? null;
        if (id !== null && this.wanted.has(id)) {
          limit = Math.ceil((index + 1) / MAP_ROW_PAGE) * MAP_ROW_PAGE;
          this.rowLimits.set(nodeId, limit);
          break;
        }
      }
      if (rows.length <= limit) return rows;
    }
    const hidden = rows.length - limit;
    const container = rows[0]?.container ?? "object";
    return [
      ...rows.slice(0, limit),
      mapRow({
        key: "",
        value: `… ${count.format(hidden)} more · show ${count.format(Math.min(MAP_ROW_PAGE, hidden))}`,
        kind: "more",
        container,
        childId: `${MORE_PREFIX}${nodeId}`,
        decoded: rows[0]?.decoded ?? false,
      }),
    ];
  }

  /**
   * The document nodes a map node stands for, for commands that act "in the
   * selection": a data node is its own tree node; a HAR host, page or range
   * stands for the requests listed under it.
   */
  treeIdsUnder(mapNodeId: string): ReadonlyArray<string> {
    const node = this.snapshot.byId.get(mapNodeId);
    if (node === undefined) return [];
    if (node.treeId !== null) return [node.treeId];
    const ids: string[] = [];
    this.walkGrouping(mapNodeId, { group: () => {}, entry: (treeId) => ids.push(treeId) });
    return ids;
  }

  /**
   * Visits what a grouping node of a capture (the capture, a host, a page, or a
   * range of one's list) holds: each host and page under it, with the size of
   * the list it shows, and each request listed under them.
   */
  private walkGrouping(
    mapNodeId: string,
    visit: {
      readonly group: (id: string, listSize: number) => void;
      readonly entry: (treeId: string) => void;
    },
  ) {
    const har = this.har;
    if (har === null) return;
    const walk = (ownerId: string, from: number, to: number) => {
      if (ownerId === CAPTURE_ID) {
        for (const host of [...har.hosts.values()].slice(from, to)) {
          visit.group(host.id, host.pages.size);
          walk(host.id, 0, Number.POSITIVE_INFINITY);
        }
        return;
      }
      const group = har.groups.get(ownerId);
      if (group === undefined) return;
      if ("host" in group) {
        for (const page of [...group.pages.values()].slice(from, to)) {
          visit.group(page.id, page.entries.length);
          walk(page.id, 0, Number.POSITIVE_INFINITY);
        }
        return;
      }
      for (const entry of group.entries.slice(from, to)) visit.entry(nodeId(entry.ref));
    };
    const range = parseRangeId(mapNodeId);
    if (range !== null) {
      walk(range.ownerId, range.from, range.from + GROUP_ROW_LIMIT);
      return;
    }
    if (mapNodeId === CAPTURE_ID) visit.group(CAPTURE_ID, har.hosts.size);
    walk(mapNodeId, 0, Number.POSITIVE_INFINITY);
  }

  /** Opens or closes a capture's host or page, and each range its long list splits into. */
  private setGroupExpanded(id: string, listSize: number, expanded: boolean) {
    const ids = [id];
    if (listSize > GROUP_ROW_LIMIT) {
      for (let from = 0; from < listSize; from += GROUP_ROW_LIMIT) ids.push(rangeId(id, from));
    }
    for (const each of ids) {
      if (expanded) this.expandedGroups.add(each);
      else this.expandedGroups.delete(each);
    }
  }

  /** Lists the next page of a node's rows (its "show more" row). */
  showMore(nodeId: string): void {
    const limit = this.rowLimits.get(nodeId) ?? MAP_ROW_PAGE;
    this.rowLimits.set(nodeId, limit + MAP_ROW_PAGE);
    this.scheduleRebuild();
  }

  /** Opens or closes the node a row points at; a "show more" row lists more rows. */
  toggleRow(nodeId: string, rowIndex: number): Promise<void> {
    const node = this.snapshot.byId.get(nodeId);
    const row = node?.rows[rowIndex];
    if (row?.kind === "more") {
      this.showMore(nodeId);
      return Promise.resolve();
    }
    if (!node || !row || !row.expandable) return Promise.resolve();
    return this.setRowExpanded(node, row, !row.expanded);
  }

  /**
   * Node-level expand: every container row of the node opens; collapse closes
   * them all. This is what Right and Left do with a node focused.
   */
  async setExpanded(nodeId: string, expanded: boolean): Promise<void> {
    const node = this.snapshot.byId.get(nodeId);
    if (!node) return;
    const rows = node.rows.filter((row) => row.expandable && row.expanded !== expanded);
    await Promise.all(rows.map((row) => this.setRowExpanded(node, row, expanded)));
  }

  /**
   * Opens what is under `nodeId` (the whole map when null): every host and
   * page of a capture, or the objects and arrays of the data up to the
   * per-call limit. Says what it did when there is more to it than the map
   * shows; null when everything opened is on the map.
   */
  async expandAll(nodeId: string | null): Promise<string | null> {
    const node = nodeId === null ? this.snapshot.nodes[0] : this.snapshot.byId.get(nodeId);
    if (node === undefined) return null;
    // The capture stands for `log` in the tree, but opens as the hosts it groups.
    if (this.har !== null && (node.id === CAPTURE_ID || node.treeId === null)) {
      this.walkGrouping(node.id, {
        group: (id, listSize) => this.setGroupExpanded(id, listSize, true),
        entry: () => {},
      });
      this.scheduleRebuild();
      return node.id === CAPTURE_ID
        ? "Opened every host and page. Open a request to see its data."
        : `Opened everything under ${node.title} down to its requests. Open a request to see its data.`;
    }
    if (node.treeId === null) return null;
    // Thousands of containers load in a row; rebuilding the map after each one
    // produces garbage by the gigabyte, so the map is rebuilt once when the
    // expansion is done.
    this.suspended += 1;
    let opened = 0;
    try {
      opened = await this.tree.expandDescendants(node.treeId, MAP_EXPAND_ALL_LIMIT);
    } finally {
      this.suspended -= 1;
      if (this.active) this.rebuild();
    }
    if (opened < MAP_EXPAND_ALL_LIMIT) return null;
    const shown = this.snapshot.nodes.length;
    const hidden = shown < opened ? ", the rest behind “more” rows" : "";
    return `Opened ${count.format(opened)} objects and arrays, the most it opens at once; ${count.format(shown)} nodes are on the map${hidden}. Run it again to open more.`;
  }

  /**
   * Closes everything open under `nodeId`, which stays open: the objects and
   * arrays of the data, or a capture's hosts and pages and the requests in them.
   */
  collapseUnder(nodeId: string): void {
    const node = this.snapshot.byId.get(nodeId);
    if (node === undefined) return;
    if (node.treeId !== null) this.tree.collapseDescendants(node.treeId);
    if (this.har === null || (node.id !== CAPTURE_ID && node.treeId !== null)) return;
    this.walkGrouping(node.id, {
      group: (id, listSize) => {
        if (id !== CAPTURE_ID) this.setGroupExpanded(id, listSize, false);
      },
      entry: (treeId) => {
        this.tree.collapseDescendants(treeId);
        void this.tree.setExpanded(treeId, false);
      },
    });
    this.scheduleRebuild();
  }

  /**
   * Opens the way to the node at the end of `path` (a search hit, another
   * view's pick): its containers in the tree and, in a grouped capture, the
   * host, page and ranges its entry is listed under.
   */
  async reveal(path: ReadonlyArray<PathStep>): Promise<void> {
    const har = this.har;
    const entry =
      har === null ? undefined : path.find((step) => har.entryPage.has(nodeId(step.node.ref)));
    if (har !== null && entry !== undefined) {
      const entryId = nodeId(entry.node.ref);
      const page = har.entryPage.get(entryId) as HarPageGroup;
      const host = har.groups.get(page.hostId) as HarHostGroup;
      const openRange = (ownerId: string, size: number, index: number) => {
        if (size > GROUP_ROW_LIMIT && index >= 0) {
          this.expandedGroups.add(rangeId(ownerId, index - (index % GROUP_ROW_LIMIT)));
        }
      };
      openRange(CAPTURE_ID, har.hosts.size, [...har.hosts.values()].indexOf(host));
      openRange(host.id, host.pages.size, [...host.pages.values()].indexOf(page));
      openRange(
        page.id,
        page.entries.length,
        page.entries.findIndex((item) => nodeId(item.ref) === entryId),
      );
      this.expandedGroups.add(host.id);
      this.expandedGroups.add(page.id);
      this.scheduleRebuild();
    }
    // The rows on the way to it are listed even past their node's first page.
    // A step inside a long array is listed in a range row: that row is wanted too.
    const wanted = new Set<string>();
    path.forEach((step, at) => {
      wanted.add(nodeId(step.node.ref));
      const parent = path[at - 1];
      if (parent !== undefined && step.index !== null) {
        wanted.add(`${nodeId(parent.node.ref)}@${step.index - (step.index % CHUNK_SIZE)}`);
      }
    });
    this.wanted = wanted;
    await this.tree.reveal(path);
    // The path may have been open already: list its rows again for the wanted one.
    this.scheduleRebuild();
  }

  collapseAll(): void {
    this.expandedGroups.clear();
    this.tree.collapseAll();
  }

  private async setRowExpanded(node: MapNode, row: MapRow, expanded: boolean) {
    if (row.treeId === null) {
      // A host, a page or a range of one: the map's own grouping, not a tree node.
      if (row.childId === null) return;
      if (expanded) this.expandedGroups.add(row.childId);
      else this.expandedGroups.delete(row.childId);
      this.scheduleRebuild();
      return;
    }
    if (expanded && this.har !== null && node.treeId === null) {
      // A grouped entry lives under log.entries in the tree: open the path to it first.
      await this.ensureEntryInTree(row.treeId);
    }
    // A value that decodes is opened or closed as the user's choice, which automatic decoding keeps.
    if (row.badge !== null) await this.tree.setDecoded(row.treeId, expanded);
    else await this.tree.setExpanded(row.treeId, expanded);
  }

  private async ensureEntryInTree(entryId: string) {
    if (this.har === null || this.har.entriesId === null) return;
    const index = this.har.entryIndex.get(entryId);
    if (index === undefined) return;
    await this.tree.setExpanded(this.har.logId, true);
    await this.tree.setExpanded(this.har.entriesId, true);
    if (this.har.entriesTotal > CHUNK_SIZE) {
      const from = Math.floor(index / CHUNK_SIZE) * CHUNK_SIZE;
      await this.tree.setExpanded(`${this.har.entriesId}@${from}`, true);
    }
  }

  /** Whether the index has finished `log`: until then the engine's entry count can grow. */
  private logSettled(): boolean {
    const logId = this.logId();
    return logId !== null && this.tree.summaryOf(logId)?.settled === true;
  }

  private async loadGrouping(generation: number) {
    if (this.source === null || this.groupingRunning === generation) return;
    this.groupingRunning = generation;
    try {
      await this.readGrouping(generation, this.source);
    } finally {
      if (this.groupingRunning === generation) this.groupingRunning = null;
    }
  }

  private async readGrouping(generation: number, source: MapSource) {
    let from = this.har?.loaded ?? 0;
    for (;;) {
      if (this.generation !== generation) return;
      // Read before the page: a count the index finished meanwhile is read again below.
      const settledBefore = this.logSettled();
      let page: HarEntriesPage;
      try {
        page = await source.harEntries(this.documentId, from, HAR_PAGE);
      } catch {
        // A capture the engine cannot group shows as a plain JSON map.
        this.groupingFailed = true;
        this.scheduleRebuild();
        return;
      }
      if (this.generation !== generation) return;
      if (page.entries === null) {
        this.groupingFailed = true;
        this.scheduleRebuild();
        return;
      }
      if (this.har === null) {
        const logId = this.logId();
        if (logId === null) {
          this.groupingWaitsForLog = true;
          return;
        }
        this.har = {
          logId,
          entriesId: nodeId(page.entries),
          entriesTotal: page.total,
          loaded: 0,
          hosts: new Map(),
          pageTitles: new Map(),
          pages: page.pages,
          entryIndex: new Map(),
          entryPage: new Map(),
          groups: new Map(),
        };
        for (const summary of page.pages) {
          if (summary.id !== null) this.har.pageTitles.set(summary.id, summary.title ?? summary.id);
        }
      }
      this.har.entriesTotal = page.total;
      for (const [offset, item] of page.items.entries()) {
        const host = item.host ?? NO_HOST;
        let group = this.har.hosts.get(host);
        if (!group) {
          group = { id: hostId(host), host, pages: new Map(), count: 0 };
          this.har.hosts.set(host, group);
          this.har.groups.set(group.id, group);
        }
        group.count += 1;
        const key = item.pageref ?? "";
        let pageGroup = group.pages.get(key);
        if (!pageGroup) {
          pageGroup = {
            id: pageId(host, item.pageref),
            hostId: group.id,
            pageref: item.pageref,
            title:
              item.pageref === null
                ? NO_PAGE
                : (this.har.pageTitles.get(item.pageref) ?? item.pageref),
            entries: [],
          };
          group.pages.set(key, pageGroup);
          this.har.groups.set(pageGroup.id, pageGroup);
        }
        pageGroup.entries.push(item);
        this.har.entryIndex.set(nodeId(item.ref), page.from + offset);
        this.har.entryPage.set(nodeId(item.ref), pageGroup);
      }
      this.har.loaded = page.from + page.items.length;
      this.scheduleRebuild();
      from = page.from + page.items.length;
      if (page.items.length === 0 || from >= page.total) {
        // Caught up with an index still counting: read on when it is done.
        if (settledBefore) return;
        if (this.logSettled()) continue;
        this.groupingWaitsForIndex = true;
        return;
      }
    }
  }

  /** The tree id of `log` when the root is an object with that member; else null. */
  private logId(): string | null {
    const root = this.tree.summaryOf(this.tree.rootId);
    if (root === undefined || root.kind !== "object") return null;
    for (const entry of this.tree.entriesOf(this.tree.rootId) ?? []) {
      if (entry.kind === "node" && this.tree.keyOf(entry.id) === "log") {
        const log = this.tree.summaryOf(entry.id);
        return log?.kind === "object" ? entry.id : null;
      }
    }
    return null;
  }

  private scheduleRebuild() {
    if (this.rebuildTimer !== null || !this.active || this.suspended > 0) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      if (this.active) this.rebuild();
    }, this.rebuildDelayMs);
  }

  private rebuild() {
    const nodes: MapNode[] = [];
    const byId = new Map<string, MapNode>();
    const childrenOf = new Map<string, string[]>();
    const locations = new Map<string, MapLocation>();
    const rowLocations = new Map<string, MapLocation>();
    const stack: Array<{
      id: string;
      parentId: string | null;
      anchor: number;
      level: number;
      position: number;
      setSize: number;
      keyDepth: number;
      build: () => { node: Omit<MapNode, "width" | "height" | "level" | "position" | "setSize"> };
    }> = [];
    const capture = this.har !== null && this.tree.summaryOf(this.har.logId) !== undefined;
    const rootId = this.tree.rootId;
    if (capture && this.har !== null) {
      const logId = this.har.logId;
      stack.push({
        id: CAPTURE_ID,
        parentId: null,
        anchor: 0,
        level: 1,
        position: 1,
        setSize: 1,
        keyDepth: 2,
        build: () => ({ node: this.captureNode(logId) }),
      });
    } else if (this.groupingPending()) {
      // A capture shows as one from its first frame: the raw `log` object never flashes by.
      stack.push({
        id: CAPTURE_ID,
        parentId: null,
        anchor: 0,
        level: 1,
        position: 1,
        setSize: 1,
        keyDepth: 2,
        build: () => ({
          node: {
            id: CAPTURE_ID,
            kind: "capture",
            parentId: null,
            title: "Capture",
            subtitle: "reading requests…",
            rows: [
              mapRow({ key: "", value: "Grouping requests by host and page…", kind: "pending" }),
            ],
            anchor: 0,
            keyDepth: 2,
            treeId: null,
            expandable: false,
            expanded: false,
            decoded: false,
            preview: null,
          },
        }),
      });
    } else {
      const root = this.tree.summaryOf(rootId);
      stack.push({
        id: rootId,
        parentId: null,
        anchor: 0,
        level: 1,
        position: 1,
        setSize: 1,
        keyDepth: root?.kind === "object" ? 1 : 0,
        build: () => ({
          node: this.dataNode(rootId, "root", null, 0, root?.kind === "object" ? 1 : 0),
        }),
      });
    }
    while (stack.length > 0) {
      const frame = stack.pop() as (typeof stack)[number];
      const { node: partial } = frame.build();
      const fitted = this.fitHeader(partial.title, partial.subtitle);
      const rows = this.capRows(frame.id, partial.rows);
      const { width, height } = sizeNode(
        fitted.title,
        fitted.subtitle,
        rows,
        partial.preview,
        this.charWidth,
      );
      const node: MapNode = {
        ...partial,
        ...fitted,
        rows,
        width,
        height,
        level: frame.level,
        position: frame.position,
        setSize: frame.setSize,
      };
      nodes.push(node);
      byId.set(node.id, node);
      if (node.treeId !== null) locations.set(node.treeId, { nodeId: node.id, rowIndex: null });
      node.rows.forEach((row, rowIndex) => {
        if (row.treeId !== null) rowLocations.set(row.treeId, { nodeId: node.id, rowIndex });
        if (row.treeId !== null && row.childId === null) {
          locations.set(row.treeId, { nodeId: node.id, rowIndex });
        }
      });
      const openRows = node.rows
        .map((row, rowIndex) => ({ row, rowIndex }))
        .filter(({ row }) => row.expanded && row.childId !== null);
      const childIds = openRows.map(({ row }) => row.childId as string);
      childrenOf.set(node.id, childIds);
      for (let i = openRows.length - 1; i >= 0; i--) {
        const { row, rowIndex } = openRows[i] as (typeof openRows)[number];
        const childId = row.childId as string;
        const anchor = MAP_HEADER_HEIGHT + rowIndex * MAP_ROW_HEIGHT;
        // An object's keys, and a decoded value's, sit one object deeper.
        const childDepth =
          frame.keyDepth + (row.kind === "object" || row.kind === "string" ? 1 : 0);
        stack.push({
          id: childId,
          parentId: node.id,
          anchor,
          level: frame.level + 1,
          position: i + 1,
          setSize: openRows.length,
          keyDepth: childDepth,
          build: () => ({
            node:
              row.treeId === null
                ? this.groupNode(childId, node.id, anchor)
                : this.dataNode(childId, row.key, node.id, anchor, childDepth),
          }),
        });
      }
    }
    const finalGraph =
      this.matchFilter === null
        ? { nodes, byId, childrenOf, locations, rowLocations }
        : filterMapGraph(nodes, this.matchFilter, (title, subtitle, filteredRows, preview) =>
            sizeNode(title, subtitle, filteredRows, preview, this.charWidth),
          );
    this.version += 1;
    this.snapshot = {
      ...this.snapshot,
      version: this.version,
      nodes: finalGraph.nodes,
      byId: finalGraph.byId,
      childrenOf: finalGraph.childrenOf,
      grouping:
        this.har !== null
          ? { loaded: this.har.loaded, total: this.har.entriesTotal }
          : this.groupingPending()
            ? { loaded: 0, total: null }
            : null,
      locations: finalGraph.locations,
      rowLocations: finalGraph.rowLocations,
      charWidth: this.charWidth,
    };
    this.emit();
    void this.runLayout();
  }

  /** A capture whose grouping has not read its first page yet: it shows as a capture already. */
  private groupingPending(): boolean {
    return (
      this.format === "har" && this.har === null && this.source !== null && !this.groupingFailed
    );
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private async runLayout() {
    const runner = this.runner;
    if (runner === null) return;
    if (this.layoutInFlight) {
      this.layoutDirty = true;
      return;
    }
    const generation = this.generation;
    this.layoutInFlight = true;
    const laidOut = this.snapshot;
    const input: MapLayoutNode[] = laidOut.nodes.map((node) => ({
      id: node.id,
      parentId: node.parentId,
      width: node.width,
      height: node.height,
      anchor: node.anchor,
    }));
    try {
      const layout = await runner.layout(input);
      if (this.generation !== generation) return;
      this.version += 1;
      this.snapshot = {
        ...this.snapshot,
        version: this.version,
        positions: layout.positions,
        bounds: layout.bounds,
        laidOutGrouping: laidOut.grouping,
      };
      this.emit();
    } finally {
      if (this.generation === generation) {
        this.layoutInFlight = false;
        if (this.layoutDirty) {
          this.layoutDirty = false;
          void this.runLayout();
        }
      }
    }
  }

  /** The tree's frame labels the cached rows were listed with. */
  private frameLabelsSeen = 0;

  private rowsOf(treeId: string, skip: ReadonlySet<string> | null): ReadonlyArray<MapRow> {
    if (this.tree.frameLabelsVersion !== this.frameLabelsSeen) {
      // Frame labels arrived since: rows listed without them are stale.
      this.frameLabelsSeen = this.tree.frameLabelsVersion;
      this.rowCache.clear();
    }
    const entries = this.tree.entriesOf(treeId);
    const cached = this.rowCache.get(treeId);
    if (cached && cached.entries === entries && skip === null) {
      // Entries unchanged: only the open state of a child row can differ.
      let stale = false;
      for (const row of cached.rows) {
        if (row.treeId === null) continue;
        // A detection arriving gives a string row its badge and its chevron.
        if (
          row.expanded !== (row.expandable && this.tree.isExpanded(row.treeId)) ||
          (row.kind === "string" &&
            row.badge !== (this.tree.detectionsOf(row.treeId)[0]?.label ?? null))
        ) {
          stale = true;
          break;
        }
      }
      if (!stale) return cached.rows;
    }
    const summary = this.tree.summaryOf(treeId);
    const decodedHere = summary !== undefined && !isContainerKind(summary.kind);
    // A decoded value lists its own children: their container is the decoded root.
    const containerKind =
      summary?.kind === "object" ||
      (decodedHere && entries?.some((entry) => entry.kind === "node" && entry.index < 0))
        ? "object"
        : "array";
    const decoded = decodedHere || this.tree.isInsideDecoded(treeId);
    if (entries === undefined) {
      // A value with rows is listed by the tree; one without (an image) gets a preview card.
      const structured = this.tree.detectionsOf(treeId).some((d) => d.structured);
      if (decodedHere && !structured) return this.previewRows(treeId, summary);
      return this.tree.isLoading(treeId)
        ? [mapRow({ key: "", value: "Loading…", kind: "pending", container: containerKind })]
        : [];
    }
    const rows: MapRow[] = [];
    for (const entry of entries) {
      if (entry.kind === "chunk") {
        rows.push(
          mapRow({
            key: `[${entry.from}…${entry.to}]`,
            value: `${count.format(entry.to - entry.from + 1)} items`,
            kind: "chunk",
            container: "array",
            childId: entry.id,
            expandable: true,
            expanded: this.tree.isExpanded(entry.id),
            treeId: entry.id,
            decoded,
          }),
        );
        continue;
      }
      if (entry.kind === "line") {
        // A decoded text value's line: it stands for the value it came from.
        rows.push(
          mapRow({
            key: String(entry.n),
            value: truncate(entry.text, this.rowMaxChars - String(entry.n).length - 2),
            kind: "line",
            container: "array",
            decoded,
          }),
        );
        continue;
      }
      if (skip?.has(entry.id)) continue;
      const node = this.tree.summaryOf(entry.id) as NodeSummary;
      const key = entry.index >= 0 ? String(entry.index) : (this.tree.keyOf(entry.id) ?? "");
      const detections = this.tree.detectionsOf(entry.id);
      // A container with children opens into its node; a string that decodes opens into its decoded value.
      const opens = (isContainerKind(node.kind) && node.childCount > 0) || detections.length > 0;
      const badge = detections[0]?.label ?? null;
      // The key gives way too, so a long key with a short value still fits the widest node.
      const shownKey = truncate(
        key,
        Math.max(
          8,
          Math.min(KEY_MAX_CHARS, this.rowMaxChars - 2 - VALUE_MIN_CHARS - badgeChars(badge)),
        ),
      );
      // A badge takes its room from the value, so the row stays inside the node.
      const valueRoom = Math.max(
        VALUE_MIN_CHARS,
        Math.min(VALUE_MAX_CHARS, this.rowMaxChars - textColumns(shownKey) - 2 - badgeChars(badge)),
      );
      rows.push(
        mapRow({
          key: shownKey,
          value: truncate(
            isContainerKind(node.kind)
              ? // A WebSocket frame reads as the tree shows it: direction, kind, size, a preview.
                (this.tree.frameLabelOf(entry.id) ?? containerSummary(node))
              : (this.tree.valueOf(entry.id) ?? ""),
            valueRoom,
          ),
          kind: node.kind,
          container: containerKind,
          childId: opens ? entry.id : null,
          expandable: opens,
          expanded: opens && this.tree.isExpanded(entry.id),
          treeId: entry.id,
          badge,
          decoded,
        }),
      );
    }
    if (skip === null) this.rowCache.set(treeId, { entries, rows });
    return rows;
  }

  /**
   * The rows of a decoded value the tree lists nothing for (an image, binary
   * data): what it is, and for binary data its first bytes. The decode is asked
   * of the engine once, when the card first shows.
   */
  private previewRows(treeId: string, summary: NodeSummary): ReadonlyArray<MapRow> {
    const detection = this.tree.detectionsOf(treeId)[0];
    if (detection === undefined) return [];
    const state = this.previews.get(treeId);
    if (state === undefined) {
      void this.loadPreview(treeId, summary.ref, detection);
      return [mapRow({ key: "", value: "Decoding…", kind: "pending", decoded: true })];
    }
    switch (state.phase) {
      case "loading":
        return [mapRow({ key: "", value: "Decoding…", kind: "pending", decoded: true })];
      case "failed":
        return [mapRow({ key: "", value: state.message, kind: "pending", decoded: true })];
      case "done": {
        const { decoded } = state;
        const facts = [
          mapRow({
            key: "type",
            value: decoded.mime ?? decoded.label,
            kind: "string",
            decoded: true,
          }),
          mapRow({ key: "size", value: formatBytes(decoded.bytes), kind: "number", decoded: true }),
        ];
        if (decoded.layers.length > 0) {
          facts.push(
            mapRow({
              key: "layers",
              value: decoded.layers.join(" → "),
              kind: "string",
              decoded: true,
            }),
          );
        }
        if (decoded.view._tag === "binary") {
          facts.push(
            mapRow({
              key: "hex",
              value: truncate(decoded.view.hex, HEX_MAX_CHARS),
              kind: "string",
              decoded: true,
            }),
          );
        }
        if (decoded.view._tag === "text") {
          for (const [n, text] of decoded.view.value.text
            .split("\n")
            .slice(0, CHUNK_SIZE)
            .entries()) {
            facts.push(
              mapRow({
                key: String(n + 1),
                value: truncate(text, this.rowMaxChars - String(n + 1).length - 2),
                kind: "line",
                container: "array",
                decoded: true,
              }),
            );
          }
        }
        return facts;
      }
    }
  }

  private async loadPreview(treeId: string, ref: NodeRef, detection: Detection) {
    const decode = this.source?.decode;
    if (decode === undefined) return;
    this.previews.set(treeId, { phase: "loading" });
    try {
      const decoded = await decode(ref, detection.kind);
      this.previews.set(treeId, { phase: "done", decoded });
    } catch (error) {
      this.previews.set(treeId, {
        phase: "failed",
        message: error instanceof Error ? error.message : "This value could not be decoded.",
      });
    }
    this.scheduleRebuild();
  }

  private dataNode(
    treeId: string,
    /** The key, index or range the parent's row showed for it. */
    title: string,
    parentId: string | null,
    anchor: number,
    keyDepth: number,
  ): Omit<MapNode, "width" | "height" | "level" | "position" | "setSize"> {
    const summary = this.tree.summaryOf(treeId);
    const chunk = summary === undefined ? this.tree.chunkOf(treeId) : undefined;
    const rows = this.rowsOf(treeId, null);
    let subtitle: string;
    let kind: MapNodeKind;
    let preview: MapPreview | null = null;
    if (chunk !== undefined) {
      subtitle = `${count.format(chunk.to - chunk.from + 1)} items`;
      kind = "chunk";
    } else if (summary !== undefined && !isContainerKind(summary.kind)) {
      // A string opened into what it decodes to.
      const detections = this.tree.detectionsOf(treeId);
      // The decode's own label once it ran (`JSON · 3 keys`), detection's until then.
      const state = this.previews.get(treeId);
      subtitle =
        this.tree.decodedLabelOf(treeId) ??
        (state?.phase === "done" ? state.decoded.label : undefined) ??
        (detections.find((d) => d.structured) ?? detections[0])?.label ??
        "";
      kind = "decoded";
      if (state?.phase === "done" && state.decoded.view._tag === "image") {
        preview = { ref: summary.ref, mime: state.decoded.view.mime };
      }
    } else if (summary !== undefined) {
      subtitle = containerSummary(summary);
      kind = summary.kind === "object" ? "object" : "array";
    } else {
      subtitle = "";
      kind = "object";
    }
    return {
      id: treeId,
      kind,
      parentId,
      title,
      subtitle,
      rows,
      anchor,
      keyDepth,
      treeId,
      expandable: rows.some((row) => row.expandable),
      expanded: rows.some((row) => row.expanded),
      decoded: kind === "decoded" || this.tree.isInsideDecoded(treeId),
      preview,
    };
  }

  private captureNode(
    logId: string,
  ): Omit<MapNode, "width" | "height" | "level" | "position" | "setSize"> {
    const har = this.har!;
    // The capture's own fields (pages and entries stay closed: the hosts below open them).
    const skip = new Set<string>();
    for (const entry of this.tree.entriesOf(logId) ?? []) {
      if (entry.kind !== "node") continue;
      const key = this.tree.keyOf(entry.id);
      if ((key === "entries" || key === "pages") && har.entriesId !== null) skip.add(entry.id);
    }
    const dataRows = this.rowsOf(logId, skip).map((row): MapRow => ({
      ...row,
      expanded: row.expandable && row.expanded,
    }));
    const hosts = this.groupList(CAPTURE_ID) as GroupList;
    const hostRows = this.listRows(CAPTURE_ID, hosts);
    const rows = [...dataRows, ...hostRows];
    const loaded = har.loaded;
    const subtitle =
      loaded < har.entriesTotal
        ? `${count.format(loaded)} of ${count.format(har.entriesTotal)} requests grouped…`
        : `${plural(har.entriesTotal, "request")}, ${plural(hosts.size, "host")}`;
    return {
      id: CAPTURE_ID,
      kind: "capture",
      parentId: null,
      title: "Capture",
      subtitle,
      rows,
      anchor: 0,
      keyDepth: 2,
      treeId: logId,
      expandable: rows.some((row) => row.expandable),
      expanded: rows.some((row) => row.expanded),
      decoded: false,
      preview: null,
    };
  }

  /** The rows of a group's whole list: each item, or ranges of GROUP_ROW_LIMIT when it is longer. */
  private listRows(ownerId: string, list: GroupList): MapRow[] {
    if (list.size <= GROUP_ROW_LIMIT) return list.rows(0, list.size);
    const rows: MapRow[] = [];
    for (let from = 0; from < list.size; from += GROUP_ROW_LIMIT) {
      const to = Math.min(from + GROUP_ROW_LIMIT, list.size) - 1;
      const id = rangeId(ownerId, from);
      rows.push({
        key: `[${from}…${to}]`,
        value: plural(to - from + 1, list.unit),
        kind: "chunk",
        container: list.container,
        childId: id,
        expandable: true,
        expanded: this.expandedGroups.has(id),
        treeId: null,
        badge: null,
        decoded: false,
      });
    }
    return rows;
  }

  /** What the capture, a host or a page lists, or null for an id the grouping does not know. */
  private groupList(ownerId: string): GroupList | null {
    const har = this.har!;
    if (ownerId === CAPTURE_ID) {
      const hosts = [...har.hosts.values()];
      return {
        size: hosts.length,
        unit: "host",
        container: "object",
        rows: (from, to) =>
          hosts.slice(from, to).map((host) => ({
            key: truncate(host.host, KEY_MAX_CHARS),
            value: plural(host.count, "request"),
            kind: "group",
            container: "object",
            childId: host.id,
            expandable: true,
            expanded: this.expandedGroups.has(host.id),
            treeId: null,
            badge: null,
            decoded: false,
          })),
      };
    }
    const group = har.groups.get(ownerId);
    if (group === undefined) return null;
    if ("host" in group) {
      const pages = [...group.pages.values()];
      return {
        size: pages.length,
        unit: "page",
        container: "object",
        rows: (from, to) =>
          pages.slice(from, to).map((page) => ({
            key: truncate(page.title, KEY_MAX_CHARS),
            value: plural(page.entries.length, "request"),
            kind: "group",
            container: "object",
            childId: page.id,
            expandable: true,
            expanded: this.expandedGroups.has(page.id),
            treeId: null,
            badge: null,
            decoded: false,
          })),
      };
    }
    const entries = group.entries;
    return {
      size: entries.length,
      unit: "request",
      container: "array",
      rows: (from, to) =>
        entries.slice(from, to).map((entry) => {
          const treeId = nodeId(entry.ref);
          const known = this.tree.summaryOf(treeId) !== undefined;
          return {
            key: truncate(`${entry.method ?? ""} ${pathOf(entry.url)}`.trim(), KEY_MAX_CHARS),
            value: entry.status === null ? "" : String(entry.status),
            kind: "object",
            container: "array",
            childId: treeId,
            expandable: true,
            expanded: known && this.tree.isExpanded(treeId),
            treeId,
            badge: null,
            decoded: false,
          };
        }),
    };
  }

  /** A host, a page, or one range of a long list of hosts, pages or requests. */
  private groupNode(
    id: string,
    parentId: string,
    anchor: number,
  ): Omit<MapNode, "width" | "height" | "level" | "position" | "setSize"> {
    const base = { id, parentId, anchor, keyDepth: 2, treeId: null, decoded: false, preview: null };
    const range = parseRangeId(id);
    const list = this.groupList(range?.ownerId ?? id);
    if (list === null) {
      return {
        ...base,
        kind: "host",
        title: id,
        subtitle: "",
        rows: [],
        expandable: false,
        expanded: false,
      };
    }
    let rows: MapRow[];
    let kind: MapNodeKind;
    let title: string;
    let subtitle: string;
    if (range !== null) {
      const to = Math.min(range.from + GROUP_ROW_LIMIT, list.size);
      rows = list.rows(range.from, to);
      kind = "chunk";
      title = `[${range.from}…${to - 1}]`;
      subtitle = plural(to - range.from, list.unit);
    } else {
      rows = this.listRows(id, list);
      const group = this.har!.groups.get(id) as HarHostGroup | HarPageGroup;
      if ("host" in group) {
        kind = "host";
        title = truncate(group.host, KEY_MAX_CHARS);
        subtitle = `${plural(group.count, "request")}, ${plural(list.size, "page")}`;
      } else {
        kind = "page";
        title = truncate(group.title, KEY_MAX_CHARS);
        subtitle = plural(list.size, "request");
      }
    }
    return {
      ...base,
      kind,
      title,
      subtitle,
      rows,
      expandable: rows.length > 0,
      expanded: rows.some((row) => row.expanded),
    };
  }
}

function filterMapGraph(
  nodes: ReadonlyArray<MapNode>,
  matchedIds: ReadonlySet<string>,
  measure: (
    title: string,
    subtitle: string,
    rows: ReadonlyArray<MapRow>,
    preview: MapPreview | null,
  ) => { readonly width: number; readonly height: number },
): {
  readonly nodes: ReadonlyArray<MapNode>;
  readonly byId: ReadonlyMap<string, MapNode>;
  readonly childrenOf: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly locations: ReadonlyMap<string, MapLocation>;
  readonly rowLocations: ReadonlyMap<string, MapLocation>;
} {
  const keptIds = new Set<string>();
  const rowMatches = (row: MapRow) =>
    (row.treeId !== null && matchedIds.has(row.treeId)) ||
    (row.childId !== null && keptIds.has(row.childId));

  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    const selfHit =
      (node.treeId !== null && matchedIds.has(node.treeId)) || matchedIds.has(node.id);
    if (selfHit || node.rows.some(rowMatches)) keptIds.add(node.id);
  }

  const keptNodes: MapNode[] = [];
  const byId = new Map<string, MapNode>();
  const childrenOf = new Map<string, string[]>();
  const locations = new Map<string, MapLocation>();
  const rowLocations = new Map<string, MapLocation>();
  const siblingCounts = new Map<string | null, number>();

  for (const node of nodes) {
    if (!keptIds.has(node.id)) continue;
    siblingCounts.set(node.parentId, (siblingCounts.get(node.parentId) ?? 0) + 1);
  }
  const siblingSeen = new Map<string | null, number>();

  for (const node of nodes) {
    if (!keptIds.has(node.id)) continue;
    const filteredRows = node.rows.filter(rowMatches);
    const { width, height } = measure(node.title, node.subtitle, filteredRows, node.preview);
    let anchor = node.anchor;
    if (node.parentId !== null) {
      const parent = byId.get(node.parentId);
      if (parent !== undefined) {
        const idx = parent.rows.findIndex((r) => r.childId === node.id);
        if (idx >= 0) anchor = MAP_HEADER_HEIGHT + idx * MAP_ROW_HEIGHT;
      }
    }
    const position = (siblingSeen.get(node.parentId) ?? 0) + 1;
    siblingSeen.set(node.parentId, position);
    const updated: MapNode = {
      ...node,
      rows: filteredRows,
      width,
      height,
      anchor,
      position,
      setSize: siblingCounts.get(node.parentId) ?? 1,
    };
    keptNodes.push(updated);
    byId.set(updated.id, updated);
    if (updated.parentId !== null) {
      const list = childrenOf.get(updated.parentId) ?? [];
      list.push(updated.id);
      childrenOf.set(updated.parentId, list);
    }
    childrenOf.set(updated.id, []);
    if (updated.treeId !== null)
      locations.set(updated.treeId, { nodeId: updated.id, rowIndex: null });
    updated.rows.forEach((row, rowIndex) => {
      if (row.treeId !== null) rowLocations.set(row.treeId, { nodeId: updated.id, rowIndex });
      if (row.treeId !== null && row.childId === null) {
        locations.set(row.treeId, { nodeId: updated.id, rowIndex });
      }
    });
  }
  return { nodes: keptNodes, byId, childrenOf, locations, rowLocations };
}
