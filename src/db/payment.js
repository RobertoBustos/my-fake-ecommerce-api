import stripeClient from "../config/stripe.js";

export const getCustomer = async (input) => {
  const { email, name } = input;
  let customer;
  const customers = await stripeClient.customers.search({
    query: `email:'${email}'`,
  });
  //the customer was found
  if (customers.data.length > 0) {
    customer = customers.data[0];
  } else {
    // i will create a customer
    customer = await stripeClient.customers.create({
      name: name,
      email: email,
    });
  }
  if (!customer) {
    throw new Error("Error getting customer information");
  }

  return customer;
};

export const createPayment = async (orderId, amount, customerId) => {
  const response = await searchPayment(orderId);
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

export const searchPayment = async (orderId) => {
  const { data } = await stripeClient.paymentIntents.search({
    query: `metadata["order_id"]: "${orderId}"`,
  });
  if (data.length === 0) {
    return null;
  }
  return data[0];
};

export const cancelPayment = async (orderId) => {
  const payment = await searchPayment(orderId);
  if (payment && payment !== null) {
    await stripeClient.paymentIntents.cancel(payment.id);
    return true;
  }
};

export const searchPaymentMethod = async (paymentMethodId) => {
  const { data } = await stripeClient.paymentMethods.retrieve(paymentMethodId);
  if (data.length === 0) {
    return null;
  }
  return data[0];
};
