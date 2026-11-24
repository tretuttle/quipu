/**
 * `depth` nested levels alternating objects and arrays, written in a loop (no
 * recursion in the generator either). `padBytes` adds a sibling string per level
 * so the 50 MiB variant reaches its size at the same depth.
 */
import type { Prng } from "./prng.ts";
import type { Sink } from "./sink.ts";
import { sentence } from "./text.ts";

export const writeDeep = (sink: Sink, prng: Prng, depth: number, padBytes: number) => {
  let pad = "";
  while (pad.length < padBytes) pad += `${sentence(prng)} `;
  const padJson = padBytes > 0 ? `"pad":${JSON.stringify(pad)},` : "";
  for (let level = 0; level < depth; level++) {
    sink.write(level % 2 === 0 ? `{${padJson}"id":${level},"child":` : "[");
  }
  sink.write('"leaf"');
  for (let level = depth - 1; level >= 0; level--) {
    sink.write(level % 2 === 0 ? "}" : "]");
  }
  sink.write("\n");
};
