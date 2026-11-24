import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("quipu/no-raw-svg-paint", { filename: "fixture.tsx" });

describe("quipu/no-raw-svg-paint", () => {
  rule.valid(
    "allows the keyword paints",
    `
      export const el = (
        <svg>
          <path fill="none" stroke="currentColor" />
          <rect fill="transparent" stroke="inherit" />
        </svg>
      );
    `,
  );

  rule.valid(
    "allows var tokens, with or without a token fallback",
    `
      export const el = (
        <svg>
          <path fill="var(--color-accent)" stroke="var(--color-border, currentColor)" />
        </svg>
      );
    `,
  );

  rule.valid(
    "allows non-literal expressions",
    `
      export const el = (tone: string) => (
        <svg>
          <path fill={tone} stroke={\`\${tone}\`} stopColor={theme.accent} />
        </svg>
      );
    `,
  );

  rule.valid("allows a gradient reference", `export const el = <rect fill="url(#grad)" />;`);

  rule.valid(
    "allows a variant name on a component color prop",
    `export const el = <Badge color="primary" />;`,
  );

  rule.valid(
    "allows token styles",
    `export const el = <rect style={{ fill: "var(--color-accent)", stroke: "currentColor" }} />;`,
  );

  rule.valid(
    "allows literals in keys that are not paint",
    `export const el = <rect style={{ width: "#fff", outline: "red" }} />;`,
  );

  rule.valid(
    "allows canvas paint from a value",
    `
      export const draw = (ctx: CanvasRenderingContext2D, accent: string) => {
        ctx.fillStyle = accent;
        ctx.strokeStyle = "currentColor";
      };
    `,
  );

  rule.valid(
    "allows a literal on an unrelated assignment",
    `const options = {};\noptions.fill = "#fff";`,
  );

  rule.invalid("reports a hex fill", `export const el = <rect fill="#ff0000" />;`, (output) => {
    assert.match(output, /The fill attribute is the color literal #ff0000/);
  });

  rule.invalid("reports a short hex stroke", `export const el = <path stroke="#fff" />;`);

  rule.invalid("reports an rgb stopColor", `export const el = <stop stopColor="rgb(0 0 0)" />;`);

  rule.invalid("reports a named color attribute", `export const el = <text color="red">x</text>;`);

  rule.invalid(
    "reports a literal in an expression container",
    `export const el = <rect fill={"#abc"} />;`,
  );

  rule.invalid(
    "reports a literal in a branch",
    `export const el = (on: boolean) => <rect fill={on ? "#0f0" : "none"} />;`,
  );

  rule.invalid(
    "reports a literal fallback of a var",
    `export const el = <rect fill="var(--x, #000)" />;`,
  );

  rule.invalid(
    "reports a template literal without substitutions",
    "export const el = <rect fill={`#123456`} />;",
  );

  rule.invalid(
    "reports a style key",
    `export const el = <rect style={{ fill: "#123" }} />;`,
    (output) => {
      assert.match(output, /The style key fill/);
    },
  );

  rule.invalid(
    "reports a style key in a conditional style object",
    `export const el = (on: boolean) => <rect style={on ? { stroke: "blue" } : undefined} />;`,
  );

  rule.invalid(
    "reports a canvas fillStyle",
    `export const draw = (ctx: CanvasRenderingContext2D) => { ctx.fillStyle = "#000"; };`,
    (output) => {
      assert.match(output, /The canvas fillStyle/);
    },
  );

  rule.invalid(
    "reports a canvas strokeStyle",
    `export const draw = (ctx: CanvasRenderingContext2D) => { ctx.strokeStyle = "rgba(0, 0, 0, 0.5)"; };`,
  );

  rule.invalid(
    "reports an element style assignment",
    `export const paint = (el: SVGElement) => { el.style.color = "#fff"; };`,
  );
});
