// Key business events: one JSON log line each time something happens in the
// business (a purchase, a cancellation, a sync), as opposed to an error,
// which says something broke. Cloud Logging copies them to BigQuery for the
// funnel, and log-based metrics count them for the dashboard and the
// "zero purchases" alert.
//
// Every event declares the only fields it may carry, so personal data can't
// slip in: no email, name, phone, address or card details, ever. Amounts are
// in cents, with their currency. A field that isn't declared throws: that's
// a bug at the call site, not something to log. Changing what an event
// means, or a field's type, bumps SCHEMA_VERSION so queries can tell old
// rows from new ones.

export const SCHEMA_VERSION = 1;

export const EVENTS = {
  // The purchase funnel, in order.
  "cart.item_added": ["cartId", "orderId", "source", "quantity", "unitPrice", "currency"],
  "cart.item_removed": ["cartId", "orderId", "source", "quantity"],
  // An anonymous user's items moved to the account they signed in to.
  "cart.merged": ["cartId", "items", "releasedUnits"],
  "order.created": ["orderId", "cartId", "items", "units", "total", "currency"],
  // Customer and address are complete: the order can be paid.
  "order.ready_to_pay": ["orderId", "cartId"],
  "order.cancelled": ["orderId", "cartId"],
  "payment.intent_created": ["orderId", "cartId", "amount", "currency"],
  // Prices changed since the items were added; nothing was charged.
  "payment.repriced": ["orderId", "cartId", "changedItems"],
  // The order can't be paid as it is (reason: reservation_expired,
  // product_unavailable, empty_order).
  "payment.blocked": ["orderId", "cartId", "reason"],
  "order.completed": ["orderId", "cartId", "amount", "currency"],
  // failureCode is Stripe's decline or error code, never card details.
  "payment.failed": ["orderId", "cartId", "amount", "currency", "failureCode"],
  // Customers, inventory and catalog.
  "customer.created": [],
  "reservation.expired": ["source", "quantity"],
  "inventory.task_done": ["action", "source", "reason", "attempts"],
  "catalog.synced": ["source", "mode", "upserted", "deleted"],
} as const satisfies Record<string, readonly string[]>;

export type EventName = keyof typeof EVENTS;
export type EventFields<Name extends EventName> = Partial<
  Record<(typeof EVENTS)[Name][number], string | number | boolean | null>
>;

export class UndeclaredEventFieldError extends Error {
  constructor(event: string, field: string) {
    super(`Event ${event} has no field "${field}"; declare it in EVENTS or leave it out`);
    this.name = "UndeclaredEventFieldError";
  }
}

// The e2e suite's carts start with "e2e-" (e2e/helpers/orders.ts), so its
// purchases can be left out of real numbers.
export const isE2eCart = (cartId: unknown) => typeof cartId === "string" && cartId.startsWith("e2e-");

export const eventFields = <Name extends EventName>(name: Name, fields: EventFields<Name>) => {
  const allowed: readonly string[] = EVENTS[name];
  for (const field of Object.keys(fields)) {
    if (!allowed.includes(field)) throw new UndeclaredEventFieldError(name, field);
  }
  const cartId = (fields as Record<string, unknown>).cartId;
  return { event: name, schemaVersion: SCHEMA_VERSION, e2e: isE2eCart(cartId), ...fields };
};
