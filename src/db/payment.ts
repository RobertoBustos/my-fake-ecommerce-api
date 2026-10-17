import type Stripe from "stripe";
import db from "../config/firestore.js";
import stripeClient from "../config/stripe.js";

// Stripe's search language delimits values with quotes; a quote inside an
// unescaped value breaks or manipulates the query (H4). Stripe expects
// quotes (and the backslash itself) inside the value to be escaped with \.
export const escapeStripeSearchValue = (value: string): string => value.replace(/[\\'"]/g, "\\$&");

const USERS_COLLECTION = "users";

// Each Firebase user has exactly one Stripe customer, found through the uid
// (users/{uid}.stripeCustomerId), never through the email typed into the
// order: looking it up by email let one user pick another user's customer
// and get an ephemeral key for their saved cards. The typed details only
// update the user's own customer.
export interface CustomerDetails {
  name: string;
  email: string;
  phone: string;
}

export const getCustomer = async (
  input: CustomerDetails,
  userId: string | null
): Promise<Stripe.Customer> => {
  if (!userId) {
    throw new Error("A Stripe customer can only be resolved for a signed-in user");
  }
  const details = { name: input.name, email: input.email, phone: input.phone };
  const userRef = db.collection(USERS_COLLECTION).doc(userId);
  const userDoc = await userRef.get();
  let customerId: string | undefined = userDoc.get("stripeCustomerId");

  if (!customerId) {
    // Same parameters on every attempt, so the idempotency key holds: two
    // concurrent first orders, or a retry after a failed Firestore write,
    // get the same customer instead of a duplicate.
    const created = await stripeClient.customers.create(
      { metadata: { firebase_uid: userId } },
      { idempotencyKey: `customer-${userId}` }
    );
    customerId = created.id;
    await userRef.set({ stripeCustomerId: customerId }, { merge: true });
  }

  return stripeClient.customers.update(customerId, details);
};

export interface PaymentCreated {
  paymentId: string;
  clientSecret: string;
  ephimeralKey: string;
}

export const createPayment = async (
  orderId: string,
  amount: number,
  customerId: string
): Promise<PaymentCreated> => {
  const response = await searchPayment("order", orderId);
  let paymentIntent: Stripe.PaymentIntent;
  if (!response || response === null) {
    // Stable key per order: if the call is retried (timeout, client retry,
    // etc.), Stripe returns the same PaymentIntent instead of creating a
    // new one.
    paymentIntent = await stripeClient.paymentIntents.create(
      {
        currency: "MXN",
        customer: customerId,
        amount: amount,
        payment_method_types: ["card"],
        metadata: {
          order_id: orderId,
        },
      },
      { idempotencyKey: `order-${orderId}-payment-intent` }
    );
  } else {
    if (response.amount !== amount) {
      paymentIntent = await stripeClient.paymentIntents.update(response.id, {
        amount: amount,
      });
    } else {
      paymentIntent = response;
    }
  }

  const ephemeralKey = await stripeClient.ephemeralKeys.create(
    { customer: customerId },
    { apiVersion: "2024-11-20.acacia" }
  );

  // Stripe always sets both for a PaymentIntent and an ephemeral key that
  // were just created or retrieved; the types only allow them to be absent.
  return {
    paymentId: paymentIntent.id,
    clientSecret: paymentIntent.client_secret as string,
    ephimeralKey: ephemeralKey.secret as string,
  };
};

export const searchPayment = async (
  searchBy: "id" | "order",
  value: string
): Promise<Stripe.PaymentIntent | null | undefined> => {
  if (searchBy === "id") {
    const response = await stripeClient.paymentIntents.retrieve(value);
    if (!response) {
      return null;
    }
    return response;
  } else if (searchBy === "order") {
    const response = await stripeClient.paymentIntents.search({
      query: `metadata["order_id"]: "${escapeStripeSearchValue(value)}"`,
    });
    if (response.data.length === 0) {
      return null;
    }
    return response.data[0];
  }
};

export const cancelPayment = async (paymentId: string): Promise<boolean> => {
  const payment = await searchPayment("id", paymentId);
  // Stripe rejects cancelling a PaymentIntent that is already cancelled.
  if (!payment || payment.status === "canceled") {
    return false;
  }
  await stripeClient.paymentIntents.cancel(payment.id);
  return true;
};

export const searchPaymentMethod = async (
  paymentMethodId: string
): Promise<Stripe.PaymentMethod> => {
  const response = await stripeClient.paymentMethods.retrieve(paymentMethodId);
  return response;
};
