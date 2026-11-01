import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";

vi.mock("../src/auth/verifyIdToken.js", () => ({
  verifyIdToken: vi.fn().mockResolvedValue({ uid: "logging-test-user" }),
}));

// The products query reads the catalog index.
vi.mock("../src/db/catalogIndex.js", async (importOriginal) => {
  const explode = vi.fn(() => {
    throw new Error("Firestore exploded");
  });
  return { ...(await importOriginal()), listCatalogEntries: explode };
});

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
    vi.unstubAllEnvs();
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
    expect(entry.stack_trace).toContain("Firestore exploded");
    expect(entry).not.toHaveProperty("stack");
    expect(entry.serviceContext.service).toBe("my-fake-ecommerce-api");
  });

  it("links the error log to the trace Cloud Run sent", async () => {
    vi.stubEnv("FIRESTORE_PROJECT_ID", "my-project");
    const created = await createApp();
    httpServer = created.httpServer;
    const readLogs = captureErrorLogs();
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

    await request(created.app)
      .post("/graphql")
      .set("traceparent", `00-${traceId}-00f067aa0ba902b7-01`)
      .send({ query: "{ products(first: 1) { edges { node { id } } } }" });

    const entry = readLogs().find((log) => log.message === "Firestore exploded");
    expect(entry).toMatchObject({
      "logging.googleapis.com/trace": `projects/my-project/traces/${traceId}`,
      "logging.googleapis.com/spanId": "00f067aa0ba902b7",
      "logging.googleapis.com/trace_sampled": true,
    });
  });

  it("writes no trace fields when the request has no trace header", async () => {
    vi.stubEnv("FIRESTORE_PROJECT_ID", "my-project");
    const created = await createApp();
    httpServer = created.httpServer;
    const readLogs = captureErrorLogs();

    await request(created.app)
      .post("/graphql")
      .send({ query: "{ products(first: 1) { edges { node { id } } } }" });

    const entry = readLogs().find((log) => log.message === "Firestore exploded");
    expect(entry).not.toHaveProperty("logging.googleapis.com/trace");
  });

  it("generates a request ID when the client doesn't send one", async () => {
    const created = await createApp();
    httpServer = created.httpServer;

    const response = await request(created.app).get("/healthcheck");

    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("replaces an incoming request ID that isn't safe to log", async () => {
    const created = await createApp();
    httpServer = created.httpServer;

    const response = await request(created.app)
      .get("/healthcheck")
      .set("X-Request-Id", "bad id; {\"severity\":\"INFO\"}");

    expect(response.headers["x-request-id"]).not.toContain("bad id");
  });
});
