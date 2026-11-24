# Document engine

The document engine is the byte-level model behind every open file: it reads the bytes, builds a
structural index over them, answers queries about nodes, searches, records edits and streams saves
and conversions. It lives in [`packages/core`](../../packages/core/src), runs in workers, and is
reached from the UI only through the typed client in
[`apps/web/src/engine/client.ts`](../../apps/web/src/engine/client.ts) and the contract in
[`packages/contracts/src/engine.ts`](../../packages/contracts/src/engine.ts). Formats other than
JSON and HAR are covered in [Formats](formats.md); the desktop shell's side of opening and saving
is in [Desktop shell](desktop.md).

This page explains the decisions behind the data structures and the traps a change is likely to
walk into. Every limit quoted here is a named constant; the constant is the source of truth.

## The constraint

V8 caps a string at 2^29 − 24 characters, and a few hundred megabytes of small JS objects are
enough to stall a tab in garbage collection. A multi-gigabyte document therefore never exists as
one string or one object graph:

- the file is the source of truth and stays on disk (a `Blob`, or a file handle on the desktop);
- structure is a tape of byte offsets, built in workers;
- values are decoded from bounded slices when they are shown, and nothing larger than a slice is
  ever decoded.

**Bytes are the only unit.** Every offset the engine stores or returns is a UTF-8 byte offset into
the source it indexes. There are no character offsets and no line arrays. Offsets cross the RPC as
JS numbers, which are exact to 2^53.

The lint rule `quipu/no-whole-document-materialization` fails `JSON.parse`, `TextDecoder#decode`,
`Blob#text` and the like in `packages/core` and `packages/formats`, except in
[`boundedSlice.ts`](../../packages/core/src/boundedSlice.ts). Every function there takes a byte
limit and throws `SliceTooLargeError` above it.

## Where things run

| Thread                                                                            | Owns                                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| UI thread                                                                         | the typed client; it holds node references and pages of results, never a tape                                       |
| coordinator ([`engine.worker.ts`](../../apps/web/src/engine/engine.worker.ts))    | `EngineHost` ([`document.ts`](../../packages/core/src/document.ts)): open documents, tapes, edits, the worker pools |
| scan workers ([`scan.worker.ts`](../../apps/web/src/engine/scan.worker.ts))       | one region at a time: summarize, structure, unescape, search, format                                                |
| format workers ([`format.worker.ts`](../../apps/web/src/engine/format.worker.ts)) | region jobs of a conversion (see [Formats](formats.md))                                                             |
| jq worker ([`jq.worker.ts`](../../apps/web/src/engine/jq.worker.ts))              | one jq run, terminated at its time limit                                                                            |

There are `min(16, navigator.hardwareConcurrency)` scan workers. The coordinator is itself a
worker so that merging region tapes and answering queries never block painting. `packages/core`
has no DOM and no React, so the same code runs the property and differential tests in Node and the
product in Chromium and Electron.

## Sources

A source is anything that answers bounded reads (`ByteSource` in
[`source.ts`](../../packages/core/src/source.ts)):

- a `File` or `Blob` on the web, read with a BYOB reader into a buffer the worker owns;
- a `MessagePort` on the desktop, served by the main process from one file handle, with reads of
  at most `MAX_DOCUMENT_READ_BYTES` (64 MiB,
  [`documentSource.ts`](../../packages/contracts/src/documentSource.ts));
- a `SharedArrayBuffer` for a nested document's unescaped bytes;
- a window over an edited document's pieces (`pieces` in
  [`pieceSource.ts`](../../packages/core/src/pieceSource.ts)), for re-indexing, search and save.

A port moves to whichever worker it is sent to, so the coordinator gives each scan worker a port
of its own, relayed through its own (`fork()` on the port source, `Pool.openEach`), and a worker
that replaces a stopped one needs a fresh fork. A desktop read is a structured clone, because
Electron's `MessagePortMain` cannot transfer a buffer; it is slower than reading a renderer `File`,
which is why a file dropped onto the desktop window takes the web path.

The engine refuses a source over `MAX_TAPE_SOURCE_BYTES` (4 GiB − 1) at open, because tape offsets
are u32.

## Tape layout

The tape ([`tape.ts`](../../packages/core/src/tape.ts)) is seven parallel typed arrays, 25 bytes
per token: `kind` u8, `start` u32, `end` u32, `parent` i32, `next` i32 (next sibling), `childCount`
u32 and `keyStart` u32, the offset of the member key's opening quote. `NO_KEY` (`0xffffffff`) marks
array elements and the root; `INHERITED_KEY` (`0xfffffffe`) marks a value whose key sits in an
earlier region, until the merger patches it.

Children follow their parent in document order, so the first child of token _i_ is _i + 1_ when
`parent(i + 1) === i`; `next` chains siblings; `childCount` is set even when the children are not
on the tape.

Typed arrays rather than objects because tens of millions of tokens fit in a few hundred megabytes
this way and the garbage collector never walks them. u32 offsets rather than f64 because they halve
the two largest columns. The cost is the 4 GiB limit above: supporting larger files means widening
`start` and `end`, not wrapping them.

### Segmented, not merged

Region tapes arrive from the scan workers as transferred buffers, and the document's tape
([`segmentedTape.ts`](../../packages/core/src/segmentedTape.ts)) keeps them as segments instead of
copying them into one array. A token id is `segment base + local index`; segment lookup is a binary
search over the bases with a one-entry cache for monotone walks. `parent` and `next` are rebased to
global ids once per segment when it is adopted, which is the only pass over the arrays.

Copying into a contiguous tape leaves every copied-from buffer as garbage until a major GC, and on
the 2 GiB HAR that garbage alone can push peak memory over the limit the engine is designed for. A
segmented tape has no copy, no garbage and no growth policy.

[`merge.ts`](../../packages/core/src/merge.ts) patches what a region could not know: the end of a
string, number or container that began earlier, sibling links and child counts across the boundary,
a key that sits in an earlier region, and the bucket anchors of containers open at entry.

### Eager depth is a token budget

The eager index goes to full depth unless the tape would pass `DEFAULT_TOKEN_BUDGET` (16 M tokens,
about 400 MB) ([`indexDocument.ts`](../../packages/core/src/indexDocument.ts)). The decision is
made once, from region 0: its structural pass runs at full depth first (it is the first paint
anyway), its token density times the file size projects the whole tape, and if that is over budget
region 0 is structured again at smaller depths (`DEPTH_LADDER`: full, 16, 8, 4, 3, 2, 1, 0) until it
fits. Only then do the other regions run their structural pass. The summarizing pass never waits,
because it does not depend on the depth.

A container at the cut depth keeps its `childCount` and reports `childrenIndexed: false`. Its
children are indexed on demand in buckets of at most `CHILDREN_PAGE_LIMIT` (1,024), the size of a
`children` page. So that a bucket is cheap, the structural pass records anchors for every container
at the cut level: the offset of its first child in each region and of every 1,024th child after
that. A bucket is the byte range between two anchors, indexed as a forest whose roots are the
elements, with no scan from the container's start. An object member anchors at its key, not its
value; when a region boundary falls between a key and its value, or inside the key, the merger
carries the key into the next region's anchor (`pendingCutKey`).

The trap is a wide array. An array of twenty million rows costs half a gigabyte of tape at depth 1
alone and several gigabytes at depth 2; with anchors it costs about twenty thousand anchors.

### Big-string skip list

The structural pass reports every string of 256 KiB or more (`BIG_STRING_BYTES` in
[`scan.ts`](../../packages/core/src/scan.ts)) that closes in its region, at any depth, with its
absolute byte range. The coordinator keeps them in file order. That is how a 600 MiB body is found
without scanning (`largestStrings`), how nested stringified documents are found without decoding
anything, and how an on-demand bucket skips a huge string instead of scanning through it.

## The region pipeline

Regions are `DEFAULT_REGION_BYTES` (8 MiB) and go to the scan workers round-robin in file order.

1. **Summarize** (pass 1) reads a region knowing nothing before it and reports, for both hypotheses
   (the region starts outside a string, or inside one): the depth delta, the minimum depth, the last
   significant byte, the string open at exit and the unmatched opens; plus the trailing backslash
   run and whether the region is only backslashes.
2. **Resolve** ([`resolve.ts`](../../packages/core/src/resolve.ts)) chains the summaries in file
   order into every region's true entry state: depth, in-string, whether the first byte is escaped,
   the previous significant byte, the container kind of each open level, and where an open string
   began. This is O(regions).
3. **Structure** (pass 2) emits tokens with the true entry state. Regions run in parallel; no region
   is scanned twice.
4. **Adopt** takes the region tape as a segment and patches it in.

A worker summarizes its region keeping the bytes, waits until every earlier summary has arrived,
structures the region, transfers the tape and drops the bytes, so bytes in flight are bounded by
workers × region size. Each worker owns one region buffer, one step buffer and one tape builder
for its whole life ([`jobs.ts`](../../packages/core/src/jobs.ts)); a fresh buffer per region leaves
dead buffers behind faster than V8's external-memory heuristics collect them.

### Boundaries inside strings and escapes

A quote is escaped iff an odd run of backslashes precedes it. Each summary reports its trailing
backslash run, and whether the whole region is backslashes so runs chain across regions, which
gives the next region its "first byte is escaped" bit. When that bit is set and the region's first
non-backslash byte is a quote, pass 1 counted a toggle that did not happen, so every state after it
is inverted: the resolver reads the opposite hypothesis and flips the quote parity. Numbers and
literals that straddle a boundary are finished by the next region, possibly across several.

The differential test ([`differential.test.ts`](../../packages/core/src/differential.test.ts)) runs
tiny region sizes so that a boundary lands inside every kind of token and escape, including the long
backslash runs of a value stringified several times. `JSON.stringify` of a leaf stringified _k_
times has 2^k − 1 backslashes before each quote: build such needles and expectations in tests, do
not type them.

### Native scans with memoized cursors

Pass 2 skips string bodies with `indexOf` (quote, then backslash), and pass 1 does the same for
stretches with no structural byte, such as a base64 body. Where structure is dense, both stay a
per-byte class-table loop.

The trap: `TypedArray.prototype.indexOf` has no end bound. Calling it once per string for a byte
that is rare in the region (a backslash in a plain array, a bracket in a base64 body) rescans the
rest of the region per call, which is quadratic. Every such search is memoized (the next occurrence
per byte class, searched again only when the cursor passes it), so each byte class costs one native
scan per region. Do not call `indexOf` for a rare byte without a memo.

### Reading while the index runs

The first rows must appear long before the whole index is done, so `root`, `children` and `keyText`
answer from the merged prefix while later regions index. The merger knows exactly which tokens a
later region can still change (`unsettledTokens`: containers open at the end of what has merged,
and a string or number cut by the boundary); everything else is final. A growing container is
listed with `settled: false`, and its `range.end` and `childCount` are lower bounds until the
`indexProgress` event says `done`; views list it again then. A page that would contain a cut
string or number waits for the index instead, so no scalar's byte range is ever provisional.
`node`, `text` and every decode wait for a settled token.

Keep that refusal. A test that walks `children` early and then reads a scalar's `range` would
otherwise read the placeholder end of a cut string.

## Where a document is not JSON

The structural pass is also the validator, so a valid file costs no second pass. At every byte it
already visits outside strings it checks a mask of what may come next, updated token by token; it
checks each complete scalar against `true`, `false`, `null` and the number grammar, and each escape
where the string scan meets a backslash. Each region reports its first problem (`SyntaxCode`), the
merger keeps the earliest, and the final entry state adds the two problems only the end can show:
an unterminated string and an unclosed container. The `problem` request turns the offset into a
line and a column on demand, counting newlines in 8 MiB reads.

What it does not detect, by design:

- control characters and invalid UTF-8 inside strings, because checking them means visiting every
  string byte, which `indexOf` skipping avoids;
- an escape or a scalar cut in two by a region boundary, and, at a boundary, whether the string
  just before it was a key.

The scan keeps indexing past a problem, so the tree shows what it read, and the UI says the
document is not valid for as long as it is open. More closes than opens stop at the root instead
of driving the depth negative.

## Memory accounting

Nothing in the scan is sized by `maxDepth`. "Full depth" is `FULL_DEPTH` (2^20), a sentinel that
means "unbounded", and a sentinel that stands for "unbounded" must never size an allocation: with
tiny regions in the differential test, a few arrays of `maxDepth + 1` per region exhaust any
machine. Stacks grow with the depth actually reached, and a region of _n_ bytes can close at most
_n_ levels, so per-level reports cover only the levels the region touched.

Peak memory is the JS heap plus ArrayBuffer backing stores over the page and every worker. The
bench samples it with CDP `Runtime.getHeapUsage` on every target
([`scripts/bench/cdpMemory.ts`](../../scripts/bench/cdpMemory.ts)).

### Measurement traps

- `performance.measureUserAgentSpecificMemory` resolves at the next major GC, which Chromium may not
  run for a minute, so it is useless for peaks. The headless shell does not have it at all.
- A sampler that awaits an instantly resolving reading in a loop starves the event loop and
  deadlocks the pool, because worker messages never arrive. Every sampler yields to a timer between
  samples.
- Time the work inside the page, never around a memory reading.
- The first index after generating a fixture is cold; the bench discards one warm-up iteration.

## Deep documents

Nothing in the engine recurses. The structural pass is a loop over bytes with explicit stacks, and
every walker keeps an explicit frame stack, so a document 100,000 levels deep indexes like any
other. Pretty-printing is the trap: a 100,000-deep document with two-space indentation is about
10^10 bytes of output, so the formatter stops growing the indentation at `MAX_INDENT_DEPTH` (256)
levels ([`format.ts`](../../packages/core/src/format.ts)).

## Decoding values

Values are decoded from slices when they are shown, through
[`boundedSlice.ts`](../../packages/core/src/boundedSlice.ts) and
[`decode.ts`](../../packages/core/src/decode.ts). The largest slice is `MAX_SLICE_BYTES` (64 MiB),
the biggest value the product ever materializes (jq's input, a nested body). A member key is at
most `MAX_KEY_BYTES` (1 MiB).

The limit is in the bytes the caller gets: a `text` or `stringHead` request of exactly 64 MiB
succeeds and one byte more fails, whatever the string's raw length. Framing the engine reads around
a value never counts against it: a string's quotes, the lookbehind and tail of an escape-safe piece,
and the 4:3 text behind a base64 head. The 64 MiB also bounds every single read: a string is
unescaped in pieces of at most 64 MiB minus `PIECE_LOOKBEHIND` (256 bytes) and `PIECE_TAIL`
(16 bytes) of content, and a base64 value is decoded in jobs of 3 MiB of output. `truncated` is true
only when the value is longer than the prefix, so a string whose escapes shrink below the limit
comes back whole.

`TextDecoder` refuses a view over a `SharedArrayBuffer`, which is what a nested document's bytes
are; `decodeUtf8` copies within the limit first.

### Nested stringified JSON

A string is a nested document when its unescaped content starts with `{` or `[` after whitespace
and indexes cleanly to one root (`looksLikeJson`, `isCleanIndex`). Detection is on demand, from the
skip list or from a node the user opens. Expansion unescapes the string in parallel: each worker
takes one piece of the escaped content with a 256-byte lookbehind and a 16-byte tail so no escape
is cut (`unescapePiece`), the pieces are written into one `SharedArrayBuffer`, every worker opens
that buffer as a source, and the pool indexes it with the same pipeline (`indexMemory`). A nested
document's node references use their own tape id, and its offsets are offsets into its own bytes.

### Decoders

Detection and decoding live in [`detectString.ts`](../../packages/core/src/detectString.ts),
[`decoders.ts`](../../packages/core/src/decoders.ts) and one module per format (JWT, form, GraphQL,
NDJSON, base64 with gzip and image sniffing, SVG). The UI only receives `Detection`, `Decoded` and
`FramesPage` values.

- **Detect, then decode.** `detect` reads the first 4 KiB (`STRING_HEAD_BYTES`) of a string's
  unescaped bytes plus what the enclosing object says (`mimeType`, `encoding`, the member key) and
  names every decoder that claims it, most specific first. It never reads more, so a 600 MiB body
  is judged like any other string. `decode` checks the kind is among the detections, so a client
  cannot ask for a decode the detector would not offer. Results are memoized per node and kind.
- **What a decode produces.** JWT, form, NDJSON and JSON inside base64 are generated as JSON bytes
  and indexed as a child document, so the tree shows them as ordinary children and edits have one
  mechanism. GraphQL comes back as text. Images and other binary come back as a type and a size;
  `preview` returns an image as a Blob, and SVG is always drawn as an `<img>` over a Blob URL, never
  inline.
- **Bounds.** Inspector text views are 16 KiB. Base64 is classified from the first 16 KiB of
  decoded bytes; the whole value decodes into a Blob in 4 MiB steps (images) or in aligned pieces
  across the workers (JSON text). A decode that needs the whole value refuses above
  `MAX_SLICE_BYTES`. gzip is inflated through `DecompressionStream` and cancelled the moment its
  output would pass the limit, so a decompression bomb costs the limit and not its size.

Traps found against real captures:

- Base64 inside JSON carries the serializer's escapes: PHP writes every `/` as `\/`, and MIME bodies
  wrap with `\r\n`. The decoder reads them as a state machine and counts them (`shifted`), because
  decoding in parallel pieces assumes every piece starts on a 4-character boundary; any shift falls
  back to one worker.
- `"encoding": "base64"` describes the body (`text`), not its siblings. Hinting every string of the
  object calls the words `base64` and `font/woff2` base64 data.
- A bare `{CACHEBUSTER}` or `{uid}` is a valid one-field GraphQL query and is everywhere in ad URLs;
  an anonymous query counts only with a sub-selection, arguments or a spread.
- One `name=value` is a cookie as often as a form. A lone pair is a form only when the object
  declares `application/x-www-form-urlencoded`.

## Search

Search and path queries answer from bytes in the workers; the UI holds only the query, the count,
the current hit and the ranges of the rows on screen
([`searchStore.ts`](../../apps/web/src/documents/searchStore.ts)).
[`search.ts`](../../packages/core/src/search.ts) has the chunk rules and
[`searchRun.ts`](../../packages/core/src/searchRun.ts) the merge.

**What is matched is the text the user sees.** A JSON document is matched as its bytes with the
escapes inside strings replaced by the characters they stand for
([`escapeView.ts`](../../packages/core/src/escapeView.ts)): `é` is `é` and `\"` is `"`. A hit is
reported as the raw byte range it covers, escapes included, so the Source view lights `\"error\"`
when the user typed `"error"`. A text document is matched as it is. This is one level only: text
inside a nested stringified document is matched as its parent string shows it until the user
expands it.

Hits are non-overlapping and leftmost-first, exactly what one scan from byte 0 would report. ASCII
letters fold for a case-insensitive literal; anything else, and every regular expression, folds
through the regex engine. A pattern is compiled with `u` (dropped when the pattern is not valid in
unicode mode) and always `g` and `m`, so `^` and `$` are line anchors and `.` stops at a newline.

**Chunks.** The file is cut into chunks (8 MiB for a literal, 1 MiB for a regex) that idle workers
take in turn. A chunk's edges move to the first position where escape pairing and UTF-8 are known
from the byte before it (`safeBoundary`); both neighbours compute the same edge from the same bytes,
so no coordination is needed, and a file with no such position within 16 MiB hands the rest to the
chunk before it. Inside a chunk, text is decoded in 1 MiB blocks with a byte-offset map that stores
escapes only, and a block without a backslash is matched in place. A hit belongs to the chunk it
starts in and may run 32 KiB of decoded text (`lookView`) past its end. Each chunk scans as if it
were the first; where the merge finds a chunk's first hit inside the previous chunk's last hit, it
scans that chunk again from the end of that hit. A match longer than the lookahead may be cut; such
hits are counted in `limited` and the bar says so. `^`, `\b` and lookbehind see 256 bytes before a
block.

**The regex time limit.** A backtracking regular expression cannot be interrupted inside a worker.
Regex chunks run on a separate pool (up to 8 workers, plus a spare that answers lighting requests
meanwhile), and a worker that overruns `REGEX_BUDGET_MS`
(1.5 s per 1 MiB chunk) is terminated and replaced with the same sources open, and its chunk is
reported as skipped. After 8 skipped chunks the search stops with status `partial`. `packages/core`
takes its timer as a parameter instead of touching global timers. The pool starts a job's timer
when the job is posted, so never post a second job to a worker that has a timed job running: the
queued job would be charged for the one in front of it.

**Hits.** A search keeps the first `MAX_RETAINED_HITS` (262,144) hits; the count stays exact beyond
that. Rows past the retained hits are lit by scanning only their own window on demand (at most
4 MiB), so lighting is exact however many hits there are; next and previous cover the retained
hits. Views read hits through [`useHitSet`](../../apps/web/src/documents/useHitSet.ts).

Over an edited document, search reads the composed bytes a save would write (`openLogicalWindow`),
so hit offsets are document positions with nothing to shift.

### Path queries

[`pathParse.ts`](../../packages/core/src/pathParse.ts) is the grammar: an RFC 9535 subset with
member names, indexes (negative counts from the end), wildcards, slices, `..` and unions. Filters
and functions are refused with a message pointing at jq.

A name step does not list children. It finds the occurrences of `"name"` with the same parallel
search, inside the input nodes' bytes when there are at most 16 of them and in the whole file
otherwise, and asks the tape which of them are member keys of which object. A key written with
escapes is found because search matches decoded text, and a `"name"` inside a string is rejected
because the tape has no key there. Index, wildcard and slice steps page the node's children.
Results keep RFC order: input node by input node, and for `..` the descendants in document order.
A node set is limited to 1,000,000 nodes, and a reply to `MAX_PATH_RESULTS` (10,000) results.

Over an edited document the text search would read the file rather than the edits, so every step
lists children instead (`pathQueryEdited`). On a large edited document a `..name` step is
therefore a walk of the tree, not a parallel scan.

### jq

`jq` reads the selected node's bytes (at most 64 MiB, refused with `JqSubtreeTooLargeError` before
any byte is read) and runs the program in a worker of its own with jq-wasm, terminated at the
request's time limit (100 ms to 60 s, 10 s by default). Output is cut at `JQ_OUTPUT_LIMIT_BYTES`
(4 MiB).

## Edits

The pieces are in [`pieceTable.ts`](../../packages/core/src/pieceTable.ts), the region logic in
[`edits.ts`](../../packages/core/src/edits.ts), the save in
[`save.ts`](../../packages/core/src/save.ts) and the coordinator's use of all three in
[`document.ts`](../../packages/core/src/document.ts). Only JSON and HAR documents are editable;
every other format opens read-only (see [Formats](formats.md)).

### The piece table is an array

A document's bytes are a sequence of pieces `{ buffer, start, length }`: buffer 0 is the append
buffer (every byte an edit introduced, in order, never rewritten), buffer 1 is the original file,
and higher buffers are spill files a transform wrote. The pieces sit in a flat array with a
parallel array of logical starts; lookup is a binary search and a splice is one native array splice
plus a prefix rebuild from the edit point. A balanced tree would make the splice O(log P), but P is
bounded by the number of edits and an array splice stays well under a millisecond at 10^5 pieces.
Abutting pieces of one buffer merge on every splice, so a typing session does not leave one piece
per keystroke for the save to walk.

`replaceRange` returns exactly the pieces it removed, so an undo record is
`{ at, removed, inserted }` and undo is the same splice with the lists swapped. No bytes are copied
for history.

The append buffer ([`appendBuffer.ts`](../../packages/core/src/appendBuffer.ts)) is bytes in
16 MiB `SharedArrayBuffer` chunks, so it grows without copying and the scan workers see new bytes
as soon as they are written; a piece never crosses a chunk. It is never a JS string: `buffer += text`
is the V8 string limit waiting to happen.

### The main tape is never rewritten

Every token on a document's tape keeps the file offset the scanner wrote. An edit re-scans the
smallest value that encloses it (with its key, when it has one) into a side tape and records that
value as a region: a disjoint span of the main tape, in file coordinates, with its current logical
length. Side-tape offsets are relative to the region's start over a frozen window of the pieces,
so an edit elsewhere never invalidates them. The logical position of an unedited token is its file
offset plus the length change of every region that ends before it, a binary search over the
regions. A logical offset is a JS number and is never written back into the u32 tape, where it
would wrap past 4 GiB.

Main-tape tokens under a region are dead. `node` on one fails with `NodeNotFoundError` and the view
asks again from the region's node, whose main-tape reference keeps working because it is answered
from the side tape. Every edit reply carries the re-indexed node; references under the previous one
are stale by contract.

### Regions nest

Every tape that defines a byte space is a level: the document's main tape and the side tape of each
region. An edit descends to the deepest level whose one region holds the whole edited span and
re-scans the smallest enclosing value there, so after a whole-document sort an edit of one member
re-indexes that member on the sorted root's side tape rather than the whole file. A committed region
absorbs the regions it contains at its level and adds its length change to every region above it.
A side tape's source is a frozen window of the pieces, which stays correct under nested edits
because every piece buffer is append-only: positions move, the bytes a token names do not.

Finding the enclosing value is a binary search over the `start` column to the deepest token starting
at or before the edit, then a climb through `parent` until the token's region covers the span. A
span inside a member's key belongs to that member, not to the parent object.

The scan indexes structure leniently, so a clean check is what refuses an edit: exactly one root,
from the first significant byte to the last, with a key iff the region had one. When it fails the
engine climbs to the parent and re-scans that (`"a": 1` typed after a member is valid only as part
of the object); when the root fails too, the splice is rolled back and the edit is refused with
`InvalidEditError`. The tape is never left describing bytes that do not index as one value. This is
not full validation: an unbalanced bracket is refused, a colon inside an array is not.

A region of up to 4 MiB re-indexes in the coordinator from one read; a bigger one runs the pool over
a worker-side window of the pieces, with the same token budget and anchors as a fresh document. The
trap: editing a value under a container the eager index cut re-scans that whole container, which
for a huge flat array is the whole file.

### Nested documents are overlays

An expanded nested document is its own `Doc` with its own piece table over its unescaped bytes.
While it is edited the parent's bytes stay put, and the parent sees it as an overlay: the string's
content span has the escaped length of the child's current bytes. Every parent query that produces
document positions (spans, logical slices, search, save) composes pieces and overlays. Escaped
length is cached per child in 64 KiB blocks, invalidated up the parent chain on every child edit.
A child undone back to its original pieces is clean and no overlay at all, and the parent copies its
original escaped span verbatim, because the file's own escapes (`A` for `A`) would not survive
a re-escape.

An edit of the parent that touches an overlay's span, or whose re-index would cover the string the
child lives in, first commits the child: its re-escaped bytes are spliced into the parent as an edit
of their own, then the child is dropped and its references fail. The commit comes before the
parent's splice, because the parent's edit range is a document position and is only correct against
the pieces that include the child's bytes.

### Transforms

Sort keys, sort an array, format and minify are each one `transform` request and one undoable edit.
The output streams into a spill: a `spill-N.bin` in the journal directory when the document has one,
otherwise shared-memory chunks. The spill becomes a piece buffer and the edit that installs it is an
ordinary splice, so undo is the inverse splice and recovery re-attaches the file without reading it
into memory.

Sorting copies members and elements byte for byte, joined by `,` with no other whitespace, so a
sorted pretty object is compact until it is formatted again. Keys sort by UTF-16 code unit;
elements sort nulls, booleans, numbers, strings in that order, with containers and elements missing
the field last in their original order, and descending reverses only the sortable part. A container
with more than `MAX_SORT_CHILDREN` (1,000,000) children is refused. Formatting a subtree starts at
the node's depth, so its lines sit where formatting the whole document would put them.

On the desktop the workers cannot read a spill the main process holds, so a pretty save of such a
document formats in the coordinator, and search over it is refused until the document is saved.

### Undo, redo and the save point

A document is dirty while the top of its undo stack is not the entry that was on top when it was
opened or last saved. Undoing back to the save point is clean again; undoing past it and then
editing clears the redo stack and the save point with it, and the document stays dirty until the
next save. Every change and every save pushes an `editState` event with the flag, the history
depths and a `revision` that views compare to know when to read again.

### Streamed save

An as-is save copies the pieces to the sink in 8 MiB chunks through one reused buffer. A
pretty-printed or minified save runs [`format.ts`](../../packages/core/src/format.ts) in the scan
workers with the shape of the index pipeline: each worker summarizes its 2 MiB chunk, the entry
states chain in order, the chunk is formatted from its true state and sent back, and the coordinator
writes outputs in file order. A worker does not start a chunk until fewer than 16 outputs are
waiting, which bounds memory to that window plus one chunk per worker. Inside strings the formatter
copies with `indexOf`. Pretty output equals `JSON.stringify(value, null, indent)` byte for byte up to
256 levels of indentation. A dirty nested document is re-escaped where its string sits; the
formatter is inside a string there and copies.

Sinks are a `FileSystemFileHandle` or any `WritableStream`, transferred to the coordinator. A save to
the file the document was read from changes the bytes the engine is reading, so the app opens the
saved file again after any save to a file.

### Journals and replay

A document opened with a `journalKey` (`kind:rest`) journals its edits in a `JournalStore`
([`journal.ts`](../../packages/core/src/journal.ts)) under `journals/<kind>/<rest>/`:

- `append.bin`: every inserted byte, in commit order;
- `journal.ndjson`: one record per edit, undo or redo, naming bytes by offset;
- `meta.json`: the lengths of the two logs;
- `spill-N.bin`: a transform's output.

On the web the store is OPFS through sync access handles in the coordinator
([`opfsJournalStore.ts`](../../packages/core/src/opfsJournalStore.ts)); on the desktop it is the
state directory, reached over a port (see [Desktop shell](desktop.md)). The original file is never
copied.

A commit is three durable writes in order: bytes, record line, meta. Open cuts both logs back to what
meta says, or meta back to the last whole line when a file is shorter, so a crash anywhere loses at
most the edit in flight; [`journal.test.ts`](../../packages/core/src/journal.test.ts) cuts the power
at each of the three writes. Replay goes through the same `edit` path the user took, so the
recovered document has the same piece table and the same undo stack. Nested documents are named by
the document-logical offsets of the strings that were expanded, which replay reproduces in order. The
journal is not compacted between saves: a long session without a save keeps every record.

Records only ever describe edits to the file whose key they sit under:

- A save to another place (a download, Save As) leaves the logs alone. The file the document was
  opened from still lacks the edits.
- A save in place (`save` with `inPlace`) starts the logs over at the save point (`journalFrom`).
  The page then sends `rekeyJournal` with the saved file's key: its fingerprint on the web, its size
  and modification time on the desktop. The engine copies the logs there, edits made in between
  included, so a crash after more edits offers back exactly those.
- An undo below `journalFrom` has no record the saved file could take, so it empties the logs, and
  they stay empty until Redo comes back to that point.
- `open` with `discardJournal`, or `dropJournal` (Discard in the unsaved-changes question), resets
  the logs.

Traps:

- A journal that fails to replay must never keep the file from opening. Replay rolls the document
  back to the file, resets the journal and sets `restoreFailed`; the page says the edits could not
  be restored.
- While records wait to be replayed, nothing is answered from the merged prefix
  (`replayPending`), because the prefix shows the document before its edits.
- Replay runs inside the document's `indexed` promise, so nothing on the replay path may wait for
  `indexed`. External queries do; the replay path resolves references directly (`docAtPath`).
- An OPFS `replace` writes a `.tmp` sibling and moves it; the sync handle on the target is closed
  first, because two handles on one file fail.

## Formats, detection and conversion

`open` reads the first 4 KiB and [`detect.ts`](../../packages/core/src/detect.ts) names the file
`json` (the first significant byte opens an object or an array), `har` (that object's first member
is `"log": {`) or `text`. The format platform in `packages/formats` then reads up to 64 KiB and
names JSONC, NDJSON, YAML, TOML, XML, CSV and TSV. No file is refused: anything unplaced is text.

JSON and HAR are indexed over the file's own bytes. Every other structured format is converted to
JSON bytes in the workers and the JSON is indexed, because the index, the queries and the edits all
speak JSON; the file's own bytes stay what the Source view shows and what an unedited save writes.
`DocumentInfo.structure` says which applies: `native` (the index is over the file, or over bytes at
the same offsets, which is the JSONC case), `converted` (node ranges are offsets in the JSON, not in
the file) or `none` (text, with no tree). Converted formats open read-only, because an edit would
be an edit to the JSON and a save could not write it back in the file's format; `InvalidEditError`
refuses it before it reaches the pieces. A text document is not indexed at all, `root` answers
`NodeNotFoundError` for it, and `headText` returns its first bytes.

Detection rules, the conversion pipeline and what each target cannot represent are in
[Formats](formats.md).

## The Source view

The Source view shows the file's bytes, virtualized by byte offset, and never holds a line array or
the document. The engine answers `sourceRows` (the rows around an offset, colored) and `nodeAt` (the
nodes that hold an offset); the UI draws what it is given.

### Rows and wrapping

A row is a line, or a piece of a long one ([`sourceRows.ts`](../../packages/core/src/sourceRows.ts)).
A minified 2 GiB HAR is a single line, so rows are also cut on a grid anchored at the line's start
and moved forward to a code point: the first row holds `wrapBytes` bytes, and the later grid points
are `wrapBytes` minus the line's hang (its leading spaces and tabs plus two, at most half the width)
minus an eighth of the width apart. The view draws the hang as an indent. A wrapped row starts just
after the last space in the eighth before its grid point, when there is one, so prose is not cut
inside a word; that eighth is why the grid is narrower than the width, so a row that starts early
still fits. Each row start depends only on its grid point and the bytes just before it, so the row
that holds an offset is still found without walking the line. The grid is never anchored at an
absolute offset, so a normal file's short lines are never cut.

Finding the row that holds an offset must not scan back to byte 0 through a 2 GiB line, so lines are
also cut wherever they cross a multiple of `SOURCE_LINE_BLOCK_BYTES` (1 MiB), and the backward search
for a line start reads at most one block, in growing steps from 4 KiB. The cost of a screen follows
the screen, not the file.

Traps the property test against a front-to-back model found:

- A newline exactly on a block boundary belongs to the row before it, not to an empty row at the
  boundary, in both directions.
- A row ending at a block boundary and a row ending at a newline at the same offset are different
  rows: the newline is searched up to and including the row's limit, or a full-width line grows a
  phantom empty row.
- Walking back one row at a time must reuse the line start while the row stays in the line;
  searching again per row reads a megabyte per step on a single-line file.
- A trailing newline ends the last row; it does not open an empty one.

### Line numbers

Newlines are counted from byte 0 in 1 MiB steps, cached per document, and only within
`SOURCE_LINE_NUMBER_LIMIT_BYTES` (64 MiB) of the start. Past that a row has no line number and the
gutter shows its byte offset, which is also exact. The column (UTF-16 units from the line's start)
is computed only within one block, and it is what lets shiki's per-line tokens be laid on the rows
of a small file.

### Colors from the index

Small files (up to `SHIKI_MAX_BYTES`, 1 MiB, in
[`sourceHighlight.ts`](../../apps/web/src/documents/sourceHighlight.ts)) are highlighted by shiki on
the Oniguruma WASM engine ([`syntaxHighlighting.ts`](../../apps/web/src/lib/syntaxHighlighting.ts);
the JS regex engine can backtrack catastrophically). Larger JSON and HAR documents are colored from
the structural index by [`sourcePaint.ts`](../../packages/core/src/sourcePaint.ts), so no tokenizer
ever sees the whole document.

The painter takes the tape's tokens for the visible range and that range's bytes. The tape does not
store `:`, `,`, `}`, `]`, whitespace or the inside of a string, so those are read from the gaps
between tokens, which is a scan of the visible range only. Its output is
`(kind, enclosing object depth, container)` per token, and the theme's syntax table maps that to a
color; the painter has no colors of its own. `gather` collects the tokens: those containing the
range's first byte (a binary search by start, then the parent chain), then every token whose key or
value starts in the range, including the on-demand buckets of a cut container through the same
`bucketTape` that `children` uses.

Traps:

- A window can begin inside a string, an escape or a run of backslashes. Escape pairing is only
  right from a byte that follows a non-backslash, so the painter steps back to one (within 64 bytes,
  from a 4 KiB lookback read) before pairing. `\\\\n` is the case: pairing one byte off swallows the
  `n` into an escape.
- A key straddling the window start is painted from its `keyStart`.
- The two painters must agree. The source e2e renders documents through both and compares the
  computed color of every character under every built-in palette and several recorded Open VSX
  themes. The built-in palettes give `:` and `,` the same color, so a swapped colon is invisible
  there; Dracula colors them differently, which is what catches it.

### Edited documents

An edited document's rows are cut from its logical bytes. The tapes keep the offsets they were
scanned with, so `gatherLogical` walks them level by level in their own coordinates and moves every
token it yields into document positions (`docLogical`): by the regions before it, plus the region's
start for a side tape, plus the growth of dirty nested strings before it. Dead main-tape tokens are
dropped, so the painter gets the tokens a fresh index of the edited bytes would give, and `nodeAt`
uses the same walk. [`editViews.test.ts`](../../packages/core/src/editViews.test.ts) holds all of it
to a fresh open of the saved bytes.

The switch is whether the index has moved (`indexMoved`: any region, or a dirty nested document), not
whether the bytes differ from the file. Undoing every edit leaves the bytes equal to the file's but
the region in place, and the main tape's tokens under it are still dead.

### The UI side

[`sourceWindow.ts`](../../apps/web/src/documents/sourceWindow.ts) keeps one window of rows (the
screen plus a margin each side) and moves inside it for free; it asks again only near an edge, for a
jump or for a new width. A view resting on the end of the file stays there when its rows are laid out
again, and the gutter is as wide as the largest offset so that scrolling never changes how many
characters fit a row.

The view's code is loaded by hand ([`LazySourceView.tsx`](../../apps/web/src/documents/LazySourceView.tsx))
and preloaded when a document opens, not through `React.lazy`: a `Suspense` boundary that has shown
its fallback holds the content back for 300 ms, which is the whole first-screen time limit.

## The RPC contract

Every request and reply crosses `postMessage` and is decoded with the schemas in
[`packages/contracts/src/engine.ts`](../../packages/contracts/src/engine.ts). Node references are
`{ documentId, tapeId, token }`: tape 0 is the document's own tape, and other tape ids hold buckets,
nested documents and edit regions, each with offsets into its own source. Errors are
`Schema.TaggedError` classes that encode to plain objects for the trip and decode back to instances.

Every collection, string and count on the wire has a maximum in the schema, so an oversized reply or
request fails to decode instead of materializing a document on the UI thread:

| What                                                          | Limit                                |
| ------------------------------------------------------------- | ------------------------------------ |
| `children`, `rows`, `harEntries` pages                        | 1,024 nodes (`CHILDREN_PAGE_LIMIT`)  |
| `text`, `slice`, `stringHead`, `decodeBase64Head`, `headText` | 64 MiB (`MAX_SLICE_BYTES`), exact    |
| a member key                                                  | 1 MiB (`MAX_KEY_BYTES`)              |
| a row preview                                                 | 4,096 bytes (`MAX_PREVIEW_BYTES`)    |
| a search text, path or jq program                             | 4,096 characters (`MAX_QUERY_CHARS`) |
| hit ranges per reply                                          | 4,096 (`MAX_HIT_RANGES`)             |
| path results; one result's path text                          | 10,000; 4,096 characters             |
| jq output                                                     | 4 MiB (`JQ_OUTPUT_LIMIT_BYTES`)      |
| Source rows per request; bytes per row                        | 2 × 256; 16 to 4,096 (`wrapBytes`)   |
| a document name; a worker error's detail; a note              | 4,096; 4,096; 512 characters         |

A `ByteRange` whose end is before its start does not decode, and a `slice` may not name a range
wider than 64 MiB. The contract tests decode each bound at its maximum and refuse maximum + 1.

## Cross-origin isolation

`SharedArrayBuffer` exists only on a cross-origin isolated page, and the engine needs it for nested
expansion, the append buffer and decoded children. Isolation takes `Cross-Origin-Opener-Policy:
same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the document and on every worker
script. Command-line switches that expose `SharedArrayBuffer` without isolation leave
`crossOriginIsolated` false and are not used.

| Host            | Where the headers come from                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vite dev server | `server.headers` in [`apps/web/vite.config.ts`](../../apps/web/vite.config.ts)                                                                                               |
| `vp preview`    | `preview.headers`, same file                                                                                                                                                 |
| Electron        | the `quipu://` and `quipu-dev://` scheme handlers, on every response (`withDocumentHeaders` in [`ElectronProtocol.ts`](../../apps/desktop/src/electron/ElectronProtocol.ts)) |
| The hosted site | [`apps/marketing/public/.htaccess`](../../apps/marketing/public/.htaccess)                                                                                                   |

Traps:

- `webRequest.onHeadersReceived` never sees a custom-scheme document, so in Electron the headers must
  be on the protocol response itself. An unprivileged scheme has an opaque origin and no isolation
  whatever the headers say.
- A browser that cached the document before the headers existed keeps the old policy, because a 304
  revalidation does not carry COOP. One hard reload fixes it.
- Under COEP, an `<img>` without `crossorigin` and a `fetch` with `mode: "no-cors"` from a host that
  sends no `Cross-Origin-Resource-Policy` fail with `ERR_BLOCKED_BY_RESPONSE`. The theme browser
  fetches Open VSX icons with CORS and shows them as Blob URLs for that reason
  ([`openVsxThemes.ts`](../../apps/web/src/openVsxThemes.ts)).

## Performance

The large-file behavior is measured, not assumed, on generated fixtures:

- `vp run fixtures` writes them to `~/.cache/quipu/fixtures/` from one seed, streamed
  ([`scripts/fixtures`](../../scripts/fixtures)). The 2 GiB HAR has the shape of a browser export,
  including a 600 MiB base64 body, nested stringified bodies up to 60 MiB and WebSocket messages;
  there is also a 2 GiB wide array and a 100,000-level deep document. Every consumer goes through
  `requireFixture`, which refuses a file that is missing, undersized or lacks the generator's
  sidecar, because a sparse file of the right size has no content.
- The e2e tests in [`apps/web/e2e`](../../apps/web/e2e) time what the user sees on the 2 GiB HAR, on
  the median of five runs: first rows and first map paint after a drop (1 s each), a literal search
  over the file (2 s), the first screen of the 600 MiB body and the Source view on it (300 ms each),
  and expanding the 60 MiB nested body (200 ms). A missed time is printed; set
  `QUIPU_ENFORCE_BUDGETS=1` to make it fail the test.
- `vp run bench` ([`scripts/bench/run.ts`](../../scripts/bench/run.ts)) builds the app with its
  bench page, serves it with the isolation headers, and times the engine requests inside the page:
  first map paint, full index, peak memory, literal search, the big body's first screen, nested
  expansion, an edit, an edit after a whole-document transform, save throughput and memory growth,
  and opening the deep document. It writes `bench/results/chromium.json`, and `vp run bench:table`
  prints it again.

For scale: on a recent 16-core desktop, the 2 GB HAR fixture shows its first rows in about 0.8 s, a
literal search with about 32,000 hits takes about 1.2 s, and a 60 MiB nested body expands in under
0.2 s.
