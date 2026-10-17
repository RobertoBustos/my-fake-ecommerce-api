import type { Request, Response } from "express";
import type Stripe from "stripe";
import stripeClient from "../config/stripe.js";
import env from "../config/env.js";
import { markOrderComplete } from "../db/index.js";
import { markEventProcessed, unmarkEventProcessed } from "../db/webhookEvents.js";
import { logger } from "../utils/logger.js";

// H11: payment used to be confirmed only client-side (the client claimed
// "I already paid"). Now the order only moves to COMPLETE when Stripe
// confirms the payment via a signed event — the client can no longer fake it.
export const handleStripeWebhook = async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers["stripe-signature"] ?? "";
  let event: Stripe.Event;
  try {
    event = stripeClient.webhooks.constructEvent(
      req.body,
      signature,
      env.STRIPE_WEBHOOK_SECRET as string
    );
  } catch (err) {
    res.status(400).send(`Webhook signature verification failed: ${(err as Error).message}`);
    return;
  }

  // Stripe delivers "at least once": if we already processed this event.id
  // before (a retry), we respond 200 without repeating the side effect.
  const alreadyProcessed = await markEventProcessed(event.id);
  if (alreadyProcessed) {
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  try {
    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object;
      const orderId = paymentIntent.metadata?.order_id;
      if (orderId) {
        const result = await markOrderComplete(orderId, {
          paymentIntentId: paymentIntent.id,
          amountReceived: paymentIntent.amount_received,
        });
        // Money was charged but the order can't take it (cancelled, wrong
        // amount, another PaymentIntent). Stripe retrying won't change that,
        // so answer 200 and leave an error for someone to refund or fix it.
        if (!result.completed) {
          logger.error("Payment not applied to its order", {
            eventId: event.id,
            orderId,
            paymentIntentId: paymentIntent.id,
            amountReceived: paymentIntent.amount_received,
            reason: result.reason,
          });
        }
      }
    }
  } catch (err) {
    // The event was already marked as processed above; without undoing it,
    // Stripe's retry would be skipped as a duplicate and the order would
    // never be completed. Reprocessing is safe: markOrderComplete leaves an
    // already complete order as it is. Rethrowing makes the endpoint answer 500, so Stripe retries.
    await unmarkEventProcessed(event.id).catch((unmarkErr) => {
      logger.error("Could not unmark webhook event; Stripe's retry will be skipped", {
        eventId: event.id,
        error: (unmarkErr as Error).message,
      });
    });
    throw err;
  }

  res.status(200).json({ received: true });
};
