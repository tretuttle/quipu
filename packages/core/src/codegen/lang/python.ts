import type { StringFormat } from "@quipu/contracts/schema";

import type { CodegenModel, Ty } from "../model.ts";
import { avoidKeyword, snake, uniqueName } from "../naming.ts";
import { quoteLiteral, usesType } from "./shared.ts";

const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

const PYDANTIC_ATTRS = new Set([
  "construct",
  "copy",
  "dict",
  "fields",
  "json",
  "parse_file",
  "parse_obj",
  "parse_raw",
  "schema",
  "schema_json",
  "update_forward_refs",
  "validate",
]);

function pyIdent(key: string, pydantic: boolean): string {
  const name = avoidKeyword(snake(key), PYTHON_KEYWORDS);
  if (pydantic && (PYDANTIC_ATTRS.has(name) || name.startsWith("model_"))) {
    return `${name}_`;
  }
  return name;
}

function emitTy(m: CodegenModel, t: Ty, pydantic: boolean): string {
  switch (t.kind) {
    case "any":
      return "Any";
    case "null":
      return "None";
    case "bool":
      return "bool";
    case "int":
      return "int";
    case "float":
      return "float";
    case "str":
      if (pydantic && t.format === "date-time") return "datetime";
      if (pydantic && t.format === "date") return "date";
      if (pydantic && t.format === "uuid") return "UUID";
      return "str";
    case "enum":
      return m.enums[t.index]!.name;
    case "object":
      return m.objects[t.index]!.name;
    case "list":
      return `list[${emitTy(m, t.item, pydantic)}]`;
    case "map":
      return "dict[str, Any]";
    case "union":
      return t.alts.map((alt) => emitTy(m, alt, pydantic)).join(" | ");
    case "nullable":
      return `${emitTy(m, t.inner, pydantic)} | None`;
  }
}

export function emitPython(m: CodegenModel, pydantic: boolean): string {
  let out = "from __future__ import annotations\n\n";
  const hasFmt = (fmt: StringFormat) =>
    usesType(m, (t) => pydantic && t.kind === "str" && t.format === fmt);

  const stdlib: string[] = [];
  if (!pydantic) {
    stdlib.push("from dataclasses import dataclass");
  }
  const hasDt = hasFmt("date-time");
  const hasDate = hasFmt("date");
  if (hasDt && hasDate) stdlib.push("from datetime import date, datetime");
  else if (hasDt) stdlib.push("from datetime import datetime");
  else if (hasDate) stdlib.push("from datetime import date");

  const typing: string[] = [];
  if (usesType(m, (t) => t.kind === "any" || t.kind === "map")) {
    typing.push("Any");
  }
  if (m.enums.length > 0) {
    typing.push("Literal");
  }
  if (typing.length > 0) {
    stdlib.push(`from typing import ${typing.join(", ")}`);
  }
  if (hasFmt("uuid")) {
    stdlib.push("from uuid import UUID");
  }
  stdlib.sort();
  for (const line of stdlib) {
    out += `${line}\n`;
  }

  if (pydantic) {
    if (stdlib.length > 0) out += "\n";
    const needsField = m.objects.some((o) =>
      o.fields.some((f) => pyIdent(f.json, pydantic) !== f.json),
    );
    out += needsField
      ? "from pydantic import BaseModel, Field\n"
      : "from pydantic import BaseModel\n";
  }
  out += "\n\n";

  const blocks: string[] = [];
  const aliases: string[] = [];
  for (const d of m.topDown) {
    if (d.kind === "enum") {
      const e = m.enums[d.index]!;
      const values = e.values.map((v) => quoteLiteral(v)).join(", ");
      aliases.push(`${e.name} = Literal[${values}]\n`);
    }
  }
  if (aliases.length > 0) {
    blocks.push(aliases.join(""));
  }

  for (const d of m.bottomUp()) {
    if (d.kind !== "object") continue;
    const o = m.objects[d.index]!;
    let cls = pydantic ? `class ${o.name}(BaseModel):\n` : `@dataclass\nclass ${o.name}:\n`;
    const taken = new Set<string>();
    const rows = o.fields.map((f) => {
      const name = uniqueName(pyIdent(f.json, pydantic), taken);
      let t = emitTy(m, f.ty, pydantic);
      if (f.optional && f.ty.kind !== "nullable" && f.ty.kind !== "null" && f.ty.kind !== "any") {
        t += " | None";
      }
      let line: string;
      if (pydantic && name !== f.json && f.optional) {
        line = `${name}: ${t} = Field(default=None, alias=${quoteLiteral(f.json)})`;
      } else if (pydantic && name !== f.json) {
        line = `${name}: ${t} = Field(alias=${quoteLiteral(f.json)})`;
      } else if (f.optional) {
        line = `${name}: ${t} = None`;
      } else {
        line = `${name}: ${t}`;
      }
      const note = !pydantic && name !== f.json ? `  # ${quoteLiteral(f.json)}` : "";
      return { optional: f.optional, line: `    ${line}${note}\n` };
    });
    if (!pydantic) {
      rows.sort((a, b) => Number(a.optional) - Number(b.optional));
    }
    for (const r of rows) cls += r.line;
    blocks.push(cls);
  }

  if (!m.rootIsObject()) {
    blocks.push(`${m.rootName} = ${emitTy(m, m.root, pydantic)}\n`);
  }
  out += blocks.join("\n\n");
  return out;
}
