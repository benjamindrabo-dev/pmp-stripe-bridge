import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
    "OMNISEND_API_KEY",
    "BRIDGE_PUBLIC_URL",
  ];
  const originals = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  Object.assign(process.env, {
    SHOPIFY_STORE_DOMAIN: "shop.example",
    SHOPIFY_ADMIN_TOKEN: "shop-token",
    STRIPE_SECRET_KEY: "stripe-token",
    UPSTASH_REDIS_REST_URL: "https://upstash.example",
    UPSTASH_REDIS_REST_TOKEN: "redis-token",
    SUCCESS_URL: "https://shop.example/thank-you",
    OMNISEND_API_KEY: "",
    BRIDGE_PUBLIC_URL: "https://bridge.example",
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
  const calls = { stripe: [], redis: [] };

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);

    if (href.includes("/admin/api/2026-01/graphql.json")) {
      return {
        ok: true,
        json: async () => ({
          data: {
            nodes: [{
              id: VARIANT_GID,
              contextualPricing: { price: { amount: "31.99", currencyCode: "USD" } },
            }],
          },
        }),
      };
    }

    if (href === "https://api.stripe.com/v1/checkout/sessions") {
      const params = new URLSearchParams(String(init.body));
      calls.stripe.push(params);
      return {
        ok: true,
        json: async () => ({
          id: "cs_correlation",
          client_secret: "secret_correlation",
          currency: "usd",
          amount_total: 3199,
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

function checkoutRequest(overrides = {}) {
  return {
    method: "POST",
    headers: {
      "user-agent": "node-test",
      "x-forwarded-for": "203.0.113.10",
      "x-vercel-ip-country": "CA",
    },
    body: {
      currency: "USD",
      checkout_country: "CA",
      external_id: "browser_123",
      items: [{
        variant_id: VARIANT_ID,
        title: "Cranberry for Dogs",
        quantity: 1,
        price_cents: 3199,
      }],
      ...overrides,
    },
  };
}

test("correlates a Shopify cart across Checkout Session, PaymentIntent and Redis", async (t) => {
  installEnvironment(t);
  const calls = mockServices();
  const res = responseHarness();

  await handler(checkoutRequest({
    email: "  Shopper+Bridge@Example.COM ",
    shopify_cart_token: "cart_abc123?key=key_456",
    shopify_cart_url: "https://shop.example/cart?view=bridge&key=url_secret#ignored",
  }), res);

  assert.equal(res.statusCode, 200);
  const stripe = calls.stripe[0];
  const emailSha256 = createHash("sha256").update("shopper+bridge@example.com").digest("hex");
  assert.equal(stripe.get("customer_email"), "shopper+bridge@example.com");
  assert.equal(stripe.get("client_reference_id"), "cart_abc123");
  assert.equal(stripe.get("metadata[email]"), null);
  assert.equal(stripe.get("metadata[tracking_version]"), "pmp_v4");
  assert.equal(stripe.get("metadata[email_sha256]"), emailSha256);
  assert.equal(stripe.get("metadata[shopify_cart_token]"), "cart_abc123");
  assert.equal(stripe.get("metadata[shopify_cart_url]"), "https://shop.example/cart?view=bridge");
  assert.equal(stripe.get("payment_intent_data[metadata][email]"), null);
  assert.equal(stripe.get("payment_intent_data[metadata][email_sha256]"), emailSha256);
  assert.equal(stripe.get("payment_intent_data[metadata][shopify_cart_token]"), "cart_abc123");
  assert.equal(stripe.get("payment_intent_data[metadata][shopify_cart_url]"), "https://shop.example/cart?view=bridge");

  assert.equal(calls.redis.length, 1);
  assert.equal(calls.redis[0].email, "shopper+bridge@example.com");
  assert.equal(calls.redis[0].email_sha256, emailSha256);
  assert.equal(calls.redis[0].shopify_cart_token, "cart_abc123");
  assert.equal(calls.redis[0].shopify_cart_url, "https://shop.example/cart?view=bridge");
  assert.equal(calls.redis[0].client_reference_id, "cart_abc123");
  assert.equal(calls.redis[0].tracking_version, "pmp_v4");
  assert.match(calls.redis[0].bridge_started_at, /^\d{4}-\d{2}-\d{2}T/);

  assert.deepEqual(res.payload.correlation, {
    emailCaptured: true,
    shopifyCartToken: "cart_abc123",
    shopifyCartUrl: "https://shop.example/cart?view=bridge",
    clientReferenceId: "cart_abc123",
  });
  assert.equal(res.payload.omnisendStarted, false);
  assert.match(res.payload.omnisendEventId, /^[0-9a-f-]{36}$/);
  assert.match(res.payload.analytics.beginCheckout.eventId, /^[0-9a-f-]{36}$/);
  assert.equal(res.payload.analytics.beginCheckout.currency, "USD");
  assert.equal(res.payload.analytics.beginCheckout.value, 31.99);
  assert.deepEqual(res.payload.analytics.beginCheckout.items, [{
    item_id: String(VARIANT_ID),
    item_name: "Cranberry for Dogs",
    price: 31.99,
    quantity: 1,
  }]);
  assert.equal(
    res.payload.abandonedCheckoutURL,
    "https://bridge.example/api/recover-checkout?session_id=cs_correlation",
  );
});

test("drops unsafe optional correlation fields and keeps browser-id fallback", async (t) => {
  installEnvironment(t);
  const calls = mockServices();
  const res = responseHarness();

  await handler(checkoutRequest({
    email: "not an email",
    shopify_cart_token: "bad token with spaces",
    shopify_cart_url: "javascript:alert(1)",
  }), res);

  assert.equal(res.statusCode, 200);
  const stripe = calls.stripe[0];
  assert.equal(stripe.get("customer_email"), null);
  assert.equal(stripe.get("metadata[email]"), null);
  assert.equal(stripe.get("metadata[email_sha256]"), null);
  assert.equal(stripe.get("metadata[shopify_cart_token]"), null);
  assert.equal(stripe.get("metadata[shopify_cart_url]"), null);
  assert.equal(stripe.get("payment_intent_data[metadata][email]"), null);
  assert.equal(stripe.get("payment_intent_data[metadata][email_sha256]"), null);
  assert.equal(stripe.get("client_reference_id"), "browser_123");
  assert.deepEqual(res.payload.correlation, {
    emailCaptured: false,
    shopifyCartToken: null,
    shopifyCartUrl: null,
    clientReferenceId: "browser_123",
  });
});

test("persists first-entry, first-free and last-paid attribution in Stripe and Redis", async (t) => {
  installEnvironment(t);
  const calls = mockServices();
  const res = responseHarness();

  const attribution = {
    attribution_model: "last_paid_else_first_free_v1",
    landing_url: "https://shop.example/products/yeast?current=ignored#section",
    referrer: "https://www.google.com/search?q=ignored",
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "yeast_sales",
    utm_content: "asset_group_1",
    utm_term: "dog yeast",
    gclid: "gclid_valid_123",
    gbraid: "gbraid_valid_123",
    wbraid: "wbraid_valid_123",
    fbclid: "fbclid_valid_123",
    ttclid: "ttclid_valid_123",
    msclkid: "0123456789abcdef0123456789abcdef",
    fbp: "fb.1.1700000000000.123456789012345",
    fbc: "fb.1.1700000000000.IwAR_valid-click-123",
    ga_client_id: "123456789.1700000000",
    ga_session_id: "1700000000",
    ga_session_number: "2",
    first_entry_landing_url: "https://shop.example/blogs/news/dog-yeast?ignored=1",
    first_entry_referrer: "https://www.google.com/",
    first_entry_source: "google",
    first_entry_medium: "organic",
    first_entry_campaign: "seo_yeast",
    first_entry_at: "2026-08-01T12:00:00.000Z",
    first_touch_landing_url: "https://shop.example/pages/dog-yeast-solution?ignored=1",
    first_touch_referrer: "https://l.instagram.com/",
    first_touch_source: "instagram",
    first_touch_medium: "dm",
    first_touch_campaign: "customer_dm",
    first_touch_at: "2026-08-02T12:00:00.000Z",
    last_touch_landing_url: "https://shop.example/products/yeast?ignored=1",
    last_touch_referrer: "https://www.google.com/",
    last_touch_source: "google",
    last_touch_medium: "paid_social",
    last_touch_campaign: "yeast_retargeting",
    last_touch_at: "2026-08-03T12:00:00.000Z",
  };

  await handler(checkoutRequest({
    email: "shopper@example.com",
    shopify_cart_token: "cart_attribution",
    shopify_cart_url: "https://shop.example/cart?view=bridge",
    ...attribution,
  }), res);

  assert.equal(res.statusCode, 200);
  const stripe = calls.stripe[0];
  const redis = calls.redis[0];
  const expected = {
    attribution_model: "last_paid_else_first_free_v1",
    first_entry_landing: "https://shop.example/blogs/news/dog-yeast",
    first_entry_referrer: "https://www.google.com/",
    first_entry_source: "google",
    first_entry_medium: "organic",
    first_entry_campaign: "seo_yeast",
    first_entry_at: "2026-08-01T12:00:00.000Z",
    first_touch_landing: "https://shop.example/pages/dog-yeast-solution",
    first_touch_referrer: "https://l.instagram.com/",
    first_touch_source: "instagram",
    first_touch_medium: "dm",
    first_touch_campaign: "customer_dm",
    first_touch_at: "2026-08-02T12:00:00.000Z",
    last_touch_landing: "https://shop.example/products/yeast",
    last_touch_referrer: "https://www.google.com/",
    last_touch_source: "google",
    last_touch_medium: "paid_social",
    last_touch_campaign: "yeast_retargeting",
    last_touch_at: "2026-08-03T12:00:00.000Z",
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(stripe.get(`metadata[${key}]`), value, `Stripe metadata ${key}`);
    assert.equal(redis[key], value, `Redis ${key}`);
  }

  for (const [key, value] of Object.entries({
    gclid: attribution.gclid,
    gbraid: attribution.gbraid,
    wbraid: attribution.wbraid,
    fbclid: attribution.fbclid,
    ttclid: attribution.ttclid,
    msclkid: attribution.msclkid,
    fbp: attribution.fbp,
    fbc: attribution.fbc,
  })) {
    assert.equal(stripe.get(`metadata[${key}]`), value, `Stripe metadata ${key}`);
    assert.equal(redis[key], value, `Redis ${key}`);
  }

  const sessionMetadataKeys = [...stripe.keys()].filter((key) => key.startsWith("metadata["));
  assert.ok(sessionMetadataKeys.length <= 50, `Stripe Session metadata uses ${sessionMetadataKeys.length}/50 keys`);
});

test("preserves journey, Display and Snapchat identifiers across Stripe and Redis", async (t) => {
  installEnvironment(t);
  const calls = mockServices();
  const res = responseHarness();

  await handler(checkoutRequest({
    journey_id: "journey-checkout-123456",
    dclid: "Display_Click_123456",
    sccid: "Snap_Click_123456",
  }), res);

  assert.equal(res.statusCode, 200);
  const stripe = calls.stripe[0];
  const redis = calls.redis[0];
  assert.equal(stripe.get("metadata[journey_id]"), "journey-checkout-123456");
  assert.equal(stripe.get("metadata[dclid]"), "Display_Click_123456");
  assert.equal(stripe.get("metadata[sccid]"), "Snap_Click_123456");
  assert.equal(redis.journey_id, "journey-checkout-123456");
  assert.equal(redis.dclid, "Display_Click_123456");
  assert.equal(redis.sccid, "Snap_Click_123456");
});

test("reserves two Stripe metadata slots for the campaign wrapper at maximum input", async (t) => {
  installEnvironment(t);
  const calls = mockServices();
  const res = responseHarness();
  const touch = {
    first_entry_landing_url: "https://shop.example/blogs/news/entry",
    first_entry_referrer: "https://www.google.com/",
    first_entry_source: "google",
    first_entry_medium: "organic",
    first_entry_campaign: "entry_campaign",
    first_entry_at: "2026-08-01T12:00:00.000Z",
    first_touch_landing_url: "https://shop.example/pages/free",
    first_touch_referrer: "https://l.instagram.com/",
    first_touch_source: "instagram",
    first_touch_medium: "dm",
    first_touch_campaign: "free_campaign",
    first_touch_at: "2026-08-02T12:00:00.000Z",
    last_touch_landing_url: "https://shop.example/products/paid",
    last_touch_referrer: "https://www.google.com/",
    last_touch_source: "google",
    last_touch_medium: "cpc",
    last_touch_campaign: "paid_campaign",
    last_touch_at: "2026-08-03T12:00:00.000Z",
  };

  await handler(checkoutRequest({
    email: "maximum@example.com",
    shopify_cart_token: "cart_maximum_123",
    shopify_cart_url: "https://shop.example/cart?view=bridge",
    journey_id: "journey-maximum-123456",
    fbp: "fb.1.1700000000000.123456789012345",
    fbc: "fb.1.1700000000000.Meta_Click_123456",
    landing_url: "https://shop.example/products/paid",
    referrer: "https://www.google.com/",
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "paid_campaign",
    utm_content: "asset_group",
    utm_term: "dog health",
    gclid: "Gclid_Click_123456",
    gbraid: "Gbraid_Click_123456",
    wbraid: "Wbraid_Click_123456",
    dclid: "Display_Click_123456",
    fbclid: "Meta_Click_123456",
    ttclid: "TikTok_Click_123456",
    msclkid: "0123456789abcdef0123456789abcdef",
    sccid: "Snap_Click_123456",
    ga_client_id: "123456789.1700000000",
    ga_session_id: "1700000000",
    ga_session_number: "2",
    attribution_model: "last_paid_else_first_free_v1",
    ...touch,
  }), res);

  assert.equal(res.statusCode, 200);
  const stripe = calls.stripe[0];
  const keys = [...stripe.keys()].filter((key) => key.startsWith("metadata["));
  assert.equal(keys.length, 48, `base handler must reserve 2 of Stripe's 50 slots; got ${keys.length}`);
  for (const key of ["tracking_version", "journey_id", "shopify_cart_token", "gclid", "dclid", "fbclid", "sccid"]) {
    assert.ok(stripe.get(`metadata[${key}]`), `critical metadata ${key}`);
  }
});

test("rejects untrusted identifiers and removes email addresses from attribution", async (t) => {
  installEnvironment(t);
  const calls = mockServices();
  const res = responseHarness();

  await handler(checkoutRequest({
    external_id: "shopper@example.com",
    journey_id: "J".repeat(256),
    fbp: "shopper@example.com",
    fbc: "fb.1.not-a-time.shopper@example.com",
    gclid: "shopper@example.com",
    gbraid: "bad id with spaces",
    wbraid: "test",
    fbclid: "shopper@example.com",
    dclid: "A".repeat(256),
    ttclid: "javascript:alert(1)",
    msclkid: "not/a/click/id",
    sccid: "snapper@example.com",
    utm_source: "shopper@example.com",
    first_entry_landing_url: "https://shop.example/customer/shopper%40example.com/orders?secret=1",
    first_entry_referrer: "https://email.example/click/shopper%2540example.com?secret=1",
    first_entry_source: "shopper@example.com",
    first_touch_landing_url: "https://shop.example/blogs/news/normal-page?email=shopper@example.com",
    last_touch_campaign: "sent-to-shopper@example.com",
  }), res);

  assert.equal(res.statusCode, 200);
  const stripe = calls.stripe[0];
  const redis = calls.redis[0];
  for (const key of [
    "person_id", "browser_id", "journey_id", "fbp", "fbc", "gclid", "gbraid", "wbraid", "fbclid",
    "dclid", "ttclid", "msclkid", "sccid", "utm_source", "first_entry_source", "last_touch_campaign",
  ]) {
    assert.equal(stripe.get(`metadata[${key}]`), null, `Stripe omits ${key}`);
    const redisKey = key === "browser_id" || key === "person_id" ? "external_id" : key;
    if (redisKey in redis) assert.equal(redis[redisKey], null, `Redis clears ${redisKey}`);
  }
  assert.equal(stripe.get("client_reference_id"), null);
  assert.equal(stripe.get("metadata[first_entry_landing]"), "https://shop.example/");
  assert.equal(stripe.get("metadata[first_entry_referrer]"), "https://email.example/");
  assert.equal(redis.first_entry_landing, "https://shop.example/");
  assert.equal(redis.first_entry_referrer, "https://email.example/");
  // Query strings are discarded, so an email used only as a query parameter
  // cannot enter metadata while the non-identifying page remains useful.
  assert.equal(stripe.get("metadata[first_touch_landing]"), "https://shop.example/blogs/news/normal-page");
});

test("localizes Stripe Checkout from trusted Shopify locale tags", async (t) => {
  installEnvironment(t);
  const calls = mockServices();

  const cases = [
    ["fr-FR", "fr"],
    ["de-DE", "de"],
    ["es-ES", "es"],
    ["it-IT", "it"],
    ["pt-PT", "pt"],
    ["en-GB", "en-GB"],
    ["unsupported-locale", "en"],
  ];

  for (const [storefrontLocale, stripeLocale] of cases) {
    const res = responseHarness();
    await handler(checkoutRequest({ locale: storefrontLocale }), res);
    assert.equal(res.statusCode, 200);
    const stripe = calls.stripe.at(-1);
    const redis = calls.redis.at(-1);
    assert.equal(stripe.get("locale"), stripeLocale);
    assert.equal(stripe.get("metadata[checkout_locale]"), stripeLocale);
    assert.equal(redis.checkout_locale, stripeLocale);
    assert.equal(res.payload.checkoutLocale, stripeLocale);
  }
});
