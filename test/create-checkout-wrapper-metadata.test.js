import assert from "node:assert/strict";
import test from "node:test";

const VARIANT_ID = 43433440903242;

function responseHarness() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    end() { return this; },
  };
}

test("production campaign wrapper stays at Stripe's 50-key metadata limit", async (t) => {
  const originalFetch = globalThis.fetch;
  const envNames = [
    "SHOPIFY_STORE_DOMAIN", "SHOPIFY_ADMIN_TOKEN", "STRIPE_SECRET_KEY",
    "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "SUCCESS_URL",
    "OMNISEND_API_KEY", "BRIDGE_PUBLIC_URL",
  ];
  const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
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

  let stripeParams = null;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes("/admin/api/2026-01/graphql.json")) {
      return {
        ok: true,
        async json() {
          return { data: { nodes: [{
            id: `gid://shopify/ProductVariant/${VARIANT_ID}`,
            contextualPricing: { price: { amount: "31.99", currencyCode: "USD" } },
          }] } };
        },
      };
    }
    if (href === "https://api.stripe.com/v1/checkout/sessions") {
      stripeParams = new URLSearchParams(String(init.body));
      return {
        ok: true,
        async json() {
          return { id: "cs_wrapper_limit", client_secret: "secret_wrapper", currency: "usd", amount_total: 3199 };
        },
      };
    }
    if (href.startsWith("https://upstash.example/set/")) return { ok: true, async text() { return "OK"; } };
    throw new Error(`Unexpected fetch: ${href}`);
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const name of envNames) {
      if (originalEnv[name] == null) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  });

  const { default: handler } = await import(`../api/create-checkout.js?metadata-limit=${Date.now()}`);
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
    last_touch_referrer: "https://l.facebook.com/",
    last_touch_source: "meta",
    last_touch_medium: "paid_social",
    last_touch_campaign: "liquid_retargeting_product_view",
    last_touch_at: "2026-08-03T12:00:00.000Z",
  };
  const req = {
    method: "POST",
    headers: {
      "user-agent": "node-test",
      "x-forwarded-for": "203.0.113.10",
      "x-vercel-ip-country": "CA",
    },
    body: {
      currency: "USD",
      checkout_country: "CA",
      locale: "en-CA",
      email: "maximum@example.com",
      external_id: "browser_maximum_123",
      shopify_cart_token: "cart_maximum_123",
      shopify_cart_url: "https://shop.example/cart?view=bridge",
      journey_id: "journey-maximum-123456",
      fbp: "fb.1.1700000000000.123456789012345",
      fbc: "fb.1.1700000000000.Meta_Click_123456",
      landing_url: "https://shop.example/products/paid",
      referrer: "https://l.facebook.com/",
      utm_source: "meta",
      utm_medium: "paid_social",
      utm_campaign: "liquid_retargeting_product_view",
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
      items: [{ variant_id: VARIANT_ID, title: "Cranberry for Dogs", quantity: 1, price_cents: 3199 }],
    },
  };
  const res = responseHarness();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(stripeParams);
  const metadataKeys = [...stripeParams.keys()].filter((key) => key.startsWith("metadata["));
  assert.equal(metadataKeys.length, 50);
  assert.equal(stripeParams.get("metadata[automatic_offer]"), "WELCOME20");
  assert.equal(stripeParams.get("metadata[automatic_offer_source]"), "meta_liquid_retargeting");
  assert.equal(stripeParams.get("discounts[0][promotion_code]"), "promo_1U6IEuA0auDoBNzsRt1kuqge");
  assert.equal(stripeParams.get("allow_promotion_codes"), null);
});
