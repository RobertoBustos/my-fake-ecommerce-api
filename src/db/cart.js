import { v4 as uuidv4 } from "uuid";
import { fakePromise } from "../utils/fakePromise.js";
import { readFile, writeFile } from "../utils/fileUtils.js";
const FILE_PATH = "../data/cart.json";

export const getCart = async (filter) => {
  const cart = await readFile(FILE_PATH);
  if (filter !== null) {
    return cart.filter((item) => item[filter.field] == filter.value);
  }
  return cart;
};

export const addToCart = async (product, input) => {
  const carts = await getCart(null);
  const existingItem = carts.find(
    (cart) =>
      cart.productId === input.productId && cart.orderId === input.orderId
  );
  if (existingItem) {
    existingItem.quantity += input.quantity;
    existingItem.subtotal += product.unitPrice * input.quantity;
    await saveCart(carts);
    return existingItem;
  }
  const newItem = {
    id: uuidv4(),
    cartId: input.cartId,
    orderId: null,
    productId: input.productId,
    quantity: input.quantity,
    unitPrice: product.unitPrice,
    subtotal: product.unitPrice * input.quantity,
  };
  carts.push(newItem);
  await saveCart(carts);
  return newItem;
};

export const removeFromCart = async (input) => {
  const carts = await getCart(null);
  const existingItem = carts.find((cart) => cart.id === input.id);
  if (!existingItem) {
    return false;
  }
  const newCart = carts.filter((cart) => cart.id !== input.id);
  await saveCart(newCart);
  return true;
};

export const updateCartItems = async (cartId, orderId) => {
  const cart = await getCart(null);
  const newCart = cart.map((item) => {
    if (item.orderId === null && item.cartId === cartId) {
      item.orderId = orderId;
    }
    return item;
  });
  await saveCart(newCart);
  return true;
};

export const saveCart = async (data) => {
  await writeFile(FILE_PATH, data);
  await fakePromise(3000);
};
