# Contributing to Quipu

Quipu is a pnpm monorepo built with [Vite+](https://viteplus.dev) (`vp`). The web app and the
Electron desktop app are built from the same code in `apps/web`.

## Prerequisites

- **Node.js 24.21.0**, the version pinned in `mise.toml`. With [mise](https://mise.jdx.dev),
  `mise install` sets it up, along with `vp` and `node_modules/.bin` on your `PATH`.
- **pnpm 11.10.0**, the version pinned by `packageManager` in `package.json`. Corepack
  (`corepack enable`) or mise will pick it up.
- **Vite+** as `vp`. After the first install, the workspace's own copy in `node_modules/.bin/vp` is
  the one to use, so tests, lint and builds all run on the pinned version.
- To build the Linux desktop package: **ImageMagick** (`magick`), for the icon sizes.

## Install

```sh
vp i
```

This runs `pnpm install` and sets up the Git pre-commit hook, which formats staged files.

## Run the app

```sh
vp run dev                 # web app on http://localhost:5300 (set PORT to change it)
```

The desktop app runs against the web dev server. Keep `vp run dev` running and, in another terminal:

```sh
VITE_DEV_SERVER_URL=http://localhost:5300 vp run dev:desktop
```

It rebuilds the main process on change and restarts Electron. `vp run start:desktop` starts the
built desktop app instead.

## Commands

| Command                     | What it does                                                          |
| --------------------------- | --------------------------------------------------------------------- |
| `vp run dev`                | Web app dev server                                                    |
| `vp run dev:desktop`        | Desktop app against the web dev server (see above)                    |
| `vp run dev:marketing`      | Marketing site dev server                                             |
| `vp run build`              | Build every app                                                       |
| `vp run build:desktop`      | Build the web app and the desktop main process                        |
| `vp run typecheck`          | Type-check every package                                              |
| `vp run lint`               | Lint with oxlint and the project rules                                |
| `vp run fmt`                | Format everything                                                     |
| `vp run fmt:check`          | Check formatting without writing                                      |
| `vp run check`              | Format check, lint and typecheck: run this before opening a PR        |
| `vp run test`               | Unit tests in every package                                           |
| `vp run test:e2e`           | End-to-end tests (web in headless Chromium, desktop through Electron) |
| `vp run test:desktop-smoke` | Launch the built desktop app and check that it starts without errors  |
| `vp run fixtures`           | Generate the large test fixtures                                      |
| `vp run bench`              | Run the engine benchmarks against the fixtures                        |
| `vp run demo <flow>`        | Record a demo clip of the built app (see below)                       |
| `vp run knip`               | Report unused files, dependencies and exports                         |
| `vp run licenses:sync`      | Regenerate the third-party license notices shown in Settings          |
| `vp run dist:desktop:linux` | Package `release/Quipu-<version>-x86_64.AppImage`                     |
| `vp run dist:desktop:win`   | Package `release/Quipu-<version>-x64.exe` (run on Windows)            |

Inside one package, `vp test run <files>` runs just the tests you name.

The end-to-end tests drive Chromium through `playwright-core`. Install its browser once with
`node apps/desktop/node_modules/playwright-core/cli.js install chromium`.

### Large test fixtures

Quipu has to stay fast on files up to 2 GiB, so some tests and the benchmarks run against large
generated files rather than committed ones. `vp run fixtures` writes them to
`~/.cache/quipu/fixtures/`, deterministically from a fixed seed (`vp run fixtures -- --seed 7` picks
another; `vp run fixtures har-50m.har` generates just the files you name). The full set takes several
gigabytes of disk. Tests that need one of the large fixtures skip when it is absent (the small ones
are generated on the fly), so you only need them when you work on the engine, the formats or
performance.

The fixture generator and the benchmarks run inside a `systemd-run --user` scope capped at 8 GiB, so
a runaway process cannot take the machine down with it. Where systemd cannot create that scope (no
systemd user session, a container, macOS or Windows), they run directly and say so. Set
`QUIPU_MEMORY_GUARD=0` to skip the scope on purpose.

The tests on the 2 GiB files also measure time budgets: how long until the first rows or the map
appear after a drop, a search over the whole file, opening a large embedded body. Each budget is
judged on the median of five runs, and every sample is printed (set `QUIPU_E2E_TIMINGS` to a file
path to collect them there too). The budgets describe the product on a quiet machine with all its
cores, so by default a missed budget is only reported. Set `QUIPU_ENFORCE_BUDGETS=1` to make a
missed budget fail the test, for example when you measure a performance change.

A few decoder tests were written against a set of 12 real HAR captures that are not distributed
with the repository. If you have them, set `QUIPU_HAR_SAMPLES` to their directory; otherwise those
tests skip. The decoder tests that use generated samples always run.

### Demo clips

`vp run demo <flow>` builds the web app, plays a scripted walk through it in headless Chromium, and
renders the recording as a short clip with a camera that zooms toward each click and a drawn cursor.
The flows are `map` (expand, decode and search a document on the Map), `edit` (edit in the Tree and
export as YAML) and `board` (draw on a new board). It needs the Chromium that `playwright-core`
installs (see above) and `ffmpeg` on your `PATH`, built with `libwebp` and `libx264`. Each run writes
`<flow>.webp` and `<flow>.mp4` to `demo-out/<flow>/`, which git ignores; `--out <dir>` writes
elsewhere, `--url <url>` records an app that is already running, and `--render-only` renders the
last recording again without the browser.

`vp run test:e2e` also records each flow once against the built app, so a flow whose step no longer
finds its element fails there.

## Repository layout

| Path                  | Contents                                                                      |
| --------------------- | ----------------------------------------------------------------------------- |
| `apps/web`            | The React app: shell, views, map and settings                                 |
| `apps/desktop`        | The Electron wrapper: main process, preload, IPC, native file access, updates |
| `apps/marketing`      | The Astro marketing site                                                      |
| `packages/contracts`  | Effect Schema contracts for everything that crosses a worker or IPC boundary  |
| `packages/shared`     | Small runtime utilities shared by the apps, imported by subpath               |
| `packages/core`       | The byte-level document engine: indexing, the piece table, search and slices  |
| `packages/formats`    | Format adapters, serializers and converters                                   |
| `packages/canvas`     | Scene model, layout, hit testing, virtualization and the drawing tools        |
| `oxlint-plugin-quipu` | The project's custom lint rules, each with tests                              |
| `scripts`             | Desktop packaging, fixtures, benchmarks, demo clips and license notices       |

`docs/internals` explains each part in more depth: [the document engine](docs/internals/document-engine.md),
[formats](docs/internals/formats.md), [the web UI](docs/internals/web-ui.md) and
[the desktop app](docs/internals/desktop.md).

## Architecture rules

These are enforced by lint where possible. A change that breaks one will not be merged.

- **The UI thread never parses, searches or transforms a document.** The engine runs in workers. UI
  code reaches it only through the typed client in `apps/web/src/engine/client.ts` and the engine
  contracts in `@quipu/contracts`; importing `@quipu/core` or `@quipu/formats` from UI code fails
  lint. A new capability over a document is a new engine method, not UI code.
- **Bytes are the only unit.** Offsets are UTF-8 byte offsets into the original file. No character
  offsets, no line arrays, and no copies of the whole document: `JSON.parse`, `TextDecoder#decode`,
  `Blob#text` and similar calls fail lint in the engine, the formats and the web app's document
  and engine code, outside `packages/core/src/boundedSlice.ts` and the few files `vite.config.ts`
  exempts by name, each with its reason.
- **Colors come from theme tokens**, in class names and in SVG and canvas paint alike. Node fills,
  edges, selection and the drawing ink palette are theme roles, never color literals.
- **`apps/web/src/components/ui` exports own their look.** Pick a `variant` or `size`; do not restyle
  a component with `className`. Layout classes (width, flex, margin, position) belong on the parent.
  If no variant fits and the look is generic, add a variant to the component; a look that belongs to
  one feature stays in that feature's component.
- **Use `observeResize`**, never a raw `ResizeObserver`, and avoid continuously repainting animations.
- **Every way in has a way out.** Collapse needs expand, pin needs unpin. A feature reachable from the
  map is usually also reachable from the Tree and Source views, the command palette and a
  keybinding; check each.

## Tests

- Test what the user sees: rendered text and geometry, or bytes written to disk. Do not assert on
  internal store state or on callback wiring.
- No snapshot tests; `toMatchSnapshot` and its relatives fail lint.
- Never wait on sleeps or polling. A test that needs a timeout to pass is wrong.
- The app talks to no host but its own, apart from Open VSX for theme search. Every web end-to-end
  test fails if its page reaches another host; a test that means to reach one lists it in
  `externalHosts` and answers it from fixtures.
- Parsers, serializers, converters and the piece table get property tests (`it.prop` from
  `@effect/vitest`) and differential tests against an independent implementation.

## Pull requests

- One change per pull request, with a [Conventional Commits](https://www.conventionalcommits.org)
  title in plain language, for example `fix(web): the map no longer drops frames while panning`.
- Describe the problem, how you fixed it, and how you checked it. UI changes need before and after
  screenshots; motion needs a short video.
- Run `vp run check` and the tests for the packages you touched before you push.
