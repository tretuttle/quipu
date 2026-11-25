import type { CodegenModel, Ty } from "../model.ts";
import { camel, screaming, uniqueName } from "../naming.ts";
import { emitBlocks, quoteLiteral, usesType } from "./shared.ts";

const KOTLIN_KEYWORDS = new Set([
  "as",
  "break",
  "class",
  "continue",
  "do",
  "else",
  "false",
  "for",
  "fun",
  "if",
  "in",
  "interface",
  "is",
  "null",
  "object",
  "package",
  "return",
  "super",
  "this",
  "throw",
  "true",
  "try",
  "typealias",
  "typeof",
  "val",
  "var",
  "when",
  "while",
]);

function kIdent(name: string): string {
  return KOTLIN_KEYWORDS.has(name) ? `\`${name}\`` : name;
}

function kQuote(s: string): string {
  return quoteLiteral(s).replaceAll("$", "\\$");
}

function emitTy(m: CodegenModel, t: Ty): string {
  switch (t.kind) {
    case "any":
    case "union":
      return "JsonElement";
    case "null":
      return "JsonElement?";
    case "bool":
      return "Boolean";
    case "int":
      return "Long";
    case "float":
      return "Double";
    case "str":
      return "String";
    case "enum":
      return m.enums[t.index]!.name;
    case "object":
      return m.objects[t.index]!.name;
    case "list":
      return `List<${emitTy(m, t.item)}>`;
    case "map":
      return "Map<String, JsonElement>";
    case "nullable": {
      const inner = emitTy(m, t.inner);
      return inner.endsWith("?") ? inner : `${inner}?`;
    }
  }
}

export function emitKotlin(m: CodegenModel): string {
  const imports = ["kotlinx.serialization.Serializable"];
  const renames =
    m.objects.some((o) => o.fields.some((f) => camel(f.json) !== f.json)) || m.enums.length > 0;
  if (renames) imports.push("kotlinx.serialization.SerialName");
  if (
    usesType(
      m,
      (t) => t.kind === "any" || t.kind === "null" || t.kind === "union" || t.kind === "map",
    )
  ) {
    imports.push("kotlinx.serialization.json.JsonElement");
  }
  imports.sort();

  let out = "";
  for (const imp of imports) {
    out += `import ${imp}\n`;
  }
  out += "\n";
  if (!m.rootIsObject()) {
    out += `typealias ${m.rootName} = ${emitTy(m, m.root)}\n\n`;
  }
  out += emitBlocks(m.topDown, (d) => {
    if (d.kind === "object") {
      const o = m.objects[d.index]!;
      let block = `@Serializable\ndata class ${o.name}(\n`;
      const taken = new Set<string>();
      for (const f of o.fields) {
        const name = uniqueName(camel(f.json), taken);
        if (name !== f.json) {
          block += `    @SerialName(${kQuote(f.json)})\n`;
        }
        let t = emitTy(m, f.ty);
        if (f.optional) {
          if (!t.endsWith("?")) t += "?";
          block += `    val ${kIdent(name)}: ${t} = null,\n`;
        } else {
          block += `    val ${kIdent(name)}: ${t},\n`;
        }
      }
      block += ")\n";
      return block;
    }
    const e = m.enums[d.index]!;
    let block = `@Serializable\nenum class ${e.name} {\n`;
    const taken = new Set<string>();
    for (const v of e.values) {
      const name = uniqueName(screaming(v), taken);
      block += `    @SerialName(${kQuote(v)}) ${name},\n`;
    }
    block += "}\n";
    return block;
  });
  return out;
}
