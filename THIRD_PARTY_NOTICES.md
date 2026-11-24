# Third-party notices

Quipu includes source code and assets adapted from the projects below. Each is credited here with
its license. Packages that Quipu installs as dependencies are not listed here: their notices are
generated from `third-party-licenses.config.json` by `vp run licenses:sync` and shown in the app under
Settings → Open source licenses.

## T3 Code

- Project: T3 Code
- Source: https://github.com/pingdotgg/t3code
- License: MIT

Quipu's application shell, its desktop wrapper and much of its tooling started from T3 Code and were
adapted to Quipu's documents and canvas. Most of these files have since been changed, some heavily.
The parts that derive from T3 Code are:

- **UI component library.** `apps/web/src/components/ui`: buttons, menus, dialogs, popovers, selects,
  combobox, autocomplete, command list, sidebar, sheet, toasts, tooltips, toggles, inputs, the color
  picker and their tests.
- **Application shell.** `apps/web/index.html`, `apps/web/src/main.tsx`, `AppRoot.tsx`, `bootstrap.ts`,
  `router.ts`, `routes/__root.tsx`, `routes/index.tsx`, `index.css`, `branding.ts`, `env.ts`,
  `confirmDialog.ts`, `panelAnimations.ts`, `rightPanelStore.ts`, `workspaceTitlebar.ts`, and in
  `apps/web/src/components`: `AppSidebarLayout.tsx`, `Sidebar.tsx`, `sidebar/`, `sidebarWidth.ts`,
  `WorkspaceBreadcrumb.tsx`, `WorkspacePageContainer.tsx`, `WorkspacePageHeader.tsx`, `RightPanel.tsx`,
  `RightPanelResizeHandle.tsx`, `ConfirmDialogHost.tsx`, `MorphIcon.tsx` and `Icons.tsx`.
- **Command palette and keybindings.** `apps/web/src/components/CommandPalette*.ts(x)`,
  `commandPaletteBus.ts`, `apps/web/src/keybindings.ts`, `shellCommands.ts`, the keybindings settings
  page (`components/settings/KeybindingsSettings*`), `packages/contracts/src/keybindings.ts` and
  `packages/shared/src/keybindings.ts`.
- **Settings.** The settings layout, search, navigation, General, About, Storage and Open source
  licenses pages under `apps/web/src/components/settings` and `apps/web/src/routes/settings*.tsx`;
  `hooks/useSettings.ts`, `clientPersistenceStorage.ts`, and the schemas in
  `packages/contracts/src/settings.ts`, `baseSchemas.ts` and `ipc.ts`.
- **Theme pipeline and Appearance settings.** `apps/web/src/themePalette.ts`, `vscodeThemeImport.ts`,
  `openVsxThemes.ts`, `openVsxThemeSearch.ts`, `appearanceFonts.ts`, `appearanceContrast.ts`,
  `lib/color.ts`, `lib/syntaxHighlighting.ts`, `hooks/useTheme.ts`, `hooks/useCustomThemes.ts`, the
  theme boot script in `apps/web/index.html`, the Appearance page and theme editor in
  `apps/web/src/components/settings` (`Theme*.tsx`, `themeEditorStore.ts`, `themeInspector.ts`,
  `FontFamilyPicker.tsx`, `SettingsFontPreviews.tsx`, `PanelAnimationsPreview.tsx`),
  `routes/settings.appearance.tsx`, `packages/shared/src/themePalettes.ts` and `themePreview.ts`, and
  the theme file `apps/web/src/testFixtures/t3-cord-sunrise.theme.json`.
- **Hooks and utilities.** In `apps/web/src/hooks`: `useCopyToClipboard`, `useLocalStorage`,
  `useMediaQuery`, `useNavigateBack`, `useResizableWidth` and `useResizeDrag`. In `apps/web/src/lib`:
  `bootError`, `diffRendering`, `editableFocus`, `formatBytes`, `observeResize`, `storage`, `utils`,
  `visibleAnimation` and `windowControlsOverlay`. In `packages/shared/src`: `HostProcess`, `schemaJson`,
  `symlink`, `thirdPartyLicenses` and `testing/`.
- **Desktop shell.** `apps/desktop/src` (`boot.ts`, `compileCache.ts`, `main.ts`, `preload.ts`,
  `windowControlsInset.ts`, and the `app`, `electron`, `ipc`, `settings`, `updates` and `window`
  directories) and the launcher, development and smoke-test scripts in `apps/desktop/scripts`.
- **Desktop packaging and license notices.** `scripts/build-desktop-artifact.ts` and its test,
  `scripts/lib/resolve-catalog.ts`, `scripts/sync-third-party-license-notices.ts`,
  `scripts/lib/third-party-licenses.ts` and the format of `third-party-licenses.config.json`.
- **Lint plugin.** `oxlint-plugin-quipu`: the plugin entry, its utilities and test helpers, and the
  rules `namespace-node-imports`, `no-global-process-runtime`, `no-inline-schema-compile`,
  `no-manual-effect-runtime-in-tests`, `no-native-title-tooltip`, `no-outset-state-indicators`,
  `no-raw-resize-observer`, `no-test-in-loop`, `no-unscoped-has`, `prefer-catch-tags`,
  `require-centered-scroll-gutter` and `require-suppression-reason`, with their tests.
- **Build and test configuration.** The root `package.json`, `pnpm-workspace.yaml`,
  `tsconfig.base.json`, `vite.config.ts`, `knip.jsonc`, `.gitignore` and `.vite-hooks/pre-commit`;
  `scripts/knip-schemas.ts`; `patches/@effect__vitest@4.0.2.patch`; the `package.json`, `tsconfig.json`
  and `vite.config.ts` of `apps/web`, `apps/desktop`, `packages/contracts` and `packages/shared`; and
  `apps/web/components.json` and `apps/web/vite/tailwind.ts`.
- **Marketing site.** The Astro configuration, layout, pages, `src/lib/site.ts` and font setup of
  `apps/marketing`.
- **Documentation.** `docs/internals/web-ui.md`.

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## DM Sans

- Project: DM Sans
- Source: https://github.com/googlefonts/dm-fonts
- License: SIL Open Font License 1.1
- Copyright 2014 The DM Sans Project Authors

The marketing site bundles DM Sans in `apps/marketing/src/assets/fonts`. The full license text ships
beside it in `apps/marketing/public/fonts/dm-sans-OFL.txt`.

## Test data from Open VSX

`apps/web/src/testFixtures/open-vsx` holds responses recorded from the Open VSX registry
(https://open-vsx.org), used only by tests. They contain the Dracula, Catppuccin Mocha, Nord and
Tokyo Night color themes, which remain the work of their authors under the licenses published with
each extension (Dracula's is MIT, as its recorded manifest states).
