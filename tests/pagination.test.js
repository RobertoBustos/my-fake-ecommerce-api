import { describe, it, expect } from "vitest";
import { paginate } from "../src/utils/pagination.js";

const items = [{ id: "1" }, { id: "2" }, { id: "3" }];

describe("paginate (H9)", () => {
  it("regresa todo en un solo edge si no se manda first", () => {
    const { edges, pageInfo } = paginate(items);
    expect(edges.map((e) => e.node.id)).toEqual(["1", "2", "3"]);
    expect(pageInfo.hasNextPage).toBe(false);
  });

  it("limita el tamaño de página con first", () => {
    const { edges, pageInfo } = paginate(items, { first: 2 });
    expect(edges.map((e) => e.node.id)).toEqual(["1", "2"]);
    expect(pageInfo.hasNextPage).toBe(true);
    expect(pageInfo.endCursor).toBeTruthy();
  });

  it("continúa después del cursor recibido", () => {
    const firstPage = paginate(items, { first: 2 });
    const secondPage = paginate(items, {
      first: 2,
      after: firstPage.pageInfo.endCursor,
    });
    expect(secondPage.edges.map((e) => e.node.id)).toEqual(["3"]);
    expect(secondPage.pageInfo.hasNextPage).toBe(false);
  });
});
