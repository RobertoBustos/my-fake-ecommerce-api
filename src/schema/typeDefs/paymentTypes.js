const paymentTypes = `#graphql
    type Customer {
        id: String!
        name: String!
        email: String!
    }

    type PaymentMethod {
        id: String!
    }

    type Payment {
        id: String!
        amount: Int!
        status: String!
        customer: String!
        payment_method: PaymentMethod
    }

    type PaymentCreated {
        paymentId: String!
        clientSecret: String!
        ephimeralKey: String
    }
`;

export default paymentTypes;
