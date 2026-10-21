import { getIdToken, type E2EUser } from "./auth.js";
import { baseUrl } from "./env.js";

export interface GraphQLErrorBody {
  message: string;
  extensions?: { code?: string; [key: string]: unknown };
}

export interface GraphQLResult<T> {
  status: number;
  requestId: string | null;
  data?: T;
  errors?: GraphQLErrorBody[];
}

// The X-Request-Id of every response of the current test. e2e/setup.ts prints
// them when the test fails: with that id, Cloud Logging shows the exact
// request (see the Runbook).
export const requestLog: { label: string; requestId: string | null; status: number }[] = [];

export const recordResponse = (label: string, response: Response) => {
  const requestId = response.headers.get("x-request-id");
  requestLog.push({ label, requestId, status: response.status });
  return requestId;
};

const operationName = (query: string) =>
  /^\s*(query|mutation)\s*(\w+)?/.exec(query)?.slice(1).filter(Boolean).join(" ") ?? "operation";

export interface GraphQLOptions {
  // Whose token to send (the main e2e user by default), a raw Authorization
  // value, or null to send none.
  as?: E2EUser | null;
  authorization?: string;
}

export const gql = async <T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown> = {},
  { as = "main", authorization }: GraphQLOptions = {}
): Promise<GraphQLResult<T>> => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authorization !== undefined) headers.Authorization = authorization;
  else if (as !== null) headers.Authorization = `Bearer ${await getIdToken(as)}`;

  const response = await fetch(`${baseUrl()}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const requestId = recordResponse(operationName(query), response);
  const body = (await response.json()) as Pick<GraphQLResult<T>, "data" | "errors">;
  return { status: response.status, requestId, ...body };
};

// The data of a result that must have succeeded; otherwise the errors,
// with their codes, become the test's failure message.
export const dataOf = <T>(result: GraphQLResult<T>): T => {
  if (result.errors?.length || !result.data) {
    const errors = (result.errors ?? []).map((e) => `${e.extensions?.code ?? "?"}: ${e.message}`);
    throw new Error(`GraphQL call failed (HTTP ${result.status}): ${errors.join("; ") || "no data"}`);
  }
  return result.data;
};

// Vitest hides console output of passing tests; a run's record (ids of what
// it bought) goes straight to stdout.
export const report = (line: string) => process.stdout.write(`${line}\n`);

export const errorCodeOf = (result: GraphQLResult<unknown>) => result.errors?.[0]?.extensions?.code;
