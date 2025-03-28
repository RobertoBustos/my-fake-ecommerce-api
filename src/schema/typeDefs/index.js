import cartTypes from "./cartTypes.js";
import orderTypes from "./orderTypes.js";
import productTypes from "./productTypes.js";

const rootTypes = `#graphql
  # Comments in GraphQL strings (such as this one) start with the hash (#) symbol.
  type Query {
    products: [Product!]!
    product(id: ID!): Product
    carts:[CartItem!]!
    cart(id: ID!): [CartItem!]!
    orders: [Order!]!
    order(id: ID!): Order
  }

  interface MutationResponse {
    code: String!
    success: Boolean!
    message: String!
  }

  type Mutation {
    addToCart(input: AddToCart): AddToCartResponse!
    removeFromCart(input: RemoveFromCart): RemoveFromCartResponse!
    createOrder(input: CreateOrder): CreateOrderResponse!
    updateOrder(input: UpdateOrder): UpdateOrderResponse!
    cancelOrder(input: CancelOrder): CancelOrderResponse!
  }
`;

export default [rootTypes, cartTypes, productTypes, orderTypes];
