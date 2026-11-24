import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("quipu/no-snapshot-assertions", {
  filename: "fixture.test.ts",
});

describe("quipu/no-snapshot-assertions", () => {
  rule.valid("allows value assertions", `expect(render()).toBe("Open file");`);

  rule.valid(
    "allows toEqual and toMatchObject",
    `expect(bytes).toEqual(expected);\nexpect(a).toMatchObject({ b: 1 });`,
  );

  rule.valid(
    "allows a property that only resembles a snapshot name",
    `expect(a).toMatchSnapshotLike();`,
  );

  rule.invalid("reports toMatchSnapshot", `expect(render()).toMatchSnapshot();`, (output) => {
    assert.match(output, /toMatchSnapshot is not allowed/);
  });

  rule.invalid(
    "reports toMatchInlineSnapshot",
    `expect(render()).toMatchInlineSnapshot(\`"Open file"\`);`,
  );

  rule.invalid(
    "reports toMatchFileSnapshot",
    `await expect(render()).toMatchFileSnapshot("./out.txt");`,
  );

  rule.invalid(
    "reports toThrowErrorMatchingSnapshot",
    `expect(() => open()).toThrowErrorMatchingSnapshot();`,
  );

  rule.invalid(
    "reports toThrowErrorMatchingInlineSnapshot",
    `expect(() => open()).toThrowErrorMatchingInlineSnapshot();`,
  );

  rule.invalid("reports a negated matcher", `expect(render()).not.toMatchSnapshot();`);

  rule.invalid("reports a computed matcher name", `expect(render())["toMatchSnapshot"]();`);

  rule.invalid(
    "reports a matcher read without a call",
    `const check = expect(render()).toMatchSnapshot;`,
  );
});
