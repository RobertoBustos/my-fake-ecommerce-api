import stripeClient from "../config/stripe.js";

// Stripe usa comillas simples para delimitar valores en su lenguaje de
// búsqueda; un email con comilla simple sin escapar rompe o manipula el
// query (H4). Stripe espera que las comillas dentro del valor vayan con \.
export const escapeStripeSearchValue = (value) => value.replace(/'/g, "\\'");

export const getCustomer = async (input) => {
  const { email, name, phone } = input;
  let customer;
  const customers = await stripeClient.customers.search({
    query: `email:'${escapeStripeSearchValue(email)}'`,
  });
  //the customer was found
  if (customers.data.length > 0) {
    customer = customers.data[0];
    if (customer.phone === null) {
      customer = await stripeClient.customers.update(customer.id, {
        phone: phone,
      });
    }
  } else {
    // i will create a customer
    customer = await stripeClient.customers.create({
      name: name,
      email: email,
      phone: phone,
    });
  }
  if (!customer) {
    throw new Error("Error getting customer information");
  }

  return customer;
};

export const createPayment = async (orderId, amount, customerId) => {
  const response = await searchPayment("order", orderId);
  let paymentIntent;
  if (!response || response === null) {
    paymentIntent = await stripeClient.paymentIntents.create({
      currency: "MXN",
      customer: customerId,
      amount: amount,
      payment_method_types: ["card"],
      metadata: {
        order_id: orderId,
      },
    });
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
      query: `metadata["order_id"]: "${value}"`,
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
