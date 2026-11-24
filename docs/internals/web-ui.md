# Web UI

How the React app in [`apps/web`](../../apps/web/src) is put together, for someone adding a screen,
a view or a command. Most of these rules are enforced by lint (the `quipu/*` rules in
[`oxlint-plugin-quipu`](../../oxlint-plugin-quipu/rules) and `@shadcn/lint`, configured per path in
the root [`vite.config.ts`](../../vite.config.ts)); this page gives the reasons and the traps. The
short version is in [CONTRIBUTING.md](../../CONTRIBUTING.md#architecture-rules).

## Components own their look

Controls come from [`components/ui`](../../apps/web/src/components/ui). Pick a `variant` or `size`;
do not restyle one with `className`. Layout classes (width, flex, margin, position) are allowed,
because placement belongs to the parent. `shadcn/no-restyle` fails anything else outside
`components/ui`, and `shadcn/require-static-classes` fails a `className` built at runtime on a `ui`
component, since the restyle check cannot read it.

If no variant fits and the look is a generic concept, add a variant to the component. A look that
belongs to one feature stays in that feature's own component, not in `components/ui`.
`CollapsibleTrigger` is the one exception: it is a bare button with no styled counterpart, so its
`className` is its API. Every other trigger is styled with `render={<Button … />}`.

Do not style a raw `<button>`, `<input>`, `<select>` or `<textarea>` to look like a control a
primitive provides. A raw element is right when it is not that control: semantic rows, tabs, resize
handles, swatches, canvas surfaces, anything whose behavior or geometry differs by design.

The sidebar is the reference for composition.
[`SidebarChrome.tsx`](../../apps/web/src/components/sidebar/SidebarChrome.tsx) exports small slots
(header, brand, width probe) that own their classes, take `className`, spread the rest of their
props and merge classes with `cn`; a slot that needs a control renders `Button` or `SidebarTrigger`.
[`AppSidebarLayout.tsx`](../../apps/web/src/components/AppSidebarLayout.tsx) composes the slots and
owns only layout behavior: width, clamping, persistence, the window-controls inset. Build new UI the
same way. When a call site repeats a treatment another one already uses, make it a variant or a slot
on the shared component instead of copying its markup and classes.

## Styles

Style with Tailwind classes in the component that renders the element.

- Global CSS ([`index.css`](../../apps/web/src/index.css)) is only for what classes on the owning
  component cannot express: imperative DOM, custom elements and shadow roots, animations, runtime
  theme variables, and browser or Electron integration.
- No `style={{ … }}` or inline `<style>` for static values a class covers. Values computed at
  runtime are fine.
- Theme-only rules use `@variant dark` and `@variant light`, not `.dark` selectors.
- Every class must be one Tailwind generates (`shadcn/no-unknown-classes`); a typo ships silently
  unstyled otherwise. Script hooks use data attributes, not class names.
- Appearance values come from the theme and Tailwind's scales (`shadcn/no-arbitrary-values`); only
  layout and per-element transitions may use arbitrary values.
- An arbitrary `:has()` variant must be anchored to a class, attribute, id or tag
  (`quipu/no-unscoped-has`). Chrome evaluates an unanchored `:has()` on every ancestor, so any DOM
  change restyles the whole page.
- A scroller that centers its content needs `scrollbar-gutter-both`
  (`quipu/require-centered-scroll-gutter`), or the content shifts sideways when the scrollbar
  appears.
- No continuously repainting animations: they keep the GPU busy on high-refresh displays for as
  long as they run.

## Colors come from theme tokens

Every color is a theme role, in class names (`shadcn/no-raw-colors`) and in SVG and canvas paint
alike (`quipu/no-raw-svg-paint`, which also covers `packages/canvas`). Node fills, edges, selection
and the drawing ink palette are theme roles, never literals. The map and the drawing layer are where
raw colors would otherwise get in, because `@shadcn/lint` reads class names only.

`quipu/no-raw-svg-paint` is syntactic: it checks string literals, templates without substitutions
and the branches of `?:`, `&&`, `||` and `??` in `fill`, `stroke`, `stopColor`, `color`, inline
style keys and canvas `fillStyle`/`strokeStyle`. A color that arrives through a variable or a call
is not seen, so read it from a theme variable rather than hiding a literal. The map paints rows with
`var(--syntax-…)` ([`syntaxCssVariables.ts`](../../apps/web/src/syntaxCssVariables.ts)) and reads
computed theme variables where it needs a value (`readThemeColor` in
[`mapPaint.ts`](../../apps/web/src/components/map/mapPaint.ts)). The only exemption is the brand mark
in [`Icons.tsx`](../../apps/web/src/components/Icons.tsx).

Focus and selection indicators paint inside their element (`quipu/no-outset-state-indicators`): an
outset ring or a positive outline offset is clipped by any ancestor with `overflow` set. Use
`ring-inset`, or a negative offset at least as wide as the outline.

## The engine is reached through the typed client

The UI thread never parses, searches or transforms a document. It reaches the engine only through
[`apps/web/src/engine/client.ts`](../../apps/web/src/engine/client.ts) and the contract in
`@quipu/contracts/engine`; importing `@quipu/core` or `@quipu/formats` (or any subpath) from web code
fails lint. The worker entry files in [`apps/web/src/engine`](../../apps/web/src/engine) are the
named exceptions. A new capability over a document is a new engine request, not UI code; see
[Document engine](document-engine.md).

Feature code does not call the client directly either. Each area defines the requests it needs as a
small interface (`TreeSource` in [`treeModel.ts`](../../apps/web/src/documents/treeModel.ts),
`SourceClient` in [`sourceWindow.ts`](../../apps/web/src/documents/sourceWindow.ts), `InspectSource`
in [`inspection.ts`](../../apps/web/src/documents/inspection.ts)); the app passes the typed client and
tests pass a fake.

Everything a view gets is bounded: pages of at most 1,024 rows, previews of a few KiB, slices of at
most 64 MiB. Design views to page and window, never to hold a document.

## Shared view state

The Map, Tree and Source views show one document and agree on what is selected, found and decoded.

- **Selection** ([`selectionStore.ts`](../../apps/web/src/documents/selectionStore.ts)). The map and
  the tree set it from the focused node, the Source view from a click and search from a hit. Each
  selection records its origin; every view follows a selection whose origin is not its own, and the
  view that made it does not jump. A selection made by an edit, undo or transform has origin `edit`
  and every view follows it. A selection carries the root-to-node path when it came from a byte
  offset, which is how the tree and the map reach a node they have not listed yet. Selecting the same
  node again bumps a counter, so it still scrolls into view. A new document clears it.
- **Expansion and decoding.** The map is built on the same `TreeModel` as the tree, so expanded nodes
  and decoded values are one state. A row inside a decoded value is selected in the tree alone (the
  Inspector shows it), because its offsets are not the file's; for the same reason search does not
  reach inside decoded values. Automatic decoding is a per-kind preference
  ([`decodePreferences.ts`](../../apps/web/src/documents/decodePreferences.ts)) that never overrides
  a value the user opened or closed by hand.
- **Search** ([`searchStore.ts`](../../apps/web/src/documents/searchStore.ts)). The store holds the
  query, the count and the current hit; views read the hits for their own window through
  [`useHitSet`](../../apps/web/src/documents/useHitSet.ts), whose identity changes only when a new
  search finishes, so views refetch once per search and not once per step. A text document offers
  Find only; path queries and jq need structure.
- **The Source view is linked only when offsets agree.** For a converted format (YAML, CSV, …) node
  ranges are offsets in the generated JSON, not in the file, so the Source view neither follows nor
  makes the shared selection there.

Every way in needs a way out and a way to see it: collapse needs expand, decode needs collapse, a
pin needs an unpin. A behavior reachable from the map is usually also expected from the tree, the
Source view, the command palette and a keybinding.

## Commands and keybindings

Every command has exactly one title and group, in
[`packages/shared/src/commands.ts`](../../packages/shared/src/commands.ts). The command palette,
Settings → Keybindings, tooltips and the desktop menu all read names from there, so a command is
called the same thing everywhere. Titles are sentence case and make sense without their group. The
command ids themselves are a schema in `@quipu/contracts`.

Default shortcuts are `DEFAULT_KEYBINDINGS` in
[`packages/shared/src/keybindings.ts`](../../packages/shared/src/keybindings.ts), each with an
optional `when` expression over a small context (`editableFocus`, `documentOpen`, `documentFocus`,
`treeFocus`, `canvasFocus`, `mapNodeActive`, `searchOpen`, `rightPanelOpen`, `drawSelection`,
`isWeb`, `isDesktop`); an identifier not in the context is false. User keybindings are merged over
the defaults. [`ShellCommandHost.tsx`](../../apps/web/src/components/ShellCommandHost.tsx) listens to
`keydown` in the capture phase, so a focused editor cannot consume a chord such as Mod+B first; it
skips events already handled, composition input, and the keybinding editor's capture field
(`data-keybinding-capture`), and ignores key repeat. Desktop menu actions run through the same
`runShellCommand`.

Shortcuts that share a chord with native editing (Mod+Z, arrows, Delete) must include
`!editableFocus`. [`isEditableFocused`](../../apps/web/src/lib/editableFocus.ts) counts inputs,
textareas, selects, contenteditable and `role="textbox"`, including focus inside an open shadow
root.

**Availability** ([`commandAvailability.ts`](../../apps/web/src/commandAvailability.ts)) maps every
command to what it needs: nothing, a document, a document with structure, an editable selection, the
map, a canvas, a drawing selection, an open board. A command whose surface is not on screen is hidden
from the palette; one whose surface is there but cannot run yet is listed disabled with the reason.
Either way, `mayRun` stops a key or a menu from running it, so nothing is queued for a document that
opens later. Edit commands are the exception: they run and explain why they cannot apply (F2 on a
decoded value says it is read-only), which a silent key press would leave unexplained. A new command
needs an entry in both tables; the types make a missing one a compile error.

## Tooltips

Use `Tooltip`, `TooltipTrigger` and `TooltipPopup` from
[`components/ui/tooltip.tsx`](../../apps/web/src/components/ui/tooltip.tsx), never a native `title`
(`quipu/no-native-title-tooltip`). The browser draws `title` unstyled, after a long delay, and never
for keyboard or touch users. `title` stays allowed on `iframe`, `embed`, `object`, `frame` and
`math`, where it is the accessible name of the embedded content. A tooltip that shows a command uses
the command's title and its current shortcut label.

## Resize observation

Use [`observeResize`](../../apps/web/src/lib/observeResize.ts), never a raw `ResizeObserver`
(`quipu/no-raw-resize-observer`). ResizeObserver callbacks run after layout and before paint, but
React commits state set there after the paint, so layout derived from an observed size lands a frame
late. `observeResize` shares one observer and runs every resize delivered in a frame inside one
`flushSync`, so all size-derived state commits in a single render before that paint. A subscriber
that joins an element already observed still gets an initial entry.

## Hooks and the React Compiler

The app is compiled with the React Compiler, which memoizes a component by the values it reads from
props, state and hooks. A getter on a mutable model (`model.selectedLocation`, `cache.get(id)`) is
invisible to it: the result is cached and the component never updates, although
`useSyncExternalStore` fired. Give `useSyncExternalStore` an immutable snapshot and read from the
snapshot it returns ([`treeLit.ts`](../../apps/web/src/documents/treeLit.ts) is an example, and
`MapView.tsx` reads locations from its snapshot for the same reason).

## Themes

A theme is a set of color roles (`THEME_COLOR_ROLES` in
[`packages/shared/src/themePalettes.ts`](../../packages/shared/src/themePalettes.ts)) for one or both
appearances, plus an optional JSON syntax table per appearance
([`syntaxTable.ts`](../../packages/shared/src/syntaxTable.ts)). The roles become CSS custom
properties on the document root, which is all components and paint ever read.

- **Built-ins and custom themes** live in [`themePalette.ts`](../../apps/web/src/themePalette.ts).
  Roles a theme omits are filled from the Orchid palette. Custom themes are stored in
  `localStorage`; the desktop app syncs the choice to the native window theme.
- **Before React mounts**, an inline script in [`index.html`](../../apps/web/index.html) applies the
  stored theme so the first frame is already the right color. It mirrors the runtime's defaults,
  built-in modes and legacy aliases; [`themeBoot.test.ts`](../../apps/web/src/themeBoot.test.ts)
  holds the two in step, so a change to one needs the other.
- **VS Code themes** import best-effort ([`vscodeThemeImport.ts`](../../apps/web/src/vscodeThemeImport.ts)):
  a complete palette is derived from a visible accent and the editor background, then usable
  workbench colors are layered on top, keeping foregrounds readable and focus and controls distinct
  from their surfaces. `tokenColors` do not feed the palette; they are resolved on their own into the
  syntax table at import ([`syntaxTableResolver.ts`](../../apps/web/src/syntaxTableResolver.ts)),
  with the same TextMate scope matching shiki uses, reimplemented so importing a theme does not load
  the highlighter. The Open VSX browser ([`openVsxThemes.ts`](../../apps/web/src/openVsxThemes.ts))
  feeds the same import.
- **The syntax table colors everything JSON**: the map's rows (through `--syntax-…` variables), the
  structural-index painter in the Source view, and shiki for small files, through a theme built on
  pierre-light or pierre-dark with rules for the JSON scopes appended
  ([`syntaxSourceTheme.ts`](../../apps/web/src/syntaxSourceTheme.ts)). Without a table, the colors
  fall back to pierre's own JSON colors. Map and source therefore always agree.
- **Theme files** (`parseThemeFile` and `serializeThemeFile`) are compatible with T3 Code's theme
  file format: Quipu reads T3 Code theme files and writes files T3 Code can read, keeping its key
  order. The syntax table is an extra optional `syntax` key, written only when the theme has one;
  T3 Code ignores it. [`themeFileRoundTrip.test.ts`](../../apps/web/src/themeFileRoundTrip.test.ts)
  checks the round trip byte for byte, so keep it passing when the file shape changes.

## Tests

Test what the user sees: rendered text and geometry in the viewport, or bytes written to disk. Do not
render components to static markup to assert props, assert callback wiring, or assert internal store
state. Snapshot assertions fail lint (`quipu/no-snapshot-assertions`). A test never waits on a sleep
or a polling loop.

Unit tests (`*.test.ts(x)` under `src`) run in Node against fakes of the engine interfaces above.
End-to-end tests (`apps/web/e2e/*.e2e.ts`, `vp run test:e2e`) drive Chromium through
`playwright-core` against the app with the real engine, and are where views, keyboard behavior and
the large-file time limits are checked. They load the Vite dev server, except the tests that measure
time limits, which build and preview the app: the development build of React is measurably slower.
