import { definePlugin } from "@oxlint/plugins";

import namespaceNodeImports from "./rules/namespace-node-imports.ts";
import noGlobalProcessRuntime from "./rules/no-global-process-runtime.ts";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noManualEffectRuntimeInTests from "./rules/no-manual-effect-runtime-in-tests.ts";
import noNativeTitleTooltip from "./rules/no-native-title-tooltip.ts";
import noOutsetStateIndicators from "./rules/no-outset-state-indicators.ts";
import noRawResizeObserver from "./rules/no-raw-resize-observer.ts";
import noRawSvgPaint from "./rules/no-raw-svg-paint.ts";
import noSnapshotAssertions from "./rules/no-snapshot-assertions.ts";
import noTestInLoop from "./rules/no-test-in-loop.ts";
import noUnscopedHas from "./rules/no-unscoped-has.ts";
import noWholeDocumentMaterialization from "./rules/no-whole-document-materialization.ts";
import preferCatchTags from "./rules/prefer-catch-tags.ts";
import requireCenteredScrollGutter from "./rules/require-centered-scroll-gutter.ts";
import requireSuppressionReason from "./rules/require-suppression-reason.ts";

export default definePlugin({
  meta: {
    name: "quipu",
  },
  rules: {
    "namespace-node-imports": namespaceNodeImports,
    "no-global-process-runtime": noGlobalProcessRuntime,
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    "no-native-title-tooltip": noNativeTitleTooltip,
    "no-outset-state-indicators": noOutsetStateIndicators,
    "no-raw-resize-observer": noRawResizeObserver,
    "no-raw-svg-paint": noRawSvgPaint,
    "no-snapshot-assertions": noSnapshotAssertions,
    "no-test-in-loop": noTestInLoop,
    "no-unscoped-has": noUnscopedHas,
    "no-whole-document-materialization": noWholeDocumentMaterialization,
    "prefer-catch-tags": preferCatchTags,
    "require-centered-scroll-gutter": requireCenteredScrollGutter,
    "require-suppression-reason": requireSuppressionReason,
  },
});
