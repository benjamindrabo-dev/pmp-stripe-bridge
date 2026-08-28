import assert from "node:assert/strict";
import test from "node:test";

import {
  OMNISEND_API_VERSION,
  OMNISEND_EVENTS_URL,
  buildPlacedOrderEvent,
  buildStartedCheckoutEvent,
  clearOmnisendLocalIdempotency,
  deterministicEventId,
  isValidEmail,
  normalizeEmail,
  sendOmnisendEvent,
  trySendStartedCheckout,
} from "../lib/omnisend.js";

test.beforeEach(() => clearOmnisendLocalIdempotency());

test("email validation normalizes reasonable addresses and rejects unsafe syntax", () => {
  assert.equal(normalizeEmail("  Dog.Parent+PMP@Sub.Example.COM  "), "dog.parent+pmp@sub.example.com");
  assert.equal(isValidEmail("owner@puremajestypet.com"), true);

  for (const invalid of [
    "owner",
    "owner@localhost",
    "owner..dog@example.com",
    ".owner@example.com",
    "owner@example..com",
    "owner@-example.com",
    "owner name@example.com",
    "owner@example.c",
  ]) {
    assert.equal(normalizeEmail(invalid), null, invalid);
  }
});

test("deterministic event IDs are stable UUID v5 values scoped by event type", () => {
  const first = deterministicEventId("started checkout", "cs_test_123");
  const second = deterministicEventId("started checkout", "cs_test_123");
  const placed = deterministicEventId("placed order", "cs_test_123");

  assert.equal(first, second);
  assert.notEqual(first, placed);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("builds a 2026 started checkout event from a Stripe session and saved cart", () => {
  const event = buildStartedCheckoutEvent({
    email: " Shopper+Dog@Example.COM ",
    session: {
      id: "cs_test_started_123",
      currency: "usd",
      amount_total: 7398,
      created: 1724800000,
    },
    cart: {
      landing_url: "https://www.puremajestypet.com/products/liquid-collagen-for-dogs?utm_source=test#offer",
      items: [{
        product_id: 9001,
        variant_id: 43433440903242,
        title: "Liquid Collagen for Dogs",
        quantity: 2,
        price_cents: 3699,
        image: "https://cdn.example.com/collagen.jpg",
        product_url: "https://www.puremajestypet.com/products/liquid-collagen-for-dogs",
      }],
    },
  });

  assert.equal(event.eventName, "started checkout");
  assert.equal(event.origin, "api");
  assert.equal(event.eventVersion, "");
  assert.equal(event.contact.email, "shopper+dog@example.com");
  assert.equal(event.properties.cartID, "cs_test_started_123");
  assert.equal(event.properties.currency, "USD");
  assert.equal(event.properties.value, 73.98);
  assert.equal(event.properties.abandonedCheckoutURL, "https://www.puremajestypet.com/products/liquid-collagen-for-dogs?utm_source=test");
  assert.deepEqual(event.properties.lineItems[0], {
    productID: "9001",
    productImageURL: "https://cdn.example.com/collagen.jpg",
    productPrice: 36.99,
    productQuantity: 2,
    productTitle: "Liquid Collagen for Dogs",
    productURL: "https://www.puremajestypet.com/products/liquid-collagen-for-dogs",
    productVariantID: "43433440903242",
    productVariantImageURL: "https://cdn.example.com/collagen.jpg",
  });
  assert.equal(event.eventTime, "2024-08-27T23:06:40.000Z");
});

test("builds a paid placed-order v2 event from Shopify order, Stripe, and cart data", () => {
  const event = buildPlacedOrderEvent({
    session: {
      id: "cs_test_paid_456",
      payment_status: "paid",
      payment_method_types: ["card"],
      customer_details: {
        email: "adel@example.com",
        name: "Adel Moussa",
        phone: "+15145550100",
        address: {
          line1: "123 Billing St",
          city: "Montreal",
          state: "QC",
          postal_code: "H1H 1H1",
          country: "CA",
        },
      },
      collected_information: {
        shipping_details: {
          name: "Adel Moussa",
          address: {
            line1: "456 Shipping Ave",
            city: "Laval",
            state: "QC",
            postal_code: "H7H 7H7",
            country: "CA",
          },
        },
      },
    },
    order: {
      id: 6123456789,
      order_number: 47001,
      created_at: "2026-08-15T11:49:15Z",
      currency: "CAD",
      financial_status: "paid",
      fulfillment_status: null,
      total_price: "82.00",
      subtotal_price: "82.00",
      total_tax: "0.00",
      total_discounts: "0.00",
      tags: "Stripe, Bridge",
      payment_gateway_names: ["Stripe"],
      line_items: [{
        product_id: 9001,
        variant_id: 43433440903242,
        title: "Liquid Collagen for Dogs",
        quantity: 2,
        price: "41.00",
        sku: "COLLAGEN-DOG",
        vendor: "Pure Majesty Pets",
      }],
    },
    cart: {
      items: [{
        product_id: 9001,
        variant_id: 43433440903242,
        title: "Old cart title",
        quantity: 2,
        price_cents: 4500,
        image: "https://cdn.example.com/collagen.jpg",
        product_url: "https://www.puremajestypet.com/products/liquid-collagen-for-dogs",
      }],
    },
  });

  assert.equal(event.eventName, "placed order");
  assert.equal(event.eventVersion, "v2");
  assert.equal(event.contact.email, "adel@example.com");
  assert.equal(event.properties.orderID, "6123456789");
  assert.equal(event.properties.orderNumber, 47001);
  assert.equal(event.properties.currency, "CAD");
  assert.equal(event.properties.totalPrice, 82);
  assert.equal(event.properties.paymentStatus, "paid");
  assert.equal(event.properties.fulfillmentStatus, "unfulfilled");
  assert.deepEqual(event.properties.tags, ["Stripe", "Bridge"]);
  assert.equal(event.properties.lineItems[0].productPrice, 41);
  assert.equal(event.properties.lineItems[0].productImageURL, "https://cdn.example.com/collagen.jpg");
  assert.equal(event.properties.billingAddress.firstName, "Adel");
  assert.equal(event.properties.billingAddress.address1, "123 Billing St");
  assert.equal(event.properties.shippingAddress.address1, "456 Shipping Ave");
  assert.equal(event.properties.createdAt, "2026-08-15T11:49:15.000Z");
});

test("posts the exact Omnisend API version and locally deduplicates successful events", async () => {
  const event = buildStartedCheckoutEvent({
    email: "owner@example.com",
    currency: "USD",
    cartID: "cart-123",
    eventTime: "2026-08-28T19:00:00Z",
    items: [{ variant_id: 123, title: "Dog supplement", quantity: 1, price_cents: 2399 }],
    abandonedCheckoutURL: "https://www.puremajestypet.com/cart",
  });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 202, text: async () => "" };
  };

  const first = await sendOmnisendEvent(event, { apiKey: "omni-secret-test", fetchImpl, logger: false });
  const second = await sendOmnisendEvent(event, { apiKey: "omni-secret-test", fetchImpl, logger: false });

  assert.equal(first.ok, true);
  assert.equal(first.status, 202);
  assert.equal(second.ok, true);
  assert.equal(second.deduplicated, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, OMNISEND_EVENTS_URL);
  assert.equal(calls[0].init.headers.Authorization, "Omnisend-API-Key omni-secret-test");
  assert.equal(calls[0].init.headers["Omnisend-Version"], OMNISEND_API_VERSION);
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), event);
});

test("safe send helpers skip missing configuration or invalid input and never throw", async () => {
  let fetchCalls = 0;
  const missingKey = await trySendStartedCheckout({
    email: "owner@example.com",
    currency: "USD",
    cartID: "cart-no-key",
    items: [{ variant_id: 123, quantity: 1, price_cents: 2399 }],
  }, {
    apiKey: "",
    fetchImpl: async () => { fetchCalls += 1; },
    logger: false,
  });
  assert.deepEqual(missingKey, {
    ok: false,
    skipped: true,
    reason: "not_configured",
    eventID: deterministicEventId("started checkout", "cart-no-key"),
  });

  const invalidEmail = await trySendStartedCheckout({
    email: "not-an-email",
    currency: "USD",
    cartID: "cart-bad-email",
    items: [{ variant_id: 123, quantity: 1, price_cents: 2399 }],
  }, { apiKey: "omni-secret-test", logger: false });
  assert.equal(invalidEmail.ok, false);
  assert.equal(invalidEmail.skipped, true);
  assert.equal(invalidEmail.reason, "invalid_input");
  assert.equal(fetchCalls, 0);
});

test("API and network failures are returned, not thrown, and remain retryable", async () => {
  const event = buildStartedCheckoutEvent({
    email: "owner@example.com",
    currency: "USD",
    cartID: "cart-retry",
    items: [{ variant_id: 123, quantity: 1, price_cents: 2399 }],
  });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503, text: async () => "temporarily unavailable" };
    if (calls === 2) throw new Error("network down");
    return { ok: true, status: 202, text: async () => "" };
  };

  const apiFailure = await sendOmnisendEvent(event, { apiKey: "omni-secret-test", fetchImpl, logger: false });
  const networkFailure = await sendOmnisendEvent(event, { apiKey: "omni-secret-test", fetchImpl, logger: false });
  const recovered = await sendOmnisendEvent(event, { apiKey: "omni-secret-test", fetchImpl, logger: false });

  assert.equal(apiFailure.reason, "api_rejected");
  assert.equal(apiFailure.status, 503);
  assert.equal(networkFailure.reason, "network_error");
  assert.equal(recovered.ok, true);
  assert.equal(calls, 3);
});
