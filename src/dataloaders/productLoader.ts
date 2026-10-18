import DataLoader from "dataloader";
import { getCatalogProducts } from "../catalog/index.js";
import type { Product } from "../types/models.js";

// New instance per request (don't share across requests): batches every
// .load(productId) call made in the same tick into a single batch call.
// Answers in the same order as the ids, null for a missing product.
export const createProductLoader = () =>
  new DataLoader<string, Product | null>((ids) => getCatalogProducts(ids));
