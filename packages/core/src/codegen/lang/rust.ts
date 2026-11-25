import type { CodegenModel, Ty } from "../model.ts";
import { camel, pascal, snake, uniqueName } from "../naming.ts";
import { emitBlocks, quoteLiteral } from "./shared.ts";

const RUST_KEYWORDS = new Set([
  "abstract",
  "as",
  "async",
  "await",
  "become",
  "box",
  "break",
  "const",
  "continue",
  "do",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "final",
  "fn",
  "for",
  "gen",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "macro",
  "match",
  "mod",
  "move",
  "mut",
  "override",
  "priv",
  "pub",
  "ref",
  "return",
  "static",
  "struct",
  "trait",
  "true",
  "try",
  "type",
  "typeof",
  "unsafe",
  "unsized",
  "use",
  "virtual",
  "where",
  "while",
  "yield",
]);

const RUST_STRICT = new Set(["crate", "self", "Self", "super"]);

function fieldIdent(name: string): string {
  if (RUST_STRICT.has(name)) return `${name}_`;
  if (RUST_KEYWORDS.has(name)) return `r#${name}`;
  return name;
}

function emitTy(m: CodegenModel, t: Ty): string {
  switch (t.kind) {
    case "any":
    case "union":
      return "serde_json::Value";
    case "null":
      return "Option<serde_json::Value>";
    case "bool":
      return "bool";
    case "int":
      return "i64";
    case "float":
      return "f64";
    case "str":
      return "String";
    case "enum":
      return m.enums[t.index]!.name;
    case "object":
      return m.objects[t.index]!.name;
    case "list":
      return `Vec<${emitTy(m, t.item)}>`;
    case "map":
      return "serde_json::Map<String, serde_json::Value>";
    case "nullable":
      return `Option<${emitTy(m, t.inner)}>`;
  }
}

export function emitRust(m: CodegenModel): string {
  let out = "use serde::{Deserialize, Serialize};\n\n";
  if (!m.rootIsObject()) {
    out += `pub type ${m.rootName} = ${emitTy(m, m.root)};\n\n`;
  }
  const body = emitBlocks(m.topDown, (d) => {
    if (d.kind === "object") {
      const o = m.objects[d.index]!;
      const taken = new Set<string>();
      const names = o.fields.map((f) => uniqueName(snake(f.json), taken));
      const camelCase =
        o.fields.every((f, idx) => camel(names[idx]!) === f.json) &&
        o.fields.some((f, idx) => names[idx]! !== f.json);
      let block = "#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]\n";
      if (camelCase) {
        block += '#[serde(rename_all = "camelCase")]\n';
      }
      block += `pub struct ${o.name} {\n`;
      for (let idx = 0; idx < o.fields.length; idx++) {
        const f = o.fields[idx]!;
        const ident = fieldIdent(names[idx]!);
        const plain = ident.startsWith("r#") ? ident.slice(2) : ident;
        const seen = camelCase ? camel(plain) : plain;
        if (seen !== f.json) {
          block += `    #[serde(rename = ${quoteLiteral(f.json)})]\n`;
        }
        let tyStr = emitTy(m, f.ty);
        if (f.optional) {
          block += '    #[serde(default, skip_serializing_if = "Option::is_none")]\n';
          if (f.ty.kind !== "nullable" && f.ty.kind !== "null") {
            tyStr = `Option<${tyStr}>`;
          }
        }
        block += `    pub ${ident}: ${tyStr},\n`;
      }
      block += "}\n";
      return block;
    }
    const e = m.enums[d.index]!;
    const taken = new Set<string>();
    const variants = e.values.map((v) => uniqueName(pascal(v), taken));
    const snakeCase = e.values.every((v, idx) => snake(variants[idx]!) === v);
    let block = "#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]\n";
    if (snakeCase) {
      block += '#[serde(rename_all = "snake_case")]\n';
    }
    block += `pub enum ${e.name} {\n`;
    for (let idx = 0; idx < e.values.length; idx++) {
      const v = e.values[idx]!;
      const n = variants[idx]!;
      if (!snakeCase && n !== v) {
        block += `    #[serde(rename = ${quoteLiteral(v)})]\n`;
      }
      block += `    ${n},\n`;
    }
    block += "}\n";
    return block;
  });
  out += body;
  return out;
}
