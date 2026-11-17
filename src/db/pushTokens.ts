import { createHash } from "crypto";
import db from "#src/config/firestore";
import { runTransaction } from "./transactions.ts";

// pushTokens/{sha256 of the token}: the Expo push token of each app install,
// under the user signed in on it. The id is derived from the token, so a
// device has one document whoever is signed in, and the token itself (which
// is enough to send to that device) never shows up in a document path.
const COLLECTION = "pushTokens";

export type PushPlatform = "IOS" | "ANDROID";

export interface PushToken {
  uid: string;
  token: string;
  platform: PushPlatform;
  createdAt: Date;
  // Last time the app registered it; the app does on every start.
  lastSeenAt: Date;
}

const pushTokenRef = (token: string) =>
  db.collection(COLLECTION).doc(createHash("sha256").update(token).digest("hex"));

// Saves the token under uid. A token already saved under another user moves
// to this one: a phone only gets the notifications of whoever is signed in
// on it. Returns whether the token changed owner.
export const registerPushToken = (
  { token, platform }: { token: string; platform: PushPlatform },
  uid: string
): Promise<{ movedFromAnotherUser: boolean }> =>
  runTransaction(async (tx) => {
    const ref = pushTokenRef(token);
    const doc = await tx.get(ref);
    const now = new Date();
    if (!doc.exists) {
      tx.set(ref, { uid, token, platform, createdAt: now, lastSeenAt: now });
      return { movedFromAnotherUser: false };
    }
    tx.update(ref, { uid, platform, lastSeenAt: now });
    return { movedFromAnotherUser: doc.get("uid") !== uid };
  });

// Deletes the token only if it's saved under uid. Returns false when it
// isn't saved, or belongs to someone else.
export const unregisterPushToken = (token: string, uid: string): Promise<boolean> =>
  runTransaction(async (tx) => {
    const ref = pushTokenRef(token);
    const doc = await tx.get(ref);
    if (!doc.exists || doc.get("uid") !== uid) {
      return false;
    }
    tx.delete(ref);
    return true;
  });
