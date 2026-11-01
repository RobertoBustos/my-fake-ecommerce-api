import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import request from "supertest";

vi.mock("../src/auth/verifyIdToken.js", () => ({
  verifyIdToken: vi.fn().mockResolvedValue({ uid: "summary-test-user" }),
}));

// The products query reads the catalog index; a test can make it throw to
// get an unexpected error.
const failure = vi.hoisted(() => ({ on: false }));
vi.mock("../src/db/catalogIndex.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    listCatalogEntries: (...args) => {
      if (failure.on) throw new Error("Firestore exploded");
      return original.listCatalogEntries(...args);
    },
  };
});

const { createApp } = await import("../src/app.js");

const PRODUCTS = "products(first: 1) { edges { node { id } } }";

// Every JSON line the logger writes, from both streams, raw and parsed.
const captureLogs = () => {
  const lines = [];
  for (const stream of ["stdout", "stderr"]) {
    vi.spyOn(process[stream], "write").mockImplementation((chunk) => {
      lines.push(...String(chunk).split("\n").filter(Boolean));
      return true;
    });
  }
  return {
    raw: () => lines.join("\n"),
    summaries: () => lines.map((line) => JSON.parse(line)).filter((log) => log.message === "GraphQL operation"),
  };
};

describe("GraphQL operation summary", () => {
  let app;
  let httpServer;

  beforeEach(async () => {
    ({ app, httpServer } = await createApp());
  });

  afterEach(() => {
    failure.on = false;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    httpServer?.close();
  });

  const post = (body, headers = {}) =>
    request(app).post("/graphql").set("Authorization", "Bearer token").set(headers).send(body);

  it("logs the operation, its type, root fields and duration at INFO", async () => {
    const logs = captureLogs();

    await post({ query: `query Catalog { ${PRODUCTS} }`, operationName: "Catalog" }, { "X-Request-Id": "req-sum" });

    const [summary] = logs.summaries();
    expect(summary).toMatchObject({
      severity: "INFO",
      requestId: "req-sum",
      operationName: "Catalog",
      operationType: "query",
      rootFields: ["products"],
    });
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(summary).not.toHaveProperty("errorCodes");
    expect(logs.summaries()).toHaveLength(1);
  });

  it("names root fields, not aliases, including those inside fragments", async () => {
    const logs = captureLogs();

    await post({
      query: `query Home { catalog: ${PRODUCTS} ... on Query { __typename } ...Extra }
        fragment Extra on Query { again: ${PRODUCTS} }`,
    });

    expect(logs.summaries()[0].rootFields).toEqual(["__typename", "products"]);
  });

  it("calls an unnamed operation anonymous", async () => {
    const logs = captureLogs();

    await post({ query: "{ __typename }" });

    expect(logs.summaries()[0]).toMatchObject({ operationName: "anonymous", rootFields: ["__typename"] });
  });

  it("logs client errors at WARNING with their codes, and still says what was asked", async () => {
    const logs = captureLogs();

    await post({ query: "query Bad { nope }" });

    expect(logs.summaries()[0]).toMatchObject({
      severity: "WARNING",
      operationName: "Bad",
      operationType: "query",
      rootFields: ["nope"],
      errorCodes: ["GRAPHQL_VALIDATION_FAILED"],
    });
  });

  it("never logs the name a client sent with a document that doesn't parse", async () => {
    const logs = captureLogs();

    await post({ query: "query Broken {", operationName: "Broken" });

    expect(logs.summaries()[0]).toMatchObject({
      severity: "WARNING",
      operationName: "anonymous",
      operationType: "unknown",
      rootFields: [],
      errorCodes: ["GRAPHQL_PARSE_FAILED"],
    });
  });

  it("logs an unexpected error at ERROR, kept out of Error Reporting", async () => {
    failure.on = true;
    const logs = captureLogs();

    await post({ query: `query Catalog { ${PRODUCTS} }` });

    const [summary] = logs.summaries();
    expect(summary).toMatchObject({ severity: "ERROR", errorCodes: ["INTERNAL_SERVER_ERROR"] });
    // The error's own line, with its stack, is the one Error Reporting groups.
    expect(summary).not.toHaveProperty("serviceContext");
    expect(summary).not.toHaveProperty("@type");
  });

  it("never logs variables, the query text or the search text", async () => {
    const logs = captureLogs();

    await post({
      query: `mutation Checkout($input: UpdateOrder!) { updateOrder(input: $input) { code } }`,
      variables: {
        input: { id: "order-1", customer: { email: "ana@example.com", name: "Ana Pérez", phone: "5512345678" } },
      },
    });
    await post({
      query: `query Find($q: String!) { searchProducts(query: $q) { totalCount } }`,
      variables: { q: "secret jacket" },
    });
    await post({ query: `query Inline { searchProducts(query: "inline jacket") { totalCount } }` });

    const raw = logs.raw();
    for (const secret of ["ana@example.com", "Ana Pérez", "5512345678", "secret jacket", "inline jacket", "updateOrder(input"]) {
      expect(raw).not.toContain(secret);
    }
    expect(logs.summaries().map((summary) => summary.rootFields)).toEqual([
      ["updateOrder"],
      ["searchProducts"],
      ["searchProducts"],
    ]);
  });

  it("carries the trace of the request", async () => {
    vi.stubEnv("FIRESTORE_PROJECT_ID", "my-project");
    const logs = captureLogs();
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

    await post({ query: "{ __typename }" }, { traceparent: `00-${traceId}-00f067aa0ba902b7-01` });

    expect(logs.summaries()[0]["logging.googleapis.com/trace"]).toBe(`projects/my-project/traces/${traceId}`);
  });
});
