/**
 * GraphQL documents, pretty-printed with the reference parser and printer
 * from the `graphql` package. The parser is run only on text of at most
 * {@link MAX_GRAPHQL_BYTES} and with a token limit, so a body built to be slow
 * to parse is refused instead of stalling the worker.
 */
import { Kind, parse, print } from "graphql";

export const MAX_GRAPHQL_BYTES = 1024 * 1024;
const MAX_GRAPHQL_TOKENS = 50_000;

export interface GraphqlOperation {
  readonly type: "query" | "mutation" | "subscription" | "fragment";
  readonly name: string | null;
}

export interface PrettyGraphql {
  readonly text: string;
  readonly operations: ReadonlyArray<GraphqlOperation>;
}

/** The document printed with two-space indentation, or null when it is not GraphQL. */
export const prettyGraphql = (source: string): PrettyGraphql | null => {
  if (source.length > MAX_GRAPHQL_BYTES) return null;
  try {
    const document = parse(source, { noLocation: true, maxTokens: MAX_GRAPHQL_TOKENS });
    const operations = document.definitions.flatMap((definition): GraphqlOperation[] => {
      if (definition.kind === Kind.OPERATION_DEFINITION) {
        return [{ type: definition.operation, name: definition.name?.value ?? null }];
      }
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        return [{ type: "fragment", name: definition.name.value }];
      }
      return [];
    });
    if (operations.length === 0) return null;
    return { text: print(document), operations };
  } catch {
    return null;
  }
};
