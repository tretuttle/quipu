import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CODEGEN_LANGUAGES, CodegenOptions, Shape, ValidationResult } from "./schema.ts";

const encodeShape = Schema.encodeSync(Shape);
const decodeShape = Schema.decodeUnknownSync(Shape);
const encodeValidationResult = Schema.encodeSync(ValidationResult);
const decodeValidationResult = Schema.decodeUnknownSync(ValidationResult);
const decodeCodegenOptions = Schema.decodeSync(CodegenOptions);

describe("schema contracts", () => {
  it("round-trips recursive inferred shapes", () => {
    const sample: Shape = {
      samples: 2,
      nulls: 0,
      bools: 0,
      integers: 0,
      floats: 0,
      string: null,
      array: {
        count: 2,
        minLen: 1,
        maxLen: 2,
        items: {
          samples: 3,
          nulls: 1,
          bools: 0,
          integers: 2,
          floats: 0,
          string: null,
          array: null,
          object: null,
        },
      },
      object: null,
    };
    const roundTripped = decodeShape(structuredClone(encodeShape(sample)) as unknown);
    expect(roundTripped).toEqual(sample);
  });

  it("round-trips validation results with optional entryIndex", () => {
    const result: ValidationResult = {
      valid: false,
      truncated: false,
      checkedEntries: 2,
      failures: [
        {
          pointer: "/order/id",
          keyword: "type",
          message: "expected integer, found string",
          entryIndex: 1,
        },
        {
          pointer: "/extra",
          keyword: "additionalProperties",
          message: 'property "extra" is not allowed',
        },
      ],
    };
    const decoded = decodeValidationResult(
      structuredClone(encodeValidationResult(result)) as unknown,
    );
    expect(decoded).toEqual(result);
  });

  it("validates all 9 codegen language targets", () => {
    expect(CODEGEN_LANGUAGES).toHaveLength(9);
    for (const language of CODEGEN_LANGUAGES) {
      const parsed = decodeCodegenOptions({
        language,
        rootName: "Root",
        maxEnum: 8,
      });
      expect(parsed.language).toBe(language);
    }
  });
});
