import { quoteJsonString } from "../../schema/jsonValue.ts";
import { CodegenModel, type Def, type Ty } from "../model.ts";

export function usesType(model: CodegenModel, predicate: (ty: Ty) => boolean): boolean {
  const walk = (ty: Ty): boolean => {
    if (predicate(ty)) return true;
    switch (ty.kind) {
      case "list":
        return walk(ty.item);
      case "map":
        return walk(ty.value);
      case "nullable":
        return walk(ty.inner);
      case "union":
        return ty.alts.some(walk);
      default:
        return false;
    }
  };
  if (walk(model.root)) return true;
  return model.objects.some((o) => o.fields.some((f) => walk(f.ty)));
}

export function emitBlocks(defs: ReadonlyArray<Def>, each: (def: Def) => string): string {
  const parts: string[] = [];
  for (const def of defs) {
    parts.push(each(def));
  }
  return parts.join("\n");
}

export function quoteLiteral(s: string): string {
  return quoteJsonString(s);
}
