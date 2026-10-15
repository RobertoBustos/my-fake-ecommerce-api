import { describe, it, expect, vi } from "vitest";

const { searchMock, createMock, ephemeralKeysCreateMock } = vi.hoisted(() => ({
  searchMock: vi.fn().mockResolvedValue({ data: [] }),
  createMock: vi.fn().mockResolvedValue({ id: "pi_1", client_secret: "secret_1" }),
  ephemeralKeysCreateMock: vi.fn().mockResolvedValue({ secret: "ek_1" }),
}));

vi.mock("../src/config/stripe.js", () => ({
  default: {
    paymentIntents: {
      search: searchMock,
      create: createMock,
    },
    ephemeralKeys: {
      create: ephemeralKeysCreateMock,
    },
  },
}));

import { createPayment } from "../src/db/payment.js";

describe("Llave de idempotencia en el PaymentIntent", () => {
  it("la llamada a Stripe lleva idempotencyKey", async () => {
    await createPayment("order-123", 10000, "cus_1");

    expect(createMock).toHaveBeenCalledTimes(1);
    const [, options] = createMock.mock.calls[0];
    expect(options).toMatchObject({ idempotencyKey: "order-order-123-payment-intent" });
  });

  it("la llave es estable para la misma orden (mismos reintentos no crean otro pago)", async () => {
    createMock.mockClear();

    await createPayment("order-456", 5000, "cus_2");
    await createPayment("order-456", 5000, "cus_2");

    const keys = createMock.mock.calls.map(([, options]) => options.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
  });
});
