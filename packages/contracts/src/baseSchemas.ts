import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const TrimmedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (value) => Effect.succeed(value.trim()),
      encode: (value) => Effect.succeed(value.trim()),
    }),
  ),
);
/**
 * Non-empty once trimmed. A `TrimmedString` only trims when decoding or
 * encoding, so `make` and encode see the untrimmed value: a plain
 * `isNonEmpty` would accept `" "` there and encode it to `""`, which no
 * longer decodes.
 */
const isNonBlank = Schema.makeFilter((value: string) => value.trim().length > 0, {
  expected: "a non-blank string",
  toJsonSchema: () => [{ minLength: 1 }, true],
  arbitraryConstraint: { minLength: 1 },
});
export const TrimmedNonEmptyString = TrimmedString.check(isNonBlank);

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

/**
 * Codec for a persisted or received value whose shape grows over time: an
 * array whose elements a newer build may add members to. Readers keep decoding
 * payloads written by builds newer than themselves instead of failing over
 * data they could not act on anyway.
 *
 * Decoding runs each value through its own schema, so transformations (dates,
 * trimming, decoding defaults) apply as usual. Only values that schema
 * rejects are dropped, on either side.
 */
export const ForwardCompatibleArray = <Element extends Schema.Top>(element: Element) =>
  Schema.Array(
    Schema.UndefinedOr(element).pipe(
      // An element this build cannot read becomes a hole, filtered out below.
      Schema.catchDecoding(() => Effect.succeedSome(undefined)),
      // Likewise an element that cannot be encoded is sent as a hole, so one
      // bad element costs only itself rather than the whole payload.
      Schema.catchEncoding(() => Effect.succeedSome(undefined)),
    ),
  ).pipe(
    Schema.decodeTo(
      Schema.Array(
        Schema.UndefinedOr(Schema.toType(element)).pipe(
          Schema.catchEncoding(() => Effect.succeedSome(undefined)),
        ),
      ).check(
        // The holes above are an encoding detail: a decoded value has none, so
        // `Schema.is` and `make` still reject an array that does. Aborts, so a
        // later check on the array never sees a hole.
        Schema.makeFilter(
          (values) => {
            // Every index, not `every`, which skips the holes of a sparse array.
            for (let index = 0; index < values.length; index++) {
              if (values[index] === undefined) return false;
            }
            return true;
          },
          { expected: "an array without holes" },
          true,
        ),
      ),
      SchemaTransformation.transform<
        ReadonlyArray<Element["Type"]>,
        ReadonlyArray<Element["Type"] | undefined>
      >({
        decode: (values) => values.filter((value) => value !== undefined),
        // An element that fails its own checks is dropped before the wire, so
        // a wrapper that reads the encoded array as JSON values never meets
        // the hole it left.
        encode: (values) => values.filter((value) => value !== undefined),
      }),
    ),
  ) as unknown as ForwardCompatibleArray<Element>;
export type ForwardCompatibleArray<Element extends Schema.Top> = Schema.Codec<
  ReadonlyArray<Element["Type"]>,
  ReadonlyArray<Element["Encoded"]>,
  Element["DecodingServices"],
  Element["EncodingServices"]
>;
