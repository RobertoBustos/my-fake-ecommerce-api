import depthLimit from "graphql-depth-limit";

// Limita cuántos niveles de selección anidada acepta una query, para evitar
// queries maliciosamente profundas que exploten el árbol de resolvers (DoS).
export const MAX_QUERY_DEPTH = 7;
export const validationRules = [depthLimit(MAX_QUERY_DEPTH)];
