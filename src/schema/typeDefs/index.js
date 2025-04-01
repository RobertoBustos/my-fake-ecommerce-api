import cartTypes from "./cartTypes.js";
import orderTypes from "./orderTypes.js";
import paymentTypes from "./paymentTypes.js";
import productTypes from "./productTypes.js";

const rootTypes = `#graphql
  # Comments in GraphQL strings (such as this one) start with the hash (#) symbol.
  input Filter {
    field: String!
    value: String!
  }

  type Query {
    products(filter: Filter): [Product!]!
    carts(filter: Filter):[CartItem!]!
    orders(filter: Filter): [Order!]!
    incompleteOrders(filter: Filter): [Order!]!
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
