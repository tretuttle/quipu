/**
 * The edit journal: the crash log that lets a killed tab or worker come back
 * with its unsaved edits.
 *
 *   journals/<kind>/<id>/meta.json       lengths of the two logs, moved into place last
 *   journals/<kind>/<id>/append.bin      every byte an edit inserted, in commit order
 *   journals/<kind>/<id>/journal.ndjson  one record per committed edit, undo or redo
 *   journals/<kind>/<id>/spill-N.bin     a transform's output, referenced by an edit record
 *
 * A commit appends the bytes, appends the record line, then replaces meta with
 * the new lengths. Open truncates both logs to what meta says (or, when a file
 * is shorter than meta, lowers meta to the last complete line), so a crash
 * anywhere loses at most the edit in flight. The original file is never copied:
 * replay is the original File plus these bytes, through the same `edit` path
 * the user took. The undo record and the journal record are one shape, so the
 * replayed document lands on the same piece table the user had.
 */
import { parseJsonSlice } from "./boundedSlice.ts";
import type { JournalStore } from "./journalStore.ts";

const JOURNAL_ROOT = "journals";
const META = "meta.json";
const APPEND = "append.bin";
const LOG = "journal.ndjson";

export interface JournalMeta {
  readonly schemaVersion: 1;
  readonly documentId: string;
  readonly appendBytes: number;
  readonly journalBytes: number;
  readonly pieceGeneration: number;
}

/**
 * One committed step. `path` names the nested documents from the top: the
 * document-logical offset of each string token that was expanded, so replay
 * re-expands the same strings. `at` and `del` are document-logical in the
 * target document. Inserted bytes are `[off, off + len)` of `append.bin`, or of
 * the spill file `src` when a transform wrote them there.
 */
export type JournalRecord =
  | {
      readonly op: "edit";
      readonly path: ReadonlyArray<number>;
      readonly at: number;
      readonly del: number;
      readonly off: number;
      readonly len: number;
      readonly src?: string;
    }
  | { readonly op: "undo" }
  | { readonly op: "redo" };

const utf8 = new TextEncoder();
const NEWLINE = 0x0a;
/** meta.json is one small object; a log line is one record of offsets and lengths. */
const META_LIMIT_BYTES = 1 << 20;
const RECORD_LIMIT_BYTES = 1 << 20;
/** How much of a file one read takes when a journal is copied. */
const COPY_CHUNK_BYTES = 1 << 20;

/** `journals/<kind>/<rest>` for a `kind:rest` document id (a colon is not a Windows file name). */
const journalDirectory = (documentId: string) => {
  const colon = documentId.indexOf(":");
  const kind = colon < 0 ? "blob" : documentId.slice(0, colon);
  const rest = colon < 0 ? documentId : documentId.slice(colon + 1);
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${JOURNAL_ROOT}/${safe(kind)}/${safe(rest)}`;
};

const isMeta = (value: unknown): value is JournalMeta =>
  typeof value === "object" &&
  value !== null &&
  (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
  typeof (value as { appendBytes?: unknown }).appendBytes === "number" &&
  typeof (value as { journalBytes?: unknown }).journalBytes === "number";

const isRecord = (value: unknown): value is JournalRecord => {
  if (typeof value !== "object" || value === null) return false;
  const r = value as {
    op?: unknown;
    at?: unknown;
    del?: unknown;
    off?: unknown;
    len?: unknown;
    path?: unknown;
  };
  if (r.op === "undo" || r.op === "redo") return true;
  return (
    r.op === "edit" &&
    typeof r.at === "number" &&
    typeof r.del === "number" &&
    typeof r.off === "number" &&
    typeof r.len === "number" &&
    Array.isArray(r.path)
  );
};

export interface OpenedJournal {
  readonly journal: Journal;
  /** Committed records, in order, ready to replay. */
  readonly records: ReadonlyArray<JournalRecord>;
}

export class Journal {
  readonly store: JournalStore;
  readonly directory: string;
  readonly documentId: string;
  private appendBytes = 0;
  private journalBytes = 0;
  private spills = 0;
  /** Spill files the committed records name. */
  private readonly named = new Set<string>();

  private constructor(store: JournalStore, documentId: string) {
    this.store = store;
    this.documentId = documentId;
    this.directory = journalDirectory(documentId);
  }

  private path(name: string) {
    return `${this.directory}/${name}`;
  }

  /**
   * Opens (or creates) the journal of a document and recovers it: temp files
   * are removed, the logs are cut back to the committed lengths, and every
   * record that is complete is returned for replay.
   */
  static async open(store: JournalStore, documentId: string): Promise<OpenedJournal> {
    const journal = new Journal(store, documentId);
    await store.acquire?.(journal.directory);
    try {
      return { journal, records: await journal.recover() };
    } catch (error) {
      await journal.close();
      throw error;
    }
  }

  /** Cuts the logs back to their last whole commit and returns the committed records. */
  private async recover(): Promise<JournalRecord[]> {
    const store = this.store;
    const names = await store.list(this.directory);
    for (const name of names) if (name.endsWith(".tmp")) await store.remove(this.path(name));
    const metaBytes = names.includes(META)
      ? await store.read(this.path(META), 0, META_LIMIT_BYTES)
      : null;
    let meta: JournalMeta | null = null;
    if (metaBytes && metaBytes.byteLength > 0) {
      try {
        const parsed: unknown = parseJsonSlice(metaBytes, META_LIMIT_BYTES);
        if (isMeta(parsed)) meta = parsed;
      } catch {
        meta = null;
      }
    }
    const appendSize = Math.max(0, await store.size(this.path(APPEND)));
    const logSize = Math.max(0, await store.size(this.path(LOG)));
    let appendBytes = Math.min(meta?.appendBytes ?? 0, appendSize);
    let journalBytes = Math.min(meta?.journalBytes ?? 0, logSize);
    // The committed log: whole lines only, and only records whose bytes made it to append.bin.
    // Each record is parsed from its own line's bytes; the log is never one string.
    const log =
      journalBytes > 0 ? await store.read(this.path(LOG), 0, journalBytes) : new Uint8Array(0);
    const records: JournalRecord[] = [];
    let keep = 0;
    let line = 0;
    for (;;) {
      const end = log.indexOf(NEWLINE, line);
      if (end < 0) break;
      let record: JournalRecord | null = null;
      try {
        const parsed: unknown = parseJsonSlice(log.subarray(line, end), RECORD_LIMIT_BYTES);
        if (isRecord(parsed)) record = parsed;
      } catch {
        record = null;
      }
      if (!record) break;
      if (record.op === "edit") {
        if (record.src !== undefined) {
          const spillSize = await store.size(this.path(record.src));
          if (spillSize < record.off + record.len) break;
          this.spills = Math.max(this.spills, spillIndex(record.src) + 1);
        } else if (record.off + record.len > appendBytes) break;
      }
      records.push(record);
      keep = end + 1;
      line = keep;
    }
    journalBytes = keep;
    // Bytes past the last committed record's insert are an edit that never committed.
    let used = 0;
    for (const r of records)
      if (r.op === "edit" && r.src === undefined) used = Math.max(used, r.off + r.len);
    appendBytes = Math.min(appendBytes, used);
    this.appendBytes = appendBytes;
    this.journalBytes = journalBytes;
    if (appendSize !== appendBytes) await store.truncate(this.path(APPEND), appendBytes);
    if (logSize !== journalBytes) await store.truncate(this.path(LOG), journalBytes);
    // Spill files no committed record names are leftovers of a transform that did not commit.
    const referenced = new Set<string>();
    for (const r of records) if (r.op === "edit" && r.src !== undefined) referenced.add(r.src);
    for (const name of referenced) this.named.add(name);
    for (const name of names) {
      if (name.startsWith("spill-") && !referenced.has(name)) await store.remove(this.path(name));
    }
    if (!meta || meta.appendBytes !== appendBytes || meta.journalBytes !== journalBytes)
      await this.writeMeta();
    return records;
  }

  private writeMeta() {
    const meta: JournalMeta = {
      schemaVersion: 1,
      documentId: this.documentId,
      appendBytes: this.appendBytes,
      journalBytes: this.journalBytes,
      pieceGeneration: 1,
    };
    return this.store.replace(this.path(META), utf8.encode(`${JSON.stringify(meta)}\n`));
  }

  /** Where the next inserted bytes land in append.bin. */
  get nextAppendOffset() {
    return this.appendBytes;
  }

  /**
   * Commits one step, durable before it resolves: the inserted bytes (when the
   * record takes them from append.bin), then the record line, then meta.
   */
  async commit(record: JournalRecord, inserted: ReadonlyArray<Uint8Array> = []): Promise<void> {
    for (const bytes of inserted) {
      if (bytes.byteLength === 0) continue;
      await this.store.append(this.path(APPEND), bytes);
      this.appendBytes += bytes.byteLength;
    }
    const line = utf8.encode(`${JSON.stringify(record)}\n`);
    await this.store.append(this.path(LOG), line);
    this.journalBytes += line.byteLength;
    if (record.op === "edit" && record.src !== undefined) this.named.add(record.src);
    await this.writeMeta();
  }

  /**
   * This journal's committed records, their bytes and the spill files they name,
   * under another document id (whatever that id held is replaced). Meta is written
   * last, so a copy cut short opens as an empty journal.
   */
  async copyTo(documentId: string): Promise<Journal> {
    const target = new Journal(this.store, documentId);
    await this.store.acquire?.(target.directory);
    try {
      await this.copyInto(target);
    } catch (error) {
      await target.close();
      throw error;
    }
    return target;
  }

  private async copyInto(target: Journal) {
    await this.store.remove(target.directory);
    const copy = async (name: string, size: number) => {
      for (let at = 0; at < size; at += COPY_CHUNK_BYTES) {
        const end = Math.min(size, at + COPY_CHUNK_BYTES);
        await this.store.append(target.path(name), await this.store.read(this.path(name), at, end));
      }
    };
    await copy(APPEND, this.appendBytes);
    await copy(LOG, this.journalBytes);
    for (const name of this.named) await copy(name, await this.store.size(this.path(name)));
    target.appendBytes = this.appendBytes;
    target.journalBytes = this.journalBytes;
    target.spills = this.spills;
    for (const name of this.named) target.named.add(name);
    await target.writeMeta();
  }

  /** Bytes an edit record inserted. */
  inserted(record: Extract<JournalRecord, { op: "edit" }>): Promise<Uint8Array> {
    return this.store.read(this.path(record.src ?? APPEND), record.off, record.off + record.len);
  }

  /** A fresh spill file name; the caller streams into it with `appendSpill` and names it in an edit record. */
  newSpill() {
    return `spill-${this.spills++}.bin`;
  }

  appendSpill(name: string, bytes: Uint8Array) {
    return this.store.append(this.path(name), bytes);
  }

  spillPath(name: string) {
    return this.path(name);
  }

  /** After a successful save: the logs start over (spill files stay while their pieces are in use). */
  async reset(): Promise<void> {
    await this.store.truncate(this.path(APPEND), 0);
    await this.store.truncate(this.path(LOG), 0);
    this.appendBytes = 0;
    this.journalBytes = 0;
    this.named.clear();
    await this.writeMeta();
  }

  /** Releases the store's handles for this directory, and the journal for other contexts. */
  async close() {
    await this.store.close(this.directory);
    this.store.release?.(this.directory);
  }

  /**
   * Closes and deletes the journal: what a document with nothing unsaved leaves
   * behind when it closes. A saved file's next open has another key (its size
   * and time changed), so a journal kept here would only ever be an orphan.
   */
  async remove(): Promise<void> {
    await this.store.close(this.directory);
    for (const name of await this.store.list(this.directory)) {
      await this.store.remove(this.path(name));
    }
    await this.store.remove(this.directory).catch(() => {});
    this.store.release?.(this.directory);
  }
}

const spillIndex = (name: string) => Number(name.slice("spill-".length, -".bin".length)) || 0;
