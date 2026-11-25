import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

export const STRING_FORMATS = ["date-time", "date", "email", "uri", "uuid"] as const;
export const StringFormat = Schema.Literals(STRING_FORMATS);
export type StringFormat = typeof StringFormat.Type;

export const CODEGEN_LANGUAGES = [
  "typescript",
  "rust",
  "go",
  "python-dataclass",
  "python-pydantic",
  "kotlin",
  "csharp",
  "swift",
  "json-schema",
] as const;
export const CodegenLanguage = Schema.Literals(CODEGEN_LANGUAGES);
export type CodegenLanguage = typeof CodegenLanguage.Type;

export const CODEGEN_LANGUAGE_LABELS: Readonly<Record<CodegenLanguage, string>> = {
  typescript: "TypeScript",
  rust: "Rust",
  go: "Go",
  "python-dataclass": "Python (dataclasses)",
  "python-pydantic": "Python (Pydantic)",
  kotlin: "Kotlin",
  csharp: "C#",
  swift: "Swift",
  "json-schema": "JSON Schema",
};

export const CODEGEN_LANGUAGE_EXTENSIONS: Readonly<Record<CodegenLanguage, string>> = {
  typescript: "ts",
  rust: "rs",
  go: "go",
  "python-dataclass": "py",
  "python-pydantic": "py",
  kotlin: "kt",
  csharp: "cs",
  swift: "swift",
  "json-schema": "schema.json",
};

export const DEFAULT_MAX_ENUM = 8;
export const DEFAULT_MAX_INFER_DEPTH = 128;
export const MAX_SCHEMA_FAILURES = 1000;

export const InferOptions = Schema.Struct({
  maxEnum: NonNegativeInt,
  maxDepth: NonNegativeInt,
});
export type InferOptions = typeof InferOptions.Type;

export const EnumValueEntry = Schema.Struct({
  value: Schema.String,
  count: NonNegativeInt,
});
export type EnumValueEntry = typeof EnumValueEntry.Type;

export const StringShape = Schema.Struct({
  count: NonNegativeInt,
  formats: Schema.Tuple([
    NonNegativeInt,
    NonNegativeInt,
    NonNegativeInt,
    NonNegativeInt,
    NonNegativeInt,
  ]),
  values: Schema.NullOr(Schema.Array(EnumValueEntry)),
});
export type StringShape = typeof StringShape.Type;

export interface FieldShape {
  readonly name: string;
  readonly present: number;
  readonly shape: Shape;
}

export interface ArrayShape {
  readonly count: number;
  readonly minLen: number;
  readonly maxLen: number;
  readonly items: Shape;
}

export interface ObjectShape {
  readonly count: number;
  readonly fields: ReadonlyArray<FieldShape>;
}

export interface Shape {
  readonly samples: number;
  readonly nulls: number;
  readonly bools: number;
  readonly integers: number;
  readonly floats: number;
  readonly string: StringShape | null;
  readonly array: ArrayShape | null;
  readonly object: ObjectShape | null;
}

const ShapeRef: Schema.Codec<Shape> = Schema.suspend((): Schema.Codec<Shape> => Shape);

export const FieldShape: Schema.Codec<FieldShape> = Schema.Struct({
  name: Schema.String,
  present: NonNegativeInt,
  shape: ShapeRef,
});

export const ArrayShape: Schema.Codec<ArrayShape> = Schema.Struct({
  count: NonNegativeInt,
  minLen: NonNegativeInt,
  maxLen: NonNegativeInt,
  items: ShapeRef,
});

export const ObjectShape: Schema.Codec<ObjectShape> = Schema.Struct({
  count: NonNegativeInt,
  fields: Schema.Array(FieldShape),
});

export const Shape: Schema.Codec<Shape> = Schema.Struct({
  samples: NonNegativeInt,
  nulls: NonNegativeInt,
  bools: NonNegativeInt,
  integers: NonNegativeInt,
  floats: NonNegativeInt,
  string: Schema.NullOr(StringShape),
  array: Schema.NullOr(ArrayShape),
  object: Schema.NullOr(ObjectShape),
});

export const SchemaFailure = Schema.Struct({
  pointer: Schema.String,
  keyword: Schema.String,
  message: Schema.String,
  entryIndex: Schema.optionalKey(NonNegativeInt),
});
export type SchemaFailure = typeof SchemaFailure.Type;

export const HarValidationSection = Schema.Literals(["response", "request"]);
export type HarValidationSection = typeof HarValidationSection.Type;

export const HarValidationFilter = Schema.Struct({
  urlPattern: Schema.String,
  section: HarValidationSection,
});
export type HarValidationFilter = typeof HarValidationFilter.Type;

export const ValidationResult = Schema.Struct({
  valid: Schema.Boolean,
  failures: Schema.Array(SchemaFailure),
  truncated: Schema.Boolean,
  checkedEntries: NonNegativeInt,
});
export type ValidationResult = typeof ValidationResult.Type;

export const SchemaErrorKind = Schema.Literals([
  "not-json",
  "not-a-schema",
  "remote-ref",
  "bad-ref",
  "bad-pattern",
  "unsupported",
]);
export type SchemaErrorKind = typeof SchemaErrorKind.Type;

export class SchemaContractError extends Schema.TaggedError<SchemaContractError>()(
  "SchemaContractError",
  {
    kind: SchemaErrorKind,
    detail: Schema.String,
    message: Schema.String,
  },
) {}

export const CodegenOptions = Schema.Struct({
  language: CodegenLanguage,
  rootName: Schema.String,
  maxEnum: NonNegativeInt,
});
export type CodegenOptions = typeof CodegenOptions.Type;

export const CodegenResult = Schema.Struct({
  language: CodegenLanguage,
  rootName: Schema.String,
  extension: Schema.String,
  code: Schema.String,
});
export type CodegenResult = typeof CodegenResult.Type;
