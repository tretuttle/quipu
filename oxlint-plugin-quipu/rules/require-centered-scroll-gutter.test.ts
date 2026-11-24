import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("quipu/require-centered-scroll-gutter", {
  filename: "fixture.tsx",
});

describe("quipu/require-centered-scroll-gutter", () => {
  rule.valid(
    "allows a scroller that does not center",
    `const el = <div className="overflow-y-auto flex-col">content</div>;`,
  );

  rule.valid(
    "allows a centering element that does not scroll",
    `const el = <div className="flex flex-col items-center">content</div>;`,
  );

  rule.valid(
    "allows a centered scroller that reserves the gutter",
    `const el = <div className="flex flex-col items-center overflow-y-auto scrollbar-gutter-both">content</div>;`,
  );

  rule.valid(
    "allows an arbitrary stable gutter",
    `const el = <div className="flex flex-col items-center overflow-auto [scrollbar-gutter:stable_both-edges]">content</div>;`,
  );

  rule.valid(
    "allows a centered scroller that hides its scrollbar",
    `const el = <div className="flex flex-col items-center overflow-auto [scrollbar-width:none]">content</div>;`,
  );

  rule.valid(
    "allows a centered child of a scroller that reserves the gutter",
    `const el = <div className="overflow-y-auto scrollbar-gutter-both"><div className="mx-auto max-w-prose">x</div></div>;`,
  );

  rule.invalid(
    "reports a column scroller that centers its items",
    `const el = <div className="flex flex-col items-center overflow-y-auto">content</div>;`,
    (output) => {
      assert.match(output, /scrollbar-gutter-both/);
    },
  );

  rule.invalid(
    "reports a row scroller that centers with justify-center",
    `const el = <div className="flex flex-row justify-center overflow-auto">content</div>;`,
  );

  rule.invalid(
    "reports a gutter that only applies in one branch",
    `const el = <div className={cn("flex flex-col items-center overflow-auto", wide && "scrollbar-gutter-both")}>content</div>;`,
  );

  rule.invalid(
    "reports a gutter behind a responsive variant",
    `const el = <div className="flex flex-col items-center overflow-auto lg:scrollbar-gutter-both">content</div>;`,
  );

  rule.invalid(
    "reports a scroller whose descendant centers itself with mx-auto",
    `const el = <div className="overflow-y-auto"><div className="mx-auto max-w-prose">x</div></div>;`,
  );
});
