import type { CodegenModel, Ty } from "../model.ts";
import { emitBlocks, quoteLiteral } from "./shared.ts";

function propertyName(key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return key;
  return quoteLiteral(key);
}

function emitTy(m: CodegenModel, t: Ty): string {
  switch (t.kind) {
    case "any":
      return "unknown";
    case "null":
      return "null";
    case "bool":
      return "boolean";
    case "int":
    case "float":
      return "number";
    case "str":
      return "string";
    case "enum":
      return m.enums[t.index]!.name;
    case "object":
      return m.objects[t.index]!.name;
    case "list": {
      const inner = emitTy(m, t.item);
      return t.item.kind === "union" || t.item.kind === "nullable" ? `(${inner})[]` : `${inner}[]`;
    }
    case "map":
      return `Record<string, ${emitTy(m, t.value)}>`;
    case "union":
      return t.alts.map((alt) => emitTy(m, alt)).join(" | ");
    case "nullable":
      return `${emitTy(m, t.inner)} | null`;
  }
}

export function emitTypeScript(m: CodegenModel): string {
  let out = "";
  if (!m.rootIsObject()) {
    out += `export type ${m.rootName} = ${emitTy(m, m.root)};\n`;
  }
  const body = emitBlocks(m.topDown, (d) => {
    if (d.kind === "object") {
      const o = m.objects[d.index]!;
      let block = `export interface ${o.name} {\n`;
      for (const f of o.fields) {
        const opt = f.optional ? "?" : "";
        block += `  ${propertyName(f.json)}${opt}: ${emitTy(m, f.ty)};\n`;
      }
      block += "}\n";
      return block;
    }
    const e = m.enums[d.index]!;
    const values = e.values.map((v) => quoteLiteral(v)).join(" | ");
    return `export type ${e.name} = ${values};\n`;
  });
  if (body.length > 0) {
    if (out.length > 0 && !out.endsWith("\n\n")) out += "\n";
    out += body;
  }
  return out;
}
