/**
 * Format detection from a document's first bytes. JSON and HAR open as
 * structure; everything else opens as a text document, because no file is
 * refused. It reads bytes and never decodes them: the head is a bounded slice
 * and a file's later bytes can still make it invalid JSON, which the structural
 * index reports as it reaches them.
 */
/** The formats the engine indexes by itself; the format adapters handle the rest. */
export type EngineFormat = "json" | "har" | "text";

/** How much of the file's head detection looks at. */
export const DETECT_HEAD_BYTES = 4096;

const BOM = [0xef, 0xbb, 0xbf] as const;
const OPEN_OBJECT = 0x7b;
const OPEN_ARRAY = 0x5b;
const QUOTE = 0x22;
const COLON = 0x3a;
const LOG = [0x6c, 0x6f, 0x67] as const;

const isWhitespace = (byte: number) =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

/**
 * `json` when the first significant byte opens an object or an array, `har` when
 * that object's first member is `"log": {` (the HAR 1.2 envelope), `text`
 * otherwise, including an empty file.
 */
export const detectFormat = (head: Uint8Array): EngineFormat => {
  let i = 0;
  if (BOM.every((byte, offset) => head[offset] === byte)) i = BOM.length;
  const skip = () => {
    while (i < head.length && isWhitespace(head[i] as number)) i++;
  };
  skip();
  const first = head[i];
  if (first === OPEN_ARRAY) return "json";
  if (first !== OPEN_OBJECT) return "text";
  i++;
  skip();
  if (head[i] !== QUOTE) return "json";
  i++;
  for (const byte of LOG) {
    if (head[i] !== byte) return "json";
    i++;
  }
  if (head[i] !== QUOTE) return "json";
  i++;
  skip();
  if (head[i] !== COLON) return "json";
  i++;
  skip();
  return head[i] === OPEN_OBJECT ? "har" : "json";
};
