const typeDefs = `#graphql
  # Comments in GraphQL strings (such as this one) start with the hash (#) symbol.
  type Rating {
    rate: Float!
    count: Int!
  }

  type PurchaseLimit {
    min: Int!
    max: Int!
  }

  type Product {
    id: ID!
    title: String!
    description: String!
    category: String!
    image: String!
    stock: Int!
    currency: String!
    unitPrice: Int!
    purchaseLimits: PurchaseLimit!
  }

  type CartItem {
    id: ID!
    cartId: String!
    productId: String!
    quantity: Int!
    unitPrice: Int!
    subtotal: Int!
    product: Product!
  }

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

  type Mutation {
    addToCart(input: AddToCartInput): AddToCartResponse!
    removeFromCart(id: ID!): RemoveFromCartResponse!
  }
`;

export default typeDefs;
