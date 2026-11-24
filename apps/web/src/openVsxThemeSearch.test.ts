import { describe, expect, it } from "vite-plus/test";

import { createTaskQueue } from "./openVsxThemeSearch";

/** A task the test finishes by hand, recording when it started. */
function manualTask(started: string[], name: string) {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  return {
    run: (signal: AbortSignal) => {
      started.push(name);
      return new Promise<string>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        void done.then(() => resolve(name));
      });
    },
    finish: () => finish(),
  };
}

describe("createTaskQueue", () => {
  it("never runs more tasks at once than its limit, and starts the rest in order", async () => {
    const enqueue = createTaskQueue(2);
    const started: string[] = [];
    const tasks = ["a", "b", "c", "d"].map((name) => manualTask(started, name));
    const results = tasks.map((task) => enqueue(task.run, new AbortController().signal));

    expect(started).toEqual(["a", "b"]);
    tasks[0]!.finish();
    await expect(results[0]).resolves.toBe("a");
    expect(started).toEqual(["a", "b", "c"]);
    tasks[1]!.finish();
    tasks[2]!.finish();
    await Promise.all(results.slice(1, 3));
    expect(started).toEqual(["a", "b", "c", "d"]);
    tasks[3]!.finish();
    await expect(results[3]).resolves.toBe("d");
  });

  it("drops a queued task whose signal aborts, without ever starting it", async () => {
    const enqueue = createTaskQueue(1);
    const started: string[] = [];
    const first = manualTask(started, "first");
    const cancelled = manualTask(started, "cancelled");
    const last = manualTask(started, "last");
    const controller = new AbortController();

    const firstResult = enqueue(first.run, new AbortController().signal);
    const cancelledResult = enqueue(cancelled.run, controller.signal);
    const lastResult = enqueue(last.run, new AbortController().signal);
    controller.abort(new Error("scrolled away"));

    await expect(cancelledResult).rejects.toThrow("scrolled away");
    first.finish();
    await firstResult;
    last.finish();
    await expect(lastResult).resolves.toBe("last");
    expect(started).toEqual(["first", "last"]);
  });

  it("aborts a running task through its signal and frees its slot", async () => {
    const enqueue = createTaskQueue(1);
    const started: string[] = [];
    const running = manualTask(started, "running");
    const next = manualTask(started, "next");
    const controller = new AbortController();

    const runningResult = enqueue(running.run, controller.signal);
    const nextResult = enqueue(next.run, new AbortController().signal);
    controller.abort(new Error("new query"));

    await expect(runningResult).rejects.toThrow("new query");
    expect(started).toEqual(["running", "next"]);
    next.finish();
    await expect(nextResult).resolves.toBe("next");
  });

  it("refuses a task whose signal has already aborted", async () => {
    const enqueue = createTaskQueue(1);
    const started: string[] = [];
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await expect(enqueue(manualTask(started, "late").run, controller.signal)).rejects.toThrow(
      "gone",
    );
    expect(started).toEqual([]);
  });
});
