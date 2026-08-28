import assert from "node:assert/strict";
import test from "node:test";

import handler, {
  buildRecoveryUrl,
  groupedCartItems,
  safeSessionId,
  safeStoreOrigin,
} from "../api/recover-checkout.js";

const SESSION_ID = "cs_live_recovery123456";

function responseHarness() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    end(body) { this.body = body; return this; },
  };
}

function installEnvironment(t) {
  const originalFetch = globalThis.fetch;
  const names = ["STORE_ORIGIN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
  const originals = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    STORE_ORIGIN: "https://www.puremajestypet.com",
    UPSTASH_REDIS_REST_URL: "https://redis.example",
    UPSTASH_REDIS_REST_TOKEN: "redis-secret",
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (originals[name] == null) delete process.env[name];
      else process.env[name] = originals[name];
    }
  });
}

test("strictly validates the session id and storefront origin", () => {
  assert.equal(safeSessionId(SESSION_ID), SESSION_ID);
  assert.equal(safeSessionId("cs_bad/../../admin"), null);
  assert.equal(safeSessionId([SESSION_ID]), null);

  assert.equal(safeStoreOrigin("https://shop.example/"), "https://shop.example");
  assert.equal(safeStoreOrigin("https://shop.example/path"), null);
  assert.equal(safeStoreOrigin("https://user:pass@shop.example/"), null);
  assert.equal(safeStoreOrigin("http://shop.example/"), null);
  assert.equal(safeStoreOrigin("https://shop.example/\r\nX-Test: injected"), null);
});

test("groups duplicate variants and rejects a malformed cart instead of partially recovering it", () => {
  assert.deepEqual(groupedCartItems({ items: [
    { variant_id: 43433440903242, quantity: 1 },
    { variant_id: "43433440903242", quantity: 2 },
    { variant_id: "43111111111111", quantity: "4" },
  ] }), [
    { variantId: "43433440903242", quantity: 3 },
    { variantId: "43111111111111", quantity: 4 },
  ]);

  assert.equal(groupedCartItems({ items: [
    { variant_id: "43433440903242", quantity: 1 },
    { variant_id: "not-a-variant", quantity: 1 },
  ] }), null);
});

test("builds a cross-device Shopify cart permalink with recovery attribution", () => {
  const value = buildRecoveryUrl("https://shop.example/", SESSION_ID, { items: [
    { variant_id: "43433440903242", quantity: 1 },
    { variant_id: "43433440903242", quantity: 2 },
    { variant_id: "43111111111111", quantity: 4 },
  ] });
  const url = new URL(value);

  assert.equal(url.origin, "https://shop.example");
  assert.equal(url.pathname, "/cart/43433440903242:3,43111111111111:4");
  assert.equal(url.searchParams.get("attributes[pmp_recovery_session]"), SESSION_ID);
  assert.equal(url.searchParams.get("utm_source"), "omnisend");
  assert.equal(url.searchParams.get("utm_medium"), "email");
  assert.equal(url.searchParams.get("utm_campaign"), "checkout_recovery");
  assert.equal(url.searchParams.get("utm_content"), "stripe_bridge");
});

test("reads sess:<id> from Upstash and redirects without exposing the cart", async (t) => {
  installEnvironment(t);
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      text: async () => JSON.stringify({
        result: JSON.stringify({ items: [
          { variant_id: 43433440903242, quantity: 1 },
          { variant_id: 43433440903242, quantity: 2 },
        ] }),
      }),
    };
  };

  const res = responseHarness();
  await handler({ method: "GET", query: { session_id: SESSION_ID } }, res);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://redis.example/get/${encodeURIComponent(`sess:${SESSION_ID}`)}`);
  assert.equal(calls[0].init.headers.Authorization, "Bearer redis-secret");
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.Location, /^https:\/\/www\.puremajestypet\.com\/cart\/43433440903242:3\?/);
  assert.equal(res.headers["Cache-Control"], "no-store, private, max-age=0");
  assert.equal(res.body, undefined);
});

test("falls back to the storefront cart on invalid input, missing data, or Redis failure", async (t) => {
  installEnvironment(t);

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, text: async () => JSON.stringify({ result: null }) };
  };

  const invalid = responseHarness();
  await handler({ method: "GET", query: { session_id: "bad" } }, invalid);
  assert.equal(invalid.statusCode, 302);
  assert.equal(invalid.headers.Location, "https://www.puremajestypet.com/cart");
  assert.equal(fetchCalls, 0);

  const missing = responseHarness();
  await handler({ method: "GET", query: { session_id: SESSION_ID } }, missing);
  assert.equal(missing.statusCode, 302);
  assert.equal(missing.headers.Location, "https://www.puremajestypet.com/cart");

  globalThis.fetch = async () => { throw new Error("secret upstream detail"); };
  const failed = responseHarness();
  await handler({ method: "GET", query: { session_id: SESSION_ID } }, failed);
  assert.equal(failed.statusCode, 302);
  assert.equal(failed.headers.Location, "https://www.puremajestypet.com/cart");
  assert.equal(failed.body, undefined);
});

test("refuses a malformed STORE_ORIGIN instead of emitting an unsafe Location", async (t) => {
  installEnvironment(t);
  process.env.STORE_ORIGIN = "https://shop.example/path";
  const res = responseHarness();

  await handler({ method: "GET", query: { session_id: SESSION_ID } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.headers.Location, undefined);
  assert.equal(res.body, undefined);
});
