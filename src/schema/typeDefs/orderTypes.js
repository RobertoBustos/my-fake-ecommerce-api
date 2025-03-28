const orderTypes = `#graphql
  # Comments in GraphQL strings (such as this one) start with the hash (#) symbol.
    enum Status {
        INCOMPLETE #"Incomplete"
        PAYMENT_PENDING #"Payment Pending"
        COMPLETE #"Completed"
        CANCELLED #"Cancelled"
    }

    type Totals {
        currency: String!
        items: Int!
        units: Int!
        subTotal: Int!
        taxes: Int!
        discount: Int!
        total: Int!
    }

    type Order {
        id: ID!
        customer: String!
        payment: String!
        cart: String!
        totals: Totals!
        status: Status
        details: [CartItem!]!
    }

    input CreateOrder {
        cartId: String!
    }

    type CreateOrderResponse implements MutationResponse {
        code: String!
        success: Boolean!
        message: String!
        data: Order!
    }

    input UpdateOrder {
        id: String!
        customer: String!
    }

    type UpdateOrderResponse implements MutationResponse {
        code: String!
        success: Boolean!
        message: String!
        data: Order!
    }

    input CancelOrder {
        id: String!
    }

    type CancelOrderResponse implements MutationResponse {
        code: String!
        success: Boolean!
        message: String!
    }
`;

export default orderTypes;
