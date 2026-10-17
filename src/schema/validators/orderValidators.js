import { z } from "zod";
import { firstInvalidField } from "./validate.js";

const id = z.string().trim().min(1);
const text = (max) => z.string().trim().min(1).max(max);

// Stripe rejects a malformed email, which used to surface as an internal error.
const customerSchema = z.object({
  email: z.email(),
  name: text(100),
  // Digits only, with an optional leading +; 10 digits is a Mexican number.
  phone: z.string().regex(/^\+?[0-9]{10,15}$/),
});

const addressSchema = z.object({
  address: text(300),
  zipCode: z.string().trim().regex(/^[0-9A-Za-z -]{3,10}$/),
  coords: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    latitudeDelta: z.number().nonnegative(),
    longitudeDelta: z.number().nonnegative(),
  }),
});

const createOrderSchema = z.object({ cartId: id });

const updateOrderSchema = z
  .object({
    id,
    customer: customerSchema.optional().nullable(),
    address: addressSchema.optional().nullable(),
  })
  // An update without either one has nothing to change.
  .refine((input) => input.customer != null || input.address != null, {
    message: "customer or address is required",
    path: ["customer"],
  });

const orderIdSchema = z.object({ orderId: id });
const cancelOrderSchema = z.object({ id });

export const checkCreateOrder = (input) => firstInvalidField(createOrderSchema, input);
export const checkUpdateOrder = (input) => firstInvalidField(updateOrderSchema, input);
export const checkCreateOrderPayment = (input) => firstInvalidField(orderIdSchema, input);
export const checkCancelOrder = (input) => firstInvalidField(cancelOrderSchema, input);
