import { GraphQLError } from "graphql";
import type { ExpoPushMessage } from "expo-server-sdk";
import expoClient from "#src/config/expo";
import {
  deletePushTokens,
  listPushTokens,
  registerPushToken as registerPushTokenDb,
  savePushTickets,
  unregisterPushToken as unregisterPushTokenDb,
} from "#src/db/index";
import type { RegisterPushToken, UnregisterPushToken } from "#src/generated/graphql";
import { checkRegisterPushToken, checkUnregisterPushToken } from "#src/schema/validators/index";
import type { MutationAck } from "#src/types/models";
import { logger } from "#src/utils/logger";
import { assertValidInput, withContentionRetryHint } from "./errors.ts";

// The app registers its token on every start, so a repeated call usually
// writes nothing. A token kept under its current user still answers success:
// an error would only make a looping app retry harder.
export const registerPushToken = async (input: RegisterPushToken, userId: string): Promise<MutationAck> => {
  assertValidInput(checkRegisterPushToken, input);
  const result = await registerPushTokenDb({ token: input.token.trim(), platform: input.platform }, userId);
  if (result === "moved") {
    logger.info("Push token moved to another user", { platform: input.platform });
  } else if (result === "kept") {
    // Never the token: it's enough to send to the device.
    logger.warn("Push token changed user too often, kept under its current user", {
      platform: input.platform,
      uid: userId.slice(0, 8),
    });
  }
  return {
    code: "200",
    success: true,
    message: "Push token registered",
  };
};

// Another user's token answers NOT_FOUND, as if it didn't exist (H2).
export const unregisterPushToken = async (input: UnregisterPushToken, userId: string): Promise<MutationAck> => {
  assertValidInput(checkUnregisterPushToken, input);
  const deleted = await withContentionRetryHint(() => unregisterPushTokenDb(input.token.trim(), userId));
  if (!deleted) {
    throw new GraphQLError("Push token not found", {
      extensions: {
        code: "NOT_FOUND",
        invalidArgument: "token",
      },
    });
  }
  return {
    code: "200",
    success: true,
    message: "Push token unregistered",
  };
};

export interface PushNotification {
  title: string;
  body: string;
  // What the app reads on a tap; type names the notification.
  data: { type: string } & Record<string, unknown>;
}

// Sends notification to every device uid is signed in on. It never throws:
// the Stripe webhook calls it after the payment is applied, and a push
// failure there must not make Stripe retry an event that already worked.
// A ticket "ok" only means Expo took the message; the receipts job checks
// later whether it reached the device.
export const notifyUser = async (uid: string, notification: PushNotification): Promise<void> => {
  const type = notification.data.type;
  try {
    const tokens = await listPushTokens(uid);
    if (tokens.length === 0) return;
    const messages: ExpoPushMessage[] = tokens.map((to) => ({
      to,
      ...notification,
      sound: "default",
      priority: "high",
      // The channel the app creates on Android.
      channelId: "orders",
    }));
    const accepted: { ticketId: string; token: string; uid: string }[] = [];
    const deadTokens: string[] = [];
    for (const chunk of expoClient.chunkPushNotifications(messages)) {
      const tickets = await expoClient.sendPushNotificationsAsync(chunk);
      // One ticket per message, in order; every message has a single token.
      tickets.forEach((ticket, i) => {
        const token = chunk[i]?.to as string;
        if (ticket.status === "ok") {
          accepted.push({ ticketId: ticket.id, token, uid });
        } else if (ticket.details?.error === "DeviceNotRegistered") {
          deadTokens.push(token);
        } else {
          // Not ticket.message: Expo puts the token in it.
          logger.error("Push notification refused by Expo", { type, error: ticket.details?.error ?? null });
        }
      });
    }
    await savePushTickets(accepted);
    await deletePushTokens(deadTokens);
    logger.info("Push notification sent", {
      type,
      devices: tokens.length,
      accepted: accepted.length,
      deadTokens: deadTokens.length,
    });
  } catch (err) {
    logger.error("Push notification failed", { type, error: (err as Error).message });
  }
};

const orderUrl = (orderId: string) => `myapp://orders/${orderId}`;

export const notifyOrderCompleted = (uid: string, orderId: string) =>
  notifyUser(uid, {
    title: "Order confirmed",
    body: "We received your payment.",
    data: { type: "order_completed", orderId, url: orderUrl(orderId) },
  });

export const notifyPaymentFailed = (uid: string, orderId: string) =>
  notifyUser(uid, {
    title: "Payment failed",
    body: "Your card was declined. Try again from the app.",
    data: { type: "payment_failed", orderId, url: orderUrl(orderId) },
  });
