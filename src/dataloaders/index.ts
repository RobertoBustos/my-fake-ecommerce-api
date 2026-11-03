import { createDisplayPriceLoader } from "./displayPriceLoader.ts";
import { createOrderTotalsLoader } from "./orderTotalsLoader.ts";
import { createProductLoader } from "./productLoader.ts";
import { createSearchLoader } from "./searchLoader.ts";

// One instance per request: caching/batching across different requests
// would leak data from one customer into another.
export const createLoaders = () => ({
  products: createProductLoader(),
  orderTotals: createOrderTotalsLoader(),
  displayPrices: createDisplayPriceLoader(),
  searches: createSearchLoader(),
});
