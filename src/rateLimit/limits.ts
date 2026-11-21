// How many requests each user may send per minute, by class of operation.
// A request is charged to the most restrictive class among its root fields.
// The same budget, times IP_BUDGET_MULTIPLIER, applies to the client's IP: a
// looping app can mint a new anonymous user on every start, and several real
// users can share an IP behind a carrier's NAT.
export interface OperationClass {
  perMinute: number;
  // Mutation root fields in this class; queries all fall in "query".
  fields?: readonly string[];
  // Repeating it with the same variables gives the same answer, so a repeat
  // within REPLAY_MS is answered from memory.
  idempotent?: boolean;
}

export const OPERATION_CLASSES = {
  pushToken: { perMinute: 3, fields: ["registerPushToken", "unregisterPushToken"], idempotent: true },
  // It also calls Stripe.
  payment: { perMinute: 5, fields: ["createOrderPayment"] },
  mutation: { perMinute: 30 },
  query: { perMinute: 120 },
} as const satisfies Record<string, OperationClass>;

export type OperationClassName = keyof typeof OPERATION_CLASSES;

export const IP_BUDGET_MULTIPLIER = 4;

// A user or IP rejected this many times within the window goes into
// quarantine: every request is rejected until it ends.
export const QUARANTINE_AFTER_REJECTIONS = 20;
export const REJECTION_WINDOW_MS = 60 * 1000;
export const QUARANTINE_MS = 10 * 60 * 1000;

export const REPLAY_MS = 5 * 1000;

// Counters are kept in memory per instance, so a flood of distinct users or
// IPs must not grow them without bound: past this many keys, the least
// recently used are dropped.
export const MAX_TRACKED_KEYS = 20_000;
