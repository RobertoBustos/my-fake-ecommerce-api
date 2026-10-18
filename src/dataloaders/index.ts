import { createDisplayPriceLoader } from "./displayPriceLoader.js";
import { createOrderTotalsLoader } from "./orderTotalsLoader.js";
import { createProductLoader } from "./productLoader.js";

// One instance per request: caching/batching across different requests
// would leak data from one customer into another.
export const createLoaders = () => ({
  products: createProductLoader(),
  orderTotals: createOrderTotalsLoader(),
  displayPrices: createDisplayPriceLoader(),
});
