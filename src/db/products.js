import { readFile } from "../utils/fileUtils.js";
const FILE_PATH = "../data/products.json";

export const getProducts = () => {
  return readFile(FILE_PATH);
};

export const getProductById = (id) => {
  const products = getProducts();
  return products.find((product) => product.id === id);
};
