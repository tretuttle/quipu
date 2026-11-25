import { JQ_OUTPUT_LIMIT_BYTES } from "@quipu/contracts/engine";

import type { JqRunReply, JqRunRequest } from "./jq.worker.ts";

export const JQ_POOL_MAX_WORKERS = 4;

export interface JqPoolOutcome {
  readonly status: "ok" | "error" | "timeout";
  readonly output: string;
  readonly truncated: boolean;
  readonly message: string;
}

export interface JqWorkerLike {
  postMessage(message: JqRunRequest, transfer?: Transferable[]): void;
  onMessage(handler: (reply: JqRunReply) => void): void;
  onError?(handler: (message: string) => void): void;
  terminate(): void;
}

export interface JqPoolOptions {
  readonly size?: number;
  readonly spawn?: () => JqWorkerLike;
}

interface WorkerSlot {
  worker: JqWorkerLike | null;
  busy: boolean;
  activeJob: {
    readonly id: number;
    readonly finish: (outcome: JqPoolOutcome) => void;
  } | null;
}

interface QueuedTask {
  readonly input: Uint8Array;
  readonly program: string;
  readonly timeoutMs: number;
  readonly outputLimit: number;
  readonly signal?: AbortSignal;
  readonly resolve: (outcome: JqPoolOutcome) => void;
}

const defaultSpawn = (): JqWorkerLike => {
  const worker = new Worker(new URL("./jq.worker.ts", import.meta.url), { type: "module" });
  return {
    postMessage: (message, transfer = []) => worker.postMessage(message, transfer),
    onMessage: (handler) =>
      worker.addEventListener("message", (event: MessageEvent<JqRunReply>) => handler(event.data)),
    onError: (handler) =>
      worker.addEventListener("error", (event) => handler(event.message || "jq worker failed.")),
    terminate: () => worker.terminate(),
  };
};

export interface JqPool {
  readonly size: number;
  readonly activeCount: number;
  run(
    input: Uint8Array,
    program: string,
    timeoutMs: number,
    outputLimit?: number,
    signal?: AbortSignal,
  ): Promise<JqPoolOutcome>;
  terminate(): void;
}

/**
 * Pool of up to N = 4 `jq.worker` instances with per-request timeout kill/respawn
 * and FIFO scheduling so large element-mode jq jobs stay bounded in memory.
 */
export function createJqPool(options: JqPoolOptions = {}): JqPool {
  const hardware =
    typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : JQ_POOL_MAX_WORKERS;
  const size = Math.max(1, Math.min(JQ_POOL_MAX_WORKERS, Math.floor(options.size ?? hardware)));
  const spawn = options.spawn ?? defaultSpawn;

  const slots: WorkerSlot[] = Array.from({ length: size }, () => ({
    worker: null,
    busy: false,
    activeJob: null,
  }));
  const queue: QueuedTask[] = [];
  let nextId = 1;
  let terminated = false;
  let activeCount = 0;

  const attachWorker = (slot: WorkerSlot): JqWorkerLike => {
    const worker = spawn();
    slot.worker = worker;
    worker.onMessage((reply) => {
      const job = slot.activeJob;
      if (job === null) return;
      if (reply.id !== undefined && reply.id !== job.id) return;
      slot.activeJob = null;
      slot.busy = false;
      activeCount--;
      job.finish({
        status: reply.status,
        output: reply.output,
        truncated: reply.truncated,
        message: reply.message,
      });
      pump();
    });
    worker.onError?.((message) => {
      const job = slot.activeJob;
      slot.activeJob = null;
      slot.worker = null;
      slot.busy = false;
      try {
        worker.terminate();
      } catch {
        // Ignore terminate errors on already-failed workers.
      }
      if (job !== null) {
        activeCount--;
        job.finish({ status: "error", output: "", truncated: false, message });
      }
      pump();
    });
    return worker;
  };

  const resetSlot = (slot: WorkerSlot) => {
    const old = slot.worker;
    slot.worker = null;
    slot.activeJob = null;
    slot.busy = false;
    if (old !== null) {
      try {
        old.terminate();
      } catch {
        // Ignore terminate errors during worker kill/respawn.
      }
    }
  };

  const dispatchOnSlot = (slot: WorkerSlot, task: QueuedTask) => {
    if (terminated || task.signal?.aborted) {
      task.resolve({
        status: "error",
        output: "",
        truncated: false,
        message: terminated ? "jq pool was terminated." : "jq run was cancelled.",
      });
      return;
    }

    slot.busy = true;
    activeCount++;
    const id = nextId++;
    const worker = slot.worker ?? attachWorker(slot);

    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      activeCount--;
      resetSlot(slot);
      task.resolve({
        status: "error",
        output: "",
        truncated: false,
        message: "jq run was cancelled.",
      });
      pump();
    };

    const finish = (outcome: JqPoolOutcome) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      task.signal?.removeEventListener("abort", onAbort);
      task.resolve(outcome);
    };

    slot.activeJob = { id, finish };
    task.signal?.addEventListener("abort", onAbort, { once: true });

    timer = setTimeout(() => {
      if (done) return;
      done = true;
      task.signal?.removeEventListener("abort", onAbort);
      activeCount--;
      // Kill the runaway worker; the next queued job spawns a fresh replacement lazily.
      resetSlot(slot);
      task.resolve({
        status: "timeout",
        output: "",
        truncated: false,
        message: `jq did not finish in ${task.timeoutMs} ms and was stopped.`,
      });
      pump();
    }, task.timeoutMs);

    // Copy to a dedicated ArrayBuffer so transferring never detaches a caller's shared batch buffer.
    const buffer = task.input.slice().buffer;
    const request: JqRunRequest = {
      id,
      input: buffer,
      program: task.program,
      outputLimit: task.outputLimit,
    };
    worker.postMessage(request, [buffer]);
  };

  const pump = () => {
    if (terminated) return;
    for (const slot of slots) {
      if (slot.busy) continue;
      const next = queue.shift();
      if (next === undefined) return;
      dispatchOnSlot(slot, next);
    }
  };

  return {
    get size() {
      return size;
    },
    get activeCount() {
      return activeCount;
    },
    run(input, program, timeoutMs, outputLimit = JQ_OUTPUT_LIMIT_BYTES, signal) {
      if (terminated) {
        return Promise.resolve({
          status: "error",
          output: "",
          truncated: false,
          message: "jq pool was terminated.",
        });
      }
      if (signal?.aborted) {
        return Promise.resolve({
          status: "error",
          output: "",
          truncated: false,
          message: "jq run was cancelled.",
        });
      }
      return new Promise<JqPoolOutcome>((resolve) => {
        const task: QueuedTask = {
          input,
          program,
          timeoutMs,
          outputLimit,
          ...(signal === undefined ? {} : { signal }),
          resolve,
        };
        const idle = slots.find((slot) => !slot.busy);
        if (idle !== undefined) dispatchOnSlot(idle, task);
        else queue.push(task);
      });
    },
    terminate() {
      if (terminated) return;
      terminated = true;
      while (queue.length > 0) {
        const queued = queue.shift() as QueuedTask;
        queued.resolve({
          status: "error",
          output: "",
          truncated: false,
          message: "jq pool was terminated.",
        });
      }
      for (const slot of slots) {
        const job = slot.activeJob;
        resetSlot(slot);
        if (job !== null) {
          activeCount--;
          job.finish({
            status: "error",
            output: "",
            truncated: false,
            message: "jq pool was terminated.",
          });
        }
      }
    },
  };
}
