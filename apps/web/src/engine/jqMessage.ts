/**
 * jq's stderr as the jq bar shows it: without the tool's own prefixes
 * (`jq: error (at /dev/stdin:0):`, `jq: 1 compile error`), with the program
 * line and its caret kept on lines of their own so the caret still points at
 * the place in a monospace block.
 */
export function cleanJqMessage(stderr: string): string {
  const lines = stderr
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^jq: \d+ compile errors?$/.test(line.trim()));
  const [first = "", ...rest] = lines;
  let head = first
    .replace(/^jq: error \(at [^)]*\) \(not a string\): (.*)$/, "Error: $1")
    .replace(/^jq: error \(at [^)]*\): /, "")
    .replace(/^jq: error: /, "")
    .replace(/^jq: /, "")
    .replace(/ at <top-level>, line (\d+), column (\d+):$/, " (line $1, column $2):")
    .replace(/ \(Unix shell quoting issues\?\)/, "");
  // jq's own lines start in lower case after the prefix; a sentence starts with a capital.
  if (first.startsWith("jq:")) head = head.charAt(0).toUpperCase() + head.slice(1);
  // The program and caret lines share jq's indent; drop it so they start at the left edge.
  const body = rest.filter((line) => line.trim() !== "");
  const indent = Math.min(
    ...body.map((line) => line.length - line.trimStart().length),
    Number.POSITIVE_INFINITY,
  );
  const trimmed = Number.isFinite(indent) ? body.map((line) => line.slice(indent)) : body;
  return [head, ...trimmed].join("\n").trimEnd();
}
