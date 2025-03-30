import { v4 as uuidv4 } from "uuid";
import { fakePromise } from "../utils/fakePromise.js";
import { readFile, writeFile } from "../utils/fileUtils.js";
import { getCart } from "./cart.js";
import { cancelPayment, getCustomer } from "./payment.js";

const FILE_PATH = "../data/orders.json";

export const getOrders = async (filter) => {
  const orders = await readFile(FILE_PATH);
  if (filter !== null) {
    return orders.filter((order) => order[filter.field] == filter.value);
  }
  return orders;
};

export const getOrderTotals = async (id) => {
  const cart = await getCart({ field: "orderId", value: id });
  const units = cart.reduce((acc, item) => (acc += item.quantity), 0);
  const subtotal = cart.reduce((acc, item) => (acc += item.subtotal), 0);
  const taxes = Math.floor(subtotal * 0.16);

  return {
    currency: "MXN",
    items: cart.length,
    units: units,
    subTotal: subtotal,
    taxes: taxes,
    discount: 0,
    total: subtotal + taxes,
  };
};

export const getIncompleteOrders = async () => {
  const orders = await getOrders(null);
  return orders.filter(
    (order) => order.status !== "COMPLETE" && order.status !== "CANCELLED"
  );
};

export const createOrder = async (input) => {
  const orders = await getOrders(null);
  const newOrder = {
    id: uuidv4(),
    customer: null,
    address: null,
    paymentId: null,
    cart: input.cartId,
    status: "INCOMPLETE",
  };
  orders.push(newOrder);
  await saveOrders(orders);
  return newOrder;
};

export const updateOrder = async (input) => {
  const orders = await getOrders(null);
  const existingOrder = orders.find((order) => order.id === input.id);
  if (existingOrder) {
    if (input.customer !== null) {
      existingOrder.customer = await getCustomer(input.customer);
    }
    if (input.address !== null) {
      existingOrder.address = input.address;
    }
    if (input.status !== null) {
      existingOrder.status = input.status;
    }
    await saveOrders(orders);
    return existingOrder;
  }
  return undefined;
};

export const cancelOrder = async (input) => {
  const orders = await getOrders(null);
  const order = orders.find((order) => order.id === input.id);
  if (!order) {
    return false;
  }
  order.status = "CANCELLED";
  await cancelPayment(order.id);
  await saveOrders(orders);
  return true;
};

export const setOrderPayment = async (orderId, paymentId) => {
  const orders = await getOrders(null);
  const order = orders.find((order) => order.id === orderId);
  if (!order) {
    return false;
  }
  order.paymentId = paymentId;
  await saveOrders(orders);
  return true;
};

export const saveOrders = async (data) => {
  await writeFile(FILE_PATH, data);
  await fakePromise(1500);
};
