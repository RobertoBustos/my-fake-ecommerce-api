import { fileURLToPath } from "url";
import type { Query } from "firebase-admin/firestore";
import { canonicalProductId, getCatalogProducts, parseProductId } from "../src/catalog/index.js";
import db from "../src/config/firestore.js";
import type { CartItem } from "../src/types/models.js";

// Cart items written before global product ids hold the bare Firestore id in
// productId and no copy of the product. This script rewrites productId to
// the global id, sets sourceKey and, when the product still exists, fills in
// the missing title, image and currency. Without --apply it only reports.
// Running it twice changes nothing the second time. Prices are not touched:
// createOrderPayment checks them against the source before charging.

const CART_COLLECTION = "cartItems";
// Firestore allows 500 writes per batch.
const BATCH_SIZE = 500;

type Updates = Partial<Pick<CartItem, "productId" | "sourceKey" | "title" | "image" | "currency">>;

const updatesFor = (
  item: CartItem,
  product: { title: string; image: string; currency: string } | null
): Updates => {
  const updates: Updates = {};
  const productId = canonicalProductId(String(item.productId));
  if (item.productId !== productId) updates.productId = productId;
  if (item.sourceKey === undefined) updates.sourceKey = parseProductId(productId).sourceKey;
  if (product) {
    if (item.title == null) updates.title = product.title;
    if (item.image == null) updates.image = product.image;
    if (item.currency == null) updates.currency = product.currency;
  }
  return updates;
};

// cartIds (up to 30) narrows the scan; the command line always scans everything.
export const migrateCartItemProductIds = async ({
  apply = false,
  cartIds,
}: { apply?: boolean; cartIds?: string[] } = {}) => {
  let query: Query = db.collection(CART_COLLECTION);
  if (cartIds) query = query.where("cartId", "in", cartIds);
  const snapshot = await query.get();
  const items = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as CartItem);
  const products = await getCatalogProducts(items.map((item) => String(item.productId)));

  const pending = items
    .map((item, i) => ({ item, updates: updatesFor(item, products[i]) }))
    .filter(({ updates }) => Object.keys(updates).length > 0);
  const missingProducts = items.filter((_, i) => products[i] === null).map((item) => item.id);

  let written = 0;
  if (apply) {
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (const { item, updates } of pending.slice(i, i + BATCH_SIZE)) {
        batch.update(db.collection(CART_COLLECTION).doc(item.id), updates);
      }
      await batch.commit();
      written += Math.min(BATCH_SIZE, pending.length - i);
    }
  }
  return { scanned: items.length, pending, missingProducts, written };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const apply = process.argv.includes("--apply");
  const { scanned, pending, missingProducts, written } = await migrateCartItemProductIds({ apply });
  console.log(`Project: ${process.env.FIRESTORE_PROJECT_ID ?? "(emulator default)"}`);
  console.log(`Mode: ${apply ? "APPLY" : "dry run (pass --apply to write)"}`);
  console.log(`Cart items scanned: ${scanned}`);
  console.log(`Cart items to update: ${pending.length}`);
  for (const { item, updates } of pending) {
    console.log(`  item ${item.id}: ${Object.keys(updates).join(", ")}`);
  }
  console.log(`Cart items whose product no longer exists (copy left empty): ${missingProducts.length}`);
  if (apply) {
    console.log(`Updated: ${written}`);
  }
  process.exit(0);
}
