import db from "../config/firestore.js";
import stripeClient from "../config/stripe.js";

// Stripe's search language delimits values with quotes; a quote inside an
// unescaped value breaks or manipulates the query (H4). Stripe expects
// quotes (and the backslash itself) inside the value to be escaped with \.
export const escapeStripeSearchValue = (value) => value.replace(/[\\'"]/g, "\\$&");

const USERS_COLLECTION = "users";

// Each Firebase user has exactly one Stripe customer, found through the uid
// (users/{uid}.stripeCustomerId), never through the email typed into the
// order: looking it up by email let one user pick another user's customer
// and get an ephemeral key for their saved cards. The typed details only
// update the user's own customer.
export const getCustomer = async (input, userId) => {
  if (!userId) {
    throw new Error("A Stripe customer can only be resolved for a signed-in user");
  }
  const details = { name: input.name, email: input.email, phone: input.phone };
  const userRef = db.collection(USERS_COLLECTION).doc(userId);
  const userDoc = await userRef.get();
  let customerId = userDoc.exists ? userDoc.data().stripeCustomerId : undefined;

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

export const createPayment = async (orderId, amount, customerId) => {
  const response = await searchPayment("order", orderId);
  let paymentIntent;
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

  return {
    paymentId: paymentIntent.id,
    clientSecret: paymentIntent.client_secret,
    ephimeralKey: ephemeralKey.secret,
  };
};

export const searchPayment = async (searchBy, value) => {
  let response;
  if (searchBy === "id") {
    response = await stripeClient.paymentIntents.retrieve(value);
    if (!response) {
      return null;
    }
    return response;
  } else if (searchBy === "order") {
    response = await stripeClient.paymentIntents.search({
      query: `metadata["order_id"]: "${escapeStripeSearchValue(value)}"`,
    });
    if (response.data.length === 0) {
      return null;
    }
    return response.data[0];
  }
};

export const cancelPayment = async (orderId) => {
  const payment = await searchPayment("id", orderId);
  if (payment && payment !== null) {
    await stripeClient.paymentIntents.cancel(payment.id);
    return true;
  }
};

export const searchPaymentMethod = async (paymentMethodId) => {
  const response = await stripeClient.paymentMethods.retrieve(paymentMethodId);
  return response;
};
