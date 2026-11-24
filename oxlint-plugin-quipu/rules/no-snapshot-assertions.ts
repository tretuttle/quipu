import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName } from "../utils.ts";

// Vitest and Jest matcher names. A snapshot asserts "same as last time", which a regression
// writes straight into the expected value.
const SNAPSHOT_MATCHERS = new Set([
  "toMatchSnapshot",
  "toMatchInlineSnapshot",
  "toMatchFileSnapshot",
  "toThrowErrorMatchingSnapshot",
  "toThrowErrorMatchingInlineSnapshot",
]);

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow snapshot assertions; tests assert the rendered text, geometry, or bytes written.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        const property = getPropertyName(node.property);
        if (Option.isNone(property) || !SNAPSHOT_MATCHERS.has(property.value)) return;
        context.report({
          node: node.property,
          message: `${property.value} is not allowed: a snapshot records whatever the code produced last time, so a regression becomes the expected value. Assert the text the user sees, the geometry in the viewport, or the bytes written to disk.`,
        });
      },
    };
  },
});
