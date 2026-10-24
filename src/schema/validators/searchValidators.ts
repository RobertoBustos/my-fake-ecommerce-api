import { z } from "zod";
import { firstInvalidField } from "./validate.js";

export const SEARCH_DEFAULT_PAGE_SIZE = 20;
export const SEARCH_MAX_PAGE_SIZE = 50;

const price = z.number().int().nonnegative().nullish();

const searchProductsSchema = z
  .object({
    query: z.string().trim().min(2).max(100),
    category: z.string().trim().min(1).nullish(),
    minPrice: price,
    maxPrice: price,
    inStock: z.boolean().nullish(),
    first: z.number().int().min(1).max(SEARCH_MAX_PAGE_SIZE).nullish(),
    after: z.string().nullish(),
  })
  .refine(({ minPrice, maxPrice }) => minPrice == null || maxPrice == null || minPrice <= maxPrice, {
    path: ["minPrice"],
  });

export const checkSearchProducts = (input: unknown) => firstInvalidField(searchProductsSchema, input);
