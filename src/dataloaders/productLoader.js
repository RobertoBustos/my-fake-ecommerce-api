import DataLoader from "dataloader";
import { getProductsByIds } from "../db/products.js";

// New instance per request (don't share across requests): batches every
// .load(productId) call made in the same tick into a single batch call.
export const createProductLoader = () =>
  new DataLoader(async (ids) => {
    const products = await getProductsByIds(ids);
    const byId = new Map(products.map((product) => [product.id, product]));
    return ids.map((id) => byId.get(id) ?? null);
  });
