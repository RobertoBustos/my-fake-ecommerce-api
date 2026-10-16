import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import env from "./env.js";

// The single firebase-admin app, shared with Auth (src/auth/verifyIdToken.js)
// so token verification doesn't depend on which module happens to load first.
export const firebaseApp = initializeApp({
  projectId: env.FIRESTORE_PROJECT_ID || "demo-ecommerce-api",
});

export default getFirestore(firebaseApp);
