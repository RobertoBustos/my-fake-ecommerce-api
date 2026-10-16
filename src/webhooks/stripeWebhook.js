import stripeClient from "../config/stripe.js";
import env from "../config/env.js";
import { markOrderComplete } from "../db/index.js";
import { markEventProcessed } from "../db/webhookEvents.js";

// H11: payment used to be confirmed only client-side (the client claimed
// "I already paid"). Now the order only moves to COMPLETE when Stripe
// confirms the payment via a signed event — the client can no longer fake it.
export const handleStripeWebhook = async (req, res) => {
  const signature = req.headers["stripe-signature"];
  let event;
  try {
    event = stripeClient.webhooks.constructEvent(
      req.body,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    res.status(400).send(`Webhook signature verification failed: ${err.message}`);
    return;
  }

  // Stripe delivers "at least once": if we already processed this event.id
  // before (a retry), we respond 200 without repeating the side effect.
  const alreadyProcessed = await markEventProcessed(event.id);
  if (alreadyProcessed) {
    res.status(200).json({ received: true, duplicate: true });
    return;
  }

  if (event.type === "payment_intent.succeeded") {
    const orderId = event.data.object.metadata?.order_id;
    if (orderId) {
      await markOrderComplete(orderId);
    }
  }

  res.status(200).json({ received: true });
};
