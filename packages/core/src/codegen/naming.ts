const isUnicodeLetter = (ch: string): boolean => /\p{L}/u.test(ch);
const isUnicodeDigit = (ch: string): boolean => /\p{N}/u.test(ch);
const isUnicodeAlnum = (ch: string): boolean => /[\p{L}\p{N}]/u.test(ch);
const isUpper = (ch: string): boolean => ch !== ch.toLowerCase() && ch === ch.toUpperCase();
const isLower = (ch: string): boolean => ch !== ch.toUpperCase() && ch === ch.toLowerCase();

/** Splits a key into heck-compatible words (matching Rust heck crate boundaries). */
function splitWords(key: string): string[] {
  const chars = [...key];
  const words: string[] = [];
  let cur = "";

  const flush = () => {
    if (cur.length > 0) {
      words.push(cur);
      cur = "";
    }
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (!isUnicodeAlnum(ch)) {
      flush();
      continue;
    }
    if (cur.length > 0) {
      const prev = chars[i - 1]!;
      const next = i + 1 < chars.length ? chars[i + 1]! : undefined;
      if (isUpper(ch)) {
        if (isLower(prev) || isUnicodeDigit(prev)) {
          flush();
        } else if (isUpper(prev) && next !== undefined && isLower(next)) {
          flush();
        }
      }
    }
    cur += ch;
  }
  flush();
  return words;
}

function capitalizeWord(word: string): string {
  const chars = [...word];
  if (chars.length === 0) return "";
  return chars[0]!.toUpperCase() + chars.slice(1).join("").toLowerCase();
}

function fixStart(s: string, empty: string, digitPrefix: string): string {
  if (s.length === 0) return empty;
  const first = s.charCodeAt(0);
  if (first >= 0x30 && first <= 0x39) return `${digitPrefix}${s}`;
  return s;
}

export function pascal(key: string): string {
  const joined = splitWords(key).map(capitalizeWord).join("");
  return fixStart(joined, "Field", "N");
}

export function camel(key: string): string {
  const words = splitWords(key);
  const joined = words.map((w, i) => (i === 0 ? w.toLowerCase() : capitalizeWord(w))).join("");
  return fixStart(joined, "field", "n");
}

export function snake(key: string): string {
  const joined = splitWords(key)
    .map((w) => w.toLowerCase())
    .join("_");
  return fixStart(joined, "field", "n");
}

export function screaming(key: string): string {
  return snake(key).toUpperCase();
}

const GO_INITIALISMS = new Set([
  "Api",
  "Css",
  "Dns",
  "Html",
  "Http",
  "Https",
  "Id",
  "Ip",
  "Json",
  "Sql",
  "Ssh",
  "Tcp",
  "Tls",
  "Ttl",
  "Ui",
  "Uid",
  "Uri",
  "Url",
  "Utf8",
  "Uuid",
  "Xml",
]);

export function goPascal(key: string): string {
  const sn = snake(key);
  let out = "";
  for (const part of sn.split("_")) {
    if (part.length === 0) continue;
    const w = capitalizeWord(part);
    out += GO_INITIALISMS.has(w) ? w.toUpperCase() : w;
  }
  return fixStart(out, "Field", "N");
}

const IRREGULAR_PLURALS: ReadonlyArray<readonly [string, string]> = [
  ["children", "child"],
  ["people", "person"],
  ["men", "man"],
  ["women", "woman"],
];

export function singular(word: string): string | null {
  const lower = word.toLowerCase();
  for (const [pluralForm, singleForm] of IRREGULAR_PLURALS) {
    if (lower.endsWith(pluralForm)) {
      const splitAt = word.length - pluralForm.length;
      const stem = word.slice(0, splitAt);
      const tail = word.slice(splitAt);
      const tailFirst = tail.charAt(0);
      const single =
        tailFirst.length > 0 &&
        tailFirst === tailFirst.toUpperCase() &&
        tailFirst !== tailFirst.toLowerCase()
          ? singleForm.charAt(0).toUpperCase() + singleForm.slice(1)
          : singleForm;
      return `${stem}${single}`;
    }
  }
  const n = word.length;
  if (lower.endsWith("ies") && n > 4) {
    return `${word.slice(0, n - 3)}y`;
  }
  for (const ending of ["sses", "ches", "shes", "xes", "zes", "uses"]) {
    if (lower.endsWith(ending)) {
      return word.slice(0, n - 2);
    }
  }
  if (
    lower.endsWith("s") &&
    n > 2 &&
    !lower.endsWith("ss") &&
    !lower.endsWith("us") &&
    !lower.endsWith("is")
  ) {
    return word.slice(0, n - 1);
  }
  return null;
}

export const RESERVED_TYPES = new Set([
  "Any",
  "Array",
  "Bool",
  "Boolean",
  "Box",
  "Dictionary",
  "Double",
  "Float",
  "Int",
  "List",
  "Long",
  "Map",
  "Nothing",
  "Object",
  "Option",
  "Optional",
  "Result",
  "Self",
  "Set",
  "String",
  "Type",
  "Unit",
  "Vec",
]);

export function avoidKeyword(name: string, keywords: ReadonlySet<string>): string {
  return keywords.has(name) ? `${name}_` : name;
}

export function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${name}${n}`;
    n++;
  }
  taken.add(candidate);
  return candidate;
}
