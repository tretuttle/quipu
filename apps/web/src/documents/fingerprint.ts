/**
 * A file's identity across sessions when there is no handle to compare: name,
 * size, modified time and the hashes of its first and last MiB, computed in a
 * worker (`fingerprint.worker.ts`). The recents list and the edit journal both
 * key on it, so one open computes it once.
 */
const digests = new WeakMap<File, Promise<string>>();

function compute(file: File): Promise<string> {
  const worker = new Worker(new URL("./fingerprint.worker.ts", import.meta.url), {
    type: "module",
  });
  return new Promise<string>((resolve, reject) => {
    worker.addEventListener(
      "message",
      (event: MessageEvent<{ digest?: string; error?: string }>) => {
        if (event.data.digest !== undefined) resolve(event.data.digest);
        else reject(new Error(event.data.error ?? "The fingerprint failed."));
      },
    );
    worker.addEventListener("error", (event) => reject(new Error(event.message)));
    worker.postMessage({ id: 1, file });
  }).finally(() => worker.terminate());
}

export function fingerprintFile(file: File): Promise<string> {
  let digest = digests.get(file);
  if (digest === undefined) {
    digest = compute(file);
    digests.set(file, digest);
    // A failed digest is not remembered: the next ask tries again.
    digest.catch(() => digests.delete(file));
  }
  return digest;
}

/** The engine's journal key for a file: the same file opened again finds its unsaved edits. */
export const journalKeyOf = async (file: File) => `blob:${await fingerprintFile(file)}`;
