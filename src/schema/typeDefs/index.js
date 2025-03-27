import cartTypes from "./cartTypes.js";
import productTypes from "./productTypes.js";

const rootTypes = `#graphql
  # Comments in GraphQL strings (such as this one) start with the hash (#) symbol.
  type Query {
    products: [Product!]!
    product(id: ID!): Product
    cartItems: [CartItem!]!
  }

  interface MutationResponse {
    code: String!
    success: Boolean!
    message: String!
  }

  type Mutation {
    addToCart(input: AddToCartInput): AddToCartResponse!
    removeFromCart(id: ID!): RemoveFromCartResponse!
  }
`;

export default [rootTypes, cartTypes, productTypes];
