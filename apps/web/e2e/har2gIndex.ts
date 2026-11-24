// @effect-diagnostics nodeBuiltinImport:off - scans a fixture from Node, outside any Effect runtime.
import * as NodeFS from "node:fs";

const CHUNK = 64 * 1024 * 1024;
const PAGEREF = Buffer.from('"pageref":"page_');
const BIG_BODY = Buffer.from('"mimeType":"video/mp4","text":"');
const NESTED = Buffer.from(
  '"mimeType":"application/json","text":"{\\"kind\\":\\"envelope\\",\\"payload\\":\\"',
);
const OVERLAP = 128;

export interface Har2gLandmarks {
  readonly entries: number;
  /** Entry index (in `log.entries`) of the one huge base64 body. */
  readonly bigBodyEntry: number;
  /** Entry indexes and `content.size` of the large nested stringified bodies, in file order. */
  readonly nestedBodies: ReadonlyArray<{ readonly entry: number; readonly size: number }>;
}

/**
 * Finds the entries the decoder budgets are measured on, without parsing the
 * file: every entry has one `"pageref":"page_…"` member, so counting them up to
 * a landmark gives its index. Reads 64 MiB at a time.
 */
export function locateHar2g(file: string): Har2gLandmarks {
  const fd = NodeFS.openSync(file, "r");
  try {
    const size = NodeFS.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    let pagerefs = 0;
    let bigBodyEntry = -1;
    const nestedBodies: Array<{ entry: number; size: number }> = [];
    for (let position = 0; position < size; position += CHUNK) {
      const chunk = Buffer.alloc(Math.min(CHUNK, size - position));
      NodeFS.readSync(fd, chunk, 0, chunk.length, position);
      const hay = Buffer.concat([carry, chunk]);
      const base = position - carry.length;
      const events: Array<{ at: number; what: "page" | "big" | "nested" }> = [];
      const scan = (needle: Buffer, what: "page" | "big" | "nested") => {
        for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
          // A match wholly inside the carried overlap was reported with the previous chunk.
          if (at + needle.length <= carry.length) continue;
          events.push({ at: base + at, what });
        }
      };
      scan(PAGEREF, "page");
      scan(BIG_BODY, "big");
      scan(NESTED, "nested");
      events.sort((a, b) => a.at - b.at);
      for (const event of events) {
        if (event.what === "page") pagerefs++;
        else if (event.what === "big") bigBodyEntry = pagerefs - 1;
        else {
          const probe = Buffer.alloc(48);
          NodeFS.readSync(fd, probe, 0, 48, event.at - 48);
          const match = /"size":(\d+),$/.exec(probe.toString("latin1"));
          if (match && Number(match[1]) > 500_000) {
            nestedBodies.push({ entry: pagerefs - 1, size: Number(match[1]) });
          }
        }
      }
      carry = hay.subarray(Math.max(0, hay.length - OVERLAP));
    }
    return { entries: pagerefs, bigBodyEntry, nestedBodies };
  } finally {
    NodeFS.closeSync(fd);
  }
}
