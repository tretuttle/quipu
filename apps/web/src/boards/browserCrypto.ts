import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

/** The browser's Web Crypto as Effect's `Crypto` service. */
const browserCrypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.promise(async () => {
      const input = new Uint8Array(data.length);
      input.set(data);
      return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
    }),
});

export function randomUUIDv4(): string {
  return Effect.runSync(browserCrypto.randomUUIDv4);
}
