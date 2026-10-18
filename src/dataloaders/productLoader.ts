import DataLoader from "dataloader";
import { getCatalogProducts } from "../catalog/index.js";
import type { Product } from "../types/models.js";

// New instance per request (don't share across requests): batches every
// .load(productId) call made in the same tick into a single batch call.
export const createProductLoader = () =>
  new DataLoader<string, Product | null>(async (ids) => {
    const products = await getCatalogProducts(ids);
    const byId = new Map(products.map((product) => [product.id, product]));
    return ids.map((id) => byId.get(id) ?? null);
  });
