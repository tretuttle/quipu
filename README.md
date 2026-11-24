# Quipu

Quipu is a local-first data canvas. Open a data file, from a few bytes up to a 2 GB HAR, and see it as a map you can
search, decode, edit, convert and draw on. It runs as a web app and as a desktop app built from the same code. There
is no account and no server: your files never leave your machine.

![The Map view: an order document as cards joined by edges, with one order selected](docs/images/map.png)

## What it does

**Open.** Drop a file on the window, paste text, or press Ctrl+O. On the desktop you can also pass a path on the
command line. JSON, JSONC, HAR, NDJSON, YAML, TOML, XML, CSV and TSV open with their structure; anything else opens as
plain text. A malformed JSON file still opens: Quipu shows the line and column of the first problem and the
structure up to that point. Background workers read the file in pieces and index it, so the page stays responsive on
a multi-gigabyte file.

**Look.** Three views share one selection:

- **Map**: the document as a node-link diagram on an infinite canvas, with zoom, pan, a minimap and zoom to fit. Long
  arrays are split into ranges of 1,000, and HAR files are grouped into hosts, pages and requests.
- **Tree**: an outline you can drive from the keyboard, with expand all and collapse all.
- **Source**: the file's own text, colored by type, with the selection highlighted.

An Inspector panel shows the selected value with its decoded forms, image previews and WebSocket frames.

**Search.**

- Find: literal or regular expression, match case, a hit count, next and previous. Hits are highlighted in the Map,
  Tree and Source.
- Path queries such as `$.log.entries[*].request.url`, `$..id`, `[-1]` and slices, with clickable results.
- jq (jq 1.8.2 compiled to WebAssembly) over the whole document or the selection, with a time limit.

**Decode.** Quipu detects encoded values inside a document: JSON stored in a string, base64, on its own or in a
`data:` URL (text, JSON, images shown as images, gzip, other binary summarized), JWTs (header and payload; the
signature is not verified), URL-encoded forms, GraphQL queries, NDJSON, SVG and HAR WebSocket frames. Decode one value
with Ctrl+D or its badge, decode or collapse everything in a selection, or turn on automatic decoding per kind.
Decoded values appear as children in the Map and the Tree.

![Decoded values on the Map: a URL-encoded form, a JSON string and a base64 text opened into their own cards](docs/images/decode.png)

**Edit** (JSON and HAR):

- Change strings, numbers, booleans and null in the Map, Tree, Source or Inspector. Typing JSON into a value
  replaces it with an object or array.
- Open an object or array as JSON text (F2, or from the Inspector), change it and write it back.
- Rename keys. A name the object already has is refused.
- Sort an object's keys, or an array by value or by a field; format or minify a value or the whole document.
- Undo and redo every step (Ctrl+Z, Ctrl+Shift+Z).
- Unsaved edits are kept in a journal. After a reload, or when you open the file again, Quipu offers to restore them.

Edits are stored as a piece table over the original bytes, so the file is never copied into memory to change it.
Search, path queries and jq read the edited document, not the file on disk.

**Save and export.** Save in place, Save As, or download. Export converts the document, edits included, to JSON
(indented or minified), YAML, TOML, XML, CSV, TSV or NDJSON. The export dialog says which targets cannot hold the
data and why, and a conversion that meets a value it cannot write names that value's path instead of writing a partial
file.

**Draw.** Boards are drawings without a document: rectangles, ellipses, diamonds, arrows that stay attached to shapes,
lines, freehand, text, sticky notes, frames, images and an eraser, with a sketchy or clean style, alignment,
grouping, layers and snapping. Frames can be named. The same tools work on top of a document's map, and arrows can
attach to its nodes. Drawings save automatically.

![A board: a request flow drawn with shapes, attached arrows, sticky notes, text and an image](docs/images/board.png)

**Themes.** Seven built-in palettes, each in light and dark, a theme editor, and VS Code color themes, either
imported from a file or installed from [Open VSX](https://open-vsx.org) inside the app.

**Keyboard.** Every command is in the command palette (Ctrl+K) with its shortcut. Shift+? lists the shortcuts, and
Settings → Keybindings rebinds them.

### Formats

| Format           | Opens with structure   | Editable | Size limit for structure |
| ---------------- | ---------------------- | -------- | ------------------------ |
| JSON, HAR        | yes                    | yes      | 4 GiB                    |
| JSONC            | yes                    | no       | 4 GiB                    |
| NDJSON, CSV, TSV | yes, converted to JSON | no       | 4 GiB of converted JSON  |
| XML              | yes, converted to JSON | no       | 4 GiB of converted JSON  |
| YAML, TOML       | yes, converted to JSON | no       | 256 MiB                  |
| Anything else    | no, plain text         | no       |                          |

A file of a known format over its limit opens as plain text, and Quipu refuses any file over 4 GiB. You can search,
query and export the read-only formats, and save them back unchanged; to change one, export it to JSON and open that.

## Privacy

Quipu has no accounts, no server and no telemetry. The only network request it makes is to Open VSX, when you search
for or install a theme. The end-to-end tests enforce this: a test fails if its page asks any other host for anything.
On the web, documents, drawings and settings stay in the browser's own storage for the site (IndexedDB, the origin
private file system and localStorage). On the desktop, drawings and unsaved edits live in `~/.quipu/userdata`, and
settings, keybindings and recent files in the app's user data folder.

## Run it from source

Prerequisites:

- Node.js 24.21.0, pinned in [`mise.toml`](mise.toml). With [mise](https://mise.jdx.dev), `mise install` sets it up.
- pnpm 11.10.0, pinned by `packageManager` in [`package.json`](package.json) (Corepack or mise picks it up).
- [Vite+](https://viteplus.dev) as `vp`. After the first install, use the workspace's copy in `node_modules/.bin`.

```sh
vp i                      # install dependencies
vp run dev                # web app on http://localhost:5300 (set PORT to change it)
```

The desktop app runs against the web dev server. Keep `vp run dev` running, and in a second terminal:

```sh
VITE_DEV_SERVER_URL=http://localhost:5300 vp run dev:desktop
```

To build the desktop packages:

```sh
vp run dist:desktop:linux # release/Quipu-<version>-x86_64.AppImage (needs ImageMagick)
vp run dist:desktop:win   # release/Quipu-<version>-x64.exe, run on Windows
```

Both packages are unsigned. There is no macOS build.

## Tests

```sh
vp run test               # unit tests in every package
vp run test:e2e           # web in headless Chromium, desktop through Electron
vp run fixtures           # generate the large test fixtures in ~/.cache/quipu/fixtures
```

The end-to-end tests need Chromium for `playwright-core`; `CONTRIBUTING.md` has the one-line install. The large
fixtures, including a 2 GB HAR, are generated from a fixed seed and take several gigabytes of disk. Tests that need
one skip when it is missing.

The end-to-end tests on the 2 GB files also time the product. On a 24-core desktop, the first rows of the 2 GB HAR
appear in about 0.8 s, a literal search with about 32,000 hits takes about 1.2 s, a 60 MiB nested body expands in
under 0.2 s, and an edit to a value shows in about 0.1 s. Each timing is checked against a budget on the median of
five runs. By default a missed budget is reported, not failed; set `QUIPU_ENFORCE_BUDGETS=1` to make it fail.

[CONTRIBUTING.md](CONTRIBUTING.md) has every command, the architecture rules and how to send a change.

## Limits

- Only JSON and HAR can be edited. The other formats open read-only; export one to JSON to edit it.
- For converted formats (everything except JSON, JSONC and HAR), the Source view shows the file as written but does
  not follow the selection or show search hits.
- YAML and TOML open with structure up to 256 MiB. Any file over 4 GiB is refused; the tests go up to 2 GB.
- Plain text files get the Source view and Find only.
- Conversions are exact only for what the target can express. XML, for example, cannot tell a one-element array from
  a single value, and TOML cannot hold `null` or a top-level array.
- jq stops after 10 seconds by default. Path queries return at most 10,000 results.
- Unsaved edits belong to one tab at a time. A document that another tab has open with unsaved edits opens without
  them here after a short wait, and says so.
- Whether a file is valid JSON is checked when it opens. After an edit the notice says so; save and reopen to check
  again.
- Desktop builds exist for Linux and Windows only, and they are unsigned.

## Repository layout

- [`apps/web`](apps/web): the React app, including the views, the map and settings.
- [`apps/desktop`](apps/desktop): the Electron wrapper: native file access, saving and the desktop shell.
- [`apps/marketing`](apps/marketing): the marketing site.
- [`packages/core`](packages/core): the document engine: streaming index, piece table, search and bounded slices.
- [`packages/formats`](packages/formats): format detection, readers and converters.
- [`packages/canvas`](packages/canvas): scene model, layout, hit testing and the drawing tools.
- [`packages/contracts`](packages/contracts): typed schemas for everything that crosses a worker or IPC boundary.
- [`packages/shared`](packages/shared): small utilities shared by the apps.

[`docs/internals`](docs/internals) explains the [document engine](docs/internals/document-engine.md),
[formats](docs/internals/formats.md), [the web UI](docs/internals/web-ui.md) and
[the desktop app](docs/internals/desktop.md).

The name: a quipu is the Inca record of knotted cords, strings hanging from strings, a tree of strings that carries
data.

## License

Quipu is released under the [MIT License](LICENSE).

Its application shell and much of its tooling are adapted from [T3 Code](https://github.com/pingdotgg/t3code), which
is also MIT. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) credits it and every other source with its license. The
app lists the notices of those projects and of the packages it is built from under Settings → Open source licenses.
