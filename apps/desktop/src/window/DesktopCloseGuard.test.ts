import { describe, expect, it } from "vite-plus/test";

import { type CloseEvent, type CloseState, decideClose } from "./DesktopCloseGuard.ts";

/** Runs events through the decision from `idle`, returning every action taken. */
const run = (events: ReadonlyArray<CloseEvent>) => {
  let state: CloseState = { phase: "idle" };
  return events.map((event) => {
    const step = decideClose(state, event);
    state = step.state;
    return step.action.type;
  });
};

const close = (nextId: number, pageCanAnswer = true): CloseEvent => ({
  type: "close",
  pageCanAnswer,
  nextId,
});
const answer = (id: number, yes: boolean): CloseEvent => ({ type: "answer", id, close: yes });

describe("closing a window with a page that may have unsaved edits", () => {
  it("asks the page, and closes on yes: the close that follows goes through", () => {
    expect(run([close(1), answer(1, true), close(2)])).toEqual(["ask", "close", "allow"]);
  });

  it("stays on no, and asks again on the next close", () => {
    expect(run([close(1), answer(1, false), close(2), answer(2, true), close(3)])).toEqual([
      "ask",
      "stay",
      "ask",
      "close",
      "allow",
    ]);
  });

  it("lets a page that cannot answer close at once", () => {
    expect(run([close(1, false)])).toEqual(["allow"]);
  });

  it("asks again when closed twice, and ignores the answer to the question it replaced", () => {
    expect(run([close(1), close(2), answer(1, true), answer(2, false), close(3)])).toEqual([
      "ask",
      "ask",
      "ignore",
      "stay",
      "ask",
    ]);
  });

  it("ignores an answer nobody asked for", () => {
    expect(run([answer(7, true), close(1)])).toEqual(["ignore", "ask"]);
  });
});
