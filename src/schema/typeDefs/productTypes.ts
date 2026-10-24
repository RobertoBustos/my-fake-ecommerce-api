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
    "ISO 4217 code of unitPrice: the settlement currency, or the source's own currency while no exchange rate is available."
    currency: String!
    "Cents of currency."
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

  enum ProductSort {
    "Best match first."
    RELEVANCE
    "Cheapest first, by the price in the settlement currency; products without a price come last."
    PRICE_ASC
    "Most expensive first; products without a price come last."
    PRICE_DESC
  }

  type ProductFacetValue {
    value: String!
    "Products of the search with this value, across all pages."
    count: Int!
  }

  type ProductFacet {
    "The product field it counts: category."
    name: String!
    "Most common first."
    values: [ProductFacetValue!]!
  }

  type ProductSearchConnection {
    edges: [ProductEdge!]!
    pageInfo: PageInfo!
    "Matches across all pages. The search index can be a few minutes behind the catalog, so a page may hold fewer products than this suggests."
    totalCount: Int!
    "Counts of each value over every match, to narrow the search down."
    facets: [ProductFacet!]!
  }
`;

export default productTypes;
