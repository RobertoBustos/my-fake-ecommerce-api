const paymentTypes = /* GraphQL */ `#graphql
    type Checks {
        cvc_check: String!
    }

    type Card {
        brand: String!
        checks: Checks
        display_brand: String!
        exp_month: Int!
        exp_year: Int!
        fingerprint: String!
        last4: String!
    }

    type PaymentMethod {
        id: String!
        card: Card!
    }

    type Payment {
        id: String!
        amount: Int!
        status: String!
        customer: String!
        payment_method: String
        paymentDetails: PaymentMethod
    }

    type PaymentCreated {
        paymentId: String!
        clientSecret: String!
        ephimeralKey: String!
    }
`;

export default paymentTypes;
