import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";

vi.mock("../src/auth/verifyIdToken.js", () => ({
  verifyIdToken: vi.fn().mockResolvedValue({ uid: "logging-test-user" }),
}));

vi.mock("../src/db/products.js", () => ({
  getProducts: vi.fn(() => {
    throw new Error("Firestore exploded");
  }),
}));

const { createApp } = await import("../src/app.js");

// Captures what the logger writes to stderr, parsed back from JSON lines.
const captureErrorLogs = () => {
  const lines = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(...String(chunk).split("\n").filter(Boolean));
    return true;
  });
  return () => lines.map((line) => JSON.parse(line));
};

describe("JSON logs with a request ID (ECOMAPI-40)", () => {
  let httpServer;

  afterEach(() => {
    vi.restoreAllMocks();
    httpServer?.close();
  });

  it("logs an unexpected error as JSON with the request ID", async () => {
    const created = await createApp();
    httpServer = created.httpServer;
    const readLogs = captureErrorLogs();

    const response = await request(created.app)
      .post("/graphql")
      .set("X-Request-Id", "req-123")
      .send({ query: "{ products(first: 1) { edges { node { id } } } }" });

    // The client still gets the generic message...
    expect(response.body.errors[0].message).not.toMatch(/Firestore exploded/);
    expect(response.headers["x-request-id"]).toBe("req-123");

    // ...while the log keeps the real cause, tied to the request.
    const entry = readLogs().find((log) => log.message === "Firestore exploded");
    expect(entry).toMatchObject({
      severity: "ERROR",
      requestId: "req-123",
      path: "products",
    });
    expect(entry.stack).toContain("Firestore exploded");
  });

  it("generates a request ID when the client doesn't send one", async () => {
    const created = await createApp();
    httpServer = created.httpServer;

    const response = await request(created.app).get("/healthz");

    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("replaces an incoming request ID that isn't safe to log", async () => {
    const created = await createApp();
    httpServer = created.httpServer;

    const response = await request(created.app)
      .get("/healthz")
      .set("X-Request-Id", "bad id; {\"severity\":\"INFO\"}");

    expect(response.headers["x-request-id"]).not.toContain("bad id");
  });
});
