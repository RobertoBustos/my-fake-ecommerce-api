const productTypes = /* GraphQL */ `#graphql
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
    "Opaque global id. Bare ids from before global ids existed are still accepted as input for one release."
    id: ID!
    title: String!
    description: String!
    category: String!
    image: String!
    stock: Int!
    currency: String!
    unitPrice: Int!
    purchaseLimits: PurchaseLimit!
    "Display name of the catalog source the product comes from."
    source: String
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
