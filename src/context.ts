import { verifyIdToken } from "./auth/verifyIdToken.ts";
import { createLoaders } from "./dataloaders/index.ts";

import type { Request } from "express";
import type { DecodedIdToken } from "firebase-admin/auth";

export interface Context {
  headers: Request["headers"];
  loaders: ReturnType<typeof createLoaders>;
  user: DecodedIdToken;
}

export const createContext = async ({ req }: { req: Request }): Promise<Context> => {
  const user = await verifyIdToken(req.headers.authorization);
  return {
    headers: req.headers,
    loaders: createLoaders(),
    user,
  };
};
