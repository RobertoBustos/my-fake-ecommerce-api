import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";

// Auth isn't what's under test here; any request just needs to get past it.
vi.mock("../src/auth/verifyIdToken.js", () => ({
  verifyIdToken: vi.fn().mockResolvedValue({ uid: "introspection-user" }),
}));

const { createApp } = await import("../src/app.js");

const INTROSPECTION_QUERY = "{ __schema { queryType { name } } }";

const runQuery = async (nodeEnv, query) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  const { app, httpServer } = await createApp();
  process.env.NODE_ENV = previous;
  try {
    return await request(app)
      .post("/graphql")
      .set("Authorization", "Bearer irrelevant-mocked-token")
      .send({ query });
  } finally {
    httpServer.close();
  }
};

describe("GraphQL introspection", () => {
  afterEach(() => vi.clearAllMocks());

  it("is rejected when NODE_ENV is production", async () => {
    const response = await runQuery("production", INTROSPECTION_QUERY);

    expect(response.status).toBe(400);
    expect(response.body.errors[0].extensions.code).toBe("GRAPHQL_VALIDATION_FAILED");
    expect(response.body.errors[0].message).toMatch(/introspection/i);
  });

  it("stays available outside production", async () => {
    const response = await runQuery("test", INTROSPECTION_QUERY);

    expect(response.status).toBe(200);
    expect(response.body.data.__schema.queryType.name).toBe("Query");
  });

  it("does not affect regular queries in production", async () => {
    const response = await runQuery("production", "{ __typename }");

    expect(response.status).toBe(200);
    expect(response.body.data.__typename).toBe("Query");
  });
});
