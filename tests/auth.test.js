import { describe, it, expect, vi } from "vitest";

const verifyIdTokenMock = vi.fn();
vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifyIdToken: verifyIdTokenMock }),
}));

import { verifyIdToken } from "../src/auth/verifyIdToken.js";

describe("verifyIdToken", () => {
  it("sin header de autorización regresa UNAUTHENTICATED", async () => {
    await expect(verifyIdToken(undefined)).rejects.toMatchObject({
      extensions: { code: "UNAUTHENTICATED" },
    });
  });

  it("con header sin prefijo Bearer regresa UNAUTHENTICATED", async () => {
    await expect(verifyIdToken("token-sin-bearer")).rejects.toMatchObject({
      extensions: { code: "UNAUTHENTICATED" },
    });
  });

  it("con token inválido regresa UNAUTHENTICATED", async () => {
    verifyIdTokenMock.mockRejectedValueOnce(new Error("invalid token"));
    await expect(verifyIdToken("Bearer bad-token")).rejects.toMatchObject({
      extensions: { code: "UNAUTHENTICATED" },
    });
  });

  it("con token válido regresa el usuario decodificado", async () => {
    verifyIdTokenMock.mockResolvedValueOnce({ uid: "user-1", email: "a@b.com" });
    const user = await verifyIdToken("Bearer good-token");
    expect(user).toEqual({ uid: "user-1", email: "a@b.com" });
  });
});
