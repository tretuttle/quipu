import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("quipu/no-whole-document-materialization");

describe("quipu/no-whole-document-materialization", () => {
  rule.valid(
    "allows slicing a blob into bounded reads",
    `
      export const head = (blob: Blob) => blob.slice(0, 4096);
      export const size = (blob: Blob) => blob.size;
    `,
  );

  rule.valid(
    "allows a decoder that is never asked to decode here",
    `const decoder = new TextDecoder();\nexport const encoding = decoder.encoding;`,
  );

  rule.valid(
    "allows decode on something that is not a TextDecoder",
    `import * as Schema from "effect/Schema";\nexport const f = (codec: { decode(x: string): number }) => codec.decode("1");`,
  );

  rule.valid(
    "allows text-like methods that take arguments",
    `export const f = (x: { text(n: number): string; json(s: string): object }) => [x.text(1), x.json("a")];`,
  );

  rule.valid(
    "allows String.fromCharCode with plain arguments",
    `export const f = (a: number, b: number) => String.fromCharCode(a, b);`,
  );

  rule.valid(
    "allows a JSON object that is not the global",
    `export const f = (JSONish: any) => JSONish.parse("1");`,
  );

  rule.valid(
    "allows Response.json, which builds a response",
    `export const r = Response.json({ ok: true });`,
  );

  rule.invalid("reports JSON.parse", `export const v = JSON.parse(source);`, (output) => {
    assert.match(output, /JSON\.parse materializes the whole document/);
  });

  rule.invalid("reports globalThis.JSON.parse", `export const v = globalThis.JSON.parse(source);`);

  rule.invalid("reports JSON.parse read as an alias", `export const parse = JSON.parse;`);

  rule.invalid(
    "reports decode on a local TextDecoder",
    `const decoder = new TextDecoder("utf-8");\nexport const s = decoder.decode(bytes);`,
    (output) => {
      assert.match(output, /TextDecoder#decode/);
    },
  );

  rule.invalid(
    "reports decode on a construction",
    `export const s = new TextDecoder().decode(bytes);`,
  );

  rule.invalid(
    "reports decode on a TextDecoder property",
    `
      export class Reader {
        readonly decoder = new TextDecoder();
        read(bytes: Uint8Array) {
          return this.decoder.decode(bytes);
        }
      }
    `,
  );

  rule.invalid(
    "reports decode on a parameter annotated TextDecoder",
    `export const read = (decoder: TextDecoder, bytes: Uint8Array) => decoder.decode(bytes);`,
  );

  rule.invalid(
    "reports a streaming decode as well",
    `const d = new TextDecoder();\nexport const s = d.decode(chunk, { stream: true });`,
  );

  rule.invalid("reports Blob#text", `export const t = await file.text();`, (output) => {
    assert.match(output, /\.text\(\)/);
  });

  rule.invalid("reports arrayBuffer", `export const b = await blob.arrayBuffer();`);

  rule.invalid("reports bytes", `export const b = await blob.bytes();`);

  rule.invalid("reports Response#json", `export const v = await response.json();`);

  rule.invalid(
    "reports Response#text through optional chaining",
    `export const v = await response?.text();`,
  );

  rule.invalid("reports new FileReader", `export const reader = new FileReader();`);

  rule.invalid(
    "reports new globalThis.FileReader",
    `export const reader = new globalThis.FileReader();`,
  );

  rule.invalid(
    "reports a spread into String.fromCharCode",
    `export const s = String.fromCharCode(...bytes);`,
    (output) => {
      assert.match(output, /String\.fromCharCode\(\.\.\.spread\)/);
    },
  );

  rule.invalid(
    "reports String.fromCharCode.apply",
    `export const s = String.fromCharCode.apply(null, bytes);`,
  );

  rule.invalid(
    "reports a spread into String.fromCodePoint",
    `export const s = String.fromCodePoint(...points);`,
  );
});
