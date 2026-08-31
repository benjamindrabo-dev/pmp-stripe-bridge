import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import handler from "../api/meta-offer-summary.js";

function responseHarness() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.payload = payload; return this; },
  };
}

function scriptSource() {
  const res = responseHarness();
  handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 200);
  return res.payload;
}

class FakeResponse {
  constructor(payload, status = 200) {
    this.payload = payload;
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.bodyUsed = false;
  }

  clone() {
    return new FakeResponse(this.payload, this.status);
  }

  async json() {
    this.bodyUsed = true;
    return this.payload;
  }
}

function successfulCheckout() {
  return {
    clientSecret: "secret_usd",
    sessionId: "cs_live_tracking_123",
    analytics: {
      beginCheckout: {
        eventId: "9447f17e-b96c-4a12-932f-85ca3802ef65",
        currency: "USD",
        value: 63.98,
        items: [{
          item_id: "43433440903242",
          item_name: "Cranberry for Dogs",
          price: 31.99,
          quantity: 2,
        }],
      },
    },
  };
}

function storefrontHarness(nativeFetch, options = {}) {
  const storage = new Map();
  const google = [];
  const clarity = [];
  const sessionStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  };
  const location = { href: "https://puremajestypet.com/products/cranberry" };
  const document = {
    querySelector(selector) {
      return selector === "#PmpHeaderCountrySelectorV3" ? { value: "US" } : null;
    },
  };
  const window = {
    fetch: nativeFetch,
    location,
    document,
    sessionStorage,
    clarity(...args) { clarity.push(args); },
  };
  if (options.withGtag !== false) {
    window.gtag = (...args) => google.push(args);
  }
  window.window = window;
  vm.runInNewContext(scriptSource(), {
    window,
    location,
    document,
    sessionStorage,
    URL,
    URLSearchParams,
    Promise,
    setTimeout: options.setTimeout || setTimeout,
  });
  return { window, google, clarity, storage };
}

test("ScriptTag tracks a successful create-checkout once and preserves its Response", async () => {
  const originals = [];
  const requestBodies = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requestBodies.push(JSON.parse(init.body));
    const response = new FakeResponse(successfulCheckout());
    originals.push(response);
    return response;
  });
  const request = [
    "https://pmp-stripe-bridge.vercel.app/api/create-checkout",
    { method: "POST", body: JSON.stringify({ items: [] }) },
  ];

  const first = await storefront.window.fetch(...request);
  const second = await storefront.window.fetch(...request);

  assert.equal(first, originals[0]);
  assert.equal(second, originals[1]);
  assert.equal(first.bodyUsed, false);
  assert.deepEqual(await first.json(), successfulCheckout());
  assert.equal(requestBodies[0].checkout_country, "US");
  assert.equal(storefront.google.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(storefront.google[0])), [
    "event",
    "begin_checkout",
    {
      send_to: "G-KKS5T7SPHR",
      event_id: "9447f17e-b96c-4a12-932f-85ca3802ef65",
      currency: "USD",
      value: 63.98,
      items: [{
        item_id: "43433440903242",
        item_name: "Cranberry for Dogs",
        price: 31.99,
        quantity: 2,
      }],
    },
  ]);
  assert.deepEqual(storefront.clarity, [
    ["set", "pmp_checkout_event_id", "9447f17e-b96c-4a12-932f-85ca3802ef65"],
    ["event", "begin_checkout"],
  ]);
});

test("ScriptTag reports a network checkout error without leaking its message", async () => {
  const networkError = new Error("shopper@example.com");
  const storefront = storefrontHarness(async () => { throw networkError; });

  await assert.rejects(
    storefront.window.fetch(
      "https://pmp-stripe-bridge.vercel.app/api/create-checkout",
      { method: "POST", body: "{}" },
    ),
    (error) => error === networkError,
  );

  assert.deepEqual(storefront.clarity, [
    ["set", "pmp_checkout_error_stage", "create_checkout"],
    ["set", "pmp_checkout_error_code", "network_error"],
    ["event", "checkout_error"],
  ]);
  assert.equal(JSON.stringify(storefront.clarity).includes("shopper@example.com"), false);
});

test("gtag guard drops only the premature begin_checkout shape", () => {
  const storefront = storefrontHarness(async () => new FakeResponse({}));
  const complete = {
    event_id: "9447f17e-b96c-4a12-932f-85ca3802ef65",
    currency: "USD",
    value: 31.99,
    items: [{ item_id: "43433440903242", item_name: "Cranberry", price: 31.99, quantity: 1 }],
  };

  storefront.window.gtag("event", "begin_checkout", { currency: "USD", value: 31.99 });
  storefront.window.gtag("event", "begin_checkout", complete);
  storefront.window.gtag("event", "add_to_cart", { currency: "USD", value: 31.99 });
  storefront.window.gtag("config", "G-KKS5T7SPHR", { page_path: "/products/cranberry" });

  assert.deepEqual(JSON.parse(JSON.stringify(storefront.google)), [
    ["event", "begin_checkout", complete],
    ["event", "add_to_cart", { currency: "USD", value: 31.99 }],
    ["config", "G-KKS5T7SPHR", { page_path: "/products/cranberry" }],
  ]);
});

test("gtag guard installs through a bounded retry when Google loads later", () => {
  const timers = [];
  const storefront = storefrontHarness(
    async () => new FakeResponse({}),
    {
      withGtag: false,
      setTimeout(callback) { timers.push(callback); return timers.length; },
    },
  );

  assert.equal(typeof storefront.window.gtag, "undefined");
  assert.equal(timers.length, 1);
  storefront.window.gtag = (...args) => storefront.google.push(args);
  timers.shift()();
  assert.equal(storefront.window.gtag.__pmpBeginCheckoutGuard, true);

  storefront.window.gtag("event", "begin_checkout", { currency: "USD", value: 31.99 });
  storefront.window.gtag("event", "view_item", { item_id: "43433440903242" });
  assert.deepEqual(storefront.google, [["event", "view_item", { item_id: "43433440903242" }]]);
  assert.equal(timers.length, 0);
});

test("successful Shopify cart additions emit only Clarity and preserve the Response", async () => {
  const responses = [];
  const storefront = storefrontHarness(async () => {
    const response = new FakeResponse({ id: 43433440903242 }, 200);
    responses.push(response);
    return response;
  });

  const returned = await storefront.window.fetch(
    "/cart/add.js",
    { method: "POST", body: JSON.stringify({ id: 43433440903242, quantity: 1 }) },
  );

  assert.equal(returned, responses[0]);
  assert.equal(returned.bodyUsed, false);
  assert.deepEqual(storefront.clarity, [["event", "add_to_cart"]]);
  assert.equal(storefront.google.length, 0);
});

test("failed Shopify cart additions do not emit add_to_cart", async () => {
  const response = new FakeResponse({ error: "sold out" }, 422);
  const storefront = storefrontHarness(async () => response);

  const returned = await storefront.window.fetch(
    "https://puremajestypet.com/cart/add",
    { method: "POST", body: "{}" },
  );

  assert.equal(returned, response);
  assert.equal(returned.bodyUsed, false);
  assert.equal(storefront.clarity.length, 0);
  assert.equal(storefront.google.length, 0);
});
