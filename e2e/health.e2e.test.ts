import { describe, it, expect } from "vitest";
import { baseUrl, optionalEnv } from "./helpers/env.js";
import { errorCodeOf, gql, recordResponse } from "./helpers/graphql.js";

const TYPENAME = "query Typename { __typename }";

const healthcheck = async (origin: string) => {
  const response = await fetch(`${origin.replace(/\/+$/, "")}/healthcheck`);
  recordResponse(`GET ${origin}/healthcheck`, response);
  return response;
};

describe("deployed API health", () => {
  it("answers /healthcheck through Firebase Hosting", async () => {
    const response = await healthcheck(baseUrl());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toMatch(/^[\w-]+$/);
  });

  // The Cloud Run URL directly, without the Hosting rewrite in front.
  const runUrl = optionalEnv("E2E_RUN_URL");
  it.skipIf(!runUrl)("answers /healthcheck on Cloud Run", async () => {
    const response = await healthcheck(runUrl as string);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

describe("GraphQL authentication", () => {
  it("answers 401 UNAUTHENTICATED without a token", async () => {
    const result = await gql(TYPENAME, {}, { as: null });
    expect(result.status).toBe(401);
    expect(errorCodeOf(result)).toBe("UNAUTHENTICATED");
  });

  it("answers 401 UNAUTHENTICATED with a token Firebase didn't sign", async () => {
    const result = await gql(TYPENAME, {}, { authorization: "Bearer not-a-firebase-token" });
    expect(result.status).toBe(401);
    expect(errorCodeOf(result)).toBe("UNAUTHENTICATED");
  });

  it("answers with the e2e user's token", async () => {
    const result = await gql<{ __typename: string }>(TYPENAME);
    expect(result.status).toBe(200);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ __typename: "Query" });
  });
});
