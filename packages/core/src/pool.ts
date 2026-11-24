/**
 * Coordinator side of the scan-worker pool. Platform-neutral: a `WorkerLike` is
 * anything with postMessage and an onMessage hook (a Web Worker, or an in-process
 * runner in tests). Each worker runs one job at a time in call order.
 */
import type { Job, JobResult, Reply, Request } from "./protocol.ts";
import type { SourceSpec } from "./source.ts";

export interface WorkerLike {
  postMessage(message: Request, transfer?: Transferable[]): void;
  onMessage(handler: (reply: Reply) => void): void;
  terminate(): Promise<void> | void;
}

interface Pending {
  readonly resolve: (value: JobResult) => void;
  readonly reject: (error: Error) => void;
  readonly worker: number;
  readonly cancelTimer: (() => void) | null;
}

/** A job overran its time budget; its worker was stopped and replaced. */
export class BudgetExceededError extends Error {
  readonly budgetMs: number;
  constructor(budgetMs: number) {
    super(`a worker job ran past its ${budgetMs} ms budget`);
    this.name = "BudgetExceededError";
    this.budgetMs = budgetMs;
  }
}

export interface PoolOptions {
  /** Makes a replacement for a worker stopped for overrunning a budget. */
  readonly spawn?: () => WorkerLike;
  /**
   * Starts a timer and returns how to cancel it. Injected because the engine's
   * core touches no global timers; the coordinator passes `setTimeout`.
   */
  readonly timer?: (ms: number, fire: () => void) => () => void;
}

/** An `open` job and what must be transferred with it, made afresh for each worker that needs it. */
type Opening = () => { readonly job: Job; readonly transfer: Transferable[] };

export class Pool {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly options: PoolOptions;
  /** Sources opened in each worker, replayed into a replacement. */
  private readonly opened: Array<Map<number, Opening>>;
  readonly workers: WorkerLike[];

  constructor(workers: ReadonlyArray<WorkerLike>, options: PoolOptions = {}) {
    this.workers = [...workers];
    this.options = options;
    this.opened = workers.map(() => new Map());
    this.workers.forEach((worker, index) => this.attach(worker, index));
  }

  private attach(worker: WorkerLike, index: number) {
    worker.onMessage((reply) => {
      const entry = this.pending.get(reply.id);
      if (!entry || entry.worker !== index) return;
      this.pending.delete(reply.id);
      entry.cancelTimer?.();
      if (reply.ok) entry.resolve(reply.result);
      else entry.reject(new Error(`scan worker ${index}: ${reply.error}`));
    });
  }

  /** Stops worker `index`, fails what it was running, and starts a replacement with the same sources open. */
  private async restart(index: number): Promise<void> {
    const { spawn } = this.options;
    if (spawn === undefined) throw new Error("this pool cannot replace a worker");
    for (const [id, entry] of this.pending) {
      if (entry.worker !== index) continue;
      this.pending.delete(id);
      entry.cancelTimer?.();
      entry.reject(new Error(`scan worker ${index} was restarted`));
    }
    const old = this.workers[index] as WorkerLike;
    const next = spawn();
    this.workers[index] = next;
    this.attach(next, index);
    // Posted before anything else can be: a worker handles messages in order.
    for (const opening of (this.opened[index] as Map<number, Opening>).values()) {
      const { job, transfer } = opening();
      this.send(index, job, transfer, null).catch(() => undefined);
    }
    await old.terminate();
  }

  get size() {
    return this.workers.length;
  }

  /**
   * Runs `job` on `worker`. With `budgetMs` the worker is stopped and replaced
   * when the job overruns it, and the call rejects with `BudgetExceededError`:
   * the only way to end a regular expression that is backtracking.
   */
  call<T extends JobResult>(
    worker: number,
    job: Job,
    transfer: ArrayBuffer[] = [],
    budgetMs: number | null = null,
  ): Promise<T> {
    const opened = this.opened[worker] as Map<number, Opening>;
    if (job.type === "open") opened.set(job.sourceId, () => ({ job, transfer: [] }));
    if (job.type === "closeSource") opened.delete(job.sourceId);
    return this.send(worker, job, transfer, budgetMs);
  }

  /**
   * Opens a source in every worker, each from its own `make()`: a port moves to
   * the worker it is sent to, so no two workers (nor a replacement) can share one.
   */
  async openEach(
    sourceId: number,
    make: () => { readonly spec: SourceSpec; readonly transfer: Transferable[] },
  ): Promise<void> {
    const opening: Opening = () => {
      const { spec, transfer } = make();
      return { job: { type: "open", sourceId, spec }, transfer };
    };
    await Promise.all(
      this.workers.map((_, index) => {
        (this.opened[index] as Map<number, Opening>).set(sourceId, opening);
        const { job, transfer } = opening();
        return this.send(index, job, transfer, null);
      }),
    );
  }

  private send<T extends JobResult>(
    worker: number,
    job: Job,
    transfer: Transferable[],
    budgetMs: number | null,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let cancelTimer: (() => void) | null = null;
      if (budgetMs !== null && this.options.timer !== undefined) {
        cancelTimer = this.options.timer(budgetMs, () => {
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          reject(new BudgetExceededError(budgetMs));
          this.restart(worker).catch(() => undefined);
        });
      }
      this.pending.set(id, {
        resolve: resolve as (value: JobResult) => void,
        reject,
        worker,
        cancelTimer,
      });
      (this.workers[worker] as WorkerLike).postMessage({ id, job }, transfer);
    });
  }

  /** Runs the same job on every worker. */
  broadcast<T extends JobResult>(job: Job): Promise<T[]> {
    return Promise.all(this.workers.map((_, index) => this.call<T>(index, job)));
  }

  async terminate() {
    for (const entry of this.pending.values()) entry.reject(new Error("pool terminated"));
    this.pending.clear();
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

interface DedicatedWorker {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

const adapt = (worker: DedicatedWorker): WorkerLike => ({
  postMessage: (message: Request, transfer: Transferable[] = []) =>
    worker.postMessage(message, transfer),
  onMessage: (handler: (reply: Reply) => void) => {
    worker.addEventListener("message", (event: MessageEvent<Reply>) => handler(event.data));
    worker.addEventListener("error", (event) => {
      throw new Error(`scan worker error: ${event.message}`);
    });
  },
  terminate: () => worker.terminate(),
});

/**
 * Adapts dedicated workers to the pool. `spawn` makes a replacement for a worker
 * a time budget stopped; `timer` starts the budget timers.
 */
export const createPoolFromWorkers = (
  workers: ReadonlyArray<DedicatedWorker>,
  options: {
    readonly spawn?: () => DedicatedWorker;
    readonly timer?: PoolOptions["timer"];
  } = {},
) => {
  const { spawn, timer } = options;
  return new Pool(workers.map(adapt), {
    ...(spawn === undefined ? {} : { spawn: () => adapt(spawn()) }),
    ...(timer === undefined ? {} : { timer }),
  });
};
