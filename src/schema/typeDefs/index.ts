import cartTypes from "./cartTypes.js";
import orderTypes from "./orderTypes.js";
import paymentTypes from "./paymentTypes.js";
import productTypes from "./productTypes.js";

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
    createOrder(input: CreateOrder!): CreateOrderResponse!
    updateOrder(input: UpdateOrder!): UpdateOrderResponse!
    cancelOrder(input: CancelOrder!): CancelOrderResponse!
    createOrderPayment(input: CreateOrderPayment!): CreateOrderPaymentResponse!
  }
`;

export default [rootTypes, cartTypes, productTypes, paymentTypes, orderTypes];
