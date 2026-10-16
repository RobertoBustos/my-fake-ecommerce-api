import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";

// The real context requires a valid Firebase ID token (ECOMAPI-24); for
// this smoke test we only care that the Express/Apollo routing works,
// not the real Firebase verification.
vi.mock("../src/auth/verifyIdToken.js", () => ({
  verifyIdToken: vi.fn().mockResolvedValue({ uid: "smoke-test-user" }),
}));

const { createApp } = await import("../src/app.js");

describe("Express app (ECOMAPI-29)", () => {
  let httpServer;

  afterEach(() => {
    httpServer?.close();
  });

  it("GET /healthz responds with 200", async () => {
    const created = await createApp();
    httpServer = created.httpServer;

    const response = await request(created.app).get("/healthz");

    expect(response.status).toBe(200);
  });

  it("POST /graphql responds with 200", async () => {
    const created = await createApp();
    httpServer = created.httpServer;

    const response = await request(created.app)
      .post("/graphql")
      .send({ query: "{ __typename }" });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ __typename: "Query" });
  });
});
