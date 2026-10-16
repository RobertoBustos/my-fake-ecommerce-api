import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";

const verifyIdTokenMock = vi.fn();
vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifyIdToken: verifyIdTokenMock }),
}));

const { createApp } = await import("../src/app.js");

describe("Unauthenticated GraphQL requests (ECOMAPI-49)", () => {
  let httpServer;

  afterEach(() => {
    httpServer?.close();
  });

  const postQuery = async (headers = {}) => {
    const created = await createApp();
    httpServer = created.httpServer;
    return request(created.app)
      .post("/graphql")
      .set(headers)
      .send({ query: "{ __typename }" });
  };

  it("answers 401 with UNAUTHENTICATED when there is no token", async () => {
    const response = await postQuery();

    expect(response.status).toBe(401);
    expect(response.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");
  });

  it("answers 401 with UNAUTHENTICATED when the token is invalid", async () => {
    verifyIdTokenMock.mockRejectedValueOnce(new Error("invalid token"));

    const response = await postQuery({ Authorization: "Bearer bad-token" });

    expect(response.status).toBe(401);
    expect(response.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");
  });

  it("doesn't expose the HTTP status inside the error extensions", async () => {
    const response = await postQuery();

    expect(response.body.errors[0].extensions).not.toHaveProperty("http");
  });
});
