import { describe, expect, it } from "@effect/vitest";

import { DETECT_PREFIX_BYTES, detectFormat } from "./detect.ts";
import type { FormatId } from "./formatIds.ts";

const utf8 = new TextEncoder();
const bytes = (text: string) => utf8.encode(text);

interface Row {
  readonly name: string;
  readonly input: string | Uint8Array;
  readonly format: FormatId;
  readonly delimiter?: number;
  readonly file?: string;
  readonly truncated?: boolean;
}

const COMMA = 0x2c;
const TAB = 0x09;
const SEMICOLON = 0x3b;
const PIPE = 0x7c;

const bom = (text: string) => {
  const body = bytes(text);
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
};

const TABLE: ReadonlyArray<Row> = [
  // JSON family
  { name: "json object", input: '{"a":1,"b":[true,null,"x"]}', format: "json" },
  {
    name: "pretty json object",
    input: '{\n  "a": 1,\n  "b": {\n    "c": [1, 2]\n  }\n}\n',
    format: "json",
  },
  { name: "json array of numbers", input: "[1, 2, 3]", format: "json" },
  { name: "json string document", input: '"just a string"', format: "json" },
  { name: "json with BOM", input: bom('{"a":1}'), format: "json" },
  { name: "json with comments is jsonc", input: '{\n  // note\n  "a": 1\n}', format: "jsonc" },
  { name: "json with block comment is jsonc", input: '/* head */ {"a": 1}', format: "jsonc" },
  { name: "json with trailing comma is jsonc", input: '{"a": [1, 2,], "b": 2,}', format: "jsonc" },
  {
    name: "slashes inside a string are not comments",
    input: '{"url":"http://a.b/c//d","re":"/*x*/"}',
    format: "json",
  },
  {
    name: "truncated json prefix of a big document",
    input: '{"rows":[{"a":1},{"a":2},{"a"',
    format: "json",
    truncated: true,
  },
  { name: "unterminated json file", input: '{"a": [1, 2', format: "json" },
  {
    name: "har with log.entries",
    input:
      '{"log":{"version":"1.2","creator":{"name":"x","version":"1"},"entries":[{"request":{}}]}}',
    format: "har",
  },
  {
    name: "har whose entries are past the prefix (version and creator only)",
    input:
      '{"log":{"version":"1.2","creator":{"name":"WebInspector","version":"537.36"},"pages":[{"id":"p"',
    format: "har",
    truncated: true,
  },
  {
    name: "json with a log key but no har shape",
    input: '{"log":{"level":"info"}}',
    format: "json",
  },
  { name: "ndjson objects", input: '{"a":1}\n{"a":2}\n{"a":3}\n', format: "ndjson" },
  {
    name: "ndjson with blank lines and CRLF",
    input: '{"a":1}\r\n\r\n{"a":2}\r\n',
    format: "ndjson",
  },
  { name: "jsonl arrays", input: "[1,2]\n[3,4]\n", format: "ndjson" },
  {
    name: "single-line ndjson with the .jsonl name",
    input: '{"a":1}\n',
    format: "ndjson",
    file: "events.jsonl",
  },
  {
    name: "ndjson cut inside the second line",
    input: '{"a":1}\n{"b":',
    format: "ndjson",
    truncated: true,
  },
  { name: "a bare number is not a document", input: "42\n", format: "text" },
  {
    name: "prose that starts with a bracket",
    input: "[1] Smith, J. A study of knots.\n",
    format: "text",
  },
  { name: "json followed by prose", input: '{"a":1} and then some words\n', format: "text" },
  // XML
  {
    name: "xml with declaration",
    input: '<?xml version="1.0" encoding="UTF-8"?>\n<root><a>1</a></root>',
    format: "xml",
  },
  {
    name: "xml without a declaration",
    input: '<feed xmlns="http://www.w3.org/2005/Atom"><entry/></feed>',
    format: "xml",
  },
  {
    name: "xml behind comments and a BOM",
    input: bom("<!-- c -->\n<?xml version='1.0'?><r/>"),
    format: "xml",
  },
  {
    name: "svg",
    input: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
    format: "xml",
  },
  { name: "html5 is text", input: "<!DOCTYPE html>\n<html><body>hi</body></html>", format: "text" },
  { name: "bare html root is text", input: "<html><head></head></html>", format: "text" },
  { name: "angle brackets in prose", input: "<3 is not markup\n", format: "text" },
  // TOML
  {
    name: "toml tables and assignments",
    input: '[package]\nname = "quipu"\nversion = "0.1.0"\n\n[dependencies]\nyaml = "2"\n',
    format: "toml",
  },
  { name: "toml dotted keys", input: "a.b.c = 1\nd = [1, 2, 3]\ne = { x = 1 }\n", format: "toml" },
  {
    name: "toml array of tables",
    input: '[[bin]]\nname = "a"\n[[bin]]\nname = "b"\n',
    format: "toml",
  },
  {
    name: "dotenv is not toml",
    input: "API_KEY=abc123\nDEBUG=true_ish\nHOST=localhost\n",
    format: "text",
  },
  // YAML
  {
    name: "yaml mapping",
    input: "name: quipu\nversion: 1\nitems:\n  - a\n  - b\n",
    format: "yaml",
  },
  { name: "yaml with document start", input: "---\nfoo: bar\n", format: "yaml" },
  { name: "yaml list", input: "- one\n- two\n- three\n", format: "yaml" },
  { name: "yaml directive", input: "%YAML 1.2\n---\na: 1\n", format: "yaml" },
  {
    name: "yaml with comments first",
    input: "# config\n# more\nkey: value\nother: 2\n",
    format: "yaml",
  },
  { name: "yaml flow mapping line", input: "{a: 1, b: 2}\n", format: "yaml" },
  {
    name: "markdown with prose is text",
    input: "# Title\n\nSome words here: they are prose.\nAnother line of prose.\n",
    format: "text",
  },
  // CSV and TSV
  {
    name: "csv",
    input: "id,name,city\n1,Ana,Lima\n2,Bo,Cusco\n3,Cy,Quito\n",
    format: "csv",
    delimiter: COMMA,
  },
  { name: "csv header and one row", input: "id,name\n1,Ana\n", format: "csv", delimiter: COMMA },
  {
    name: "csv with quoted newlines",
    input: 'id,note\n1,"line one\nline two"\n2,"a ""quoted"" word"\n',
    format: "csv",
    delimiter: COMMA,
  },
  { name: "csv with CRLF", input: "a,b\r\n1,2\r\n3,4\r\n", format: "csv", delimiter: COMMA },
  { name: "semicolon csv", input: "a;b;c\n1;2;3\n4;5;6\n", format: "csv", delimiter: SEMICOLON },
  { name: "pipe csv", input: "a|b|c\n1|2|3\n4|5|6\n", format: "csv", delimiter: PIPE },
  { name: "tsv", input: "a\tb\tc\n1\t2\t3\n4\t5\t6\n", format: "tsv", delimiter: TAB },
  {
    name: "tsv with commas inside cells",
    input: "a\tb\n1, 2\t3\n4\t5, 6\n",
    format: "tsv",
    delimiter: TAB,
  },
  {
    name: "csv cut inside the last record",
    input: "a,b,c\n1,2,3\n4,5,6\n7,8",
    format: "csv",
    delimiter: COMMA,
    truncated: true,
  },
  {
    name: "single column csv by name",
    input: "name\nana\nbo\n",
    format: "csv",
    delimiter: COMMA,
    file: "people.csv",
  },
  {
    name: "two lines of prose are not csv",
    input: "Hello, world.\nHow are you, today?\n",
    format: "text",
  },
  // Text, and inputs that only look like a format
  { name: "empty file", input: "", format: "text" },
  { name: "whitespace only", input: "  \n\t\n", format: "text" },
  {
    name: "plain prose",
    input: "The quick brown fox jumps over the lazy dog.\nA second line.\n",
    format: "text",
  },
  {
    name: "binary with NUL",
    input: new Uint8Array([0x7b, 0x22, 0x61, 0x00, 0x22, 0x7d]),
    format: "text",
  },
  {
    name: "utf-16 le bom",
    input: new Uint8Array([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00]),
    format: "text",
  },
  {
    name: "control characters",
    input: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4]),
    format: "text",
  },
  { name: "json-looking junk", input: "{{{{{{{{", format: "text" },
  { name: "unclosed quote prose", input: '"hello there\nsecond line\n', format: "text" },
  {
    name: "extension cannot make prose json",
    input: "hello there\n",
    format: "text",
    file: "a.json",
  },
  {
    name: "invalid utf-8 bytes inside text",
    input: new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0xfd, 0x0a]),
    format: "text",
  },
];

describe("detectFormat", () => {
  it.each(TABLE)("$name → $format", (row) => {
    const input = typeof row.input === "string" ? bytes(row.input) : row.input;
    const found = detectFormat(input, {
      ...(row.file === undefined ? {} : { name: row.file }),
      ...(row.truncated === undefined ? {} : { truncated: row.truncated }),
    });
    expect(found.format).toBe(row.format);
    if (row.delimiter !== undefined) expect(found.delimiter).toBe(row.delimiter);
  });

  it("reports the BOM so adapters can skip it", () => {
    expect(detectFormat(bom("a,b\n1,2\n")).bomBytes).toBe(3);
    expect(detectFormat(bytes("a,b\n1,2\n")).bomBytes).toBe(0);
  });

  it("never throws on any single byte or on random prefixes", () => {
    for (let b = 0; b < 256; b++) {
      expect(typeof detectFormat(new Uint8Array([b])).format).toBe("string");
    }
    let seed = 7;
    for (let k = 0; k < 300; k++) {
      const n = (seed = (seed * 1103515245 + 12345) >>> 0) % 200;
      const noise = new Uint8Array(n);
      for (let i = 0; i < n; i++) noise[i] = (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
      expect(typeof detectFormat(noise, { truncated: k % 2 === 0 }).format).toBe("string");
    }
  });

  it("reads a prefix of at most DETECT_PREFIX_BYTES from a large document", () => {
    const row = '{"id":1,"name":"x"}\n';
    const text = row.repeat(Math.ceil((DETECT_PREFIX_BYTES * 2) / row.length));
    const all = bytes(text);
    expect(detectFormat(all.subarray(0, DETECT_PREFIX_BYTES), { truncated: true }).format).toBe(
      "ndjson",
    );
  });
});
