import cartTypes from "./cartTypes.ts";
import orderTypes from "./orderTypes.ts";
import paymentTypes from "./paymentTypes.ts";
import productTypes from "./productTypes.ts";
import pushTypes from "./pushTypes.ts";

const rootTypes = /* GraphQL */ `#graphql
  # Comments in GraphQL strings (such as this one) start with the hash (#) symbol.
  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type Query {
    products(id: ID, category: String,
      "Page size, from 1 to 100. Defaults to 20."
      first: Int
      "endCursor of the previous page. An unknown cursor is rejected with BAD_USER_INPUT."
      after: String
    ): ProductConnection!
    "Full-text search of the catalog: words match with typo tolerance and the last one as a prefix; a phrase in double quotes matches exactly."
    searchProducts(
      "From 2 to 100 characters."
      query: String!
      category: String
      "Cents of the settlement currency, inclusive. Products without a price in it never match a price filter."
      minPrice: Int
      "Cents of the settlement currency, inclusive. Not below minPrice."
      maxPrice: Int
      inStock: Boolean
      sort: ProductSort = RELEVANCE
      "Page size, from 1 to 50. Defaults to 20."
      first: Int
      "endCursor of the previous page of the same search. An unknown cursor is rejected with BAD_USER_INPUT."
      after: String
    ): ProductSearchConnection!
    carts(cartId: String, productId: String,
      "Page size, from 1 to 100. Defaults to 20."
      first: Int
      "endCursor of the previous page. An unknown cursor is rejected with BAD_USER_INPUT."
      after: String
    ): CartItemConnection!
    orders(id: ID, cart: String, status: Status,
      "Page size, from 1 to 100. Defaults to 20."
      first: Int
      "endCursor of the previous page. An unknown cursor is rejected with BAD_USER_INPUT."
      after: String
    ): OrderConnection!
    incompleteOrders(cart: String,
      "Page size, from 1 to 100. Defaults to 20."
      first: Int
      "endCursor of the previous page. An unknown cursor is rejected with BAD_USER_INPUT."
      after: String
    ): OrderConnection!
  }

  interface MutationResponse {
    code: String!
    success: Boolean!
    message: String!
  }

  type Mutation {
    addToCart(input: AddToCart!): AddToCartResponse!
    removeFromCart(input: RemoveFromCart!): RemoveFromCartResponse!
    mergeAnonymousCart(input: MergeAnonymousCart!): MergeAnonymousCartResponse!
    createOrder(input: CreateOrder!): CreateOrderResponse!
    updateOrder(input: UpdateOrder!): UpdateOrderResponse!
    cancelOrder(input: CancelOrder!): CancelOrderResponse!
    createOrderPayment(input: CreateOrderPayment!): CreateOrderPaymentResponse!
    "Saves the device's push token under the signed-in user. Safe to call on every app start; a token registered by another user moves to this one."
    registerPushToken(input: RegisterPushToken!): RegisterPushTokenResponse!
    "Deletes one of the signed-in user's push tokens; call it before signing out."
    unregisterPushToken(input: UnregisterPushToken!): UnregisterPushTokenResponse!
  }
`;

export default [rootTypes, cartTypes, productTypes, paymentTypes, orderTypes, pushTypes];
