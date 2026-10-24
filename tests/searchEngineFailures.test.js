import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/auth/verifyIdToken.js", () => ({
  verifyIdToken: vi.fn().mockResolvedValue({ uid: "search-failures-user" }),
}));

// SEARCH_ENGINE=memory builds this fake instead, so each test decides how
// the engine answers, behind the real registry and its deadline.
const engine = vi.hoisted(() => ({ search: null, calls: [] }));
vi.mock("../src/search/adapters/memory.js", () => ({
  createMemorySearchIndex: () => ({
    key: "memory",
    upsert: async () => {},
    delete: async () => {},
    replaceAll: async () => {},
    search: (query) => {
      engine.calls.push(query);
      return engine.search(query);
    },
  }),
}));

const { createApp } = await import("../src/app.js");
const { SearchUnavailableError } = await import("../src/search/ports.js");
const { SearchTimeoutError, withSearchTimeout } = await import("../src/search/timeout.js");

const found = { ids: [], total: 0, facets: [{ name: "category", values: [] }] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What the logger writes to stdout (INFO and WARNING), parsed back from JSON lines.
const captureLogs = () => {
  const lines = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(...String(chunk).split("\n").filter(Boolean));
    return true;
  });
  return () => lines.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
};

describe("search deadline (ECOMAPI-96)", () => {
  const fake = (search) => ({
    key: "fake",
    upsert: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    replaceAll: vi.fn(async () => {}),
    search,
  });

  it("fails a search that takes longer than the deadline with SearchUnavailableError", async () => {
    const index = withSearchTimeout(fake(() => sleep(200).then(() => found)), 20);
    const error = await index.search({ text: "lamp" }).catch((err) => err);
    expect(error).toBeInstanceOf(SearchUnavailableError);
    expect(error.engineKey).toBe("fake");
    expect(error.cause).toBeInstanceOf(SearchTimeoutError);
  });

  it("passes a fast answer and an engine's own failure through", async () => {
    await expect(withSearchTimeout(fake(async () => found), 50).search({ text: "lamp" })).resolves.toBe(found);
    const down = new SearchUnavailableError("fake", new Error("connection refused"));
    await expect(withSearchTimeout(fake(async () => Promise.reject(down)), 50).search({ text: "lamp" })).rejects.toBe(
      down
    );
  });

  it("leaves writes without a deadline", async () => {
    const inner = fake(async () => found);
    inner.replaceAll.mockImplementation(() => sleep(60));
    await expect(withSearchTimeout(inner, 20).replaceAll([])).resolves.toBeUndefined();
  });
});

describe("searchProducts while the search engine fails (ECOMAPI-96)", () => {
  let created;
  const original = { engine: process.env.SEARCH_ENGINE, timeout: process.env.SEARCH_TIMEOUT_MS };
  const restore = (name, value) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
  const post = (query, requestId = "req-search-96") =>
    request(created.app)
      .post("/graphql")
      .set("Authorization", "Bearer test-token")
      .set("X-Request-Id", requestId)
      .send({ query });

  beforeAll(async () => {
    process.env.SEARCH_ENGINE = "memory";
    process.env.SEARCH_TIMEOUT_MS = "50";
    created = await createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    engine.calls = [];
  });

  afterAll(() => {
    created.httpServer?.close();
    restore("SEARCH_ENGINE", original.engine);
    restore("SEARCH_TIMEOUT_MS", original.timeout);
  });

  const SEARCH = `{ searchProducts(query: "secret gift for anna") { totalCount } }`;

  it("answers SERVICE_UNAVAILABLE with retryable when the engine fails, and logs it with the request id", async () => {
    engine.search = async () => {
      throw new SearchUnavailableError("memory", new Error("connection refused"));
    };
    const readLogs = captureLogs();

    const response = await post(SEARCH);

    expect(response.body.errors[0].extensions).toEqual({ code: "SERVICE_UNAVAILABLE", retryable: true });
    expect(response.body.data).toBeNull();
    const entry = readLogs().find((log) => log.message === "Search engine call failed");
    expect(entry).toMatchObject({
      severity: "WARNING",
      requestId: "req-search-96",
      engine: "memory",
      cause: "connection refused",
    });
    // What people search for stays out of the logs.
    expect(JSON.stringify(readLogs())).not.toMatch(/secret gift|anna/);
  });

  it("answers SERVICE_UNAVAILABLE within the deadline when the engine is slow", async () => {
    engine.search = () => sleep(1000).then(() => found);
    const readLogs = captureLogs();

    const started = Date.now();
    const response = await post(SEARCH);

    expect(Date.now() - started).toBeLessThan(900);
    expect(response.body.errors[0].extensions).toEqual({ code: "SERVICE_UNAVAILABLE", retryable: true });
    expect(readLogs().find((log) => log.message === "Search engine call failed")).toMatchObject({
      requestId: "req-search-96",
      cause: "The search engine didn't answer within 50 ms",
    });
  });

  it("asks the engine once for identical searches of the same request", async () => {
    engine.search = async () => found;

    const response = await post(`{
      a: searchProducts(query: "lamp") { totalCount }
      b: searchProducts(query: "lamp") { totalCount }
      c: searchProducts(query: "lamp", inStock: true) { totalCount }
    }`);

    expect(response.body.errors).toBeUndefined();
    expect(engine.calls).toHaveLength(2);
    expect(engine.calls.map((query) => query.filters.inStock)).toEqual([undefined, true]);

    // A new request searches again.
    await post(`{ searchProducts(query: "lamp") { totalCount } }`);
    expect(engine.calls).toHaveLength(3);
  });
});
