# Third-party notices

Quipu includes source code and assets adapted from the projects below. Each is credited here with
its license. Packages that Quipu installs as dependencies are not listed here: the web build collects
their notices, with the entries of `third-party-licenses.config.json`, into the list the app shows under
Settings → Open source licenses.

A project below whose material is part of the app needs an entry in that list too, so that its notice
goes out with every build and not only with the source. T3 Code, shadcn/ui, coss ui and Excalidraw are
`customNotices` in `third-party-licenses.config.json`; vscode-textmate and Shiki are dependencies, so
theirs are collected already.

Several of these projects use the MIT License. Its text is printed once, under T3 Code; each MIT
entry below gives its own copyright notice, to which that same permission notice applies.

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

## shadcn/ui and coss ui

- Projects: shadcn/ui (https://github.com/shadcn-ui/ui) and coss ui (https://github.com/cosscom/ui)
- License: MIT, both
- Copyright (c) 2023 shadcn
- Copyright (c) 2025 coss.com and Origin UI

T3 Code built its UI component library from components of these two registries, and Quipu's
`apps/web/src/components/ui` descends from it.

## vscode-textmate and Shiki

- Projects: vscode-textmate (https://github.com/microsoft/vscode-textmate), in the fork Shiki
  publishes as `@shikijs/vscode-textmate`, and Shiki (https://github.com/shikijs/shiki)
- License: MIT, both
- Copyright (c) Microsoft Corporation
- Copyright (c) 2021 Pine Wu
- Copyright (c) 2023 Anthony Fu <https://github.com/antfu>

`apps/web/src/syntaxTableResolver.ts` reimplements, in TypeScript, the theme-rule resolution and
scope matching of `@shikijs/vscode-textmate` 10.0.2 (`parseTheme`, `resolveParsedThemeRules`,
`ThemeTrieElement` and `_scopePathMatchesParentScopes`) and the default foreground of
`@shikijs/primitive` 4.2.0 (`normalizeTheme`), so that an imported theme colors JSON the way Shiki
would without loading the highlighter.

## Excalidraw

- Project: Excalidraw
- Source: https://github.com/excalidraw/excalidraw
- License: MIT
- Copyright (c) 2020 Excalidraw

No Excalidraw source file is included. The drawing element model in `packages/canvas/src/elements.ts`
follows the shape of Excalidraw's elements, and the canvas adopts several of its constants and
conventions: the zoom limits and wheel zoom in `packages/canvas/src/camera.ts`, the hit threshold in
`editor.ts`, the snap distance in `snapping.ts`, and the text box sizing in `text.ts` and
`apps/web/src/components/board/boardPaint.ts`.

## Patched dependencies

`patches/` holds two patches that pnpm applies to installed packages. Both came with T3 Code, and
each contains lines of the package it changes.

- `patches/@effect__vitest@4.0.2.patch` changes `@effect/vitest` 4.0.2
  (https://github.com/Effect-TS/effect). License: MIT. Copyright (c) 2023 Effectful Technologies Inc.
- `patches/@pierre%2Fdiffs@1.5.2.patch` changes `@pierre/diffs` 1.5.2: the code view and its search,
  the virtualized file, the editor's search panel, the resize manager, the file header and the
  package manifest. License: Apache License 2.0. Copyright 2025 Pierre Computer Company.

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1.  Definitions.

    "License" shall mean the terms and conditions for use, reproduction, and
    distribution as defined by Sections 1 through 9 of this document.

    "Licensor" shall mean the copyright owner or entity authorized by the
    copyright owner that is granting the License.

    "Legal Entity" shall mean the union of the acting entity and all other
    entities that control, are controlled by, or are under common control with
    that entity. For the purposes of this definition, "control" means (i) the
    power, direct or indirect, to cause the direction or management of such
    entity, whether by contract or otherwise, or (ii) ownership of fifty percent
    (50%) or more of the outstanding shares, or (iii) beneficial ownership of
    such entity.

    "You" (or "Your") shall mean an individual or Legal Entity exercising
    permissions granted by this License.

    "Source" form shall mean the preferred form for making modifications,
    including but not limited to software source code, documentation source, and
    configuration files.

    "Object" form shall mean any form resulting from mechanical transformation
    or translation of a Source form, including but not limited to compiled
    object code, generated documentation, and conversions to other media types.

    "Work" shall mean the work of authorship, whether in Source or Object form,
    made available under the License, as indicated by a copyright notice that is
    included in or attached to the work (an example is provided in the Appendix
    below).

    "Derivative Works" shall mean any work, whether in Source or Object form,
    that is based on (or derived from) the Work and for which the editorial
    revisions, annotations, elaborations, or other modifications represent, as a
    whole, an original work of authorship. For the purposes of this License,
    Derivative Works shall not include works that remain separable from, or
    merely link (or bind by name) to the interfaces of, the Work and Derivative
    Works thereof.

    "Contribution" shall mean any work of authorship, including the original
    version of the Work and any modifications or additions to that Work or
    Derivative Works thereof, that is intentionally submitted to Licensor for
    inclusion in the Work by the copyright owner or by an individual or Legal
    Entity authorized to submit on behalf of the copyright owner. For the
    purposes of this definition, "submitted" means any form of electronic,
    verbal, or written communication sent to the Licensor or its
    representatives, including but not limited to communication on electronic
    mailing lists, source code control systems, and issue tracking systems that
    are managed by, or on behalf of, the Licensor for the purpose of discussing
    and improving the Work, but excluding communication that is conspicuously
    marked or otherwise designated in writing by the copyright owner as "Not a
    Contribution."

    "Contributor" shall mean Licensor and any individual or Legal Entity on
    behalf of whom a Contribution has been received by Licensor and subsequently
    incorporated within the Work.

2.  Grant of Copyright License. Subject to the terms and conditions of this
    License, each Contributor hereby grants to You a perpetual, worldwide,
    non-exclusive, no-charge, royalty-free, irrevocable copyright license to
    reproduce, prepare Derivative Works of, publicly display, publicly perform,
    sublicense, and distribute the Work and such Derivative Works in Source or
    Object form.

3.  Grant of Patent License. Subject to the terms and conditions of this
    License, each Contributor hereby grants to You a perpetual, worldwide,
    non-exclusive, no-charge, royalty-free, irrevocable (except as stated in
    this section) patent license to make, have made, use, offer to sell, sell,
    import, and otherwise transfer the Work, where such license applies only to
    those patent claims licensable by such Contributor that are necessarily
    infringed by their Contribution(s) alone or by combination of their
    Contribution(s) with the Work to which such Contribution(s) was submitted.
    If You institute patent litigation against any entity (including a
    cross-claim or counterclaim in a lawsuit) alleging that the Work or a
    Contribution incorporated within the Work constitutes direct or contributory
    patent infringement, then any patent licenses granted to You under this
    License for that Work shall terminate as of the date such litigation is
    filed.

4.  Redistribution. You may reproduce and distribute copies of the Work or
    Derivative Works thereof in any medium, with or without modifications, and
    in Source or Object form, provided that You meet the following conditions:

    (a) You must give any other recipients of the Work or Derivative Works a
    copy of this License; and

    (b) You must cause any modified files to carry prominent notices stating
    that You changed the files; and

    (c) You must retain, in the Source form of any Derivative Works that You
    distribute, all copyright, patent, trademark, and attribution notices from
    the Source form of the Work, excluding those notices that do not pertain to
    any part of the Derivative Works; and

    (d) If the Work includes a "NOTICE" text file as part of its distribution,
    then any Derivative Works that You distribute must include a readable copy
    of the attribution notices contained within such NOTICE file, excluding
    those notices that do not pertain to any part of the Derivative Works, in at
    least one of the following places: within a NOTICE text file distributed as
    part of the Derivative Works; within the Source form or documentation, if
    provided along with the Derivative Works; or, within a display generated by
    the Derivative Works, if and wherever such third-party notices normally
    appear. The contents of the NOTICE file are for informational purposes only
    and do not modify the License. You may add Your own attribution notices
    within Derivative Works that You distribute, alongside or as an addendum to
    the NOTICE text from the Work, provided that such additional attribution
    notices cannot be construed as modifying the License.

    You may add Your own copyright statement to Your modifications and may
    provide additional or different license terms and conditions for use,
    reproduction, or distribution of Your modifications, or for any such
    Derivative Works as a whole, provided Your use, reproduction, and
    distribution of the Work otherwise complies with the conditions stated in
    this License.

5.  Submission of Contributions. Unless You explicitly state otherwise, any
    Contribution intentionally submitted for inclusion in the Work by You to the
    Licensor shall be under the terms and conditions of this License, without
    any additional terms or conditions. Notwithstanding the above, nothing
    herein shall supersede or modify the terms of any separate license agreement
    you may have executed with Licensor regarding such Contributions.

6.  Trademarks. This License does not grant permission to use the trade names,
    trademarks, service marks, or product names of the Licensor, except as
    required for reasonable and customary use in describing the origin of the
    Work and reproducing the content of the NOTICE file.

7.  Disclaimer of Warranty. Unless required by applicable law or agreed to in
    writing, Licensor provides the Work (and each Contributor provides its
    Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied, including, without limitation, any
    warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or
    FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining
    the appropriateness of using or redistributing the Work and assume any risks
    associated with Your exercise of permissions under this License.

8.  Limitation of Liability. In no event and under no legal theory, whether in
    tort (including negligence), contract, or otherwise, unless required by
    applicable law (such as deliberate and grossly negligent acts) or agreed to
    in writing, shall any Contributor be liable to You for damages, including
    any direct, indirect, special, incidental, or consequential damages of any
    character arising as a result of this License or out of the use or inability
    to use the Work (including but not limited to damages for loss of goodwill,
    work stoppage, computer failure or malfunction, or any and all other
    commercial damages or losses), even if such Contributor has been advised of
    the possibility of such damages.

9.  Accepting Warranty or Additional Liability. While redistributing the Work or
    Derivative Works thereof, You may choose to offer, and charge a fee for,
    acceptance of support, warranty, indemnity, or other liability obligations
    and/or rights consistent with this License. However, in accepting such
    obligations, You may act only on Your own behalf and on Your sole
    responsibility, not on behalf of any other Contributor, and only if You
    agree to indemnify, defend, and hold each Contributor harmless for any
    liability incurred by, or claims asserted against, such Contributor by
    reason of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS
```

## DM Sans

- Project: DM Sans
- Source: https://github.com/googlefonts/dm-fonts
- License: SIL Open Font License 1.1
- Copyright 2014 The DM Sans Project Authors

The marketing site bundles DM Sans in `apps/marketing/src/assets/fonts`. The full license text ships
beside it in `apps/marketing/public/fonts/dm-sans-OFL.txt`.

## Test data

`apps/web/src/testFixtures/open-vsx` holds responses recorded from the Open VSX registry
(https://open-vsx.org), used only by tests. They contain four color themes, unchanged, each under the
MIT License:

- Dracula Official (`dracula-theme.theme-dracula` 2.25.1). Copyright (c) 2016 Dracula Theme
- Catppuccin for VSCode (`catppuccin.catppuccin-vsc` 3.19.0). Copyright (c) 2021 Catppuccin
- Nord (`arcticicestudio.nord-visual-studio-code` 0.19.0).
  Copyright (C) 2017-present Arctic Ice Studio <development@arcticicestudio.com> (https://www.arcticicestudio.com),
  Copyright (C) 2017-present Sven Greb <development@svengreb.de> (https://www.svengreb.de)
- Tokyo Night (`enkia.tokyo-night` 1.1.2). Copyright (c) 2018-present Enkia

`packages/core/src/query.test.ts` uses the example document of RFC 9535, "JSONPath: Query Expressions
for JSON" (https://www.rfc-editor.org/rfc/rfc9535), with the results the RFC lists for its example
queries. Copyright (c) 2024 IETF Trust and the persons identified as the document authors; code
components of an RFC are licensed under the Revised BSD License of the IETF Trust's Legal Provisions
(https://trustee.ietf.org/license-info).
