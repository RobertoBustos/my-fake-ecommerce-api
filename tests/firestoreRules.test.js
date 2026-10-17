import { describe, it, expect } from "vitest";

// The Firestore emulator applies firestore.rules to any request without the
// admin "Bearer owner" token, exactly as production does for clients. The API
// itself uses the Admin SDK, which is not subject to these rules.
const host = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const project = process.env.GCLOUD_PROJECT ?? "demo-ecommerce-api";
const documents = `http://${host}/v1/projects/${project}/databases/(default)/documents`;

describe("Firestore security rules", () => {
  it.each(["products", "orders", "cartItems", "users", "processedWebhookEvents"])(
    "deny an unauthenticated client reading %s",
    async (collection) => {
      const response = await fetch(`${documents}/${collection}`);
      expect(response.status).toBe(403);
    }
  );

  it("deny an unauthenticated client writing a document", async () => {
    const response = await fetch(`${documents}/products?documentId=rules-test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { stock: { integerValue: "999" } } }),
    });
    expect(response.status).toBe(403);
  });

  it("deny a signed-in client too, since no client reads Firestore directly", async () => {
    // The emulator accepts unsigned JWTs; this one carries a regular user's uid.
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "none", typ: "JWT" })}.${encode({
      sub: "rules-user",
      user_id: "rules-user",
      aud: project,
      iss: `https://securetoken.google.com/${project}`,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.`;
    const response = await fetch(`${documents}/orders`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
  });
});
