import { describe, it, expect, vi, afterAll, afterEach, beforeEach } from "vitest";
import { createHash, randomUUID } from "crypto";
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
import { cancelOrderOutcome, markOrderComplete } from "../src/db/orders.js";
import { registerPushToken } from "../src/db/pushTokens.js";
import { notifyOrderCancelled } from "../src/services/pushService.js";
import { cancelAbandonedOrders } from "../src/db/abandonedOrders.js";
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
// The real client, so messages are chunked as in production; only the send
// to Expo's servers is simulated.
vi.mock("../src/config/expo.js", async () => {
  const { Expo } = await import("expo-server-sdk");
  const client = new Expo();
  client.sendPushNotificationsAsync = vi.fn();
  return { default: client };
});
const expoClient = (await import("../src/config/expo.js")).default;
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

    expect(result).toEqual({ completed: true, cartId, userId: expect.any(String) });
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
  describe("abandoned PAYMENT_PENDING orders", () => {
    // The reservation expires 60 minutes after addToCart; the grace period
    // is 24 hours after that.
    const pastGrace = () => later(60 + 24 * 60 + 5);
    const statusOf = async (orderId) => (await db.collection("orders").doc(orderId).get()).get("status");
    const paymentStatus = (statuses) =>
      payment.searchPayment.mockImplementation(async (_field, id) =>
        statuses[id] ? { id, status: statuses[id] } : null
      );

    afterEach(() => {
      payment.searchPayment.mockReset();
      payment.searchPayment.mockResolvedValue(null);
    });

    it("keeps an order whose reservations expired less than the grace period ago", async () => {
      const id = await newProduct(10);
      const paying = await cartWith(id, 2);
      const orderId = await order(paying.cartId, "PAYMENT_PENDING");

      await cancelAbandonedOrders({ now: later(60 + 23 * 60) });

      expect(await statusOf(orderId)).toBe("PAYMENT_PENDING");
      expect((await reservationDoc(paying.reservationId)).status).toBe("HELD");
      expect(await stockOf(id)).toBe(8);
    });

    it("cancels an order without a PaymentIntent once past the grace period and gives its units back", async () => {
      const event = vi.spyOn(logger, "event");
      const id = await newProduct(10);
      const paying = await cartWith(id, 2);
      const orderId = await order(paying.cartId, "PAYMENT_PENDING");

      const result = await cancelAbandonedOrders({ now: pastGrace() });

      expect(result.cancelled).toBeGreaterThanOrEqual(1);
      expect(await statusOf(orderId)).toBe("CANCELLED");
      expect((await reservationDoc(paying.reservationId)).status).toBe("RELEASED");
      expect(await stockOf(id)).toBe(10);
      expect(event).toHaveBeenCalledWith("order.abandoned", { orderId, cartId: paying.cartId });
    });

    it("cancels an order whose PaymentIntent was never charged, and its PaymentIntent too", async () => {
      paymentStatus({ pi_abandoned_unpaid: "requires_payment_method" });
      const id = await newProduct(10);
      const paying = await cartWith(id, 3);
      const orderId = await order(paying.cartId, "PAYMENT_PENDING", "pi_abandoned_unpaid");

      await cancelAbandonedOrders({ now: pastGrace() });

      expect(await statusOf(orderId)).toBe("CANCELLED");
      expect(payment.cancelPayment).toHaveBeenCalledWith("pi_abandoned_unpaid");
      expect(await stockOf(id)).toBe(10);
    });

    it("keeps an order whose payment is processing, for its webhook to complete", async () => {
      paymentStatus({ pi_abandoned_processing: "processing" });
      const id = await newProduct(10);
      const paying = await cartWith(id, 4);
      const orderId = await order(paying.cartId, "PAYMENT_PENDING", "pi_abandoned_processing");

      const result = await cancelAbandonedOrders({ now: pastGrace() });

      expect(result.keptPaid).toBeGreaterThanOrEqual(1);
      expect(await statusOf(orderId)).toBe("PAYMENT_PENDING");
      expect((await reservationDoc(paying.reservationId)).status).toBe("HELD");
      expect(await stockOf(id)).toBe(6);
    });
    describe("push to the order's user", () => {
      const tokens = [];
      const okTickets = (messages) => messages.map(() => ({ status: "ok", id: `ticket-${randomUUID()}` }));
      // Messages about one order: the sweep may also cancel other tests' orders.
      const sentFor = (orderId) =>
        expoClient.sendPushNotificationsAsync.mock.calls
          .flatMap(([messages]) => messages)
          .filter((message) => message.data.orderId === orderId);
      // An abandoned order of a user of its own, with `devices` signed-in devices.
      const abandonedOrder = async ({ devices = 0, userId = `abandoned-${randomUUID()}` } = {}) => {
        const id = await newProduct(10);
        const paying = await cartWith(id, 1);
        const orderId = await order(paying.cartId, "PAYMENT_PENDING");
        await db.collection("orders").doc(orderId).update({ userId });
        const deviceTokens = [];
        for (let i = 0; i < devices; i++) {
          const token = `ExponentPushToken[${randomUUID()}]`;
          tokens.push(token);
          deviceTokens.push(token);
          await registerPushToken({ token, platform: "ANDROID" }, userId);
        }
        return { orderId, deviceTokens };
      };

      beforeEach(() => {
        expoClient.sendPushNotificationsAsync.mockImplementation(async (messages) => okTickets(messages));
      });
      afterEach(() => {
        vi.restoreAllMocks();
        expoClient.sendPushNotificationsAsync.mockReset();
      });
      afterAll(async () => {
        await Promise.all(
          tokens.map((token) => db.collection("pushTokens").doc(createHash("sha256").update(token).digest("hex")).delete())
        );
        const tickets = await db.collection("pushTickets").get();
        await Promise.all(tickets.docs.filter((doc) => tokens.includes(doc.get("token"))).map((doc) => doc.ref.delete()));
      });

      it("tells every device of the user that the order was cancelled", async () => {
        const { orderId, deviceTokens } = await abandonedOrder({ devices: 2 });

        await cancelAbandonedOrders({ now: pastGrace(), onCancelled: notifyOrderCancelled });

        expect(await statusOf(orderId)).toBe("CANCELLED");
        const sent = sentFor(orderId);
        expect(sent.map((message) => message.to).sort()).toEqual([...deviceTokens].sort());
        for (const message of sent) {
          expect(message).toMatchObject({
            title: "Order cancelled",
            body: "Your order expired before it was paid.",
            data: { type: "order_cancelled", orderId, url: `myapp://orders/${orderId}` },
            channelId: "orders",
          });
        }
      });

      it("sends nothing to a user without devices, or for an order without a user", async () => {
        const withoutDevices = await abandonedOrder();
        const withoutUser = await abandonedOrder({ userId: null });

        await cancelAbandonedOrders({ now: pastGrace(), onCancelled: notifyOrderCancelled });

        expect(await statusOf(withoutDevices.orderId)).toBe("CANCELLED");
        expect(await statusOf(withoutUser.orderId)).toBe("CANCELLED");
        expect(sentFor(withoutDevices.orderId)).toEqual([]);
        expect(sentFor(withoutUser.orderId)).toEqual([]);
      });

      it("sends nothing when the user cancels the order from the app", async () => {
        const { orderId } = await abandonedOrder({ devices: 1 });
        const userId = (await db.collection("orders").doc(orderId).get()).get("userId");

        const response = await new ApolloServer({ typeDefs, resolvers }).executeOperation(
          { query: `mutation ($input: CancelOrder!) { cancelOrder(input: $input) { success } }`, variables: { input: { id: orderId } } },
          { contextValue: { user: { uid: userId }, loaders: createLoaders() } }
        );

        expect(response.body.singleResult.data.cancelOrder.success).toBe(true);
        expect(await statusOf(orderId)).toBe("CANCELLED");
        expect(expoClient.sendPushNotificationsAsync).not.toHaveBeenCalled();
      });

      it("tells its own cancellation apart from an earlier one, so a push goes only for the sweep's own", async () => {
        const { orderId } = await abandonedOrder();

        expect(await cancelOrderOutcome({ id: orderId })).toBe("cancelled");
        expect(await cancelOrderOutcome({ id: orderId })).toBe("alreadyCancelled");
        expect(await cancelOrderOutcome({ id: `missing-${randomUUID()}` })).toBe("notFound");
      });

      it("keeps sweeping when Expo is down, and logs the failure without the token", async () => {
        expoClient.sendPushNotificationsAsync.mockRejectedValue(new Error("connect ECONNREFUSED"));
        const error = vi.spyOn(logger, "error");
        const first = await abandonedOrder({ devices: 1 });
        const second = await abandonedOrder({ devices: 1 });

        await cancelAbandonedOrders({ now: pastGrace(), onCancelled: notifyOrderCancelled });

        expect(await statusOf(first.orderId)).toBe("CANCELLED");
        expect(await statusOf(second.orderId)).toBe("CANCELLED");
        expect(error).toHaveBeenCalledWith("Push notification failed", {
          type: "order_cancelled",
          error: "connect ECONNREFUSED",
        });
        expect(JSON.stringify(error.mock.calls)).not.toContain(first.deviceTokens[0]);
      });

      it("keeps sweeping when the callback itself throws", async () => {
        const first = await abandonedOrder();
        const second = await abandonedOrder();
        const error = vi.spyOn(logger, "error");

        await cancelAbandonedOrders({
          now: pastGrace(),
          onCancelled: async () => {
            throw new Error("callback broke");
          },
        });

        expect(await statusOf(first.orderId)).toBe("CANCELLED");
        expect(await statusOf(second.orderId)).toBe("CANCELLED");
        expect(error).toHaveBeenCalledWith("Abandoned order callback failed", {
          orderId: first.orderId,
          error: "callback broke",
        });
      });
    });
  });
});
