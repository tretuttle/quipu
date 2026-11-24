/**
 * How the value editor reads what the user typed. This is the user's text,
 * never the document: the document's bytes stay in the engine.
 */
export type EditorValueType = "string" | "number" | "boolean" | "null" | "object" | "array";

/**
 * What the typed text writes: a JSON value, or, for text that starts like JSON
 * and is not, nothing until the user says to keep it as a string (`asText`).
 */
export type EditorValue =
  | {
      readonly valid: true;
      /** The JSON text the engine writes. */
      readonly json: string;
      readonly type: EditorValueType;
    }
  | {
      readonly valid: false;
      /** What is wrong, in a sentence. */
      readonly problem: string;
      /** The JSON string the text is written as when the user keeps it as text. */
      readonly asText: string;
    };

const typeOf = (value: unknown): EditorValueType => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    default:
      return "object";
  }
};

/** Text made only of what numbers are written with, starting like one: `1.2.3`, `007`, `-1e`. */
const NUMBER_LIKE = /^-?\.?\d[\d.eE+-]*$/;

/** The parser's reason, in the words the rest of the app uses for a place in text. */
const reasonOf = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  if (/end of JSON input|end of data/i.test(message)) return "it ends before the value is complete";
  const reason = message
    .replace(/ in JSON at position \d+ \(line (\d+) column (\d+)\)/, " at line $1, column $2")
    // V8 repeats the whole text after an unexpected token; the editor already shows it.
    .replace(/, ".*" is not valid JSON$/s, "")
    .replace(/\.$/, "");
  return reason === "" ? "it does not parse" : reason.charAt(0).toLowerCase() + reason.slice(1);
};

/** The first character says JSON was meant: an object, an array or a quoted string. */
const startsLikeJson = (trimmed: string) =>
  trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"');

/**
 * Text that is one JSON value becomes that value (`42`, `true`, `"text"`,
 * `{"a":1}`). Text that starts like JSON or reads like a number but is not
 * valid (`[1,2`, `007`) is not written: a slip would otherwise become a string
 * silently. Any other text becomes a string.
 */
export function editorValue(text: string): EditorValue {
  const trimmed = text.trim();
  const asText = JSON.stringify(text);
  if (trimmed === "") return { valid: true, json: asText, type: "string" };
  try {
    return { valid: true, json: trimmed, type: typeOf(JSON.parse(trimmed)) };
  } catch (error) {
    if (NUMBER_LIKE.test(trimmed)) {
      return { valid: false, problem: `${trimmed} is not a JSON number.`, asText };
    }
    if (startsLikeJson(trimmed)) {
      return { valid: false, problem: `Not valid JSON: ${reasonOf(error)}.`, asText };
    }
    return { valid: true, json: asText, type: "string" };
  }
}

/**
 * The text an editor starts from. A string shows its content, unless typing
 * that content back would make something else (`42` would become a number),
 * in which case it shows the quoted JSON. Anything else shows its JSON text.
 */
export function editorText(kind: string, text: string): string {
  if (kind !== "string") return text;
  const value = editorValue(text);
  return value.valid && value.json === JSON.stringify(text) ? text : JSON.stringify(text);
}
