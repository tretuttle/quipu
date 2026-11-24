import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("quipu/no-raw-resize-observer");

describe("quipu/no-raw-resize-observer", () => {
  rule.valid(
    "allows observeResize",
    `
      import { observeResize } from "~/lib/observeResize";

      export const stop = observeResize(element, () => undefined);
    `,
  );

  rule.valid("allows IntersectionObserver", `new IntersectionObserver(() => undefined);`);

  rule.valid(
    "allows an unrelated member named ResizeObserver on a local object",
    `new fakes.ResizeObserver(() => undefined);`,
  );

  rule.invalid(
    "reports a bare ResizeObserver",
    `new ResizeObserver(() => undefined);`,
    (output) => {
      assert.match(output, /observeResize/);
    },
  );

  rule.invalid(
    "reports globalThis.ResizeObserver",
    `new globalThis.ResizeObserver(() => undefined);`,
  );

  rule.invalid("reports window.ResizeObserver", `new window.ResizeObserver(() => undefined);`);

  rule.invalid("reports self.ResizeObserver", `new self.ResizeObserver(() => undefined);`);

  rule.invalid(
    "reports a computed string name",
    `new globalThis["ResizeObserver"](() => undefined);`,
  );
});
