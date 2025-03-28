import { v4 as uuidv4 } from "uuid";
import { readFile, writeFile } from "../utils/fileUtils.js";
const FILE_PATH = "../data/cart.json";

export const getCart = () => {
  return readFile(FILE_PATH);
};

export const getCartById = (id) => {
  const carts = getCart();
  return carts.filter((cart) => cart.cartId === id);
};

export const addToCart = (product, input) => {
  const carts = getCart();
  const existingItem = carts.find((cart) => cart.productId === input.productId);
  if (existingItem) {
    existingItem.quantity += input.quantity;
    existingItem.subtotal += product.unitPrice * input.quantity;
    saveCart(carts);
    return existingItem;
  }
  const newItem = {
    id: uuidv4(),
    cartId: input.cartId,
    productId: input.productId,
    quantity: input.quantity,
    unitPrice: product.unitPrice,
    subtotal: product.unitPrice * input.quantity,
  };
  carts.push(newItem);
  saveCart(carts);
  return newItem;
};

export const removeFromCart = (input) => {
  const carts = getCart();
  const existingItem = carts.find((cart) => cart.id === input.id);
  if (!existingItem) {
    return false;
  }
  const newCart = carts.filter((cart) => cart.id !== input.id);
  saveCart(newCart);
  return true;
};

export const saveCart = (data) => {
  writeFile(FILE_PATH, data, (err, data) => {
    console.log("err", err);
    console.log("data", data);
  });
};
