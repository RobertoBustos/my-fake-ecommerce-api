import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { Query } from "firebase-admin/firestore";
import db from "../src/config/firestore.js";
import { paginateQuery } from "../src/db/pagination.js";
import {
  decodeCursor,
  encodeCursor,
  resolvePageSize,
  toConnection,
} from "../src/utils/pagination.js";

const extensionsOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.extensions;
  }
  return null;
};

describe("pagination arguments", () => {
  it("uses a page of 20 when first is omitted", () => {
    expect(resolvePageSize(undefined)).toBe(20);
  });

  it("accepts the maximum page size of 100", () => {
    expect(resolvePageSize(100)).toBe(100);
  });

  it.each([-1, 0, 101, 1.5])("rejects first = %s", (first) => {
    expect(extensionsOf(() => resolvePageSize(first))).toEqual({
      code: "BAD_USER_INPUT",
      invalidArgument: "first",
    });
  });

  it("round-trips a cursor", () => {
    expect(decodeCursor(encodeCursor("abc123"))).toBe("abc123");
  });

  it.each([
    ["isn't base64", "%%%"],
    ["decodes to an id with a slash", encodeCursor("orders/abc")],
    ["is empty", ""],
  ])("rejects a cursor that %s", (_, after) => {
    expect(extensionsOf(() => decodeCursor(after))).toEqual({
      code: "BAD_USER_INPUT",
      invalidArgument: "after",
    });
  });

  it("builds a connection from one extra item", () => {
    const { edges, pageInfo } = toConnection([{ id: "1" }, { id: "2" }, { id: "3" }], 2);
    expect(edges.map((e) => e.node.id)).toEqual(["1", "2"]);
    expect(pageInfo).toEqual({ hasNextPage: true, endCursor: encodeCursor("2") });
  });
});

// Runs against the emulator: the page is cut by Firestore, not in memory.
describe("paginateQuery (ECOMAPI-66)", () => {
  const collection = db.collection(`paginationTest_${randomUUID()}`);
  const toNode = (doc) => ({ id: doc.id, ...doc.data() });
  const ids = Array.from({ length: 120 }, (_, i) => `item-${String(i).padStart(3, "0")}`);

  beforeAll(async () => {
    const batch = db.batch();
    ids.forEach((id, i) => batch.set(collection.doc(id), { group: i % 2 === 0 ? "even" : "odd" }));
    await batch.commit();
  });

  afterAll(async () => {
    const batch = db.batch();
    ids.forEach((id) => batch.delete(collection.doc(id)));
    await batch.commit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Counts the documents every query returns, i.e. what Firestore bills as reads.
  const countReads = () => {
    const sizes = [];
    const realGet = Query.prototype.get;
    vi.spyOn(Query.prototype, "get").mockImplementation(async function (...args) {
      const snapshot = await realGet.apply(this, args);
      sizes.push(snapshot.size);
      return snapshot;
    });
    return sizes;
  };

  it("walks the whole list page by page without gaps or repeats", async () => {
    const seen = [];
    let after;
    let hasNextPage = true;
    while (hasNextPage) {
      const page = await paginateQuery(collection, { first: 50, after }, toNode);
      seen.push(...page.edges.map((e) => e.node.id));
      ({ hasNextPage, endCursor: after } = page.pageInfo);
    }
    expect(seen).toEqual(ids);
  });

  it("reads at most first + 1 documents for a page, not the whole collection", async () => {
    const reads = countReads();
    const page = await paginateQuery(collection, { first: 10 }, toNode);

    expect(page.edges).toHaveLength(10);
    expect(page.pageInfo.hasNextPage).toBe(true);
    expect(reads).toEqual([11]);
  });

  it("checks the cursor with one extra read and continues after it", async () => {
    const reads = countReads();
    const page = await paginateQuery(
      collection,
      { first: 5, after: encodeCursor("item-009") },
      toNode
    );

    expect(page.edges.map((e) => e.node.id)).toEqual([
      "item-010",
      "item-011",
      "item-012",
      "item-013",
      "item-014",
    ]);
    expect(reads).toEqual([1, 6]);
  });

  it("applies the list's filters before cutting the page", async () => {
    const page = await paginateQuery(collection.where("group", "==", "odd"), { first: 3 }, toNode);
    expect(page.edges.map((e) => e.node.id)).toEqual(["item-001", "item-003", "item-005"]);
  });

  it("rejects a cursor from a document outside the filtered list", async () => {
    const odd = collection.where("group", "==", "odd");
    await expect(
      paginateQuery(odd, { after: encodeCursor("item-002") }, toNode)
    ).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "after" },
    });
  });

  it("rejects a cursor for a document that doesn't exist", async () => {
    await expect(
      paginateQuery(collection, { after: encodeCursor("missing") }, toNode)
    ).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "after" },
    });
  });

  it("returns an empty last page with no cursor", async () => {
    const page = await paginateQuery(collection, { after: encodeCursor("item-119") }, toNode);
    expect(page).toEqual({ edges: [], pageInfo: { hasNextPage: false, endCursor: null } });
  });
});
