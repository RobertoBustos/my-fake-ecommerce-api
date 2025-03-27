const cartTypes = `#graphql
  # Comments in GraphQL strings (such as this one) start with the hash (#) symbol.
  type CartItem {
    id: ID!
    cartId: String!
    productId: String!
    quantity: Int!
    unitPrice: Int!
    subtotal: Int!
    product: Product!
  }

  type AddToCartResponse implements MutationResponse {
    code: String!
    success: Boolean!
    message: String!
    data: CartItem
  }

  type RemoveFromCartResponse implements MutationResponse {
    code: String!
    success: Boolean!
    message: String!
  }

  input AddToCartInput {
    productId: String!
    quantity: Int!
    cartId: String!
  }
`;

export default cartTypes;
