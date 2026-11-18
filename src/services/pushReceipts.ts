import expoClient from "#src/config/expo";
import { deletePushTickets, listPushTicketsSentBefore } from "#src/db/pushTickets";
import { deletePushTokens } from "#src/db/pushTokens";
import { logger } from "#src/utils/logger";

// Not through #src/db/index, which loads the Stripe client: the receipts
// job has no Stripe key, and doesn't need one.

// Expo has a ticket's receipt ready about 15 minutes after the send and
// deletes it after 24 hours.
const RECEIPT_READY_MS = 15 * 60 * 1000;
const RECEIPT_KEPT_MS = 24 * 60 * 60 * 1000;
// The most receipt ids Expo takes in one request.
const RECEIPTS_PAGE = 1000;

export interface PushReceiptCounts {
  ok: number;
  failed: number;
  // Not ready yet: checked again on the next run.
  pending: number;
  // Older than 24 hours: Expo no longer has the receipt.
  expired: number;
  deadTokens: number;
}

// For the receipts job: reads the receipt of every ticket sent at least 15
// minutes ago and deletes the ticket. A DeviceNotRegistered receipt deletes
// its token; any other error is logged (InvalidCredentials means the APNs or
// FCM credentials in EAS are missing or expired). A ticket older than 24
// hours is deleted without asking. An error from Expo stops the run, and the
// tickets not deleted yet are read again on the next one.
export const checkPushReceipts = async ({ now = new Date() }: { now?: Date } = {}): Promise<PushReceiptCounts> => {
  const counts: PushReceiptCounts = { ok: 0, failed: 0, pending: 0, expired: 0, deadTokens: 0 };
  const readyCutoff = new Date(now.getTime() - RECEIPT_READY_MS);
  const keptCutoff = now.getTime() - RECEIPT_KEPT_MS;
  let after: { ticketId: string; createdAt: Date } | undefined;
  for (;;) {
    const tickets = await listPushTicketsSentBefore(readyCutoff, { limit: RECEIPTS_PAGE, after });
    if (tickets.length === 0) break;
    const last = tickets[tickets.length - 1]!;
    after = { ticketId: last.ticketId, createdAt: last.createdAt };

    const expired = tickets.filter((ticket) => ticket.createdAt.getTime() <= keptCutoff);
    const toCheck = tickets.filter((ticket) => ticket.createdAt.getTime() > keptCutoff);
    const receipts = toCheck.length > 0 ? await expoClient.getPushNotificationReceiptsAsync(toCheck.map((t) => t.ticketId)) : {};
    const reviewed = expired.map((ticket) => ticket.ticketId);
    const deadTokens = new Set<string>();
    for (const ticket of toCheck) {
      const receipt = receipts[ticket.ticketId];
      if (!receipt) {
        counts.pending++;
        continue;
      }
      reviewed.push(ticket.ticketId);
      if (receipt.status === "ok") {
        counts.ok++;
        continue;
      }
      counts.failed++;
      const error = receipt.details?.error ?? null;
      if (error === "DeviceNotRegistered") {
        deadTokens.add(ticket.token);
      } else {
        // Not receipt.message: Expo puts the token in it.
        logger.error("Push notification not delivered", { error });
      }
    }
    await deletePushTokens([...deadTokens]);
    await deletePushTickets(reviewed);
    counts.expired += expired.length;
    counts.deadTokens += deadTokens.size;
  }
  return counts;
};
