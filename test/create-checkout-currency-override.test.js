import assert from "node:assert/strict";
import test from "node:test";

import handler from "../lib/create-checkout-base.js";

const VARIANT_ID = 43433440903242;
const VARIANT_GID = `gid://shopify/ProductVariant/${VARIANT_ID}`;

function responseHarness() {
  return {
    headers: {},
    statusCode: 200,
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    end() { return this; },
  };
}

function installEnvironment(t) {
  const originalFetch = globalThis.fetch;
  const names = [
    "SHOPIFY_STORE_DOMAIN",
    "SHOPIFY_ADMIN_TOKEN",
    "STRIPE_SECRET_KEY",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "SUCCESS_URL",
    "TEMP_US_CAD_UNTIL",
  ];
  const originals = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  Object.assign(process.env, {
    SHOPIFY_STORE_DOMAIN: "shop.example",
    SHOPIFY_ADMIN_TOKEN: "shop-token",
    STRIPE_SECRET_KEY: "stripe-token",
    UPSTASH_REDIS_REST_URL: "https://upstash.example",
    UPSTASH_REDIS_REST_TOKEN: "redis-token",
    SUCCESS_URL: "https://shop.example/thank-you",
    TEMP_US_CAD_UNTIL: "2099-01-01T00:00:00.000Z",
  });

  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (originals[name] == null) delete process.env[name];
      else process.env[name] = originals[name];
    }
  });
}

function mockServices() {
  const calls = { shopify: [], stripe: [], redis: [] };

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);

    if (href.includes("/admin/api/2026-01/graphql.json")) {
      const request = JSON.parse(String(init.body));
      const isCad = request.query.includes("country:CA");
      calls.shopify.push({ request, isCad });
      return {
        ok: true,
        json: async () => ({
          data: {
            nodes: [{
              id: VARIANT_GID,
              contextualPricing: {
                price: {
                  amount: isCad ? "45.00" : "31.99",
                  currencyCode: isCad ? "CAD" : "USD",
                },
              },
            }],
          },
        }),
      };
    }

    if (href === "https://api.stripe.com/v1/checkout/sessions") {
      const params = new URLSearchParams(String(init.body));
      calls.stripe.push(params);
      const currency = params.get("line_items[0][price_data][currency]");
      const unitAmount = Number(params.get("line_items[0][price_data][unit_amount]"));
      const quantity = Number(params.get("line_items[0][quantity]"));
      return {
        ok: true,
        json: async () => ({
          id: `cs_${currency}`,
          client_secret: `secret_${currency}`,
          currency,
          amount_total: unitAmount * quantity,
        }),
      };
    }

    if (href.startsWith("https://upstash.example/set/")) {
      calls.redis.push(JSON.parse(String(init.body)));
      return { ok: true, text: async () => "OK" };
    }

    throw new Error(`Unexpected fetch: ${href}`);
  };

  return calls;
}

function checkoutRequest(country) {
  return {
    method: "POST",
    headers: {
      "user-agent": "node-test",
      "x-forwarded-for": "203.0.113.10",
      "x-vercel-ip-country": country,
    },
    body: {
      currency: "USD",
      checkout_country: country,
      items: [{
        variant_id: VARIANT_ID,
        title: "Cranberry for Dogs",
        quantity: 1,
        price_cents: 3199,
      }],
    },
  };
}

test("US checkout validates USD, converts against Shopify CAD, and charges CAD", async (t) => {
  installEnvironment(t);
  const calls = mockServices();
  const res = responseHarness();

  await handler(checkoutRequest("US"), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual({
    currency: res.payload.currency,
    amountTotal: res.payload.amountTotal,
    displayCurrency: res.payload.displayCurrency,
    temporaryCurrencyOverride: res.payload.temporaryCurrencyOverride,
  }, {
    currency: "CAD",
    amountTotal: 4500,
    displayCurrency: "USD",
    temporaryCurrencyOverride: true,
  });
  assert.equal(calls.shopify.length, 2);
  assert.equal(calls.stripe[0].get("line_items[0][price_data][currency]"), "cad");
  assert.equal(calls.stripe[0].get("line_items[0][price_data][unit_amount]"), "4500");
  assert.equal(calls.stripe[0].get("metadata[display_currency]"), "USD");
  assert.equal(calls.stripe[0].get("metadata[charge_currency]"), "CAD");
  assert.equal(calls.redis[0].currency, "cad");
  assert.equal(calls.redis[0].items[0].price_cents, 4500);
});

test("a non-US USD checkout remains in USD", async (t) => {
  installEnvironment(t);
  const calls = mockServices();
  const res = responseHarness();

  await handler(checkoutRequest("CA"), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.currency, "USD");
  assert.equal(res.payload.amountTotal, 3199);
  assert.equal(res.payload.temporaryCurrencyOverride, false);
  assert.equal(calls.shopify.length, 1);
  assert.equal(calls.stripe[0].get("line_items[0][price_data][currency]"), "usd");
});
