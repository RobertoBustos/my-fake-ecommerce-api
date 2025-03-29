import { readFile } from "../utils/fileUtils.js";
const FILE_PATH = "../data/products.json";

export const getProducts = async (filter) => {
  const products = await readFile(FILE_PATH);
  if (filter !== null) {
    return products.filter((product) => product[filter.field] == filter.value);
  }
  return products;
};
