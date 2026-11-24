/** One array of about 100-byte flat objects, streamed to `targetBytes` (2 GiB ≈ 19 M objects). */
import type { Prng } from "./prng.ts";
import type { Sink } from "./sink.ts";
import { number, word } from "./text.ts";

const smallRecord = (prng: Prng, id: number) => ({
  id,
  name: `${word(prng)} ${word(prng)}`,
  email: `${word(prng)}@${word(prng)}.example`,
  active: prng.chance(0.7),
  score: number(prng),
  tags: prng.chance(0.5) ? [word(prng)] : [],
});

export const writeWide = (sink: Sink, prng: Prng, targetBytes: number) => {
  sink.write("[");
  let count = 0;
  while (sink.size() < targetBytes) {
    const pieces: string[] = [];
    for (let i = 0; i < 1024; i++) {
      pieces.push((count === 0 ? "" : ",") + JSON.stringify(smallRecord(prng, count)));
      count++;
    }
    sink.write(pieces.join(""));
  }
  sink.write("]\n");
  return { objects: count };
};
