# Formats

[`packages/formats`](../../packages/formats/src) handles every format the document engine does not
index natively: JSONC, NDJSON, CSV/TSV, XML, YAML and TOML. It detects them, turns them into JSON
bytes so the engine can index them, and converts documents between all of them for export. It runs
in the engine's workers and follows the engine's rules (see [Document engine](document-engine.md)):
bytes are the unit, nothing builds a document as one string or one object graph, and the only
module that turns bytes into a string is
[`packages/core/src/boundedSlice.ts`](../../packages/core/src/boundedSlice.ts).

## Detection

`detectFormat(prefix, hint)` in [`detect.ts`](../../packages/formats/src/detect.ts) reads at most
`DETECT_PREFIX_BYTES` (64 KiB), never throws and never refuses: whatever it cannot place is `text`.
Every decision is made on bytes, so it behaves the same on a 2 GiB file and a 2 KiB one. Order is
the rule, and the test table in [`detect.test.ts`](../../packages/formats/src/detect.test.ts) pins
it:

1. BOM and binary check (a NUL byte, or more than one byte in eight a control character).
2. A JSON probe for JSON, JSONC, HAR and NDJSON.
3. XML.
4. Line shapes, TOML then YAML.
5. Delimiter sniffing for CSV and TSV.
6. The file extension, as a tie-breaker only.
7. Text.

Details worth knowing before changing it:

- The JSON probe is a one-value tokenizer, not a parser. It tracks nesting and, at the first two
  levels only, the keys `log`, `entries`, `version` and `creator`, so a HAR is recognized without a
  full parse, even when its `entries` lie past the prefix. A comment or a trailing comma outside a
  string makes the file JSONC; a second value after a newline makes it NDJSON. A bare number or
  literal is not a document: `42` is text.
- XML needs a declaration, or a root element that is not `html`; `<!DOCTYPE html>` is text.
- TOML is rejected by a single assignment whose right side is not a TOML value, which keeps dotenv
  and INI files as text. YAML is a `---` or `%YAML` line, or mostly `key: value` and `- item` lines.
- CSV and TSV: for each of `,` `\t` `;` `|` the prefix is split into records with quote parity, and
  the delimiter wins on consistency (at least 0.9 of records share the most common field count),
  then on width. Comma-separated tables stay CSV even when a cell holds a colon.
- A flow sequence only counts as YAML when the line ends with `]`, otherwise `[1] Smith, J.` would
  read as a TOML table header.
- An extension can settle CSV, TSV, YAML or TOML when the bytes say nothing, but it never turns prose
  into JSON or XML.

The engine runs its own 4 KiB check first ([`packages/core/src/detect.ts`](../../packages/core/src/detect.ts)):
a file whose first significant byte is `{` or `[` opens as JSON (valid or not; the index reports
where it breaks) unless this detector names it JSONC, NDJSON or HAR, or the file name ends in
`.jsonc`.

## Opening through JSON

The engine's index, its queries (rows, keys, previews, search, paths, jq) and its edits all speak
JSON. Rather than teach each of them CSV fields, XML markup and YAML scalars,
[`engineFormats.ts`](../../packages/formats/src/engineFormats.ts) (the engine's `FormatPlatform`)
streams the file through a reader into a scratch file of JSON bytes, and the engine indexes that.
The file's own bytes stay what the Source view shows and what an unedited save writes back.

| Format  | Reader                                                                        | Streams           |
| ------- | ----------------------------------------------------------------------------- | ----------------- |
| JSONC   | [`JsoncBlanker`](../../packages/formats/src/jsoncBlank.ts)                    | yes               |
| NDJSON  | [`NdjsonToJson`](../../packages/formats/src/ndjsonToJson.ts)                  | yes               |
| CSV/TSV | [`CsvToJson`](../../packages/formats/src/csvToJson.ts)                        | yes               |
| XML     | [`XmlToJson`](../../packages/formats/src/xmlToJson.ts)                        | yes               |
| YAML    | `yaml`, through [`valueSource.ts`](../../packages/formats/src/valueSource.ts) | no, up to 256 MiB |
| TOML    | `smol-toml`, through the same module                                          | no, up to 256 MiB |

The file is read in 8 MiB steps and each step's JSON is written before the next is read.

- **JSONC** keeps its offsets. `JsoncBlanker` turns comments and trailing commas into spaces and
  keeps line breaks, so the JSON has the file's length and every node range is a position in the
  file. A JSONC document is `native`: the Source view paints and selects the file's own text.
- **NDJSON** becomes an array of the non-blank lines, each copied byte for byte.
- **CSV/TSV** becomes an array of row objects keyed by the header, every value a string. A blank line
  is skipped, a UTF-8 BOM is skipped, a row with more fields than the header names the extras
  `_<position>`, and a row with fewer lacks those keys. A header that names a column twice cannot be
  an object's keys and is an error.
- **XML** follows the mapping in [Mapping XML and JSON](#mapping-xml-and-json).
- **YAML and TOML** need the whole text, so they open only up to `TEXT_FORMAT_LIMIT` (256 MiB,
  [`textDocument.ts`](../../packages/formats/src/textDocument.ts)) and above it open as text. The
  bytes are decoded through `decodeUtf8` in slices of at most 64 MiB cut at character boundaries. A
  YAML stream of several documents becomes an array of them. `smol-toml` refuses integers past 2^53
  unless asked, so the reader passes `integersAsBigInt: "asNeeded"`: a valid TOML file is not
  refused for holding a large ID.

Every format other than JSON and HAR opens **read-only**. An edit would be an edit to the JSON, and a
save could not write it back in the file's format. `DocumentInfo.structure` is `converted` for all
of them except JSONC: node ranges are offsets in the JSON, so the Source view shows the file without
the index's colors (shiki colors small files with the format's grammar) and neither follows nor
makes the shared selection. Search, path queries and jq run over the JSON.

A file of a known format opens as text, with a note that says why, when its reader fails (naming the
line of a syntax error, or the JSON Pointer of the value that cannot be mapped), when it is YAML or
TOML over 256 MiB, or when its JSON would pass the engine's 4 GiB tape limit.

**Scratch files.** On the web the JSON is written to OPFS under `conversions/<session>/`, one
directory per engine worker, held by a Web Lock for the worker's life
([`engine.worker.ts`](../../apps/web/src/engine/engine.worker.ts)). The first conversion of the next
session removes every directory whose lock is free, so a crashed tab leaves nothing behind for long.
Without OPFS the bytes go to blob storage chunk by chunk (`memoryScratch`).

## Export

`convert` on the engine RPC writes the document as it stands, edits included: JSON through the
engine's own formatter (indented or minified), every other target through
[`convert.ts`](../../packages/formats/src/convert.ts) from JSON bytes, read from the indexed file when
the document is unedited and from a scratch copy of the edited bytes otherwise. `exportTargets` checks
each target from the root and its first 64 rows, by the rules the writers refuse on first; the
conversion has the last word, and its refusal is a `ConvertError` with the pointer or line.

The writers do not wait for the sink, so the input reads wait for the writes in flight instead
(`pacedPair`). Without that, a fast reader fills memory ahead of a slow disk.

## Streaming conversion

Every route is "the source as JSON bytes", then "JSON bytes as the target". A JSON source into YAML,
TOML, CSV, TSV, NDJSON or minified JSON goes through the engine's region pipeline
([`convertSource.ts`](../../packages/formats/src/convertSource.ts)) with a conversion job in place of
the structural pass: summarize, resolve entry states, convert, and write outputs in file order. Every
other route is read once, in order, through a reader into a sequential target (`JsonPump` in
[`convertRegion.ts`](../../packages/formats/src/convertRegion.ts)).

### Regions

A region converts the tokens that start in it, and reads an overhang past its end
(`OVERHANG_BYTES`, a little over 1 MiB) to finish its last token. A region that starts inside a
string or a number skips it; its entry state says so.

The output must not depend on where regions were cut, and that is a rule about content, not about
boundaries. In YAML ([`yamlEmit.ts`](../../packages/formats/src/yamlEmit.ts)), whether a string is
written plain depends only on its own bytes (`isPlainSafe`: short, made of safe characters, not a
reserved word); a string over `PLAIN_STRING_LIMIT` (1 MiB) is always written double-quoted, raw. The
overhang is longer than that limit, so the region that owns a string always sees whether it is
short. A longer one is written raw by its owner up to the region end and continued by the regions
after it (`partialString`, `continueString`).

### Whole-token targets

CSV, TSV and TOML (and XML, through the sequential pump) need each string or number whole. A region
grows its overhang, doubling up to `MAX_ROW_BYTES` (64 MiB), until the token it owns fits; a token
past that is `token-too-large`, with the token's pointer. Only YAML carries a string across regions.
A target without `continueString` must not fail when a region starts inside a string: the owner has
already written it whole, or has failed the job.

### Row targets

CSV, TSV and NDJSON work on whole elements of the root array. A row is copied out of the window cell
by cell as it is read, so it never needs the window it began in, and the handler stops at the first
element that starts at or after the region end (`RegionStop`). The CSV header comes from the first
1,024 rows (`columns: "first"`), from every row (`"full"`, single-threaded), or from an explicit list.
A key that is not a column is an error, not a silent drop. Nested values in a cell are written as
compact JSON by default, or refused with `nested: "error"`.

### TOML

TOML ([`tomlEmit.ts`](../../packages/formats/src/tomlEmit.ts)) goes through the same region pipeline,
so its layout may depend only on the depth and the kind of the open containers. A region that starts
mid-document cannot know the key path, which rules out `[table]` headers. The root's members are
`key = value` lines, an array directly under the root is one element per line, and everything deeper
is an inline table or inline array. A TOML document is a table, so a root that is not an object is
`not-a-table`: a top-level array of rows cannot be written as TOML.

- Keys are bare when they are `[A-Za-z0-9_-]+`, quoted otherwise. Strings are copied byte for byte
  unless they hold a backslash, DEL or a control character, in which case they are unescaped and
  written again with TOML's escapes.
- Integers outside 64 bits are written as floats with every digit kept. A lone surrogate escape has
  no UTF-8 form and is refused (`invalid-input`), not replaced.
- Duplicate keys in one JSON object are written as they come. TOML readers reject them, but no region
  can see the earlier keys of its object to check.

### Errors name a node

Workers know a byte offset, not a path. An emitter throws `OffendingNode(offset, reason)`
([`abort.ts`](../../packages/formats/src/abort.ts)); the coordinator turns the offset into a JSON
Pointer with `locatePointer` ([`locate.ts`](../../packages/formats/src/locate.ts)), a sequential walk
that runs only on the failure path and keeps only the path to the node. For a source that is not
JSON, the offset is into the JSON its reader produced, so the reader runs again into the locator
(`locatePointerFrom`) and stops at the node. The earliest failing region wins, so the error is the
first offending node in file order. `UnrepresentableError` carries `from`, `to`, `reason` (a closed
set in [`errors.ts`](../../packages/formats/src/errors.ts)), `pointer` and `detail`.

| Target        | Not representable                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSV/TSV       | a root that is not an array (`not-rows`), an element that is not an object, a key twice in a row, a key outside the header, a nested value with `nested: "error"` |
| YAML          | nesting deeper than 1,024, a key over 1,024 bytes (`key-too-long`), NaN or Infinity from a YAML source                                                            |
| TOML          | a root that is not an object, null, nesting deeper than 1,024, a lone surrogate escape, a token over 64 MiB                                                       |
| XML           | null, an empty array, an array in an array, a name that is not an XML name, a second root, an attribute after content, text beside child elements                 |
| JSON from CSV | a header that names a column twice                                                                                                                                |
| JSON from XML | text beside child elements (`mixed-content`), a name that comes back after a different sibling (`duplicate-key`)                                                  |

XML, YAML and TOML round trips are exact on what they can express. XML cannot express a one-element
array: `{"a":["x"]}` writes `<a>x</a>`, which reads back as `"x"`.

Nothing is cut short silently. What cannot stream into a target is refused with a message:

| Where                                      | Limit       | Error                                                      |
| ------------------------------------------ | ----------- | ---------------------------------------------------------- |
| YAML or TOML as a source                   | 256 MiB     | `FormatTooLargeError`, naming format, size and limit       |
| One string or number into CSV/TSV/TOML/XML | 64 MiB      | `UnrepresentableError` `token-too-large`, with the pointer |
| One object key into YAML                   | 1,024 bytes | `key-too-long`, with the pointer                           |

### XML output

JSON to XML is the one JSON-source route that does not use the pool: element names need the key
path, which a region does not have, so it runs the sequential `JsonPump` on the calling thread. The
engine calls `convert` from its coordinator worker, so the UI thread is not involved; the input is
read in 8 MiB steps and the output is written as it is produced.

### Mapping XML and JSON

[`xmlEmit.ts`](../../packages/formats/src/xmlEmit.ts) and
[`xmlToJson.ts`](../../packages/formats/src/xmlToJson.ts) are one mapping read in two directions:

- the document is `{"<root>": <element>}`;
- an element with no attributes and no child elements is its text;
- otherwise it is an object: attributes first as `"@name"`, then child elements in order (a run of
  same-named siblings is an array), and `"#text"` for the text of an element that has no child
  elements.

XML to JSON streams. The first element of a run waits for its next sibling to learn whether the run
is an array; later elements stream straight through, so a million-row table never sits in memory.
Writing XML, a string of only whitespace is written as character references so a reader that drops
indentation keeps it, and a carriage return is always written as `&#13;`, because XML readers
normalize a literal CR to LF.

## Tape indexers

The package also has indexers that build the engine's tape directly over a file's own bytes, with no
JSON in between: [`indexLines.ts`](../../packages/formats/src/indexLines.ts) for NDJSON and CSV,
[`indexXml.ts`](../../packages/formats/src/indexXml.ts) for XML, and
[`yamlTape.ts`](../../packages/formats/src/yamlTape.ts) and
[`tomlTape.ts`](../../packages/formats/src/tomlTape.ts) for YAML and TOML. Their tapes have the
engine's shape (children follow their parent, `next` chains siblings, `childCount` is always set,
offsets are bytes of the file) and apply the same token budget. Opening a file in the app goes
through JSON instead, because every tape token would otherwise need a format-specific decoder in
every query. [`packages/formats/bench/index.ts`](../../packages/formats/bench/index.ts) measures the
indexers, and [`bench/convert.ts`](../../packages/formats/bench/convert.ts) measures conversion:

```sh
node packages/formats/bench/convert.ts <yaml|toml|csv|tsv|ndjson> <input.json> [workers] [output]
node packages/formats/bench/index.ts <ndjson|csv|tsv|xml> <file> [workers]
```

### CSV

One rule makes region boundaries a prefix sum: a double quote toggles quoted state wherever it
appears, and a quote inside a quoted field is written doubled. The state at any byte is the parity of
the quotes before it, so a region's entry state comes from counting quotes in the regions before it,
and no region is scanned twice. A row belongs to the region it starts in and reads past the region
end to finish. The same rule holds in detection and in `CsvToJson`, so a stray quote in an unquoted
field inverts the rest of the file the same way everywhere. A container at the cut depth records an
anchor every `LINE_BUCKET` (1,024) rows, so a page of rows is indexed on demand from its own range.

### XML

An element's `keyStart` is the `<` of its start tag, an attribute's is its name, and text and CDATA
use `TEXT_KEY` (`0xfffffffd`). Comments, processing instructions, the declaration and the doctype are
skipped. A markup construct belongs to the region its `<` is in and is read whole from the overhang,
so a region boundary only cuts text, or a comment, CDATA section or processing instruction longer
than the window; those carry their state across the boundary. Entry states are chained by a
lexical-only pass and the regions are then structured in parallel. That pass is a deliberate serial
step: the alternative, one hypothesis per lexical state per region, costs more code than the pass
costs time. A text node is emitted when it ends, so a text node that spans regions needs no patching.

### YAML and TOML

Both parse the whole text. `yaml` gives each node a range in UTF-16 units; `ByteOffsets` maps them to
bytes with a forward cursor over checkpoints every 4,096 units (requests arrive in order, so mapping
is linear). `yaml` keeps no key end, so key ends are kept beside the tape. An alias is expanded in
place, with the ranges of its anchor; an alias to an ancestor stays a string token holding its text.
`smol-toml` validates but keeps no positions, so a byte scanner reads the same text for ranges and
builds the table tree (dotted keys, `[a.b]`, `[[a]]`, inline tables, the four string forms).

## Traps

- A worker's window buffer is reused by its next read. A window kept between two jobs is valid only
  when nothing reads in between; CSV summarizing does not keep its window, because every region is
  summarized before any is structured.
- `partialString` writes only what its region owns. Writing to the window end duplicates the overhang
  in the next region.
- Offsets inside a window are window-relative. `convertRegion` and `JsonPump` rebase thrown offsets to
  the file before the coordinator names a node, and the pointer locator adds `JsonPump.windowOffset`;
  compared bare, offsets are right only in the first window.
- A failing region must not strand the workers behind it. A worker that stops at a failure skips its
  later regions, so the entry states and write positions after it never arrive; the coordinator wakes
  every waiter past the failing region.
- A lone surrogate escape has no UTF-8 form. The engine's unescape writes its three-byte generalized
  encoding, and CSV output rewrites it to U+FFFD in place.
