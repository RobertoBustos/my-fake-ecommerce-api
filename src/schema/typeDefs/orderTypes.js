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

    type Customer {
        id: String!
        name: String!
        email: String!
    }

    type Order {
        id: ID!
        customer: Customer
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

    input CustomerInput{
        email: String!
        name: String!
    }

    input UpdateOrder {
        id: String!
        customer: CustomerInput
    }

    type UpdateOrderResponse implements MutationResponse {
        code: String!
        success: Boolean!
        message: String!
        data: Order
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
