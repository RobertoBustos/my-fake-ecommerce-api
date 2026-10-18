const cartTypes = /* GraphQL */ `#graphql
  # Comments in GraphQL strings (such as this one) start with the hash (#) symbol.
  type CartItem {
    id: ID!
    orderId: String
    cartId: String!
    "Global id of the product (Product.id)."
    productId: String!
    quantity: Int!
    unitPrice: Int!
    subtotal: Int!
    product: Product!
  }

  type CartItemEdge {
    node: CartItem!
    cursor: String!
  }

  type CartItemConnection {
    edges: [CartItemEdge!]!
    pageInfo: PageInfo!
  }

  input AddToCart {
    productId: String!
    quantity: Int!
    cartId: String!
    orderId: String
  }

  type AddToCartResponse implements MutationResponse {
    code: String!
    success: Boolean!
    message: String!
    data: CartItem!
  }

  input RemoveFromCart {
    id: String!
  }

  type RemoveFromCartResponse implements MutationResponse {
    code: String!
    success: Boolean!
    message: String!
  }
`;

export default cartTypes;
