import stripeClient from "../config/stripe.js";
import env from "../config/env.js";
import { markOrderComplete } from "../db/index.js";
import { markEventProcessed } from "../db/webhookEvents.js";

// H11: el pago solo se confirmaba del lado del cliente (el cliente avisaba
// "ya pagué"). Ahora la orden solo pasa a COMPLETE cuando Stripe confirma el
// pago vía un evento firmado — el cliente ya no puede fingirlo.
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

  // Stripe entrega "al menos una vez": si ya procesamos este event.id antes
  // (reintento), respondemos 200 sin repetir el efecto secundario.
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
