import stripe from "stripe";
import env from "./env.js";

const stripeClient = stripe(env.STRIPE_SECRET_KEY);

export default stripeClient;
