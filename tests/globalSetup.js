import { seedProducts } from "../scripts/seedFirestore.js";

export default async function setup() {
  await seedProducts();
}
