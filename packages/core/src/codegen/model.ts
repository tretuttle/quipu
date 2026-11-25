import type { Shape, StringFormat } from "@quipu/contracts/schema";

import { isFieldRequired, stringShapeEnumValues, stringShapeFormat } from "../schema/infer.ts";
import { pascal, RESERVED_TYPES, singular, uniqueName } from "./naming.ts";

export type Ty =
  | { readonly kind: "any" }
  | { readonly kind: "null" }
  | { readonly kind: "bool" }
  | { readonly kind: "int" }
  | { readonly kind: "float" }
  | { readonly kind: "str"; readonly format: StringFormat | null }
  | { readonly kind: "enum"; readonly index: number }
  | { readonly kind: "list"; readonly item: Ty }
  | { readonly kind: "map"; readonly value: Ty }
  | { readonly kind: "object"; readonly index: number }
  | { readonly kind: "union"; readonly alts: ReadonlyArray<Ty> }
  | { readonly kind: "nullable"; readonly inner: Ty };

export type Def =
  | { readonly kind: "object"; readonly index: number }
  | { readonly kind: "enum"; readonly index: number };

export interface ModelField {
  readonly json: string;
  readonly ty: Ty;
  readonly optional: boolean;
}

export interface ModelObject {
  name: string;
  readonly fields: ReadonlyArray<ModelField>;
}

export interface ModelEnum {
  name: string;
  readonly values: ReadonlyArray<string>;
}

function tyRefs(ty: Ty, visit: (def: Def) => void): void {
  switch (ty.kind) {
    case "enum":
      visit({ kind: "enum", index: ty.index });
      break;
    case "object":
      visit({ kind: "object", index: ty.index });
      break;
    case "list":
      tyRefs(ty.item, visit);
      break;
    case "map":
      tyRefs(ty.value, visit);
      break;
    case "nullable":
      tyRefs(ty.inner, visit);
      break;
    case "union":
      for (const alt of ty.alts) tyRefs(alt, visit);
      break;
    default:
      break;
  }
}

function tyKey(ty: Ty): string {
  switch (ty.kind) {
    case "any":
    case "null":
    case "bool":
    case "int":
    case "float":
      return ty.kind;
    case "str":
      return `str:${ty.format ?? ""}`;
    case "enum":
      return `enum:${ty.index}`;
    case "object":
      return `obj:${ty.index}`;
    case "list":
      return `list(${tyKey(ty.item)})`;
    case "map":
      return `map(${tyKey(ty.value)})`;
    case "nullable":
      return `nullable(${tyKey(ty.inner)})`;
    case "union":
      return `union(${ty.alts.map(tyKey).join(",")})`;
  }
}

function fieldsKey(fields: ReadonlyArray<ModelField>): string {
  return fields
    .map((f) => `${JSON.stringify(f.json)}:${f.optional ? 1 : 0}:${tyKey(f.ty)}`)
    .join("|");
}

function defKey(def: Def): string {
  return `${def.kind}:${def.index}`;
}

export class CodegenModel {
  readonly rootName: string;
  readonly root: Ty;
  readonly objects: ModelObject[];
  readonly enums: ModelEnum[];
  readonly topDown: Def[];

  private constructor(
    rootName: string,
    root: Ty,
    objects: ModelObject[],
    enums: ModelEnum[],
    topDown: Def[],
  ) {
    this.rootName = rootName;
    this.root = root;
    this.objects = objects;
    this.enums = enums;
    this.topDown = topDown;
  }

  static build(shape: Shape, rootNameInput: string, maxEnum: number): CodegenModel {
    const rootName = pascal(rootNameInput);
    const objects: ModelObject[] = [];
    const enums: ModelEnum[] = [];
    const hints = new Map<string, string>();
    const objectIds = new Map<string, number>();
    const enumIds = new Map<string, number>();

    const internObject = (fields: ReadonlyArray<ModelField>, hint: string): Ty => {
      const key = fieldsKey(fields);
      const existing = objectIds.get(key);
      if (existing !== undefined) return { kind: "object", index: existing };
      const index = objects.length;
      objectIds.set(key, index);
      objects.push({ name: "", fields });
      hints.set(defKey({ kind: "object", index }), hint);
      return { kind: "object", index };
    };

    const internEnum = (values: ReadonlyArray<string>, hint: string): Ty => {
      const key = values.map((v) => `${v.length}:${v}`).join("|");
      const existing = enumIds.get(key);
      if (existing !== undefined) return { kind: "enum", index: existing };
      const index = enums.length;
      enumIds.set(key, index);
      enums.push({ name: "", values });
      hints.set(defKey({ kind: "enum", index }), hint);
      return { kind: "enum", index };
    };

    const buildTy = (s: Shape, hint: string): Ty => {
      const alts: Ty[] = [];
      if (s.bools > 0) alts.push({ kind: "bool" });
      if (s.floats > 0) alts.push({ kind: "float" });
      else if (s.integers > 0) alts.push({ kind: "int" });

      if (s.string !== null) {
        const enumVals = stringShapeEnumValues(s.string, maxEnum);
        if (enumVals !== null) {
          alts.push(internEnum(enumVals, hint));
        } else {
          alts.push({ kind: "str", format: stringShapeFormat(s.string) });
        }
      }
      if (s.array !== null) {
        const sing = singular(hint);
        const itemHint = sing !== null ? sing : `${hint}Item`;
        const item: Ty =
          s.array.items.samples === 0 ? { kind: "any" } : buildTy(s.array.items, itemHint);
        alts.push({ kind: "list", item });
      }
      if (s.object !== null) {
        if (s.object.fields.length === 0) {
          alts.push({ kind: "map", value: { kind: "any" } });
        } else {
          const obj = s.object;
          const fields: ModelField[] = obj.fields.map((f) => ({
            json: f.name,
            ty: buildTy(f.shape, pascal(f.name)),
            optional: !isFieldRequired(f, obj),
          }));
          alts.push(internObject(fields, hint));
        }
      }

      let core: Ty;
      if (alts.length === 0) {
        return s.nulls > 0 ? { kind: "null" } : { kind: "any" };
      }
      core = alts.length === 1 ? alts[0]! : { kind: "union", alts };
      return s.nulls > 0 ? { kind: "nullable", inner: core } : core;
    };

    const root = buildTy(shape, rootName);

    const taken = new Set<string>();
    const queue: { def: Def; parent: string }[] = [];
    const seen = new Set<string>();
    const topDown: Def[] = [];

    const rootObject = root.kind === "object";
    if (!rootObject) {
      taken.add(rootName);
    }
    tyRefs(root, (def) => queue.push({ def, parent: rootName }));

    while (queue.length > 0) {
      const next = queue.shift()!;
      const dk = defKey(next.def);
      if (seen.has(dk)) continue;
      seen.add(dk);
      topDown.push(next.def);

      const hint = hints.get(dk) ?? "Type";
      let wanted: string;
      if (rootObject && topDown.length === 1) {
        wanted = rootName;
      } else if (taken.has(hint) || RESERVED_TYPES.has(hint)) {
        wanted = `${next.parent}${hint}`;
      } else {
        wanted = hint;
      }
      const finalName = uniqueName(wanted, taken);
      if (next.def.kind === "object") {
        const obj = objects[next.def.index]!;
        obj.name = finalName;
        for (const f of obj.fields) {
          tyRefs(f.ty, (d) => queue.push({ def: d, parent: finalName }));
        }
      } else {
        enums[next.def.index]!.name = finalName;
      }
    }

    return new CodegenModel(rootName, root, objects, enums, topDown);
  }

  rootIsObject(): boolean {
    return this.root.kind === "object" && this.objects[this.root.index]?.name === this.rootName;
  }

  bottomUp(): Def[] {
    const seen = new Set<string>();
    const out: Def[] = [];
    const visit = (def: Def) => {
      const dk = defKey(def);
      if (seen.has(dk)) return;
      seen.add(dk);
      if (def.kind === "object") {
        for (const f of this.objects[def.index]!.fields) {
          tyRefs(f.ty, visit);
        }
      }
      out.push(def);
    };
    for (const d of this.topDown) visit(d);
    return out;
  }
}
