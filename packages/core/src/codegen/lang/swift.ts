import type { CodegenModel, Ty } from "../model.ts";
import { camel, uniqueName } from "../naming.ts";
import { emitBlocks, quoteLiteral, usesType } from "./shared.ts";

const SWIFT_KEYWORDS = new Set([
  "Any",
  "Self",
  "as",
  "associatedtype",
  "break",
  "case",
  "catch",
  "class",
  "continue",
  "default",
  "defer",
  "deinit",
  "do",
  "else",
  "enum",
  "extension",
  "fallthrough",
  "false",
  "fileprivate",
  "for",
  "func",
  "guard",
  "if",
  "import",
  "in",
  "init",
  "inout",
  "internal",
  "is",
  "let",
  "nil",
  "open",
  "operator",
  "private",
  "protocol",
  "public",
  "repeat",
  "rethrows",
  "return",
  "self",
  "static",
  "struct",
  "subscript",
  "super",
  "switch",
  "throw",
  "throws",
  "true",
  "try",
  "typealias",
  "var",
  "where",
  "while",
]);

function sIdent(name: string): string {
  return SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name;
}

const JSON_VALUE_ENUM = `enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}
`;

function emitTy(m: CodegenModel, t: Ty): string {
  switch (t.kind) {
    case "any":
    case "union":
      return "JSONValue";
    case "null":
      return "JSONValue?";
    case "bool":
      return "Bool";
    case "int":
      return "Int";
    case "float":
      return "Double";
    case "str":
      return "String";
    case "enum":
      return m.enums[t.index]!.name;
    case "object":
      return m.objects[t.index]!.name;
    case "list":
      return `[${emitTy(m, t.item)}]`;
    case "map":
      return "[String: JSONValue]";
    case "nullable": {
      const inner = emitTy(m, t.inner);
      return inner.endsWith("?") ? inner : `${inner}?`;
    }
  }
}

export function emitSwift(m: CodegenModel): string {
  let out = "";
  if (!m.rootIsObject()) {
    out += `typealias ${m.rootName} = ${emitTy(m, m.root)}\n\n`;
  }
  out += emitBlocks(m.topDown, (d) => {
    if (d.kind === "object") {
      const o = m.objects[d.index]!;
      let block = `struct ${o.name}: Codable {\n`;
      const taken = new Set<string>();
      const names = o.fields.map((f) => uniqueName(camel(f.json), taken));
      for (let i = 0; i < o.fields.length; i++) {
        const f = o.fields[i]!;
        let t = emitTy(m, f.ty);
        if (f.optional && !t.endsWith("?")) t += "?";
        block += `    let ${sIdent(names[i]!)}: ${t}\n`;
      }
      if (o.fields.some((f, i) => names[i]! !== f.json)) {
        block += "\n    enum CodingKeys: String, CodingKey {\n";
        for (let i = 0; i < o.fields.length; i++) {
          const f = o.fields[i]!;
          const name = names[i]!;
          if (name === f.json) {
            block += `        case ${sIdent(name)}\n`;
          } else {
            block += `        case ${sIdent(name)} = ${quoteLiteral(f.json)}\n`;
          }
        }
        block += "    }\n";
      }
      block += "}\n";
      return block;
    }
    const e = m.enums[d.index]!;
    let block = `enum ${e.name}: String, Codable {\n`;
    const taken = new Set<string>();
    for (const v of e.values) {
      const name = uniqueName(camel(v), taken);
      if (name === v) {
        block += `    case ${sIdent(name)}\n`;
      } else {
        block += `    case ${sIdent(name)} = ${quoteLiteral(v)}\n`;
      }
    }
    block += "}\n";
    return block;
  });
  if (
    usesType(
      m,
      (t) => t.kind === "any" || t.kind === "null" || t.kind === "union" || t.kind === "map",
    )
  ) {
    out += `\n${JSON_VALUE_ENUM}`;
  }
  return out;
}
