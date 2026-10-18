import { DEFAULT_SOURCE_KEY } from "./registry.js";

// The id clients see for a product: "<sourceKey>:<localId>" in base64url, so
// two sources can both have a product "42" and the app still treats the id as
// an opaque string (like the pagination cursors).

export interface ProductRef {
  sourceKey: string;
  localId: string;
}

// Source keys are short and lowercase ("fs", "mysql-outlet").
const SOURCE_KEY = /^[a-z][a-z0-9-]*$/;

export const toGlobalProductId = (sourceKey: string, localId: string): string =>
  Buffer.from(`${sourceKey}:${localId}`, "utf-8").toString("base64url");

// The only place that reads a product id. An id that doesn't decode to
// "<sourceKey>:<localId>" is an id from before global ids existed, which can
// only belong to Firestore; that fallback stays for one release, while the
// stored cart items are migrated. Whether the source exists is checked by the
// registry, not here, so a stored item of a switched-off source can still be
// parsed.
export const parseProductId = (id: string): ProductRef => {
  const decoded = Buffer.from(id, "base64url").toString("utf-8");
  const separator = decoded.indexOf(":");
  if (separator > 0 && toGlobalProductId(decoded.slice(0, separator), decoded.slice(separator + 1)) === id) {
    const sourceKey = decoded.slice(0, separator);
    const localId = decoded.slice(separator + 1);
    if (SOURCE_KEY.test(sourceKey) && localId.length > 0) {
      return { sourceKey, localId };
    }
  }
  return { sourceKey: DEFAULT_SOURCE_KEY, localId: id };
};

// The same product always ends up with the same stored id, whichever form
// (global or legacy) the client sent.
export const canonicalProductId = (id: string): string => {
  const { sourceKey, localId } = parseProductId(id);
  return toGlobalProductId(sourceKey, localId);
};
