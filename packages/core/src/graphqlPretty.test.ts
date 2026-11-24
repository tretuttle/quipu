import { describe, expect, it } from "@effect/vitest";
import { parse, print } from "graphql";

import { MAX_GRAPHQL_BYTES, prettyGraphql } from "./graphqlPretty.ts";
import { GRAPHQL_QUERY } from "./testing/decoderSamples.ts";

describe("prettyGraphql", () => {
  it("prints a minified query on indented lines and names its operation", () => {
    const pretty = prettyGraphql(GRAPHQL_QUERY);
    expect(pretty?.operations).toEqual([{ type: "query", name: "Products" }]);
    expect(pretty?.text.split("\n").slice(0, 6)).toEqual([
      "query Products($first: Int!, $after: String) {",
      "  products(first: $first, after: $after) {",
      "    edges {",
      "      node {",
      "        id",
      "        title",
    ]);
  });

  it("means what the source meant: the printed text parses to the same document", () => {
    const sources = [
      GRAPHQL_QUERY,
      "{ viewer { login } }",
      "mutation Add($input: AddInput!) { add(input: $input) { id tags(first: 3) @include(if: true) } }",
      "fragment F on User { id name } query { me { ...F } }",
    ];
    for (const source of sources) {
      const pretty = prettyGraphql(source);
      expect(pretty, source).not.toBeNull();
      expect(print(parse(pretty!.text))).toBe(print(parse(source)));
    }
  });

  it("refuses text that is not a GraphQL document, and an oversized one", () => {
    expect(prettyGraphql("query {")).toBeNull();
    expect(prettyGraphql('{"query":"{ a }"}')).toBeNull();
    expect(prettyGraphql("hello world")).toBeNull();
    expect(prettyGraphql(`{ ${"a ".repeat(MAX_GRAPHQL_BYTES)} }`)).toBeNull();
  });
});
