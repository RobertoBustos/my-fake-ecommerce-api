import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
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
    ["src/schema/resolvers/mutations.ts", "#src/db/products", /Writes go through src\/services\//],
    ["src/schema/resolvers/mutations.ts", "#src/config/stripe", /use src\/services\//],
    ["src/services/orderService.ts", "#src/config/firestore", /go through CatalogSource/],
    ["src/catalog/catalogSync.ts", "#src/config/firestore", /go through CatalogSource/],
  ])("rejects %s importing %s", async (filePath, specifier, message) => {
    const messages = await restricted(filePath, specifier);
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatch(message);
  });

  it.each([
    ["src/schema/resolvers/mutations.ts", "../../db/products.ts"],
    ["src/schema/resolvers/mutations.ts", "../../config/stripe.ts"],
    ["src/catalog/catalogSync.ts", "../config/firestore.ts"],
  ])("rejects the relative form too: %s importing %s", async (filePath, specifier) => {
    expect(await restricted(filePath, specifier)).toHaveLength(1);
  });

  it.each([
    ["src/schema/resolvers/queries.ts", "#src/db/products"],
    ["src/catalog/sources/firestore/adapter.ts", "#src/config/firestore"],
    ["src/services/orderService.ts", "#src/db/orders"],
  ])("allows %s importing %s", async (filePath, specifier) => {
    expect(await restricted(filePath, specifier)).toEqual([]);
  });
});

// Relative imports name the .ts file (tsc rewrites them to .js in dist/) and
// alias imports carry no extension (package.json maps them to .ts or .js).
// A .js import of a source file names a file that doesn't exist in src/.
describe("Import extensions in src/ and scripts/", () => {
  const sourceFiles = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    });
  const imports = /(?:\bfrom|\bimport)\s*\(?\s*["']((?:\.\.?\/|#src\/)[^"']+)["']/g;

  it("has no relative .js imports and no alias imports with an extension", () => {
    const offenders = ["src", "scripts"].flatMap(sourceFiles).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(imports)]
        .map(([, specifier]) => specifier)
        .filter((specifier) => (specifier.startsWith("#src/") ? /\.[cm]?[jt]s$/.test(specifier) : specifier.endsWith(".js")))
        .map((specifier) => `${file}: ${specifier}`)
    );
    expect(offenders).toEqual([]);
  });
});
