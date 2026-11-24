/**
 * Writes a deterministic XML file of about `bytes` bytes (rows with attributes,
 * entities, CDATA, comments and non-ASCII text) for the index bench.
 *   node packages/formats/bench/genXml.ts <output> <bytes>
 */
import * as NodeFS from "node:fs";

const [output, sizeArg] = process.argv.slice(2);
if (!output || !sizeArg) throw new Error("usage: genXml.ts <output> <bytes>");
const target = Number(sizeArg);
const words = ["quipu", "khipu", "cord", "knot", "résumé", "北京", "🙂", "alpha", "tango", "mike"];
let state = 12345;
const next = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state;
};
const pick = () => words[next() % words.length] as string;
const fd = NodeFS.openSync(output, "w");
let written = 0;
const encoder = new TextEncoder();
const write = (text: string) => {
  const bytes = encoder.encode(text);
  NodeFS.writeSync(fd, bytes);
  written += bytes.length;
};
write('<?xml version="1.0" encoding="UTF-8"?>\n<!-- generated -->\n<rows xmlns:q="urn:quipu">\n');
let id = 0;
let batch = "";
for (;;) {
  if (written >= target) break;
  const tags = Array.from({ length: next() % 3 }, () => `<tag>${pick()}</tag>`).join("");
  batch += `  <row id="${id}" q:kind="${pick()}"><name>${pick()} &amp; ${pick()}</name><email>${pick()}@${pick()}.example</email><active>${next() % 2 === 0}</active><score>${next() % 100000}</score>${tags ? `<tags>${tags}</tags>` : ""}<note><![CDATA[<${pick()}> & ${pick()}]]></note><!-- row ${id} --></row>\n`;
  id++;
  if (batch.length > 1 << 20) {
    write(batch);
    batch = "";
  }
}
write(`${batch}</rows>\n`);
NodeFS.closeSync(fd);
process.stdout.write(`${id} rows, ${written} bytes\n`);
