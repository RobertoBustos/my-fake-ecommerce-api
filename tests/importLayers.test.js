import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

// The layer rules match a path, so they must catch an import written with the
// #src/* alias as well as the relative form; otherwise the alias would be a
// way around them.
const eslint = new ESLint();
const restricted = async (filePath, specifier) => {
  const [result] = await eslint.lintText(`import x from "${specifier}";\nexport const y = x;\n`, { filePath });
  return result.messages.filter((message) => message.ruleId === "no-restricted-imports");
};

describe("Layer rules with the #src/* alias", () => {
  it.each([
    ["src/schema/resolvers/mutations.ts", "#src/db/products.js", /Writes go through src\/services\//],
    ["src/schema/resolvers/mutations.ts", "#src/config/stripe.js", /use src\/services\//],
    ["src/services/orderService.ts", "#src/config/firestore.js", /go through CatalogSource/],
    ["src/catalog/catalogSync.ts", "#src/config/firestore.js", /go through CatalogSource/],
  ])("rejects %s importing %s", async (filePath, specifier, message) => {
    const messages = await restricted(filePath, specifier);
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatch(message);
  });

  it("rejects the relative form too", async () => {
    expect(await restricted("src/schema/resolvers/mutations.ts", "../../db/products.js")).toHaveLength(1);
  });

  it.each([
    ["src/schema/resolvers/queries.ts", "#src/db/products.js"],
    ["src/catalog/sources/firestore/adapter.ts", "#src/config/firestore.js"],
    ["src/services/orderService.ts", "#src/db/orders.js"],
  ])("allows %s importing %s", async (filePath, specifier) => {
    expect(await restricted(filePath, specifier)).toEqual([]);
  });
});
