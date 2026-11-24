/**
 * Closing a window, or quitting, with unsaved edits asks first. Electron ignores
 * a page's `beforeunload` text, so the window's `close` is held while the page
 * is asked over IPC whether it may close: the page shows its own Save, Discard
 * or Cancel dialog and answers. A yes closes the window (and carries on with a
 * quit that was under way); a no keeps it open and cancels the quit. A page
 * that cannot answer (still loading, crashed) never blocks a close.
 */
import * as Electron from "electron";

import { CLOSE_REPLY_CHANNEL, CLOSE_REQUEST_CHANNEL } from "../ipc/channels.ts";

export type CloseState =
  | { readonly phase: "idle" }
  | { readonly phase: "asking"; readonly id: number }
  | { readonly phase: "confirmed" };

export type CloseEvent =
  | { readonly type: "close"; readonly pageCanAnswer: boolean; readonly nextId: number }
  | { readonly type: "answer"; readonly id: number; readonly close: boolean };

/**
 * - `allow`: let this close happen.
 * - `ask`: hold this close and ask the page (request `id`).
 * - `close`: the page said yes; close the window now.
 * - `stay`: the page said no; the window stays and a quit under way is cancelled.
 * - `ignore`: an answer to a question that is no longer open.
 */
export type CloseAction =
  | { readonly type: "allow" }
  | { readonly type: "ask"; readonly id: number }
  | { readonly type: "close" }
  | { readonly type: "stay" }
  | { readonly type: "ignore" };

/** What a window does with a close request or the page's answer. */
export function decideClose(
  state: CloseState,
  event: CloseEvent,
): { readonly state: CloseState; readonly action: CloseAction } {
  switch (event.type) {
    case "close":
      if (state.phase === "confirmed" || !event.pageCanAnswer) {
        return { state, action: { type: "allow" } };
      }
      // A second close while the question is open asks again; the page replaces its question.
      return {
        state: { phase: "asking", id: event.nextId },
        action: { type: "ask", id: event.nextId },
      };
    case "answer":
      if (state.phase !== "asking" || state.id !== event.id) {
        return { state, action: { type: "ignore" } };
      }
      return event.close
        ? { state: { phase: "confirmed" }, action: { type: "close" } }
        : { state: { phase: "idle" }, action: { type: "stay" } };
  }
}

/** Set by `before-quit`, so a window the page lets close carries the quit on. */
let quitting = false;
let nextId = 1;
const answerers = new Map<number, (id: number, close: boolean) => void>();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  Electron.app.on("before-quit", () => {
    quitting = true;
  });
  Electron.ipcMain.on(CLOSE_REPLY_CHANNEL, (event, reply: unknown) => {
    if (typeof reply !== "object" || reply === null) return;
    const { id, close } = reply as { id?: unknown; close?: unknown };
    if (typeof id !== "number" || typeof close !== "boolean") return;
    answerers.get(event.sender.id)?.(id, close);
  });
}

/** Holds the window's close until its page agrees. */
export function installCloseGuard(window: Electron.BrowserWindow): void {
  listen();
  const contents = window.webContents;
  const contentsId = contents.id;
  let state: CloseState = { phase: "idle" };

  const pageCanAnswer = () =>
    !contents.isDestroyed() && !contents.isCrashed() && !contents.isLoadingMainFrame();

  window.on("close", (event) => {
    const step = decideClose(state, { type: "close", pageCanAnswer: pageCanAnswer(), nextId });
    state = step.state;
    if (step.action.type !== "ask") return;
    nextId += 1;
    event.preventDefault();
    contents.send(CLOSE_REQUEST_CHANNEL, step.action.id);
  });

  answerers.set(contentsId, (id, close) => {
    const step = decideClose(state, { type: "answer", id, close });
    state = step.state;
    if (step.action.type === "close") {
      const resumeQuit = quitting;
      window.close();
      if (resumeQuit) Electron.app.quit();
    } else if (step.action.type === "stay") {
      quitting = false;
    }
  });
  window.on("closed", () => {
    answerers.delete(contentsId);
  });
}
