import { describe, it, expect, vi } from "vitest";

vi.mock("../src/auth/verifyIdToken.js", () => ({
  verifyIdToken: vi.fn().mockResolvedValue({ uid: "user-1" }),
}));

import { createContext } from "../src/context.js";

describe("createContext", () => {
  it("arma headers, loaders y user a partir del request", async () => {
    const req = { headers: { authorization: "Bearer good-token" } };
    const context = await createContext({ req });

    expect(context.user).toEqual({ uid: "user-1" });
    expect(context.headers).toBe(req.headers);
    expect(context.loaders.products).toBeDefined();
    expect(context.loaders.orderTotals).toBeDefined();
  });
});
