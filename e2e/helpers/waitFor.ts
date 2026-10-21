export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  // Shown in the error when time runs out.
  description?: string;
}

// Calls `read` until `done` holds for its result, and returns that result.
// For what happens asynchronously in the deployed API (the Stripe webhook,
// the inventory queue): polling instead of a fixed sleep keeps the suite
// as fast as the environment allows.
export const waitFor = async <T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  { timeoutMs = 60_000, intervalMs = 2_000, description = "condition" }: WaitForOptions = {}
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() + intervalMs > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}; last value: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};
