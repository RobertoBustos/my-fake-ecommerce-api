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
  const paymentIntent = await stripeClient.paymentIntents.create({
    currency: "MXN",
    customer: customerId,
    amount: amount,
    payment_method_types: ["card"],
    metadata: {
      order_id: orderId,
    },
  });

  return paymentIntent;
};
