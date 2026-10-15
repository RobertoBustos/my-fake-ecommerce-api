import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import env from "./env.js";

const app = initializeApp({
  projectId: env.FIRESTORE_PROJECT_ID || "demo-ecommerce-api",
});

export default getFirestore(app);
