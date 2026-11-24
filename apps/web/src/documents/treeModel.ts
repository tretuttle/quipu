import type {
  Decoded,
  DecoderKind,
  Detection,
  FramesPage,
  NodeRef,
  NodeSummary,
  PathStep,
  RowsPage,
  TextValue,
} from "@quipu/contracts/engine";

/** What the tree asks of the engine; the app passes the typed client, tests pass a fake. */
export interface TreeSource {
  readonly node: (ref: NodeRef) => Promise<NodeSummary>;
  /** A page of children with their keys and previews, in one request. */
  readonly rows: (
    ref: NodeRef,
    from: number,
    count: number,
    previewBytes: number,
  ) => Promise<RowsPage>;
  readonly keyText: (ref: NodeRef) => Promise<string>;
  readonly text: (ref: NodeRef, limit: number) => Promise<TextValue>;
  /** What a string can be decoded as. */
  readonly detect: (ref: NodeRef) => Promise<ReadonlyArray<Detection>>;
  readonly decode: (ref: NodeRef, kind: DecoderKind) => Promise<Decoded>;
  /** Frames of a HAR `_webSocketMessages` array, read by their members. */
  readonly frames: (ref: NodeRef, from: number, count: number) => Promise<FramesPage>;
}

/**
 * Strings shorter than this (quotes included) cannot hold a decodable value: the
 * shortest is a 12-character base64 cursor such as `eyJwYWdlIjoyfQ`.
 */
const MIN_DECODABLE_BYTES = 14;
/** A decoded text value (a GraphQL document) shows this many lines as rows. */
const DECODED_LINE_LIMIT = 500;
const FRAMES_KEY = "_webSocketMessages";
const FRAMES_PAGE = 256;

/** Containers with more children than this show them as `[0…999]` ranges. */
export const CHUNK_SIZE = 1000;
/** A preview decodes at most this many bytes of a value. */
const PREVIEW_BYTES = 160;
/** Expand all stops adding rows past this many, so it cannot walk a 2 GiB document. */
const EXPAND_ALL_ROW_LIMIT = 5000;
/** A bulk decode looks at most this many loaded strings, and asks the engine about them in batches of this size. */
const DECODE_ALL_LIMIT = 2000;
const DECODE_BATCH = 32;

/** Automatic decoding: off, or on for every decoder kind or the kinds listed. */
export interface AutoDecode {
  readonly enabled: boolean;
  /** null: every kind. */
  readonly kinds: ReadonlyArray<DecoderKind> | null;
}

export type Entry =
  | { readonly kind: "node"; readonly id: string; readonly index: number }
  | {
      readonly kind: "chunk";
      readonly id: string;
      readonly parent: string;
      readonly from: number;
      readonly to: number;
    }
  /** One line of a decoded text value; it has no node behind it. */
  | { readonly kind: "line"; readonly id: string; readonly n: number; readonly text: string };

/** A row with the text the view draws for it, so rendering reads only this snapshot. */
export interface ViewRow extends TreeRow {
  /** The key, index or range the row stands for; empty while a key is still being decoded. */
  readonly name: string;
  /** The preview of a scalar, or the size of a container. */
  readonly value: string;
  /** What the value decodes as (`JWT · HS256`), when detection found something. */
  readonly badge: string | null;
  /** The row is a decoded value's child, not a member of the document. */
  readonly decoded: boolean;
}

const count = new Intl.NumberFormat("en-US");

export interface TreeRow {
  readonly id: string;
  readonly kind: "node" | "chunk" | "pending" | "text";
  readonly depth: number;
  /** How many objects enclose the row: which key color a member's key takes, as in the source view. */
  readonly objectDepth: number;
  /** What holds the row: an array element's index and an object member's key read differently. */
  readonly container: "object" | "array" | null;
  readonly parentId: string | null;
  /** 1-based place among the parent's visible entries, and how many there are (ARIA posinset and setsize). */
  readonly position: number;
  readonly setSize: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly node: NodeSummary | null;
  /** The element's index in its array, or null for an object member, a chunk, or the root. */
  readonly index: number | null;
  readonly from: number;
  readonly to: number;
  /** The text of a decoded line (kind `text`). */
  readonly text?: string;
}

/** What the Inspector shows: the selected row and where it sits. */
export interface Selection {
  readonly id: string;
  readonly node: NodeSummary;
  /** The key, index or `root`. */
  readonly name: string;
  /** Names from the root down to this row. */
  readonly path: ReadonlyArray<string>;
  readonly detections: ReadonlyArray<Detection>;
  /** The container holding this row, when it is one of its members. */
  readonly parent: { readonly ref: NodeRef; readonly key: string | null } | null;
  /** The index among its parent's children, for an array element. */
  readonly index: number | null;
  /** This row is a child of a decoded value rather than a member of the document. */
  readonly decoded: boolean;
}

/** A node's id in the tree and the map. */
export const nodeId = (ref: NodeRef) => `${ref.tapeId}.${ref.token}`;
const chunkId = (parent: string, from: number) => `${parent}@${from}`;

const isContainer = (node: NodeSummary) => node.kind === "object" || node.kind === "array";

/**
 * The outline's state: which containers are open, the nodes their children
 * loaded as, and the keys and previews decoded for the rows on screen. It is a
 * plain mutable object with a version, so a 100 k-row list is not copied on
 * every update; React reads it through `useSyncExternalStore`.
 */
export class TreeModel {
  readonly rootId: string;
  /** The engine document this outline lists. */
  readonly documentId: number;
  private readonly source: TreeSource;
  private readonly nodes = new Map<string, NodeSummary>();
  private readonly entries = new Map<string, ReadonlyArray<Entry>>();
  private readonly expandedIds = new Set<string>();
  /** Loads in flight by id, so a second request for the same list waits for the first. */
  private readonly loading = new Map<string, Promise<void>>();
  private readonly texts = new Map<string, string>();
  private readonly textsRequested = new Set<string>();
  private readonly detections = new Map<string, ReadonlyArray<Detection>>();
  private readonly detectionsRequested = new Set<string>();
  /** String row → the root of the child document its decoded value was indexed as. */
  private readonly decodedRoots = new Map<string, NodeSummary>();
  /**
   * Values opened or closed by hand or by a bulk command. Whether a value is
   * open is `expandedIds`, the one state every view reads; a choice here only
   * keeps automatic decoding from changing it back.
   */
  private readonly decodeChoices = new Map<string, boolean>();
  /** The label each decode gave its value, more precise than detection's (`JSON · 3 keys`). */
  private readonly decodedLabels = new Map<string, string>();
  private autoDecode: AutoDecode = { enabled: false, kinds: null };
  private readonly parents = new Map<string, string>();
  private readonly indexes = new Map<string, number>();
  private selectionCache: { version: number; selection: Selection | null } | null = null;
  private readonly frameLabels = new Map<string, string>();
  /** Bumped whenever frame labels arrive or are dropped: a view caching rows lists them again. */
  frameLabelsVersion = 0;
  private selectedId: string;
  private readonly listeners = new Set<() => void>();
  private cache: { version: number; rows: ReadonlyArray<TreeRow> } | null = null;
  private viewCache: { version: number; rows: ReadonlyArray<ViewRow> } | null = null;
  private failure: string | null = null;
  version = 0;

  constructor(source: TreeSource, root: NodeSummary) {
    this.source = source;
    this.documentId = root.ref.documentId;
    this.rootId = nodeId(root.ref);
    this.nodes.set(this.rootId, root);
    this.selectedId = this.rootId;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = () => this.version;

  /** The last load error, for the view to show. */
  get error() {
    return this.failure;
  }

  /**
   * While a reload re-lists every open container, the rows the views were given
   * stay published and listeners hear nothing: a 19 M-item array lists as
   * thousands of range rows, and rendering them once per container re-listed
   * held the page for most of a second.
   */
  private held: ReadonlyArray<ViewRow> | null = null;

  private changed() {
    this.version++;
    this.cache = null;
    this.viewCache = null;
    if (this.held !== null) return;
    for (const listener of this.listeners) listener();
  }

  /** Rows in display order: the root, then the children of every open container, depth first. */
  rows(): ReadonlyArray<TreeRow> {
    if (this.cache?.version === this.version) return this.cache.rows;
    const rows: TreeRow[] = [];
    const root = this.nodes.get(this.rootId) as NodeSummary;
    const stack: Array<{
      entry: Entry;
      depth: number;
      objectDepth: number;
      container: "object" | "array" | null;
      position: number;
      setSize: number;
      parent: string | null;
    }> = [
      {
        entry: { kind: "node", id: this.rootId, index: -1 },
        depth: 0,
        objectDepth: 0,
        container: null,
        position: 1,
        setSize: 1,
        parent: null,
      },
    ];
    while (stack.length > 0) {
      const { entry, depth, objectDepth, container, position, setSize, parent } =
        stack.pop() as (typeof stack)[number];
      const expanded = this.expandedIds.has(entry.id);
      if (entry.kind === "line") {
        rows.push({
          id: entry.id,
          kind: "text",
          depth,
          objectDepth,
          container,
          parentId: parent,
          position,
          setSize,
          expandable: false,
          expanded: false,
          node: null,
          index: entry.n,
          from: 0,
          to: 0,
          text: entry.text,
        });
        continue;
      }
      if (entry.kind === "chunk") {
        rows.push({
          id: entry.id,
          kind: "chunk",
          depth,
          objectDepth,
          container,
          parentId: parent,
          position,
          setSize,
          expandable: true,
          expanded,
          node: null,
          index: null,
          from: entry.from,
          to: entry.to,
        });
      } else {
        const node = (this.nodes.get(entry.id) ?? root) as NodeSummary;
        rows.push({
          id: entry.id,
          kind: "node",
          depth,
          objectDepth,
          container,
          parentId: parent,
          position,
          setSize,
          expandable: this.isExpandable(entry.id, node),
          expanded,
          node,
          index: entry.index >= 0 ? entry.index : null,
          from: 0,
          to: 0,
        });
      }
      if (!expanded) continue;
      const children = this.entries.get(entry.id);
      if (children === undefined) {
        if (this.loading.has(entry.id)) {
          rows.push({
            id: `${entry.id}…`,
            kind: "pending",
            depth: depth + 1,
            objectDepth,
            container: null,
            parentId: entry.id,
            position: 1,
            setSize: 1,
            expandable: false,
            expanded: false,
            node: null,
            index: null,
            from: 0,
            to: 0,
          });
        }
        continue;
      }
      // A chunk passes its array on; an object adds one to the depth its members' keys are colored at.
      const holder = entry.kind === "chunk" ? null : (this.nodes.get(entry.id) ?? root);
      const inner = holder === null ? container : holder.kind === "object" ? "object" : "array";
      const innerDepth = holder?.kind === "object" ? objectDepth + 1 : objectDepth;
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({
          entry: children[i] as Entry,
          depth: depth + 1,
          objectDepth: innerDepth,
          container: inner,
          position: i + 1,
          setSize: children.length,
          parent: entry.id,
        });
      }
    }
    this.cache = { version: this.version, rows };
    return rows;
  }

  /**
   * The rows with their text, as one immutable snapshot per version: what the
   * view subscribes to, so it re-renders when a key or preview arrives.
   */
  view = (): ReadonlyArray<ViewRow> => {
    if (this.held !== null) return this.held;
    if (this.viewCache?.version === this.version) return this.viewCache.rows;
    const rows = this.rows().map((row): ViewRow => {
      const decoded = row.parentId !== null && this.decodedRoots.has(row.parentId);
      if (row.kind === "chunk")
        return { ...row, name: `[${row.from}…${row.to}]`, value: "", badge: null, decoded };
      if (row.kind === "pending")
        return { ...row, name: "", value: "Loading…", badge: null, decoded: false };
      if (row.kind === "text") {
        return {
          ...row,
          name: String(row.index),
          value: row.text ?? "",
          badge: null,
          decoded: true,
        };
      }
      const node = row.node as NodeSummary;
      const name =
        row.index !== null
          ? String(row.index)
          : row.id === this.rootId
            ? "root"
            : (this.keyOf(row.id) ?? "");
      return {
        ...row,
        name,
        value:
          this.frameLabels.get(row.id) ??
          (isContainer(node) ? summaryOf(node) : (this.valueOf(row.id) ?? "")),
        badge: this.detections.get(row.id)?.[0]?.label ?? null,
        decoded,
      };
    });
    this.viewCache = { version: this.version, rows };
    return rows;
  };

  /** Decodes what a row shows: an object member's key, a scalar's preview. Lazy, once per row. */
  requestText(id: string): Promise<void> {
    // A row listed through `rows` has its text already; detection still runs once.
    if (this.textsRequested.has(id)) return this.requestDetection(id);
    const node = this.nodes.get(id);
    if (node === undefined) return Promise.resolve();
    const wantsKey = node.key !== null;
    const wantsPreview = !isContainer(node);
    if (!wantsKey && !wantsPreview) return Promise.resolve();
    this.textsRequested.add(id);
    return (async () => {
      try {
        if (wantsKey) this.texts.set(`${id}:key`, await this.source.keyText(node.ref));
        if (wantsPreview) {
          const value = await this.source.text(node.ref, PREVIEW_BYTES);
          this.texts.set(`${id}:value`, previewOf(node, value));
        }
        this.changed();
      } catch {
        // The row keeps its type label; a later refresh asks again.
        this.textsRequested.delete(id);
        return;
      }
      await this.requestDetection(id);
    })();
  }

  /** Asks once what a long enough string decodes as; the row gets a badge and a chevron. */
  private async requestDetection(id: string): Promise<void> {
    const node = this.nodes.get(id);
    if (node === undefined || node.kind !== "string") return;
    if (node.range.end - node.range.start < MIN_DECODABLE_BYTES) return;
    if (this.detectionsRequested.has(id)) return;
    this.detectionsRequested.add(id);
    try {
      const found = await this.source.detect(node.ref);
      if (found.length > 0) {
        this.detections.set(id, found);
        this.changed();
        this.decodeAutomatically(id);
      }
    } catch {
      // Detection is a hint; a value that cannot be inspected is shown as the string it is.
    }
  }

  /** The row a node is listed under (its container, or the string it was decoded from), once listed. */
  parentOf(id: string): string | undefined {
    return this.parents.get(id);
  }

  keyOf(id: string) {
    return this.texts.get(`${id}:key`);
  }

  /** What a decode said the value is (`JSON · 3 keys`), once the value was decoded. */
  decodedLabelOf(id: string): string | undefined {
    return this.decodedLabels.get(id);
  }

  /** A WebSocket frame's one-line summary (`↑ send · text · 88 B · {…}`), once its frames were read. */
  frameLabelOf(id: string): string | undefined {
    return this.frameLabels.get(id);
  }

  /** What a string row decodes as, once detection found something; empty otherwise. */
  detectionsOf(id: string): ReadonlyArray<Detection> {
    return this.detections.get(id) ?? [];
  }

  valueOf(id: string) {
    return this.texts.get(`${id}:value`);
  }

  isExpanded(id: string) {
    return this.expandedIds.has(id);
  }

  /** Opens or closes a row by hand; for a value that decodes, that is the user's choice for it. */
  toggle(id: string) {
    return this.detections.has(id)
      ? this.setDecoded(id, !this.expandedIds.has(id))
      : this.setExpanded(id, !this.expandedIds.has(id));
  }

  /** Opens or closes what a string decodes to as the user's choice, which automatic decoding keeps. */
  setDecoded(id: string, open: boolean): Promise<void> {
    this.decodeChoices.set(id, open);
    return this.setExpanded(id, open);
  }

  /**
   * Decodes values as they are detected (detection runs for rows on screen,
   * so this never walks the file), for every kind or the kinds listed. A value
   * opened or closed by hand stays as the user left it. Turning it on opens
   * the values already detected.
   */
  setAutoDecode(settings: AutoDecode) {
    this.autoDecode = settings;
    if (!settings.enabled) return;
    for (const id of this.detections.keys()) this.decodeAutomatically(id);
  }

  private decodeAutomatically(id: string) {
    const { enabled, kinds } = this.autoDecode;
    if (!enabled || this.decodeChoices.has(id) || this.expandedIds.has(id)) return;
    const detection = this.detections.get(id)?.[0];
    if (detection === undefined || (kinds !== null && !kinds.includes(detection.kind))) return;
    void this.setExpanded(id, true);
  }

  /**
   * Opens (or closes) every value that decodes among the loaded rows under
   * `id`, as the user's choice for each. Only rows already loaded are looked
   * at, at most {@link DECODE_ALL_LIMIT} strings, and the engine is asked in
   * small batches, so a 2 GiB document costs what is on screen. Returns how
   * many values it opened or closed.
   */
  async decodeAll(id: string, open: boolean): Promise<number> {
    const strings: string[] = [];
    const stack = [id];
    while (stack.length > 0 && strings.length < DECODE_ALL_LIMIT) {
      const current = stack.pop() as string;
      const node = this.nodes.get(current);
      if (node?.kind === "string") {
        strings.push(current);
        // A decoded value's own rows can hold more values that decode.
        if (!this.entries.has(current)) continue;
      }
      for (const entry of this.entries.get(current) ?? []) {
        if (entry.kind !== "line") stack.push(entry.id);
      }
    }
    let changed = 0;
    for (let from = 0; from < strings.length; from += DECODE_BATCH) {
      const batch = strings.slice(from, from + DECODE_BATCH);
      if (open) await Promise.all(batch.map((string) => this.requestDetection(string)));
      await Promise.all(
        batch.map((string) => {
          if (!this.detections.has(string) || this.expandedIds.has(string) === open) return null;
          changed += 1;
          return this.setDecoded(string, open);
        }),
      );
    }
    this.changed();
    return changed;
  }

  /** The row the Inspector shows. Moving the focus in the view moves the selection with it. */
  select(id: string) {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.changed();
  }

  get selectedRowId() {
    return this.selectedId;
  }

  /**
   * Opens or closes what the selected row decodes to (the `decode.toggle`
   * command). A value with no rows of its own (an image) opens too: the map
   * shows it as a preview card, and the Inspector shows it either way.
   */
  toggleSelectedDecode(): Promise<void> {
    const row = this.rows().find((r) => r.id === this.selectedId);
    if (row === undefined || (!row.expandable && !this.detections.has(row.id))) {
      return Promise.resolve();
    }
    return this.toggle(row.id);
  }

  /** The selected row's id, or the root's: where a bulk decode starts. */
  get decodeScope(): string {
    return this.nodes.has(this.selectedId) || this.chunkFor(this.selectedId) !== undefined
      ? this.selectedId
      : this.rootId;
  }

  /** The selected row and where it sits, one object per version so a view can subscribe to it. */
  selection = (): Selection | null => {
    if (this.selectionCache?.version === this.version) return this.selectionCache.selection;
    const computed = this.computeSelection();
    // The same selection stays the same object across unrelated updates (a key or
    // preview arriving elsewhere), so a view can depend on it without re-reading.
    const previous = this.selectionCache?.selection ?? null;
    const selection =
      previous !== null && computed !== null && sameSelection(previous, computed)
        ? previous
        : computed;
    this.selectionCache = { version: this.version, selection };
    return selection;
  };

  private computeSelection(): Selection | null {
    let id = this.selectedId;
    // A decoded text line stands for the value it came from.
    while (!this.nodes.has(id) && this.parents.has(id)) id = this.parents.get(id) as string;
    const node = this.nodes.get(id);
    if (node === undefined) return null;
    const path: string[] = [];
    for (let at: string | undefined = id; at !== undefined; at = this.parents.get(at)) {
      path.unshift(at === this.rootId ? "root" : (this.nameOf(at) ?? ""));
      if (at === this.rootId) break;
    }
    const parentId = this.parents.get(id);
    const parentNode = parentId === undefined ? undefined : this.containerOf(parentId);
    return {
      id,
      node,
      name: path[path.length - 1] ?? "",
      path,
      detections: this.detections.get(id) ?? [],
      parent:
        parentId !== undefined && parentNode !== undefined
          ? { ref: parentNode.ref, key: this.keyOf(parentId) ?? null }
          : null,
      index: this.indexes.get(id) ?? null,
      decoded: parentId !== undefined && this.decodedRoots.has(parentId),
    };
  }

  private nameOf(id: string) {
    const index = this.indexes.get(id);
    return index !== undefined ? String(index) : this.keyOf(id);
  }

  /** Resolves when the container's children have arrived. */
  setExpanded(id: string, expanded: boolean): Promise<void> {
    // Already open: its load may still be in flight (two rows opening one path at once).
    if (expanded === this.expandedIds.has(id)) return expanded ? this.load(id) : Promise.resolve();
    if (!expanded) {
      this.expandedIds.delete(id);
      this.changed();
      return Promise.resolve();
    }
    this.expandedIds.add(id);
    this.changed();
    return this.load(id);
  }

  collapseAll() {
    this.expandedIds.clear();
    this.expandedIds.add(this.rootId);
    this.changed();
  }

  /** Closes every container opened under `id`, which stays as it is. */
  collapseDescendants(id: string) {
    const stack = (this.entries.get(id) ?? []).map((entry) => entry.id);
    let closed = false;
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (this.expandedIds.delete(current)) closed = true;
      for (const child of this.entries.get(current) ?? []) stack.push(child.id);
    }
    if (closed) this.changed();
  }

  /** Opens every container breadth first until about {@link EXPAND_ALL_ROW_LIMIT} rows are showing. */
  async expandAll() {
    const queue = [this.rootId];
    let shown = this.rows().length;
    while (queue.length > 0 && shown < EXPAND_ALL_ROW_LIMIT) {
      const id = queue.shift() as string;
      const node = this.nodes.get(id);
      if (node !== undefined && !isContainer(node)) continue;
      if (!this.expandedIds.has(id)) {
        this.expandedIds.add(id);
        await this.load(id);
      }
      for (const child of this.entries.get(id) ?? []) {
        if (child.kind === "chunk") queue.push(child.id);
        else if (isContainer(this.nodes.get(child.id) as NodeSummary)) queue.push(child.id);
      }
      shown = this.rows().length;
    }
    this.changed();
  }

  /**
   * The row id of a node. The root's row keeps its id when an edit re-indexes the
   * whole document and the engine starts calling the root by a new ref.
   */
  rowIdOf(ref: NodeRef): string {
    const id = nodeId(ref);
    const root = this.nodes.get(this.rootId);
    return root !== undefined && nodeId(root.ref) === id ? this.rootId : id;
  }

  /** The engine's summary of a node, or undefined for a chunk or an unknown id. */
  summaryOf(id: string): NodeSummary | undefined {
    return this.nodes.get(id);
  }

  /** A container's or chunk's loaded entries, in order; undefined until loaded. */
  entriesOf(id: string): ReadonlyArray<Entry> | undefined {
    return this.entries.get(id);
  }

  /** The chunk range an id stands for, or undefined for a node. */
  chunkOf(id: string) {
    return this.chunkFor(id);
  }

  isLoading(id: string) {
    return this.loading.has(id);
  }

  /**
   * Opens containers under `id` depth first until `limit` more are open: the
   * map's "expand all", which keeps going from where the last call stopped
   * because open containers are skipped and not counted.
   */
  async expandDescendants(id: string, limit: number): Promise<number> {
    let opened = 0;
    const stack = [id];
    while (stack.length > 0 && opened < limit) {
      const current = stack.pop() as string;
      const node = this.nodes.get(current);
      const chunk = node === undefined ? this.chunkFor(current) : undefined;
      if (node === undefined && chunk === undefined) continue;
      if (node !== undefined && !isContainer(node)) continue;
      if (node !== undefined && node.childCount === 0) continue;
      if (!this.expandedIds.has(current)) {
        this.expandedIds.add(current);
        await this.load(current);
        opened += 1;
      }
      const children = this.entries.get(current) ?? [];
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i] as Entry;
        if (child.kind === "chunk" || isContainer(this.nodes.get(child.id) as NodeSummary)) {
          stack.push(child.id);
        }
      }
    }
    this.changed();
    return opened;
  }

  /** Work that fills in rows after they are listed (frame labels); `idle` waits for it. */
  private readonly background = new Set<Promise<void>>();

  private track(work: Promise<void>) {
    this.background.add(work);
    void work.finally(() => this.background.delete(work));
  }

  /** Resolves when no background work is pending. */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.all(this.background);
  }

  /** The row lies inside a decoded value, so its bytes are not the file's. */
  isInsideDecoded(id: string): boolean {
    for (let at = this.parents.get(id); at !== undefined; at = this.parents.get(at)) {
      if (this.decodedRoots.has(at)) return true;
    }
    return false;
  }

  /** The container whose children a row lists: a decoded value's child document, or the node itself. */
  private containerOf(id: string) {
    return this.decodedRoots.get(id) ?? this.nodes.get(id);
  }

  /** The decoding that gives a string row children of its own, when detection found one. */
  private structured(id: string) {
    return this.detections.get(id)?.find((d) => d.structured);
  }

  private isExpandable(id: string, node: NodeSummary) {
    return (isContainer(node) && node.childCount > 0) || this.structured(id) !== undefined;
  }

  /**
   * Decodes a string row on demand, never ahead of time: a value that indexes
   * as a document becomes the row's children; a text value becomes its lines.
   */
  private async decodeRow(id: string) {
    const detection = this.structured(id);
    const node = this.nodes.get(id);
    if (detection === undefined || node === undefined) return;
    try {
      const decoded = await this.source.decode(node.ref, detection.kind);
      this.decodedLabels.set(id, decoded.label);
      if (decoded.document) {
        this.decodedRoots.set(id, decoded.document.root);
      } else if (decoded.view._tag === "text") {
        const lines = decoded.view.value.text.split("\n").slice(0, DECODED_LINE_LIMIT);
        const entries: Entry[] = lines.map((text, n) => ({
          kind: "line",
          id: `${id}#${n + 1}`,
          n: n + 1,
          text,
        }));
        this.entries.set(id, entries);
      } else {
        this.entries.set(id, []);
      }
      this.failure = null;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : "This value could not be decoded.";
      // A value that does not decode is the string it is: no chevron, no badge.
      this.detections.delete(id);
      this.expandedIds.delete(id);
    } finally {
      this.changed();
    }
  }

  /**
   * Loads one container's children, or one chunk's. A container too big for one
   * list is split into ranges without asking the engine anything. A string that
   * decodes is decoded first and then lists its decoded value's children.
   */
  private load(id: string, force = false): Promise<void> {
    const inFlight = this.loading.get(id);
    if (inFlight !== undefined) return inFlight;
    if (!force && this.entries.has(id)) return Promise.resolve();
    const chunk = this.chunkFor(id);
    if (!chunk && !this.decodedRoots.has(id) && this.structured(id) !== undefined) {
      // A string that decodes: decode it first, then list the decoded value's children.
      const decoding = this.decodeRow(id)
        .finally(() => this.loading.delete(id))
        .then(() => (this.decodedRoots.has(id) ? this.load(id, force) : undefined));
      this.loading.set(id, decoding);
      this.changed();
      return decoding;
    }
    const node = chunk ? this.containerOf(chunk.parent) : this.containerOf(id);
    if (node === undefined || !isContainer(node)) return Promise.resolve();
    if (!chunk && node.childCount > CHUNK_SIZE) {
      const ranges: Entry[] = [];
      for (let from = 0; from < node.childCount; from += CHUNK_SIZE) {
        ranges.push({
          kind: "chunk",
          id: chunkId(id, from),
          parent: id,
          from,
          to: Math.min(from + CHUNK_SIZE, node.childCount) - 1,
        });
      }
      this.entries.set(id, ranges);
      this.changed();
      return Promise.resolve();
    }
    const from = chunk ? chunk.from : 0;
    const count = chunk ? chunk.to - chunk.from + 1 : node.childCount;
    const promise = this.fetch(id, chunk ? chunk.parent : id, node, from, count);
    this.loading.set(id, promise);
    this.changed();
    return promise;
  }

  private async fetch(id: string, owner: string, node: NodeSummary, from: number, count: number) {
    try {
      const page = await this.source.rows(
        node.ref,
        from,
        Math.max(1, Math.min(count, CHUNK_SIZE)),
        PREVIEW_BYTES,
      );
      const loaded: Entry[] = [];
      page.rows.forEach(({ node: child, key, preview }, offset) => {
        const childId = nodeId(child.ref);
        this.nodes.set(childId, child);
        this.parents.set(childId, owner);
        const index = child.key === null ? from + offset : -1;
        if (index >= 0) this.indexes.set(childId, index);
        loaded.push({ kind: "node", id: childId, index });
        // The row's text came with the page; nothing to ask for later.
        if (key !== null) this.texts.set(`${childId}:key`, key);
        if (preview !== null) this.texts.set(`${childId}:value`, previewOf(child, preview));
        if (key !== null || preview !== null) this.textsRequested.add(childId);
      });
      this.entries.set(id, loaded);
      this.failure = null;
      this.track(
        this.labelFrames(
          owner,
          node,
          from,
          page.rows.map((row) => row.node),
        ),
      );
    } catch (error) {
      this.failure = error instanceof Error ? error.message : "This node could not be opened.";
    } finally {
      this.loading.delete(id);
      this.changed();
    }
  }

  /**
   * Opens the containers on the way to the last node of `path` (as the engine
   * names the nodes that hold a byte offset), including the chunk of a big
   * array that holds it, and returns that node's row id. It stops early, and
   * returns the last row it could reach, when a listing does not hold the next
   * node.
   */
  async reveal(path: ReadonlyArray<PathStep>): Promise<string | null> {
    const root = path[0];
    if (root === undefined || this.rowIdOf(root.node.ref) !== this.rootId) return null;
    let parent = this.rootId;
    for (const step of path.slice(1)) {
      const id = nodeId(step.node.ref);
      await this.setExpanded(parent, true);
      // Resolves at once when the listing exists, and waits for one that is arriving.
      await this.load(parent);
      let list = this.entries.get(parent);
      if (list?.some((entry) => entry.kind === "chunk")) {
        const index = step.index;
        const chunk = list.find(
          (entry) =>
            entry.kind === "chunk" && index !== null && entry.from <= index && index <= entry.to,
        );
        if (chunk === undefined) return parent;
        await this.setExpanded(chunk.id, true);
        await this.load(chunk.id);
        list = this.entries.get(chunk.id);
      }
      if (!list?.some((entry) => entry.kind === "node" && entry.id === id)) return parent;
      parent = id;
    }
    return parent;
  }

  /** Labels the rows of a HAR `_webSocketMessages` array with each frame's direction, kind and size. */
  private async labelFrames(
    ownerId: string,
    container: NodeSummary,
    from: number,
    nodes: ReadonlyArray<NodeSummary>,
  ) {
    if (container.kind !== "array" || container.key === null || nodes.length === 0) return;
    try {
      const key = this.keyOf(ownerId) ?? (await this.source.keyText(container.ref));
      if (key !== FRAMES_KEY) return;
      for (let offset = 0; offset < nodes.length; offset += FRAMES_PAGE) {
        const page = await this.source.frames(
          container.ref,
          from + offset,
          Math.min(FRAMES_PAGE, nodes.length - offset),
        );
        for (const frame of page.frames) this.frameLabels.set(nodeId(frame.ref), frameLabel(frame));
        this.frameLabelsVersion += 1;
        this.changed();
      }
    } catch {
      // The rows keep their object summary; the Inspector asks for the frames again.
    }
  }

  private chunkFor(id: string) {
    for (const list of this.entries.values()) {
      for (const entry of list) if (entry.kind === "chunk" && entry.id === id) return entry;
    }
    return undefined;
  }

  /**
   * After the document's bytes changed: the root and every open container are
   * listed again, top down, and only what is still listed reopens. Nodes away
   * from an edit keep their ids (their refs do not move); the nodes an edit
   * re-indexed get new ones, so `renamed` maps an edited node's new id to the
   * id its row had, to keep it open. Returns once every open row is listed.
   */
  async reload(renamed: ReadonlyMap<string, string> = new Map()): Promise<void> {
    const root = await this.source.node((this.nodes.get(this.rootId) as NodeSummary).ref);
    const wasOpen = new Set(this.expandedIds);
    this.held = this.view();
    const opened = (id: string) => {
      if (wasOpen.has(id)) return true;
      // A chunk of a renamed container: `<id>@<from>`.
      const at = id.indexOf("@");
      const base = at < 0 ? id : id.slice(0, at);
      const before = renamed.get(base);
      return before !== undefined && wasOpen.has(before + id.slice(base.length));
    };
    this.nodes.clear();
    this.nodes.set(this.rootId, root);
    this.entries.clear();
    this.expandedIds.clear();
    this.parents.clear();
    this.indexes.clear();
    this.textsRequested.clear();
    this.frameLabels.clear();
    this.frameLabelsVersion += 1;
    this.selectionCache = null;
    const reopen = async (id: string): Promise<void> => {
      if (id !== this.rootId && !opened(id)) return;
      this.expandedIds.add(id);
      await this.load(id, true);
      for (const entry of this.entries.get(id) ?? []) {
        if (entry.kind !== "line") await reopen(entry.id);
      }
    };
    try {
      await reopen(this.rootId);
    } finally {
      this.held = null;
      this.changed();
    }
  }

  /**
   * Called when the index finished: containers that were still growing when
   * their children were listed are listed again, with the final counts.
   */
  async refresh() {
    const root = await this.source.node(this.nodes.get(this.rootId)!.ref);
    this.nodes.set(this.rootId, root);
    const open = [...this.expandedIds];
    // Parents first, so a re-listed container's children are the ones its open descendants refresh.
    for (const id of open) {
      if (id === this.rootId || this.nodes.has(id) || this.chunkFor(id) !== undefined) {
        this.entries.delete(id);
        await this.load(id, true);
      }
    }
    this.changed();
  }
}

const sameSelection = (a: Selection, b: Selection) =>
  a.id === b.id &&
  a.node === b.node &&
  a.name === b.name &&
  a.index === b.index &&
  a.decoded === b.decoded &&
  a.path.join("\u0000") === b.path.join("\u0000") &&
  a.parent?.key === b.parent?.key &&
  a.parent?.ref.token === b.parent?.ref.token &&
  a.parent?.ref.tapeId === b.parent?.ref.tapeId &&
  a.detections.length === b.detections.length &&
  a.detections.every(
    (d, i) => d.kind === b.detections[i]?.kind && d.label === b.detections[i]?.label,
  );

function frameLabel(frame: FramesPage["frames"][number]): string {
  const arrow = frame.direction === "send" ? "↑" : frame.direction === "receive" ? "↓" : "·";
  const direction = frame.direction === "unknown" ? "frame" : frame.direction;
  const kind =
    frame.opcode === 2
      ? "binary"
      : frame.opcode === 1 || frame.opcode === null
        ? "text"
        : `opcode ${frame.opcode}`;
  const preview = frame.preview.replace(/\s+/g, " ").trim();
  const mime = frame.opcode === 2 && frame.mime !== null ? ` ${frame.mime}` : "";
  return `${arrow} ${direction} · ${kind}${mime} · ${count.format(frame.size)} B${preview ? ` · ${preview}` : ""}`;
}

function summaryOf(node: NodeSummary): string {
  const unit = node.kind === "object" ? "key" : "item";
  const symbol = node.kind === "object" ? "{}" : "[]";
  if (!node.settled) return `${symbol} …`;
  return `${symbol} ${count.format(node.childCount)} ${unit}${node.childCount === 1 ? "" : "s"}`;
}

const previewOf = (node: NodeSummary, value: TextValue) => {
  const flat = value.text.replace(/\s+/g, " ");
  if (node.kind !== "string") return flat;
  return value.truncated ? `"${flat}…"` : `"${flat}"`;
};
