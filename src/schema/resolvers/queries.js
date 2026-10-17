import {
  getCartWithoutOrder,
  getIncompleteOrders,
  getOrders,
  getProducts,
} from "../../db/index.js";
import { paginate } from "../../utils/pagination.js";

// Read-only resolvers may call db/ directly: there are no business rules to
// apply on a plain read. Anything that writes goes through services/ (see
// mutations.js and the no-restricted-imports rule in eslint.config.js).
export const Query = {
  products: async (_, { id, category, first, after }) => {
    const products = await getProducts({ id, category });
    return paginate(products, { first, after });
  },
  carts: async (_, { cartId, productId, first, after }, context) => {
    const cart = await getCartWithoutOrder({ cartId, productId, userId: context.user.uid });
    return paginate(cart, { first, after });
  },
  orders: async (_, { id, cart, status, first, after }, context) => {
    // H2: a user only sees their own orders, even when requesting a
    // direct id that isn't theirs.
    const orders = await getOrders({ id, cart, status, userId: context.user.uid });
    return paginate(orders, { first, after });
  },
  incompleteOrders: async (_, { cart, first, after }, context) => {
    const incompleteOrders = await getIncompleteOrders({ cart, userId: context.user.uid });
    return paginate(incompleteOrders, { first, after });
  },
};
