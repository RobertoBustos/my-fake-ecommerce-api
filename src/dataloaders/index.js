import { createOrderTotalsLoader } from "./orderTotalsLoader.js";
import { createProductLoader } from "./productLoader.js";

// Una instancia por request: cachear/batchear entre requests distintos
// filtraría datos de un cliente a otro.
export const createLoaders = () => ({
  products: createProductLoader(),
  orderTotals: createOrderTotalsLoader(),
});
