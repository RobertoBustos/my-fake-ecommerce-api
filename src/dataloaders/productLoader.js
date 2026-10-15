import DataLoader from "dataloader";
import { getProductsByIds } from "../db/products.js";

// Instancia nueva por request (no compartir entre requests): agrupa todos
// los .load(productId) pedidos en el mismo tick en una sola llamada batch.
export const createProductLoader = () =>
  new DataLoader(async (ids) => {
    const products = await getProductsByIds(ids);
    const byId = new Map(products.map((product) => [product.id, product]));
    return ids.map((id) => byId.get(id) ?? null);
  });
