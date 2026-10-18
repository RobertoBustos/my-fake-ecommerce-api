import { applyCatalogChanges } from "../../src/catalog/catalogSync.js";
import { toGlobalProductId } from "../../src/catalog/productId.js";
import { firestoreCatalogSource } from "../../src/catalog/sources/firestore/adapter.js";
import { deleteCatalogEntries } from "../../src/db/catalogIndex.js";

// The products query reads the catalog index, so a test that writes a
// product straight to Firestore indexes it, as the sync job would.
export const indexFirestoreProducts = async (...localIds) => {
  const items = await firestoreCatalogSource.getProducts(localIds);
  await applyCatalogChanges(firestoreCatalogSource.key, { items, deletedIds: [] });
};

export const unindexFirestoreProducts = (...localIds) =>
  deleteCatalogEntries(localIds.map((id) => toGlobalProductId(firestoreCatalogSource.key, id)));
