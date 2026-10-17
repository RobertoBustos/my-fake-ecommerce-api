import depthLimit from "graphql-depth-limit";

// Limits how many levels of nested selection a query accepts, to prevent
// maliciously deep queries from exploiting the resolver tree (DoS).
export const MAX_QUERY_DEPTH = 7;
export const validationRules = [depthLimit(MAX_QUERY_DEPTH)];
