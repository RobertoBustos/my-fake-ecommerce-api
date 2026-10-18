import { describe, it, expect, vi, afterAll, afterEach, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { ApolloServer } from "@apollo/server";
import typeDefs from "../src/schema/typeDefs/index.js";
import resolvers from "../src/schema/resolvers.js";
import { createLoaders } from "../src/dataloaders/index.js";
import db from "../src/config/firestore.js";
import { ReservationExpiredError, toGlobalProductId } from "../src/catalog/index.js";
import {
  processInventoryTasks,
  retryInventoryTask,
  runInventoryTask,
} from "../src/catalog/inventoryQueue.js";
import { firestoreCatalogSource as fs } from "../src/catalog/sources/firestore/adapter.js";
import { getInventoryTask, queueInventoryTasks } from "../src/db/inventoryTasks.js";
import { markOrderComplete } from "../src/db/orders.js";
import { sweepExpiredReservations } from "../src/db/reservationSweep.js";
import { runTransaction } from "../src/db/transactions.js";
import { logger } from "../src/utils/logger.js";
import { computeOrderTotals } from "../src/utils/orderTotals.js";

const { payment, flaky } = vi.hoisted(() => ({
  payment: {
    cancelPayment: vi.fn().mockResolvedValue(true),
    createPayment: vi.fn().mockResolvedValue({
      paymentId: "pi_inventory",
      clientSecret: "secret",
      ephimeralKey: "ek",
    }),
    getCustomer: vi.fn().mockResolvedValue({ id: "cus_inventory" }),
    searchPayment: vi.fn().mockResolvedValue(null),
    searchPaymentMethod: vi.fn(),
  },
  // A source whose confirm and release each test scripts to fail or succeed.
  flaky: {
    key: "flaky",
    displayName: "Flaky source",
    capabilities: { reservations: true, changeFeed: false },
    listChanged: async () => ({ items: [], deletedIds: [] }),
    getProducts: async () => [],
    reserve: async () => {
      throw new Error("not used");
    },
    confirm: null,
    release: null,
  },
}));
vi.mock("../src/db/payment.js", () => payment);
vi.mock("../src/catalog/registry.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getCatalogSource: (key) => (key === "flaky" ? flaky : actual.getCatalogSource(key)),
  };
});

const MINUTE = 60_000;
const later = (minutes) => new Date(Date.now() + minutes * MINUTE);
// Fails `times` times, then succeeds.
const failing = (times, error = () => new Error("source is down")) => {
  let calls = 0;
  return vi.fn(async () => {
    calls += 1;
    if (calls <= times) throw error();
  });
};

const queue = async (draft) => {
  const [id] = await runTransaction((tx) => queueInventoryTasks(tx, [draft]));
  return id;
};
const flakyDraft = (action) => ({
  action,
  sourceKey: "flaky",
  reservation: { reservationId: `test-res-${randomUUID()}`, localId: "sku-1", quantity: 2, expiresAt: null },
  reason: "test",
  orderId: "order-test",
});

const productIds = [];
const newProduct = async (stock) => {
  const id = `test-inventory-${randomUUID()}`;
  productIds.push(id);
  await db.collection("products").doc(id).set({
    title: "Inventory fixture",
    description: "",
    category: "test-inventory",
    image: "",
    currency: "MXN",
    unitPrice: 100,
    purchaseLimits: { min: 1, max: 20 },
    stock,
  });
  return id;
};
const stockOf = async (id) => (await db.collection("products").doc(id).get()).get("stock");
const reservationDoc = async (id) => (await db.collection("reservations").doc(id).get()).data();

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.INVENTORY_TASK_MAX_ATTEMPTS;
});
afterAll(async () => {
  await Promise.all(productIds.map((id) => db.collection("products").doc(id).delete()));
});

describe("inventory queue (ECOMAPI-75)", () => {
  it("retries a failing task with backoff until the source answers", async () => {
    flaky.release = failing(2);
    const id = await queue(flakyDraft("release"));

    expect(await runInventoryTask(id)).toBe("PENDING");
    const afterFirst = await getInventoryTask(id);
    expect(afterFirst).toMatchObject({ attempts: 1, lastError: "source is down" });
    expect(afterFirst.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 0.9 * MINUTE);

    // Not due yet: a pass now leaves it alone.
    await processInventoryTasks();
    expect((await getInventoryTask(id)).attempts).toBe(1);

    await processInventoryTasks({ now: later(2) });
    expect(await getInventoryTask(id)).toMatchObject({ attempts: 2, status: "PENDING" });
    await processInventoryTasks({ now: later(10) });
    expect(await getInventoryTask(id)).toMatchObject({ attempts: 3, status: "DONE", nextAttemptAt: null });
    expect(flaky.release).toHaveBeenCalledTimes(3);
    expect(flaky.release.mock.calls[0][1]).toMatch(/-release$/);
  });

  it("gives up after its attempts and logs a confirm that never happened", async () => {
    process.env.INVENTORY_TASK_MAX_ATTEMPTS = "2";
    flaky.confirm = failing(Infinity);
    const error = vi.spyOn(logger, "error");
    const id = await queue(flakyDraft("confirm"));

    await runInventoryTask(id);
    expect(error).not.toHaveBeenCalled();
    await processInventoryTasks({ now: later(2) });

    expect(await getInventoryTask(id)).toMatchObject({ status: "FAILED", attempts: 2, nextAttemptAt: null });
    expect(error).toHaveBeenCalledWith(
      "Sold units not confirmed in their source",
      expect.objectContaining({ taskId: id, orderId: "order-test", sourceKey: "flaky", attempts: 2 })
    );
    // Failed tasks don't come back on their own.
    await processInventoryTasks({ now: later(600) });
    expect(flaky.confirm).toHaveBeenCalledTimes(2);

    // Once the source is fixed, a person puts it back.
    flaky.confirm = vi.fn(async () => {});
    expect(await retryInventoryTask(id)).toBe("DONE");
  });

  it("doesn't retry an error that retrying can't fix", async () => {
    flaky.confirm = failing(Infinity, () => new ReservationExpiredError("gone"));
    const error = vi.spyOn(logger, "error");
    const id = await queue(flakyDraft("confirm"));

    expect(await runInventoryTask(id)).toBe("FAILED");
    expect((await getInventoryTask(id)).attempts).toBe(1);
    expect(error).toHaveBeenCalledWith("Sold units not confirmed in their source", expect.anything());
  });

  it("queuing the same release twice keeps one task and doesn't reopen a done one", async () => {
    flaky.release = vi.fn(async () => {});
    const draft = flakyDraft("release");
    const id = await queue(draft);
    await runInventoryTask(id);

    expect(await queue(draft)).toBe(id);
    expect(await getInventoryTask(id)).toMatchObject({ status: "DONE" });
    await processInventoryTasks({ now: later(5) });
    expect(flaky.release).toHaveBeenCalledTimes(1);
  });
});

describe("the purchase saga through the queue (ECOMAPI-75)", () => {
  const USER = "user-inventory";
  const server = new ApolloServer({ typeDefs, resolvers });
  const run = async (query, variables) => {
    const response = await server.executeOperation(
      { query, variables },
      { contextValue: { user: { uid: USER }, loaders: createLoaders() } }
    );
    return response.body.singleResult;
  };
  const cartIds = [];
  const orderIds = [];
  const ADD = `mutation ($input: AddToCart!) { addToCart(input: $input) { data { id } } }`;
  const REMOVE = `mutation ($input: RemoveFromCart!) { removeFromCart(input: $input) { success } }`;
  const itemData = async (id) => (await db.collection("cartItems").doc(id).get()).data();

  // A cart with one item of `quantity` units; returns its ids.
  const cartWith = async (productId, quantity) => {
    const cartId = `cart-inventory-${randomUUID()}`;
    cartIds.push(cartId);
    const added = await run(ADD, {
      input: { cartId, productId: toGlobalProductId("fs", productId), quantity },
    });
    const itemId = added.data.addToCart.data.id;
    const [reservation] = (await itemData(itemId)).reservations;
    return { cartId, itemId, reservationId: reservation.reservationId };
  };
  const order = async (cartId, status, paymentId = null) => {
    const created = await run(`mutation ($input: CreateOrder!) { createOrder(input: $input) { data { id } } }`, {
      input: { cartId },
    });
    const orderId = created.data.createOrder.data.id;
    orderIds.push(orderId);
    await db.collection("orders").doc(orderId).update({ status, paymentId });
    return orderId;
  };
  const totalOf = async (orderId) => {
    const items = await db.collection("cartItems").where("orderId", "==", orderId).get();
    return computeOrderTotals(items.docs.map((doc) => doc.data())).total;
  };

  beforeEach(() => {
    payment.cancelPayment.mockClear();
  });
  afterAll(async () => {
    await Promise.all(orderIds.map((id) => db.collection("orders").doc(id).delete()));
    for (const cartId of cartIds) {
      const items = await db.collection("cartItems").where("cartId", "==", cartId).get();
      await Promise.all(items.docs.map((doc) => doc.ref.delete()));
    }
  });

  it("the webhook confirms the order's reservations", async () => {
    const id = await newProduct(10);
    const { cartId, reservationId } = await cartWith(id, 2);
    const orderId = await order(cartId, "PAYMENT_PENDING", "pi_saga");

    const result = await markOrderComplete(orderId, {
      paymentIntentId: "pi_saga",
      amountReceived: await totalOf(orderId),
    });

    expect(result).toEqual({ completed: true });
    expect(await getInventoryTask(`${reservationId}-confirm`)).toMatchObject({ status: "DONE", orderId });
    expect((await reservationDoc(reservationId)).status).toBe("CONFIRMED");
    expect(await stockOf(id)).toBe(8);
  });

  it("with the source down, the webhook completes the order and leaves the confirm queued", async () => {
    const id = await newProduct(10);
    const { cartId, reservationId } = await cartWith(id, 1);
    const orderId = await order(cartId, "PAYMENT_PENDING", "pi_saga_down");
    vi.spyOn(fs, "confirm").mockRejectedValueOnce(new Error("source is down"));

    const result = await markOrderComplete(orderId, {
      paymentIntentId: "pi_saga_down",
      amountReceived: await totalOf(orderId),
    });

    expect(result.completed).toBe(true);
    expect((await db.collection("orders").doc(orderId).get()).get("status")).toBe("COMPLETE");
    const taskId = `${reservationId}-confirm`;
    expect(await getInventoryTask(taskId)).toMatchObject({ status: "PENDING", attempts: 1 });
    expect((await reservationDoc(reservationId)).status).toBe("HELD");

    await processInventoryTasks({ now: later(2) });
    expect((await getInventoryTask(taskId)).status).toBe("DONE");
    expect((await reservationDoc(reservationId)).status).toBe("CONFIRMED");
  });

  it("a removal while the source is down gives the units back once it answers", async () => {
    const id = await newProduct(10);
    const { itemId, reservationId } = await cartWith(id, 3);
    vi.spyOn(fs, "release").mockRejectedValueOnce(new Error("source is down"));

    const removed = await run(REMOVE, { input: { id: itemId } });
    expect(removed.data.removeFromCart.success).toBe(true);
    expect(await itemData(itemId)).toBeUndefined();
    expect(await stockOf(id)).toBe(7);

    await processInventoryTasks({ now: later(2) });
    expect((await getInventoryTask(`${reservationId}-release`)).status).toBe("DONE");
    expect(await stockOf(id)).toBe(10);
  });

  it("cancelling queues the release in the same write as the status", async () => {
    const id = await newProduct(10);
    const { cartId, reservationId } = await cartWith(id, 2);
    const orderId = await order(cartId, "INCOMPLETE");

    await run(`mutation ($input: CancelOrder!) { cancelOrder(input: $input) { success } }`, {
      input: { id: orderId },
    });

    expect(await getInventoryTask(`${reservationId}-release`)).toMatchObject({
      status: "DONE",
      reason: "cancelOrder",
      orderId,
    });
    expect(await stockOf(id)).toBe(10);
  });

  it("the sweep releases expired reservations of abandoned carts, never of an order being paid", async () => {
    const id = await newProduct(20);
    const free = await cartWith(id, 1);
    const incomplete = await cartWith(id, 2);
    const paying = await cartWith(id, 3);
    const paid = await cartWith(id, 4);
    await order(incomplete.cartId, "INCOMPLETE");
    await order(paying.cartId, "PAYMENT_PENDING", "pi_sweep");
    await order(paid.cartId, "COMPLETE", "pi_sweep_paid");
    // Reserved, but the cart write never happened: no item holds it.
    const orphan = await fs.reserve(id, 5, `test-orphan-${randomUUID()}`);
    expect(await stockOf(id)).toBe(5);

    // Nothing has expired yet.
    await sweepExpiredReservations();
    await processInventoryTasks();
    expect(await stockOf(id)).toBe(5);

    // An hour and a half later, every reservation is past its expiry.
    const now = later(90);
    const swept = await sweepExpiredReservations({ now });
    await processInventoryTasks({ now });

    expect(swept.queued).toBeGreaterThanOrEqual(3);
    for (const { reservationId } of [free, incomplete]) {
      expect((await reservationDoc(reservationId)).status).toBe("RELEASED");
    }
    expect((await reservationDoc(orphan.reservationId)).status).toBe("RELEASED");
    for (const { reservationId } of [paying, paid]) {
      expect((await reservationDoc(reservationId)).status).toBe("HELD");
    }
    expect(await stockOf(id)).toBe(5 + 1 + 2 + 5);

    // The item stays in its cart; removing it later doesn't give the units back twice.
    expect(await itemData(free.itemId)).toBeDefined();
    await run(REMOVE, { input: { id: free.itemId } });
    expect(await stockOf(id)).toBe(13);
  });
});
