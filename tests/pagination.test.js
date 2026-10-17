import { describe, it, expect } from "vitest";
import { paginate } from "../src/utils/pagination.js";

const items = [{ id: "1" }, { id: "2" }, { id: "3" }];

describe("paginate (H9)", () => {
  it("returns everything as a single page when first is omitted", () => {
    const { edges, pageInfo } = paginate(items);
    expect(edges.map((e) => e.node.id)).toEqual(["1", "2", "3"]);
    expect(pageInfo.hasNextPage).toBe(false);
  });

  it("limits the page size with first", () => {
    const { edges, pageInfo } = paginate(items, { first: 2 });
    expect(edges.map((e) => e.node.id)).toEqual(["1", "2"]);
    expect(pageInfo.hasNextPage).toBe(true);
    expect(pageInfo.endCursor).toBeTruthy();
  });

  it("continues after the received cursor", () => {
    const firstPage = paginate(items, { first: 2 });
    const secondPage = paginate(items, {
      first: 2,
      after: firstPage.pageInfo.endCursor,
    });
    expect(secondPage.edges.map((e) => e.node.id)).toEqual(["3"]);
    expect(secondPage.pageInfo.hasNextPage).toBe(false);
  });
});

describe("paginate argument validation", () => {
  const many = Array.from({ length: 150 }, (_, i) => ({ id: String(i + 1) }));
  const rejected = (args) => {
    try {
      paginate(many, args);
    } catch (err) {
      return err.extensions;
    }
    return null;
  };

  it("uses a page of 20 when first is omitted", () => {
    const { edges, pageInfo } = paginate(many);
    expect(edges).toHaveLength(20);
    expect(pageInfo.hasNextPage).toBe(true);
  });

  it("accepts the maximum page size of 100", () => {
    expect(paginate(many, { first: 100 }).edges).toHaveLength(100);
  });

  it.each([-1, 0, 101])("rejects first = %s", (first) => {
    expect(rejected({ first })).toEqual({ code: "BAD_USER_INPUT", invalidArgument: "first" });
  });

  it("rejects a cursor that doesn't belong to the list", () => {
    const after = Buffer.from("not-an-item").toString("base64");
    expect(rejected({ after })).toEqual({ code: "BAD_USER_INPUT", invalidArgument: "after" });
  });

  it("rejects a cursor that isn't even base64", () => {
    expect(rejected({ after: "%%%" })).toEqual({
      code: "BAD_USER_INPUT",
      invalidArgument: "after",
    });
  });
});
