import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@quipu/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import {
  openSaveStream,
  type SavePortLike,
  serveSavePort,
  tempPathFor,
} from "./DesktopDocumentSave.ts";

const utf8 = new TextEncoder();

/** A temp directory holding `doc.json` with ORIGINAL bytes, plus the helpers the assertions need. */
const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const dir = yield* fileSystem.makeTempDirectory({ prefix: "quipu-save-" });
  const target = path.join(dir, "doc.json");
  yield* fileSystem.writeFileString(target, "ORIGINAL");
  return {
    dir,
    target,
    temp: tempPathFor(target, 4242, "t"),
    read: (p: string) => fileSystem.readFileString(p),
    list: fileSystem.readDirectory(dir),
    exists: (p: string) => fileSystem.exists(p),
    remove: (p: string) => fileSystem.remove(p),
    open: openSaveStream({ path: target, pid: 4242, suffix: "t", platform }),
  };
});

describe("the desktop save stream", () => {
  it.effect("writes the streamed bytes over the original atomically and leaves no temp file", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      const stream = yield* t.open;
      yield* stream.write(utf8.encode('{"a":'));
      // Before close, the original is still what is on disk.
      expect(yield* t.read(t.target)).toBe("ORIGINAL");
      expect(yield* t.exists(t.temp)).toBe(true);
      yield* stream.write(utf8.encode(" 1}\n"));
      yield* stream.close;
      expect(yield* t.read(t.target)).toBe('{"a": 1}\n');
      expect(yield* t.list).toEqual(["doc.json"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the permissions of the file it replaces", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      const fileSystem = yield* FileSystem.FileSystem;
      if ((yield* HostProcess.Platform) === "win32") return;
      yield* fileSystem.chmod(t.target, 0o640);
      const stream = yield* t.open;
      yield* stream.write(utf8.encode("NEW"));
      yield* stream.close;
      expect(yield* t.read(t.target)).toBe("NEW");
      expect((yield* fileSystem.stat(t.target)).mode & 0o777).toBe(0o640);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "replaces a file that is open for reading: the open reader keeps the old bytes, a new open reads the saved ones",
    () =>
      Effect.gen(function* () {
        const t = yield* setup;
        const fileSystem = yield* FileSystem.FileSystem;
        if ((yield* HostProcess.Platform) === "win32") return;
        yield* Effect.scoped(
          Effect.gen(function* () {
            // What the main process holds for an open document.
            const held = yield* fileSystem.open(t.target, { flag: "r" });
            const stream = yield* t.open;
            yield* stream.write(utf8.encode("SAVED"));
            yield* stream.close;
            const old = new Uint8Array(8);
            const read = yield* held.read(old);
            expect(new TextDecoder().decode(old.subarray(0, Number(read)))).toBe("ORIGINAL");
            // Which is why the window reopens the document from the path after a save.
            expect(yield* t.read(t.target)).toBe("SAVED");
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("an abort, or a crash before the rename, leaves the original bytes in place", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      const stream = yield* t.open;
      yield* stream.write(utf8.encode("NEW-PARTIAL"));
      expect(yield* t.read(t.temp)).toBe("NEW-PARTIAL");
      yield* stream.abort;
      expect(yield* t.read(t.target)).toBe("ORIGINAL");
      expect(yield* t.list).toEqual(["doc.json"]);
      // A process that dies mid-stream: the temp file is all that is left, the target untouched.
      const crashed = yield* t.open;
      yield* crashed.write(utf8.encode("HALF"));
      expect(yield* t.read(t.target)).toBe("ORIGINAL");
      expect(yield* t.read(t.temp)).toBe("HALF");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports which step failed and keeps the target when the rename cannot happen", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      const stream = yield* t.open;
      yield* stream.write(utf8.encode("NEW"));
      // Remove the temp file behind the stream's back: the rename has nothing to move.
      yield* t.remove(t.temp);
      const result = yield* stream.close.pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.operation).toBe("rename");
        expect(result.failure.path).toBe(t.target);
      }
      expect(yield* t.read(t.target)).toBe("ORIGINAL");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("serves a save over a port: chunks are acknowledged in order and close commits", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      const port = fakePort();
      const served = serveSavePort(port, yield* t.open);
      port.deliver({ _tag: "chunk", bytes: utf8.encode("[1,") });
      port.deliver({ _tag: "chunk", bytes: utf8.encode("2]") });
      port.deliver({ _tag: "close" });
      yield* Effect.promise(() => served.settled());
      expect(port.replies).toEqual([
        { _tag: "ok", bytes: 3 },
        { _tag: "ok", bytes: 5 },
        { _tag: "ok", bytes: 5 },
      ]);
      expect(port.closed).toBe(true);
      expect(yield* t.read(t.target)).toBe("[1,2]");
      expect(yield* t.list).toEqual(["doc.json"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a malformed message or a dropped port aborts and keeps the original", () =>
    Effect.gen(function* () {
      const t = yield* setup;
      const port = fakePort();
      const served = serveSavePort(port, yield* t.open);
      port.deliver({ _tag: "chunk", bytes: utf8.encode("x") });
      port.deliver({ _tag: "bogus" });
      yield* Effect.promise(() => served.settled());
      expect(port.replies).toContainEqual(expect.objectContaining({ _tag: "error" }));
      expect(port.closed).toBe(true);
      expect(yield* t.read(t.target)).toBe("ORIGINAL");
      expect(yield* t.list).toEqual(["doc.json"]);

      const port2 = fakePort();
      const served2 = serveSavePort(port2, yield* t.open);
      port2.deliver({ _tag: "chunk", bytes: utf8.encode("y") });
      port2.drop();
      yield* Effect.promise(() => served2.settled());
      expect(yield* t.read(t.target)).toBe("ORIGINAL");
      expect(yield* t.list).toEqual(["doc.json"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

/** A MessagePortMain stand-in that records replies and lets the test deliver messages or drop the port. */
const fakePort = () => {
  const listeners: {
    message: Array<(event: { data: unknown }) => void>;
    close: Array<() => void>;
  } = { message: [], close: [] };
  const replies: unknown[] = [];
  const port: SavePortLike & {
    replies: unknown[];
    closed: boolean;
    deliver(message: unknown): void;
    drop(): void;
  } = {
    replies,
    closed: false,
    on: ((event: "message" | "close", listener: never) => {
      (listeners[event] as never[]).push(listener);
    }) as SavePortLike["on"],
    postMessage: (message) => {
      replies.push(message);
    },
    start: () => {},
    close: () => {
      port.closed = true;
    },
    deliver: (message) => {
      for (const listener of listeners.message) listener({ data: message });
    },
    drop: () => {
      for (const listener of listeners.close) listener();
    },
  };
  return port;
};
