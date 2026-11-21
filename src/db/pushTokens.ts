import { createHash } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
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
  // Last time the app registered it, at most a day off: the app registers on
  // every start, but a repeat within a day writes nothing.
  lastSeenAt: Date;
  // When the token changed owner in the last OWNER_CHANGE_WINDOW_MS.
  ownerChanges?: Date[];
}

const pushTokenRef = (token: string) =>
  db.collection(COLLECTION).doc(createHash("sha256").update(token).digest("hex"));

const DAY_MS = 24 * 60 * 60 * 1000;
// Two app sessions registering the same token at once made it move between
// two users 661 times in two minutes (incident of Nov 20, 2026). Past
// MAX_OWNER_CHANGES moves in the window, the token stays where it is.
const OWNER_CHANGE_WINDOW_MS = 10 * 60 * 1000;
const MAX_OWNER_CHANGES = 3;

const millisOf = (value: unknown): number =>
  value instanceof Timestamp ? value.toMillis() : value instanceof Date ? value.getTime() : 0;

// created: new token. unchanged: same user and platform, seen within a day,
// nothing written. refreshed: same user, new platform or lastSeenAt older
// than a day. moved: it was another user's. kept: it changed owner too often
// and stays with its current user.
export type RegisterPushTokenResult = "created" | "unchanged" | "refreshed" | "moved" | "kept";

// Saves the token under uid. A token already saved under another user moves
// to this one: a phone only gets the notifications of whoever is signed in
// on it. A plain read and write, not a transaction: a looping app calls this
// thousands of times for one document, and transactions on it fought each
// other (CONFLICT, ~10 reads per call). If two calls race, the last write
// wins, which is the user now signed in; at worst a "moved" log is lost and
// the owner-change guard counts one change short.
export const registerPushToken = async (
  { token, platform }: { token: string; platform: PushPlatform },
  uid: string
): Promise<RegisterPushTokenResult> => {
  const ref = pushTokenRef(token);
  const doc = await ref.get();
  const now = new Date();
  if (!doc.exists) {
    await ref.set({ uid, token, platform, createdAt: now, lastSeenAt: now });
    return "created";
  }
  const createdAt = doc.get("createdAt") ?? now;
  if (doc.get("uid") === uid) {
    if (doc.get("platform") === platform && now.getTime() - millisOf(doc.get("lastSeenAt")) < DAY_MS) {
      return "unchanged";
    }
    // set, not update: the document may have been deleted since the read.
    await ref.set({ uid, token, platform, createdAt, lastSeenAt: now }, { merge: true });
    return "refreshed";
  }
  const recent = ((doc.get("ownerChanges") as unknown[] | undefined) ?? [])
    .map(millisOf)
    .filter((millis) => now.getTime() - millis < OWNER_CHANGE_WINDOW_MS);
  if (recent.length >= MAX_OWNER_CHANGES) {
    return "kept";
  }
  await ref.set({
    uid,
    token,
    platform,
    createdAt,
    lastSeenAt: now,
    ownerChanges: [...recent.map((millis) => new Date(millis)), now],
  });
  return "moved";
};

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

// The tokens saved under uid: every device that user is signed in on.
export const listPushTokens = async (uid: string): Promise<string[]> => {
  const snapshot = await db.collection(COLLECTION).where("uid", "==", uid).get();
  return snapshot.docs.map((doc) => doc.get("token") as string);
};

// Deletes tokens Expo says no longer reach a device (DeviceNotRegistered),
// whoever they're saved under.
export const deletePushTokens = async (tokens: string[]): Promise<void> => {
  if (tokens.length === 0) return;
  const batch = db.batch();
  for (const token of tokens) batch.delete(pushTokenRef(token));
  await batch.commit();
};
