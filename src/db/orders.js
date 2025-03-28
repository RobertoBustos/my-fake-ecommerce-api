import { v4 as uuidv4 } from "uuid";
import { readFile, writeFile } from "../utils/fileUtils.js";
const FILE_PATH = "../data/orders.json";

export const getOrders = (filter) => {
  const orders = readFile(FILE_PATH);
  if (filter !== null) {
    return orders.filter((order) => order[filter.field] == filter.value);
  }
  return orders;
};

export const createOrder = (input) => {
  const orders = getOrders();
  const newOrder = {
    id: uuidv4(),
    customer: "",
    payment: "",
    cart: input.cartId,
    status: "INCOMPLETE",
  };
  orders.push(newOrder);
  saveOrders(orders);
  return newOrder;
};

export const cancelOrder = (input) => {
  const orders = getOrders();
  const order = orders.find((order) => order.id === input.id);
  if (!order) {
    return false;
  }
  order.status = "CANCELLED";
  saveOrders(orders);
  return true;
};

export const saveOrders = (data) => {
  writeFile(FILE_PATH, data);
};
