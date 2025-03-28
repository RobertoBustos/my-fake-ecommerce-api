import { v4 as uuidv4 } from "uuid";
import { readFile, writeFile } from "../utils/fileUtils.js";
import { getCart } from "./cart.js";
import { cancelPayment, getCustomer } from "./payment.js";
const FILE_PATH = "../data/orders.json";

export const getOrders = (filter) => {
  const orders = readFile(FILE_PATH);
  if (filter !== null) {
    return orders.filter((order) => order[filter.field] == filter.value);
  }
  return orders;
};

export const getOrderTotals = (id) => {
  const cart = getCart({ field: "cartId", value: id });
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

export const createOrder = (input) => {
  const orders = getOrders(null);
  const newOrder = {
    id: uuidv4(),
    customer: null,
    cart: input.cartId,
    status: "INCOMPLETE",
  };
  orders.push(newOrder);
  saveOrders(orders);
  return newOrder;
};

export const updateOrder = async (input) => {
  const orders = getOrders(null);
  const existingOrder = orders.find((order) => order.id === input.id);
  if (existingOrder) {
    existingOrder.customer = await getCustomer(input.customer);
    saveOrders(orders);
    return existingOrder;
  }
  return undefined;
};

export const cancelOrder = async (input) => {
  const orders = getOrders(null);
  const order = orders.find((order) => order.id === input.id);
  if (!order) {
    return false;
  }
  order.status = "CANCELLED";
  await cancelPayment(order.id);
  saveOrders(orders);
  return true;
};

export const saveOrders = (data) => {
  writeFile(FILE_PATH, data, () => {});
};
