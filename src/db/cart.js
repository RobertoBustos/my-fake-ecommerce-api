import { v4 as uuidv4 } from "uuid";
import { readFile, writeFile } from "../utils/fileUtils.js";
const FILE_PATH = "../data/cart.json";

export const getCart = async ({ cartId, orderId, productId } = {}) => {
  const cart = await readFile(FILE_PATH);
  return cart.filter(
    (item) =>
      (cartId === undefined || item.cartId == cartId) &&
      (orderId === undefined || item.orderId == orderId) &&
      (productId === undefined || item.productId == productId)
  );
};

export const getCartWithoutOrder = async ({ cartId, productId } = {}) => {
  const cart = await readFile(FILE_PATH);
  return cart.filter(
    (item) =>
      item.orderId === null &&
      (cartId === undefined || item.cartId == cartId) &&
      (productId === undefined || item.productId == productId)
  );
};

export const addToCart = async (product, input) => {
  const carts = await getCart();
  const existingItem = carts.find(
    (cart) =>
      cart.productId === input.productId &&
      cart.orderId === input.orderId &&
      cart.cartId === input.cartId
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
  const carts = await getCart();
  const existingItem = carts.find((cart) => cart.id === input.id);
  if (!existingItem) {
    return false;
  }
  const newCart = carts.filter((cart) => cart.id !== input.id);
  await saveCart(newCart);
  return true;
};

export const updateCartItems = async (cartId, orderId) => {
  const cart = await getCart();
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
};
