import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

type ProtocolHandler = (request: Request) => Promise<Response>;

// Electron only exists inside the Electron binary. This stand-in records the
// handler the app registers, so the test can send it a request and read the
// headers the renderer would get back.
const electron = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }));

vi.mock("electron", () => ({
  protocol: {
    handle: (scheme: string, handler: unknown) => electron.handlers.set(scheme, handler),
    unhandle: (scheme: string) => electron.handlers.delete(scheme),
    registerSchemesAsPrivileged: () => undefined,
  },
  net: { fetch: () => Promise.reject(new Error("no network in this test")) },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";

const OPEN_VSX_HOSTS = ["https://open-vsx.org", "https://openvsx.eclipsecontent.org"];
const TestLayer = Layer.provideMerge(ElectronProtocol.layer, NodeServices.layer);

const servedPolicy = (scheme: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const assetDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "quipu-protocol-",
    });
    yield* fileSystem.writeFileString(
      path.join(assetDirectory, "index.html"),
      "<!doctype html><title>Quipu</title>",
    );
    const protocol = yield* ElectronProtocol.ElectronProtocol;
    yield* protocol.registerDesktopProtocol({ scheme, assetDirectory });
    const handler = electron.handlers.get(scheme) as ProtocolHandler;
    const response = yield* Effect.promise(() => handler(new Request(`${scheme}://app/`)));
    const header = response.headers.get("content-security-policy");
    if (header === null) {
      return yield* Effect.die(new Error("the protocol response carried no CSP"));
    }
    return new Map(
      header.split("; ").map((directive) => {
        const [name = "", ...sources] = directive.split(" ");
        return [name, sources];
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(TestLayer));

afterEach(() => electron.handlers.clear());

describe("desktop protocol", () => {
  it("serves production from quipu://app and development from quipu-dev://app", () => {
    expect(ElectronProtocol.getDesktopUrl(false)).toBe("quipu://app/");
    expect(ElectronProtocol.getDesktopUrl(true)).toBe("quipu-dev://app/");
    expect(ElectronProtocol.getDesktopScheme(false)).toBe("quipu");
    expect(ElectronProtocol.getDesktopScheme(true)).toBe("quipu-dev");
  });

  it("isolates every response it returns to the renderer", async () => {
    const upstream = new Response("body", {
      status: 206,
      headers: { "content-type": "text/javascript", "cache-control": "no-cache" },
    });
    const response = ElectronProtocol.withDocumentHeaders(upstream, "default-src 'self'");
    expect(response.status).toBe(206);
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(response.headers.get("content-type")).toBe("text/javascript");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toBe("body");
  });
});

describe("the content security policy the desktop app serves", () => {
  it.effect.each(["quipu", "quipu-dev"])(
    "lets %s reach Open VSX and its file host for data and icons, and nothing else off-origin",
    (scheme) =>
      Effect.gen(function* () {
        const policy = yield* servedPolicy(scheme);
        for (const directive of ["connect-src", "img-src"]) {
          const external = (policy.get(directive) ?? []).filter((source) =>
            /^https?:\/\//.test(source),
          );
          expect(external.toSorted(), directive).toEqual([...OPEN_VSX_HOSTS].toSorted());
        }
        const offOrigin = [...policy.entries()].flatMap(([directive, sources]) =>
          directive === "connect-src" || directive === "img-src"
            ? []
            : sources.filter((source) => /^[a-z]+:\/\//.test(source) || source === "*"),
        );
        expect(offOrigin).toEqual([]);
      }),
  );
});
