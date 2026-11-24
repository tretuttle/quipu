/**
 * The identity of a file that has no handle: name, size, modified time, and
 * the hashes of its first and last MiB. Hashing the whole file would make
 * opening a large file wait on reading all of it, and a worker keeps even
 * these two bounded reads off the UI thread.
 */
import { readBlobSlice } from "@quipu/core/boundedSlice";

const MIB = 1024 * 1024;

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

const u64 = (value: number) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
};

async function fingerprint(file: File) {
  const head = await sha256((await readBlobSlice(file, 0, MIB, MIB)) as Uint8Array<ArrayBuffer>);
  const tail = await sha256(
    (await readBlobSlice(
      file,
      Math.max(0, file.size - MIB),
      file.size,
      MIB,
    )) as Uint8Array<ArrayBuffer>,
  );
  const name = new TextEncoder().encode(file.name);
  const parts = [name, u64(file.size), u64(file.lastModified), head, tail];
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.byteLength;
  }
  return hex(await sha256(joined));
}

self.addEventListener("message", (event: MessageEvent<{ id: number; file: File }>) => {
  const { id, file } = event.data;
  fingerprint(file).then(
    (digest) => self.postMessage({ id, digest }),
    (error: unknown) =>
      self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }),
  );
});
