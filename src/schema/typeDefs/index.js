import cartTypes from "./cartTypes.js";
import orderTypes from "./orderTypes.js";
import paymentTypes from "./paymentTypes.js";
import productTypes from "./productTypes.js";

const rootTypes = `#graphql
  # Comments in GraphQL strings (such as this one) start with the hash (#) symbol.
  type PageInfo {
    hasNextPage: Boolean!
    endCursor: String
  }

  type Query {
    products(id: ID, category: String, first: Int, after: String): ProductConnection!
    carts(cartId: String, productId: String, first: Int, after: String): CartItemConnection!
    orders(id: ID, cart: String, status: Status, first: Int, after: String): OrderConnection!
    incompleteOrders(cart: String, first: Int, after: String): OrderConnection!
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
