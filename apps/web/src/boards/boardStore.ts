/**
 * The boards the sidebar lists, newest opened first (`drawingStore.ts` says
 * where they are kept). Reads happen once, lazily; a created or renamed board
 * is published to every subscriber before its record has finished writing,
 * and the write failure is surfaced by the caller.
 */
import { useSyncExternalStore } from "react";

import { randomUUIDv4 } from "./browserCrypto";
import { deleteDrawing, listBoards, putBoard, removeBoard, type BoardRecord } from "./drawingStore";

export type { BoardRecord } from "./drawingStore";

const listeners = new Set<() => void>();
let boards: ReadonlyArray<BoardRecord> = [];
let hydrated = false;
let hydration: Promise<void> | null = null;

function publish(next: ReadonlyArray<BoardRecord>): void {
  boards = [...next].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  for (const listener of listeners) listener();
}

function hydrateBoards(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (hydration) return hydration;
  hydration = listBoards()
    .then((records) => {
      publish(records);
      hydrated = true;
    })
    .finally(() => {
      hydration = null;
    });
  return hydration;
}

function getBoardsSnapshot(): ReadonlyArray<BoardRecord> {
  return boards;
}

function subscribeBoards(listener: () => void): () => void {
  listeners.add(listener);
  void hydrateBoards().catch(() => undefined);
  return () => listeners.delete(listener);
}

export function useBoards(): ReadonlyArray<BoardRecord> {
  return useSyncExternalStore(subscribeBoards, getBoardsSnapshot, getBoardsSnapshot);
}

export function findBoard(id: string): BoardRecord | null {
  return boards.find((board) => board.id === id) ?? null;
}

function nextBoardName(existing: ReadonlyArray<BoardRecord>): string {
  const taken = new Set(existing.map((board) => board.name));
  for (let n = existing.length + 1; ; n += 1) {
    const name = `Board ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** Mints `board:<uuid>`, publishes it and writes its record. */
export async function createBoard(): Promise<BoardRecord> {
  await hydrateBoards();
  const now = Date.now();
  const record: BoardRecord = {
    schemaVersion: 1,
    id: `board:${randomUUIDv4()}`,
    kind: "board",
    name: nextBoardName(boards),
    size: 0,
    lastModified: now,
    lastOpenedAt: now,
  };
  publish([...boards, record]);
  await putBoard(record);
  return record;
}

/** Marks a board as the most recently opened one. */
export async function touchBoard(id: string): Promise<void> {
  await hydrateBoards();
  const board = findBoard(id);
  if (!board) return;
  const touched: BoardRecord = { ...board, lastOpenedAt: Date.now() };
  publish(boards.map((candidate) => (candidate.id === id ? touched : candidate)));
  await putBoard(touched);
}

/** Records the saved scene's size against the board. */
export async function recordBoardSize(id: string, size: number): Promise<void> {
  const board = findBoard(id);
  if (!board || board.size === size) return;
  const updated: BoardRecord = { ...board, size, lastModified: Date.now() };
  publish(boards.map((candidate) => (candidate.id === id ? updated : candidate)));
  await putBoard(updated);
}

/** Gives a board a new name; a blank or unchanged name leaves it as it was. */
export async function renameBoard(id: string, name: string): Promise<void> {
  await hydrateBoards();
  const board = findBoard(id);
  const trimmed = name.trim();
  if (!board || trimmed.length === 0 || trimmed === board.name) return;
  const renamed: BoardRecord = { ...board, name: trimmed };
  publish(boards.map((candidate) => (candidate.id === id ? renamed : candidate)));
  await putBoard(renamed);
}

/**
 * Deletes a board: its drawing and the images no other drawing uses go first,
 * then its record, so a failure part way leaves the board listed and the
 * delete can be tried again.
 */
export async function deleteBoard(id: string): Promise<void> {
  await hydrateBoards();
  await deleteDrawing(id);
  await removeBoard(id);
  publish(boards.filter((board) => board.id !== id));
}

const renameListeners = new Set<() => void>();
let renamingId: string | null = null;

function setRenaming(id: string | null): void {
  renamingId = id;
  for (const listener of renameListeners) listener();
}

/** Opens the board's row in the sidebar for renaming. */
export function requestBoardRename(id: string): void {
  setRenaming(id);
}

export function endBoardRename(): void {
  setRenaming(null);
}

/** The board whose sidebar row is being renamed, or null. */
export function useBoardRenaming(): string | null {
  return useSyncExternalStore(
    (listener) => {
      renameListeners.add(listener);
      return () => renameListeners.delete(listener);
    },
    () => renamingId,
    () => renamingId,
  );
}
