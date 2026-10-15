import { readFile } from "../utils/fileUtils.js";
const FILE_PATH = "../data/products.json";

export const getProducts = async ({ id, category } = {}) => {
  const products = await readFile(FILE_PATH);
  return products.filter(
    (product) =>
      (id === undefined || product.id == id) &&
      (category === undefined || product.category == category)
  );
};
