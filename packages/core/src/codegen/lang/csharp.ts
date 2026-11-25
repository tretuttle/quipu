import type { CodegenModel, Ty } from "../model.ts";
import { pascal, uniqueName } from "../naming.ts";
import { emitBlocks, quoteLiteral, usesType } from "./shared.ts";

function emitTy(m: CodegenModel, t: Ty): string {
  switch (t.kind) {
    case "any":
    case "union":
      return "JsonElement";
    case "null":
      return "JsonElement?";
    case "bool":
      return "bool";
    case "int":
      return "long";
    case "float":
      return "double";
    case "str":
      if (t.format === "date-time") return "DateTimeOffset";
      if (t.format === "date") return "DateOnly";
      if (t.format === "uuid") return "Guid";
      if (t.format === "uri") return "Uri";
      return "string";
    case "enum":
      return m.enums[t.index]!.name;
    case "object":
      return m.objects[t.index]!.name;
    case "list":
      return `List<${emitTy(m, t.item)}>`;
    case "map":
      return "Dictionary<string, JsonElement>";
    case "nullable": {
      const inner = emitTy(m, t.inner);
      return inner.endsWith("?") ? inner : `${inner}?`;
    }
  }
}

function qualified(t: string): string {
  return t
    .replaceAll("List<", "System.Collections.Generic.List<")
    .replaceAll("Dictionary<", "System.Collections.Generic.Dictionary<")
    .replaceAll("JsonElement", "System.Text.Json.JsonElement")
    .replaceAll("DateTimeOffset", "System.DateTimeOffset")
    .replaceAll("DateOnly", "System.DateOnly")
    .replaceAll("Guid", "System.Guid")
    .replaceAll("Uri", "System.Uri");
}

export function emitCSharp(m: CodegenModel): string {
  let out = "#nullable enable\n\n";
  const needsSystem = usesType(
    m,
    (t) =>
      t.kind === "str" &&
      (t.format === "date-time" ||
        t.format === "date" ||
        t.format === "uuid" ||
        t.format === "uri"),
  );
  if (needsSystem) out += "using System;\n";
  if (usesType(m, (t) => t.kind === "list" || t.kind === "map")) {
    out += "using System.Collections.Generic;\n";
  }
  if (
    usesType(
      m,
      (t) => t.kind === "any" || t.kind === "null" || t.kind === "union" || t.kind === "map",
    )
  ) {
    out += "using System.Text.Json;\n";
  }
  out += "using System.Text.Json.Serialization;\n";
  if (!m.rootIsObject()) {
    out += `using ${m.rootName} = ${qualified(emitTy(m, m.root))};\n`;
  }
  out += "\n";

  out += emitBlocks(m.topDown, (d) => {
    if (d.kind === "object") {
      const o = m.objects[d.index]!;
      let block = `public record ${o.name}\n{\n`;
      const taken = new Set<string>();
      for (let n = 0; n < o.fields.length; n++) {
        if (n > 0) block += "\n";
        const f = o.fields[n]!;
        let name = pascal(f.json);
        if (name === o.name) name += "Value";
        name = uniqueName(name, taken);
        let t = emitTy(m, f.ty);
        let required = "required ";
        if (f.optional) {
          if (!t.endsWith("?")) t += "?";
          required = "";
        }
        block += `    [JsonPropertyName(${quoteLiteral(f.json)})]\n`;
        block += `    public ${required}${t} ${name} { get; init; }\n`;
      }
      block += "}\n";
      return block;
    }
    const e = m.enums[d.index]!;
    let block = `[JsonConverter(typeof(JsonStringEnumConverter<${e.name}>))]\npublic enum ${e.name}\n{\n`;
    const taken = new Set<string>();
    for (const v of e.values) {
      const name = uniqueName(pascal(v), taken);
      block += `    [JsonStringEnumMemberName(${quoteLiteral(v)})]\n`;
      block += `    ${name},\n`;
    }
    block += "}\n";
    return block;
  });
  return out;
}
