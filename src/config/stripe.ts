import Stripe from "stripe";
import env from "./env.js";

const stripeClient = new Stripe(env.STRIPE_SECRET_KEY as string);

export default stripeClient;
