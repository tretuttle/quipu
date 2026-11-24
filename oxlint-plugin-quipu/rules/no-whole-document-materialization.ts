import { defineRule, type ESTree } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

/*
 * Why: a 2 GB document must never exist as one JS string or object graph (V8 caps a string at
 * about 512 M characters). Each construct below turns a whole document into one.
 *
 * Limits. The rule is syntactic; oxlint gives it no types.
 * - `.text()`, `.arrayBuffer()`, `.bytes()` and `.json()` are reported as zero-argument calls on
 *   any receiver, because the receiver's type is unknown. A non-Blob method with one of those
 *   names and no arguments is reported too; rename it.
 * - `.decode(` is reported only when the receiver is provably a TextDecoder: `new TextDecoder()`
 *   directly, a local, property or parameter bound to one in this file, or a parameter or
 *   property annotated `TextDecoder`. A decoder that arrives untyped through a call result or
 *   an `any` is not seen.
 * - `JSON.parse` is reported on `JSON` and `globalThis.JSON` (also `self`, `window`). An alias
 *   such as `const parse = JSON.parse` reports on the read; calling the alias later is not seen.
 * - `String.fromCharCode`/`fromCodePoint` are reported with a spread argument, or via `.apply`.
 *   Other ways to feed one huge array to them are not seen.
 * - `new FileReader` is reported on the bare name and on `globalThis`/`self`/`window`.
 * The only exemption is packages/core/src/boundedSlice.ts, named in vite.config.ts.
 */

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self"]);
const MATERIALIZING_METHODS = new Set(["text", "arrayBuffer", "bytes", "json"]);
const CHAR_CODE_BUILDERS = new Set(["fromCharCode", "fromCodePoint"]);

const FIX =
  "Read bounded slices through packages/core/src/boundedSlice.ts, or stream the bytes through the structural index.";

/** `name`, `globalThis.name`, `window.name` or `self.name`. */
function isGlobalReference(node: unknown, name: string): boolean {
  const expression = unwrapExpression(node);
  if (isIdentifier(expression, name)) return true;
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") return false;
  const object = unwrapExpression(expression.value.object);
  const property = getPropertyName(expression.value.property);
  return (
    Option.isSome(object) &&
    object.value.type === "Identifier" &&
    GLOBAL_OBJECTS.has(object.value.name) &&
    Option.isSome(property) &&
    property.value === name
  );
}

const isNewOf = (node: unknown, name: string): boolean => {
  const expression = unwrapExpression(node);
  return (
    Option.isSome(expression) &&
    expression.value.type === "NewExpression" &&
    isGlobalReference(expression.value.callee, name)
  );
};

/** A stable text for the binding a decoder is held in: `decoder` or `this.decoder`. */
function bindingKey(node: unknown): string | undefined {
  const expression = unwrapExpression(node);
  if (Option.isNone(expression)) return undefined;
  const value = expression.value;
  if (value.type === "Identifier") return value.name;
  if (value.type !== "MemberExpression" || value.object.type !== "ThisExpression") return undefined;
  const property = getPropertyName(value.property);
  return Option.isSome(property) ? `this.${property.value}` : undefined;
}

const annotatesTextDecoder = (annotation: unknown): boolean => {
  if (typeof annotation !== "object" || annotation === null) return false;
  const node = annotation as { type?: string; typeAnnotation?: unknown; typeName?: unknown };
  if (node.type === "TSTypeAnnotation") return annotatesTextDecoder(node.typeAnnotation);
  return (
    node.type === "TSTypeReference" && isIdentifier(unwrapExpression(node.typeName), "TextDecoder")
  );
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow constructs that turn a whole document into one JS string or object: JSON.parse, TextDecoder#decode, Blob#text, Response#json, FileReader, String.fromCharCode(...x).",
    },
  },
  createOnce(context) {
    const decoders = new Set<string>();

    const report = (node: ESTree.Node, what: string) =>
      context.report({
        node,
        message: `${what} materializes the whole document in memory, which fails on a 2 GB file. ${FIX}`,
      });

    const noteDecoder = (target: unknown, init: unknown, annotation: unknown) => {
      if (!isNewOf(init, "TextDecoder") && !annotatesTextDecoder(annotation)) return;
      const key = bindingKey(target);
      if (key !== undefined) decoders.add(key);
    };

    return {
      before() {
        decoders.clear();
      },
      VariableDeclarator(node) {
        noteDecoder(node.id, node.init, node.id.typeAnnotation);
      },
      AssignmentExpression(node) {
        noteDecoder(node.left, node.right, undefined);
      },
      PropertyDefinition(node) {
        const key = getPropertyName(node.key);
        if (Option.isNone(key)) return;
        if (isNewOf(node.value, "TextDecoder") || annotatesTextDecoder(node.typeAnnotation)) {
          decoders.add(`this.${key.value}`);
        }
      },
      // Parameters and TS parameter properties annotated TextDecoder.
      Identifier(node) {
        if (annotatesTextDecoder(node.typeAnnotation)) decoders.add(node.name);
      },
      NewExpression(node) {
        if (isGlobalReference(node.callee, "FileReader")) report(node, "new FileReader");
      },
      MemberExpression(node) {
        // `const parse = JSON.parse` leaves a callable alias that bypasses the call check.
        const property = getPropertyName(node.property);
        if (Option.isNone(property) || property.value !== "parse") return;
        if (isGlobalReference(node.object, "JSON")) report(node, "JSON.parse");
      },
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (Option.isNone(callee) || callee.value.type !== "MemberExpression") return;
        const member = callee.value;
        const property = getPropertyName(member.property);
        if (Option.isNone(property)) return;
        const name = property.value;

        if (name === "decode") {
          const key = bindingKey(member.object);
          if (isNewOf(member.object, "TextDecoder") || (key !== undefined && decoders.has(key))) {
            report(node, "TextDecoder#decode");
          }
          return;
        }

        if (MATERIALIZING_METHODS.has(name) && node.arguments.length === 0) {
          report(node, `.${name}()`);
          return;
        }

        const object = unwrapExpression(member.object);
        if (Option.isNone(object)) return;

        // String.fromCharCode(...bytes)
        if (
          object.value.type === "Identifier" &&
          object.value.name === "String" &&
          CHAR_CODE_BUILDERS.has(name) &&
          node.arguments.some((argument) => argument.type === "SpreadElement")
        ) {
          report(node, `String.${name}(...spread)`);
          return;
        }

        // String.fromCharCode.apply(null, bytes)
        if (
          name === "apply" &&
          object.value.type === "MemberExpression" &&
          isIdentifier(unwrapExpression(object.value.object), "String")
        ) {
          const builder = getPropertyName(object.value.property);
          if (Option.isSome(builder) && CHAR_CODE_BUILDERS.has(builder.value)) {
            report(node, `String.${builder.value}.apply`);
          }
        }
      },
    };
  },
});
