import { listCatalogProducts } from "../../catalog/index.js";
import { listCartItemsWithoutOrder, listIncompleteOrders, listOrders } from "../../db/index.js";
import type { QueryResolvers } from "../../generated/graphql.js";

// Read-only resolvers may call db/ directly: there are no business rules to
// apply on a plain read. Anything that writes goes through services/ (see
// mutations.ts and the no-restricted-imports rule in eslint.config.js).
// Each list is paginated inside Firestore (db/pagination.ts); products come
// through the catalog, which gives them their global ids.
export const Query: QueryResolvers = {
  products: (_, { id, category, first, after }) =>
    listCatalogProducts({ id, category }, { first, after }),
  carts: (_, { cartId, productId, first, after }, context) =>
    listCartItemsWithoutOrder({ cartId, productId, userId: context.user.uid }, { first, after }),
  // H2: a user only sees their own orders, even when requesting a direct id
  // that isn't theirs.
  orders: (_, { id, cart, status, first, after }, context) =>
    listOrders({ id, cart, status, userId: context.user.uid }, { first, after }),
  incompleteOrders: (_, { cart, first, after }, context) =>
    listIncompleteOrders({ cart, userId: context.user.uid }, { first, after }),
};
