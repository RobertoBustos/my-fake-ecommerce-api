import { listCatalogProducts } from "../../catalog/index.js";
import { searchCatalogProducts } from "../../catalog/searchProducts.js";
import { listCartItemsWithoutOrder, listIncompleteOrders, listOrders } from "../../db/index.js";
import type { QueryResolvers } from "../../generated/graphql.js";
import { assertValidInput } from "../../services/errors.js";
import { checkSearchProducts, SEARCH_DEFAULT_PAGE_SIZE } from "../validators/index.js";

// Read-only resolvers may call db/ directly: there are no business rules to
// apply on a plain read. Anything that writes goes through services/ (see
// mutations.ts and the no-restricted-imports rule in eslint.config.js).
// Each list is paginated inside Firestore (db/pagination.ts); products come
// through the catalog, which gives them their global ids.
export const Query: QueryResolvers = {
  products: (_, { id, category, first, after }) =>
    listCatalogProducts({ id, category }, { first, after }),
  // The search index finds the products, the catalog index shows them.
  searchProducts: (_, args) => {
    assertValidInput(checkSearchProducts, args);
    return searchCatalogProducts({ ...args, first: args.first ?? SEARCH_DEFAULT_PAGE_SIZE });
  },
  carts: (_, { cartId, productId, first, after }, context) =>
    listCartItemsWithoutOrder({ cartId, productId, userId: context.user.uid }, { first, after }),
  // H2: a user only sees their own orders, even when requesting a direct id
  // that isn't theirs.
  orders: (_, { id, cart, status, first, after }, context) =>
    listOrders({ id, cart, status, userId: context.user.uid }, { first, after }),
  incompleteOrders: (_, { cart, first, after }, context) =>
    listIncompleteOrders({ cart, userId: context.user.uid }, { first, after }),
};
