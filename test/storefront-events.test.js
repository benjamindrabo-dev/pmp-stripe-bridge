import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const trackerSource = await readFile(
  new URL("../public/pmp-checkout-events.js", import.meta.url),
  "utf8",
);

function sessionStorageHarness(shared = new Map()) {
  return {
    getItem(key) { return shared.has(key) ? shared.get(key) : null; },
    setItem(key, value) { shared.set(key, String(value)); },
  };
}

function browserHarness({ storage = sessionStorageHarness(), withGtag = true } = {}) {
  const google = [];
  const clarity = [];
  const window = {
    sessionStorage: storage,
    clarity(...args) { clarity.push(args); },
  };
  if (withGtag) window.gtag = (...args) => google.push(args);
  window.window = window;
  vm.runInNewContext(trackerSource, { window, globalThis: window });
  return { window, google, clarity };
}

function checkoutResponse(overrides = {}) {
  return {
    sessionId: "cs_live_tracking_123",
    analytics: {
      beginCheckout: {
        eventId: "9447f17e-b96c-4a12-932f-85ca3802ef65",
        currency: "usd",
        value: 63.98,
        items: [{
          item_id: "43433440903242",
          item_name: "Cranberry for Dogs",
          price: 31.99,
          quantity: 2,
        }],
        ...overrides,
      },
    },
  };
}

test("emits a complete GA4 and Clarity begin_checkout once", () => {
  const { window, google, clarity } = browserHarness();

  assert.equal(window.PMPCheckoutEvents.beginCheckout(checkoutResponse()), true);
  assert.equal(window.PMPCheckoutEvents.beginCheckout(checkoutResponse()), false);

  assert.deepEqual(JSON.parse(JSON.stringify(google)), [["event", "begin_checkout", {
    event_id: "9447f17e-b96c-4a12-932f-85ca3802ef65",
    currency: "USD",
    value: 63.98,
    items: [{
      item_id: "43433440903242",
      item_name: "Cranberry for Dogs",
      price: 31.99,
      quantity: 2,
    }],
  }]]);
  assert.deepEqual(clarity, [
    ["set", "pmp_checkout_event_id", "9447f17e-b96c-4a12-932f-85ca3802ef65"],
    ["event", "begin_checkout"],
  ]);
});

test("sessionStorage de-duplicates the event after a page reload", () => {
  const shared = new Map();
  const first = browserHarness({ storage: sessionStorageHarness(shared) });
  const reloaded = browserHarness({ storage: sessionStorageHarness(shared) });

  assert.equal(first.window.PMPCheckoutEvents.beginCheckout(checkoutResponse()), true);
  assert.equal(reloaded.window.PMPCheckoutEvents.beginCheckout(checkoutResponse()), false);
  assert.equal(first.google.length, 1);
  assert.equal(reloaded.google.length, 0);
});

test("queues the GA4 call when gtag has not loaded yet", () => {
  const { window } = browserHarness({ withGtag: false });

  assert.equal(window.PMPCheckoutEvents.beginCheckout(checkoutResponse()), true);
  assert.equal(window.dataLayer.length, 1);
  assert.equal(window.dataLayer[0][0], "event");
  assert.equal(window.dataLayer[0][1], "begin_checkout");
  assert.equal(window.dataLayer[0][2].value, 63.98);
});

test("rejects malformed analytics payloads instead of polluting GA4", () => {
  const { window, google, clarity } = browserHarness();

  assert.equal(window.PMPCheckoutEvents.beginCheckout(checkoutResponse({ currency: "XXX", items: [] })), false);
  assert.equal(google.length, 0);
  assert.equal(clarity.length, 0);
});

test("reports sanitized checkout errors to Clarity without messages", () => {
  const { window, clarity } = browserHarness();

  window.PMPCheckoutEvents.checkoutError({
    stage: "mount checkout",
    code: "stripe/runtime-error",
    message: "shopper@example.com",
  });

  assert.deepEqual(clarity, [
    ["set", "pmp_checkout_error_stage", "mount_checkout"],
    ["set", "pmp_checkout_error_code", "stripe_runtime-error"],
    ["event", "checkout_error"],
  ]);
  assert.equal(JSON.stringify(clarity).includes("shopper@example.com"), false);
});
