import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import db from "../src/config/firestore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const seedProducts = async () => {
  const products = JSON.parse(
    readFileSync(path.join(__dirname, "seed-data/products.json"), "utf8")
  );
  const batch = db.batch();
  for (const { id, ...data } of products) {
    batch.set(db.collection("products").doc(id), data);
  }
  await batch.commit();
  return products.length;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const count = await seedProducts();
  console.log(`Seeded ${count} products into Firestore.`);
}
