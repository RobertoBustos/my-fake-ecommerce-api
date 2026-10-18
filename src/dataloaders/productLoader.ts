import DataLoader from "dataloader";
import { getIndexedCatalogProducts } from "../catalog/index.js";
import type { Product } from "../types/models.js";

// New instance per request (don't share across requests): batches every
// .load(productId) call made in the same tick into a single batch call.
// Answers in the same order as the ids, null for a missing product. Reads
// the catalog index, not the sources (CartItem.product only shows the
// product; the item keeps its own copy of the price).
export const createProductLoader = () =>
  new DataLoader<string, Product | null>((ids) => getIndexedCatalogProducts(ids));
