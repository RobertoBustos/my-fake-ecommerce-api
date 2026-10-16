import { describe, it, expect, vi } from "vitest";

const verifyIdTokenMock = vi.fn();
vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifyIdToken: verifyIdTokenMock }),
}));

import { verifyIdToken } from "../src/auth/verifyIdToken.js";

describe("verifyIdToken", () => {
  it("without an authorization header returns UNAUTHENTICATED", async () => {
    await expect(verifyIdToken(undefined)).rejects.toMatchObject({
      extensions: { code: "UNAUTHENTICATED" },
    });
  });

  it("with a header missing the Bearer prefix returns UNAUTHENTICATED", async () => {
    await expect(verifyIdToken("token-without-bearer")).rejects.toMatchObject({
      extensions: { code: "UNAUTHENTICATED" },
    });
  });

  it("with an invalid token returns UNAUTHENTICATED", async () => {
    verifyIdTokenMock.mockRejectedValueOnce(new Error("invalid token"));
    await expect(verifyIdToken("Bearer bad-token")).rejects.toMatchObject({
      extensions: { code: "UNAUTHENTICATED" },
    });
  });

  it("with a valid token returns the decoded user", async () => {
    verifyIdTokenMock.mockResolvedValueOnce({ uid: "user-1", email: "a@b.com" });
    const user = await verifyIdToken("Bearer good-token");
    expect(user).toEqual({ uid: "user-1", email: "a@b.com" });
  });
});
