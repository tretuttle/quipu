import {
  CODEGEN_LANGUAGE_EXTENSIONS,
  DEFAULT_MAX_ENUM,
  type CodegenLanguage,
  type CodegenOptions,
  type CodegenResult,
  type Shape,
} from "@quipu/contracts/schema";

import { inferJsonText, shapeToJsonSchema } from "../schema/infer.ts";
import { formatJsonPretty } from "../schema/jsonValue.ts";
import { emitCSharp } from "./lang/csharp.ts";
import { emitGo } from "./lang/go.ts";
import { emitKotlin } from "./lang/kotlin.ts";
import { emitPython } from "./lang/python.ts";
import { emitRust } from "./lang/rust.ts";
import { emitSwift } from "./lang/swift.ts";
import { emitTypeScript } from "./lang/typescript.ts";
import { CodegenModel } from "./model.ts";
import { pascal } from "./naming.ts";

export function generateFromShape(
  shape: Shape,
  options: Partial<CodegenOptions> & { readonly language: CodegenLanguage },
): CodegenResult {
  const rootName = options.rootName ?? "Root";
  const maxEnum = options.maxEnum ?? DEFAULT_MAX_ENUM;
  let code: string;
  if (options.language === "json-schema") {
    const schema = shapeToJsonSchema(shape, pascal(rootName), maxEnum);
    code = `${formatJsonPretty(schema)}\n`;
  } else {
    const model = CodegenModel.build(shape, rootName, maxEnum);
    switch (options.language) {
      case "typescript":
        code = emitTypeScript(model);
        break;
      case "rust":
        code = emitRust(model);
        break;
      case "go":
        code = emitGo(model);
        break;
      case "python-dataclass":
        code = emitPython(model, false);
        break;
      case "python-pydantic":
        code = emitPython(model, true);
        break;
      case "kotlin":
        code = emitKotlin(model);
        break;
      case "csharp":
        code = emitCSharp(model);
        break;
      case "swift":
        code = emitSwift(model);
        break;
    }
  }
  return {
    language: options.language,
    rootName,
    extension: CODEGEN_LANGUAGE_EXTENSIONS[options.language],
    code,
  };
}

export function generateFromJsonText(
  text: string,
  options: Partial<CodegenOptions> & { readonly language: CodegenLanguage },
): CodegenResult {
  const maxEnum = options.maxEnum ?? DEFAULT_MAX_ENUM;
  return generateFromShape(inferJsonText(text, { maxEnum }), options);
}
