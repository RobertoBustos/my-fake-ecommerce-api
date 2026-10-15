import { verifyIdToken } from "./auth/verifyIdToken.js";
import { createLoaders } from "./dataloaders/index.js";

export const createContext = async ({ req }) => {
  const user = await verifyIdToken(req.headers.authorization);
  return {
    headers: req.headers,
    loaders: createLoaders(),
    user,
  };
};
