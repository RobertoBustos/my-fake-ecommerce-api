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
        phone: String!
    }

    type Coords {
        latitude: Float!
        longitude: Float!
        latitudeDelta: Float!
        longitudeDelta: Float!
    }

    type Address {
        address: String!
        zipCode: String!
        coords: Coords!
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

    type OrderEdge {
        node: Order!
        cursor: String!
    }

    type OrderConnection {
        edges: [OrderEdge!]!
        pageInfo: PageInfo!
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
        phone: String!
    }

    input CoordsInput {
        latitude: Float!
        longitude: Float!
        latitudeDelta: Float!
        longitudeDelta: Float!
    }

    input AddressInput{
        address: String!
        zipCode: String!
        coords: CoordsInput!
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
