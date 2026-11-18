import { describe, it, expect, vi } from "vitest";

const verifyIdTokenMock = vi.fn();
vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifyIdToken: verifyIdTokenMock }),
}));

import { GraphQLError } from "graphql";
import { verifyAnonymousIdToken, verifyIdToken } from "../src/auth/verifyIdToken.js";

// firebase-admin's errors carry their code as "auth/<name>".
const firebaseError = (code) => Object.assign(new Error(`Firebase: ${code}`), { code });

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

  it("accepts an anonymous user's token, which has no email", async () => {
    const anonymous = { uid: "anon-1", firebase: { sign_in_provider: "anonymous" } };
    verifyIdTokenMock.mockResolvedValueOnce(anonymous);
    await expect(verifyIdToken("Bearer anon-token")).resolves.toEqual(anonymous);
  });
});

describe("verifyAnonymousIdToken", () => {
  it("checks that the token wasn't revoked and its user still exists", async () => {
    const anonymous = { uid: "anon-1", firebase: { sign_in_provider: "anonymous" } };
    verifyIdTokenMock.mockResolvedValueOnce(anonymous);
    await expect(verifyAnonymousIdToken("anon-token")).resolves.toEqual(anonymous);
    expect(verifyIdTokenMock).toHaveBeenLastCalledWith("anon-token", true);
  });

  it("answers UNAUTHENTICATED without an http status, so the caller's session isn't blamed", async () => {
    verifyIdTokenMock.mockRejectedValueOnce(firebaseError("auth/user-not-found"));
    const error = await verifyAnonymousIdToken("bad-token").catch((err) => err);
    expect(error.extensions).toEqual({ code: "UNAUTHENTICATED", invalidArgument: "anonymousIdToken" });
  });

  it.each(["auth/argument-error", "auth/id-token-expired", "auth/id-token-revoked", "auth/user-disabled"])(
    "answers UNAUTHENTICATED for a token refused with %s",
    async (code) => {
      verifyIdTokenMock.mockRejectedValueOnce(firebaseError(code));
      await expect(verifyAnonymousIdToken("bad-token")).rejects.toMatchObject({
        extensions: { code: "UNAUTHENTICATED", invalidArgument: "anonymousIdToken" },
      });
    }
  );

  it.each(["auth/insufficient-permission", "auth/internal-error"])(
    "answers an internal error naming the code when verification fails with %s",
    async (code) => {
      const cause = firebaseError(code);
      verifyIdTokenMock.mockRejectedValueOnce(cause);
      const error = await verifyAnonymousIdToken("anon-token").catch((err) => err);
      expect(error).not.toBeInstanceOf(GraphQLError);
      expect(error.message).toContain(code);
      expect(error.cause).toBe(cause);
    }
  );

  it("answers an internal error for a failure without a code, such as the network", async () => {
    verifyIdTokenMock.mockRejectedValueOnce(new Error("socket hang up"));
    const error = await verifyAnonymousIdToken("anon-token").catch((err) => err);
    expect(error).not.toBeInstanceOf(GraphQLError);
    expect(error.message).toContain("no code");
  });

  it("answers BAD_USER_INPUT for an account with an email", async () => {
    verifyIdTokenMock.mockResolvedValueOnce({ uid: "user-1", firebase: { sign_in_provider: "password" } });
    await expect(verifyAnonymousIdToken("email-token")).rejects.toMatchObject({
      extensions: { code: "BAD_USER_INPUT", invalidArgument: "anonymousIdToken" },
    });
  });
});
