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

    type Address {
        address: String!
        zipCode: String!
    }

    type Order {
        id: ID!
        cart: String!
        totals: Totals!
        status: Status!
        paymentId: String
        customer: Customer
        address: Address
        payment: Payment
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

    input AddressInput{
        address: String!
        zipCode: String!
    }

    input UpdateOrder {
        id: String!
        customer: CustomerInput
        address: AddressInput
        status: Status
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

    input CreateOrderPayment {
        orderId: String!
    }

    type CreateOrderPaymentResponse implements MutationResponse{
        code: String!
        success: Boolean!
        message: String!
        data: PaymentCreated
    }
`;

export default orderTypes;
