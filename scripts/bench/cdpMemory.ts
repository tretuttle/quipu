// @effect-diagnostics globalFetch:off globalTimers:off - a raw DevTools-protocol client: fetches the debugger URL and times out calls to workers that went away.
/**
 * Instant "JS heap + ArrayBuffers, including every worker" for a Chromium
 * browser over the DevTools protocol: Runtime.getHeapUsage per attached target
 * (the page and every dedicated worker, nested ones included) returns usedSize
 * (V8 heap) and backingStorageSize (ArrayBuffer backing stores) without waiting
 * for a garbage collection. performance.measureUserAgentSpecificMemory resolves
 * only at the next major GC, which can be a minute away, so it is no use for
 * peaks (docs/internals/document-engine.md, "Measurement traps").
 */
export interface HeapUsage {
  readonly targets: number;
  readonly heapBytes: number;
  readonly backingStoreBytes: number;
}

interface TargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class CdpMemory {
  private socket!: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly sessions = new Map<string, string>();
  private readonly targets = new Map<string, TargetInfo>();

  static async connect(debugPort: number): Promise<CdpMemory> {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    const version = (await response.json()) as { webSocketDebuggerUrl: string };
    const cdp = new CdpMemory();
    await cdp.open(version.webSocketDebuggerUrl);
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    return cdp;
  }

  private open(url: string) {
    return new Promise<void>((resolve, reject) => {
      this.socket = new WebSocket(url);
      this.socket.addEventListener("open", () => resolve());
      this.socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)));
      this.socket.addEventListener("message", (event) => {
        this.receive(JSON.parse(String(event.data)) as Record<string, unknown>);
      });
    });
  }

  private receive(message: Record<string, unknown>) {
    if (typeof message.id === "number") {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
      return;
    }
    if (
      message.method === "Target.targetCreated" ||
      message.method === "Target.targetInfoChanged"
    ) {
      const info = (message.params as { targetInfo: TargetInfo }).targetInfo;
      this.targets.set(info.targetId, info);
    } else if (message.method === "Target.targetDestroyed") {
      const id = (message.params as { targetId: string }).targetId;
      this.targets.delete(id);
      this.sessions.delete(id);
    }
  }

  /** A call with no answer within `timeoutMs` (a worker torn down mid-call) rejects instead of hanging. */
  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 2000,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.send(
        JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }),
      );
    });
  }

  /** Heap usage summed over the page(s) and every live dedicated worker. */
  async sample(): Promise<HeapUsage> {
    const wanted = [...this.targets.values()].filter(
      (t) => t.type === "page" || t.type === "worker",
    );
    const results = await Promise.all(
      wanted.map(async (target) => {
        try {
          let sessionId = this.sessions.get(target.targetId);
          if (!sessionId) {
            const attached = await this.send<{ sessionId: string }>("Target.attachToTarget", {
              targetId: target.targetId,
              flatten: true,
            });
            sessionId = attached.sessionId;
            this.sessions.set(target.targetId, sessionId);
          }
          const usage = await this.send<{ usedSize: number; backingStorageSize?: number }>(
            "Runtime.getHeapUsage",
            {},
            sessionId,
          );
          return { heap: usage.usedSize, backing: usage.backingStorageSize ?? 0 };
        } catch {
          // The worker went away between discovery and the call.
          this.sessions.delete(target.targetId);
          return null;
        }
      }),
    );
    let heapBytes = 0;
    let backingStoreBytes = 0;
    let targets = 0;
    for (const r of results) {
      if (!r) continue;
      targets++;
      heapBytes += r.heap;
      backingStoreBytes += r.backing;
    }
    return { targets, heapBytes, backingStoreBytes };
  }

  close() {
    this.socket.close();
  }
}
