import {
  IP_BUDGET_MULTIPLIER,
  MAX_TRACKED_KEYS,
  OPERATION_CLASSES,
  QUARANTINE_AFTER_REJECTIONS,
  QUARANTINE_MS,
  REJECTION_WINDOW_MS,
  type OperationClassName,
} from "./limits.ts";

// A Map that forgets its least recently used keys past maxSize.
export class BoundedMap<K, V> {
  readonly #entries = new Map<K, V>();
  readonly #maxSize: number;

  constructor(maxSize: number) {
    this.#maxSize = maxSize;
  }

  get size() {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    const value = this.#entries.get(key);
    if (value !== undefined) {
      // Map keeps insertion order: moving the key to the end marks it used.
      this.#entries.delete(key);
      this.#entries.set(key, value);
    }
    return value;
  }

  set(key: K, value: V) {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.#maxSize) {
      this.#entries.delete(this.#entries.keys().next().value as K);
    }
  }

  delete(key: K) {
    this.#entries.delete(key);
  }
}

export type Scope = "user" | "ip";

export type Decision =
  | { allowed: true }
  | {
      allowed: false;
      retryAfterSeconds: number;
      // Set when this rejection is the one that started a quarantine.
      quarantined?: { scope: Scope; id: string };
    };

interface Bucket {
  tokens: number;
  at: number;
}

interface Rejections {
  count: number;
  since: number;
}

// Token buckets per user and per IP, one per class of operation, refilled
// continuously at perMinute tokens a minute. Everything stays in memory: no
// Firestore read or write, so a rejection costs microseconds. The counters
// are per instance, so with N instances the real limit is N times higher;
// the instance cap bounds N.
export class RateLimiter {
  readonly #now: () => number;
  readonly #buckets: BoundedMap<string, Bucket>;
  readonly #rejections: BoundedMap<string, Rejections>;
  readonly #quarantines: BoundedMap<string, number>;

  constructor({ now = Date.now, maxKeys = MAX_TRACKED_KEYS }: { now?: () => number; maxKeys?: number } = {}) {
    this.#now = now;
    this.#buckets = new BoundedMap(maxKeys);
    this.#rejections = new BoundedMap(maxKeys);
    this.#quarantines = new BoundedMap(maxKeys);
  }

  // Charges one request of operationClass to uid and ip.
  check({ uid, ip, operationClass }: { uid: string; ip: string; operationClass: OperationClassName }): Decision {
    const now = this.#now();
    const perMinute = OPERATION_CLASSES[operationClass].perMinute;
    const subjects = [
      { scope: "user" as const, id: uid, perMinute },
      { scope: "ip" as const, id: ip, perMinute: perMinute * IP_BUDGET_MULTIPLIER },
    ];
    for (const { scope, id } of subjects) {
      const until = this.#quarantines.get(`${scope}:${id}`);
      if (until !== undefined && until > now) {
        return { allowed: false, retryAfterSeconds: Math.ceil((until - now) / 1000) };
      }
    }
    // The IP is charged only for requests its user's budget let through, so
    // one user's flood doesn't use up the budget of others on the same IP.
    for (const { scope, id, perMinute: budget } of subjects) {
      const waitMs = this.#take(`${scope}:${id}:${operationClass}`, budget, now);
      if (waitMs > 0) {
        const quarantined = this.#reject(scope, id, now);
        return {
          allowed: false,
          retryAfterSeconds: quarantined ? QUARANTINE_MS / 1000 : Math.ceil(waitMs / 1000),
          ...(quarantined && { quarantined: { scope, id } }),
        };
      }
    }
    return { allowed: true };
  }

  // Takes a token; returns 0, or how long until there's one.
  #take(key: string, perMinute: number, now: number): number {
    const msPerToken = 60_000 / perMinute;
    const bucket = this.#buckets.get(key);
    const tokens = bucket ? Math.min(perMinute, bucket.tokens + (now - bucket.at) / msPerToken) : perMinute;
    if (tokens >= 1) {
      this.#buckets.set(key, { tokens: tokens - 1, at: now });
      return 0;
    }
    this.#buckets.set(key, { tokens, at: now });
    return (1 - tokens) * msPerToken;
  }

  // Counts a rejection; returns true when it starts a quarantine.
  #reject(scope: Scope, id: string, now: number): boolean {
    const key = `${scope}:${id}`;
    const previous = this.#rejections.get(key);
    const rejections =
      previous && now - previous.since < REJECTION_WINDOW_MS
        ? { count: previous.count + 1, since: previous.since }
        : { count: 1, since: now };
    if (rejections.count >= QUARANTINE_AFTER_REJECTIONS) {
      this.#rejections.delete(key);
      this.#quarantines.set(key, now + QUARANTINE_MS);
      return true;
    }
    this.#rejections.set(key, rejections);
    return false;
  }
}
