/**
 * Coordinator side of a pool of format workers. Platform-neutral like the
 * engine's pool: a `WorkerLike` is anything with `postMessage` and an
 * `onMessage` hook, so the same driver runs over Web Workers, Node worker
 * threads and the in-process runner the tests use. Each worker runs one job at a
 * time, in call order.
 */
export interface WorkerLike<Job, Result> {
  postMessage(message: { readonly id: number; readonly job: Job }, transfer?: ArrayBuffer[]): void;
  onMessage(
    handler: (
      reply:
        | { readonly id: number; readonly ok: true; readonly result: Result }
        | { readonly id: number; readonly ok: false; readonly error: JobFailure },
    ) => void,
  ): void;
  terminate(): Promise<void> | void;
}

/** A job that failed in a worker, carried as plain data so it survives `postMessage`. */
export type JobFailure =
  | {
      readonly kind: "offending";
      readonly offset: number;
      readonly reason: string;
      readonly detail: string;
    }
  | { readonly kind: "error"; readonly message: string };

export class JobFailedError extends Error {
  readonly failure: JobFailure;
  constructor(failure: JobFailure) {
    super(failure.kind === "error" ? failure.message : failure.detail);
    this.name = "JobFailedError";
    this.failure = failure;
  }
}

interface Pending<Result> {
  readonly resolve: (value: Result) => void;
  readonly reject: (error: Error) => void;
}

export class FormatPool<Job, Result> {
  private nextId = 1;
  private readonly pending = new Map<number, Pending<Result>>();
  readonly workers: ReadonlyArray<WorkerLike<Job, Result>>;

  constructor(workers: ReadonlyArray<WorkerLike<Job, Result>>) {
    this.workers = workers;
    for (const worker of workers) {
      worker.onMessage((reply) => {
        const entry = this.pending.get(reply.id);
        if (!entry) return;
        this.pending.delete(reply.id);
        if (reply.ok) entry.resolve(reply.result);
        else entry.reject(new JobFailedError(reply.error));
      });
    }
  }

  get size() {
    return this.workers.length;
  }

  call<R extends Result = Result>(
    worker: number,
    job: Job,
    transfer: ArrayBuffer[] = [],
  ): Promise<R> {
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: Result) => void, reject });
      (this.workers[worker] as WorkerLike<Job, Result>).postMessage({ id, job }, transfer);
    });
  }

  broadcast<R extends Result = Result>(job: Job): Promise<R[]> {
    return Promise.all(this.workers.map((_, index) => this.call<R>(index, job)));
  }

  async terminate() {
    for (const entry of this.pending.values()) entry.reject(new Error("pool terminated"));
    this.pending.clear();
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
