import type { CodegenModel, Ty } from "../model.ts";
import { goPascal, uniqueName } from "../naming.ts";
import { emitBlocks, quoteLiteral, usesType } from "./shared.ts";

function isNilable(t: Ty): boolean {
  return (
    t.kind === "any" ||
    t.kind === "null" ||
    t.kind === "union" ||
    t.kind === "list" ||
    t.kind === "map" ||
    t.kind === "nullable"
  );
}

function emitTy(m: CodegenModel, t: Ty): string {
  switch (t.kind) {
    case "any":
    case "null":
    case "union":
      return "any";
    case "bool":
      return "bool";
    case "int":
      return "int64";
    case "float":
      return "float64";
    case "str":
      return t.format === "date-time" ? "time.Time" : "string";
    case "enum":
      return m.enums[t.index]!.name;
    case "object":
      return m.objects[t.index]!.name;
    case "list":
      return `[]${emitTy(m, t.item)}`;
    case "map":
      return "map[string]any";
    case "nullable":
      return isNilable(t.inner) ? emitTy(m, t.inner) : `*${emitTy(m, t.inner)}`;
  }
}

function formatAlignedRows(rows: ReadonlyArray<readonly [string, string, string]>): string {
  let w0 = 0;
  let w1 = 0;
  for (const [a, b] of rows) {
    const aLen = [...a].length;
    const bLen = [...b].length;
    if (aLen > w0) w0 = aLen;
    if (bLen > w1) w1 = bLen;
  }
  let out = "";
  for (const [a, b, c] of rows) {
    const pad0 = " ".repeat(w0 - [...a].length);
    const pad1 = " ".repeat(w1 - [...b].length);
    out += `\t${a}${pad0} ${b}${pad1} ${c}\n`;
  }
  return out;
}

export function emitGo(m: CodegenModel): string {
  let out = "package model\n\n";
  if (usesType(m, (t) => t.kind === "str" && t.format === "date-time")) {
    out += 'import "time"\n\n';
  }
  if (!m.rootIsObject()) {
    out += `type ${m.rootName} ${emitTy(m, m.root)}\n\n`;
  }
  out += emitBlocks(m.topDown, (d) => {
    if (d.kind === "object") {
      const o = m.objects[d.index]!;
      const taken = new Set<string>();
      const rows = o.fields.map((f): readonly [string, string, string] => {
        const name = uniqueName(goPascal(f.json), taken);
        let t = emitTy(m, f.ty);
        if (f.optional && !isNilable(f.ty)) {
          t = `*${t}`;
        }
        const omit = f.optional ? ",omitempty" : "";
        const tag = `\`json:${quoteLiteral(`${f.json}${omit}`)}\``;
        return [name, t, tag];
      });
      return `type ${o.name} struct {\n${formatAlignedRows(rows)}}\n`;
    }
    const e = m.enums[d.index]!;
    const taken = new Set<string>();
    const rows = e.values.map((v): readonly [string, string, string] => {
      const name = uniqueName(`${e.name}${goPascal(v)}`, taken);
      return [name, e.name, `= ${quoteLiteral(v)}`];
    });
    return `type ${e.name} string\n\nconst (\n${formatAlignedRows(rows)})\n`;
  });
  return out;
}
