# Quipu

Open, search, decode, edit, diff, and inspect JSON and HAR files locally in the browser or desktop app. Tested up to a `2.00 GB` (`1.86 GiB`) HAR and `100 MiB` JSON, with a hard `4 GiB - 1 byte` source address limit. Renders with Canvas2D, SVG, and DOM, with no WebGPU requirement, no backend, and no accounts.

![Quipu showing a HAR capture grouped by host and request on the map alongside the inspector](docs/images/map.png)

## When to use `jq` or DevTools instead

- Use `jq` or `rg` for files under a few dozen megabytes, scripted pipelines, and CI jobs where you already know the exact path you want.
- Use browser DevTools for live step-debugging and inspecting traffic while a tab is running.
- Use Quipu when you have a multi-hundred-megabyte or multi-gigabyte HAR or JSON dump on disk, nested base64 or stringified JSON payloads inside it, or edits you need to save back without copying the file into memory.

## What Quipu does

- **Linked views.** Switch between Map (HAR grouped by host, page, and request), virtualized Tree, virtualized Table (with a HAR request preset, SVG timing waterfall, and status-colored timeline scrubber), and byte-virtualized Source without losing your selection. Compare opens a two-document diff mode. (Converted read-only formats show an unlinked Source view.)
- **In-place decoding and deep search.** Decode nested stringified JSON, base64, data URLs, gzip streams, JWTs (marked unverified), GraphQL queries, URL-encoded forms, NDJSON, SVG and raster image previews, and HAR WebSocket frames per node, in bulk, or via per-kind auto-decode. Turn on **Deep decode** in the search bar to scan inside encoded payloads up to 8 stringified layers deep and inspect the decode chain.
- **Exact value tracing and match filtering.** Select any scalar to find every exact occurrence across a capture (including encoded payloads), grouped by HAR entry and section with optional transient trace arcs on the map. Toggle **Show matches only** to filter Tree, Map, and Table to matching nodes and their ancestors.
- **Search, JSONPath, and `jq`.** Parallel literal and regex search with worker timeouts, JSONPath queries including `[?(...)]` filter predicates, and `jq` (`jq-wasm 3.0.0`, bundling `jq 1.8.2`) either directly up to `64 MiB` or in per-element streaming mode across larger arrays and HAR captures.
- **Real editing and streaming export.** Edit JSON and HAR values, rename keys, edit subtrees (`F2`), sort objects or arrays, format, and minify with unlimited undo/redo and crash-recovery journals. Search works immediately after sorts and reformats without saving first. Export to JSON, YAML, TOML, XML, CSV, TSV, or NDJSON with pre-flight structural checks.
- **Diff, schema, and type generation.** Compare two JSON files structurally (with array identity matching and Myers LCS) or match HAR captures by `(method, url_without_fragment, _resourceType)` with `F7` stepping and inline body diffs. Infer shapes across every record, validate against local JSON Schema (draft 2020-12 and draft-07), and generate types for nine targets (TypeScript, Rust, Go, Python dataclasses, Python Pydantic, Kotlin, C#, Swift, and JSON Schema).
- **Map annotations and themes.** Draw shapes, sticky notes, freehand ink, and node-bound arrows on standalone boards or over the map, and export the visible or whole map to PNG or SVG (up to `8192 px`). Includes six named themes plus Graphite, a `7:1` contrast High Contrast palette, an OKLCH editor, and VS Code theme import.

![HAR request table with SVG waterfall and timeline scrubber in Quipu](docs/images/table.png)

![HAR capture diff with inline body diff in Quipu](docs/images/compare.png)

![Decoding nested payloads inside Quipu](docs/images/decode.png)

## How it works

Quipu reads JSON and HAR files from disk in `8 MiB` slices (`Blob.slice` in the browser, `fs.read` over `MessageChannelMain` in Electron) instead of loading the entire file into memory. Up to 16 parallel `scan.worker` threads scan regions in two passes using dual-hypothesis string parity, then adopt the per-region arrays into a `SegmentedTape` (25 bytes per token, `Uint32Array` byte offsets up to `4 GiB - 1 byte`). Containers past the eager token budget store `1,024`-entry bucket anchors and index on demand when expanded.

Edits go into a zero-copy `PieceTable`, side-tapes, and crash-recovery journals stored in OPFS (browser) or `~/.quipu/userdata` (desktop). When OPFS is unavailable, in-place save (`detach()`) and transform spills fall back to an in-memory `Blob`. Search, path queries, `jq`, table views, and diffs read through the logical edited view. Multi-record operations (per-element `jq` across four pooled `jq-wasm` workers, streaming HAR capture diff, monoid-merged schema inference, and HAR validation) stream bounded `<= 64 MiB` child batches through `elementMap`.

## Download

Prebuilt desktop binaries for Windows (`x64` installer) and Linux (`x86_64` AppImage) are available on the [Releases](https://github.com/tretuttle/quipu/releases/latest) page (unsigned; checksums in `SHA256SUMS.txt`).

## Build from source

### Requirements

- Windows (`x64`) or Linux (`x86_64`) for desktop builds
- Node.js `24.13.1+`
- pnpm `11.10.0`

```sh
git clone https://github.com/tretuttle/quipu.git
cd quipu
pnpm install
```

Run locally:

```sh
pnpm dev:web       # browser app
pnpm dev:desktop   # Electron desktop app
```

Build and package:

```sh
pnpm build                # build web, desktop, and marketing apps
pnpm dist:desktop:win     # Windows x64 NSIS installer (release/)
pnpm dist:desktop:linux   # Linux x86_64 AppImage (release/)
```

Tests and checks:

```sh
pnpm check                # format, lint, and typecheck
pnpm test                 # unit tests
pnpm test:e2e             # end-to-end tests
```

## License

MIT. See [LICENSE](LICENSE). Third-party components and adapted codebases are credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
