import { describe, expect, it } from "vite-plus/test";

import { cleanJqMessage } from "./jqMessage.ts";

// What jq-wasm writes to stderr for each kind of failure, captured from the real tool.
describe("jq's messages", () => {
  it("drops the stdin location from a runtime error", () => {
    expect(
      cleanJqMessage('jq: error (at /dev/stdin:0): Cannot index string with string ("data")'),
    ).toBe('Cannot index string with string ("data")');
    expect(cleanJqMessage("jq: error (at /dev/stdin:0): boom")).toBe("Boom");
    expect(cleanJqMessage('jq: error (at /dev/stdin:0) (not a string): {"code":2}')).toBe(
      'Error: {"code":2}',
    );
  });

  it("keeps a compile error's program and caret on their own lines, aligned", () => {
    expect(
      cleanJqMessage(
        "jq: error: syntax error, unexpected end of file at <top-level>, line 1, column 6:\n    .data[\n         ^\njq: 1 compile error",
      ),
    ).toBe("Syntax error, unexpected end of file (line 1, column 6):\n.data[\n     ^");
    expect(
      cleanJqMessage(
        "jq: error: $y is not defined at <top-level>, line 1, column 12:\n    .a as $x | $y\n               ^^\njq: 1 compile error",
      ),
    ).toBe("$y is not defined (line 1, column 12):\n.a as $x | $y\n           ^^");
  });

  it("leaves a message from elsewhere as it is", () => {
    expect(cleanJqMessage("jq did not finish in 100 ms and was stopped.")).toBe(
      "jq did not finish in 100 ms and was stopped.",
    );
  });
});
