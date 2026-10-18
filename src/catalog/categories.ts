// The shared category names every source maps its own categories to, so the
// app can filter the whole catalog by one list. They are the names the
// Firestore catalog already uses ("jewelery" included: clients filter by it),
// and products(category:) matches them exactly.
export const CATALOG_CATEGORIES = [
  "electronics",
  "jewelery",
  "men's clothing",
  "women's clothing",
] as const;

export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

export const isCatalogCategory = (value: string): value is CatalogCategory =>
  (CATALOG_CATEGORIES as readonly string[]).includes(value);
