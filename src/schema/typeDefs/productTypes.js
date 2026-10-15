const productTypes = `#graphql
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

  type ProductEdge {
    node: Product!
    cursor: String!
  }

  type ProductConnection {
    edges: [ProductEdge!]!
    pageInfo: PageInfo!
  }
`;

export default productTypes;
