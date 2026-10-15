import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";

// El context real exige un Firebase ID token válido (ECOMAPI-24); para esta
// prueba de humo solo nos interesa que el enrutado de Express/Apollo
// funcione, no la verificación real de Firebase.
vi.mock("../src/auth/verifyIdToken.js", () => ({
  verifyIdToken: vi.fn().mockResolvedValue({ uid: "smoke-test-user" }),
}));

const { createApp } = await import("../src/app.js");

describe("Express app (ECOMAPI-29)", () => {
  let httpServer;

  afterEach(() => {
    httpServer?.close();
  });

  it("GET /healthz responde 200", async () => {
    const created = await createApp();
    httpServer = created.httpServer;

    const response = await request(created.app).get("/healthz");

    expect(response.status).toBe(200);
  });

  it("POST /graphql responde 200", async () => {
    const created = await createApp();
    httpServer = created.httpServer;

    const response = await request(created.app)
      .post("/graphql")
      .send({ query: "{ __typename }" });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ __typename: "Query" });
  });
});
