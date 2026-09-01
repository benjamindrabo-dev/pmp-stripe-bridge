import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import handler from "../api/meta-offer-summary.js";

const DAY = 24 * 60 * 60 * 1000;

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

function storageFrom(map, onAccess = () => {}) {
  return {
    get length() { return map.size; },
    key(index) { return Array.from(map.keys())[index] || null; },
    getItem(key) { onAccess("get", key); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { onAccess("set", key); map.set(key, String(value)); },
    removeItem(key) { onAccess("remove", key); map.delete(key); },
  };
}

function fakeDateFor(clock) {
  return class FakeDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(clock.now);
    }
    static now() { return clock.now; }
  };
}

function storefrontHarness(nativeFetch, options = {}) {
  const storage = options.sessionMap || new Map();
  const localMap = options.localMap || new Map();
  const google = [];
  const clarity = [];
  const sessionStorage = storageFrom(storage, options.onSessionAccess);
  const localStorage = storageFrom(localMap, options.onLocalAccess);
  const location = { href: options.href || "https://puremajestypet.com/products/cranberry" };
  const document = {
    referrer: options.referrer || "",
    readyState: "complete",
    querySelector(selector) {
      return selector === "#PmpHeaderCountrySelectorV3" ? { value: "US" } : null;
    },
  };
  const window = {
    fetch: nativeFetch,
    location,
    document,
    sessionStorage,
    localStorage,
    clarity(...args) { clarity.push(args); },
  };
  if (options.customerPrivacy) {
    window.Shopify = { customerPrivacy: options.customerPrivacy };
  }
  if (options.withGtag !== false) {
    window.gtag = (...args) => google.push(args);
  }
  window.window = window;
  const clock = options.clock || { now: Date.now() };
  const context = vm.createContext({
    window,
    location,
    document,
    sessionStorage,
    localStorage,
    URL,
    URLSearchParams,
    Promise,
    Date: fakeDateFor(clock),
    setTimeout: options.setTimeout || setTimeout,
  });
  const runScript = () => vm.runInContext(scriptSource(), context);
  runScript();
  return { window, google, clarity, storage, localMap, location, document, clock, runScript };
}

async function checkoutBody(storefront, body = {}) {
  await storefront.window.fetch(
    "https://pmp-stripe-bridge.vercel.app/api/create-checkout",
    { method: "POST", body: JSON.stringify(body) },
  );
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

test("checkout bridge reads canonical pixel attribution without writing legacy keys", async () => {
  const now = Date.UTC(2026, 8, 1);
  const localMap = new Map([["pmp:attribution", JSON.stringify({
    schemaVersion: 3,
    journeyId: "journey-test-123456",
    startedAt: now - 1_000,
    expiresAt: now + (90 * 24 * 60 * 60 * 1000),
    firstEntry: { landingUrl: "https://puremajestypet.com/en-ca/products/collagen", capturedAt: now - 1_000 },
    firstFree: {
      landingUrl: "https://puremajestypet.com/blogs/news/dog-health",
      referrer: "https://www.google.com/",
      source: "google",
      medium: "organic",
      campaign: "dog_health_guide",
      capturedAt: now - 2_000,
    },
    lastPaid: {
      clickIds: { gclid: "TEST_FAKE_GCLID_001" },
      landingUrl: "https://puremajestypet.com/en-ca/products/collagen?gclid=TEST_FAKE_GCLID_001",
      capturedAt: now - 1_000,
    },
    writer: "pmp-custom-pixel",
  })]]);
  const writes = [];
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, { localMap, clock: { now }, onLocalAccess: (operation, key) => {
    if (operation !== "get") writes.push([operation, key]);
  } });

  await checkoutBody(storefront, { items: [], gclid: "STALE_THEME_GCLID_123456" });
  assert.equal(requests[0].journey_id, "journey-test-123456");
  assert.equal(requests[0].gclid, "TEST_FAKE_GCLID_001");
  assert.notEqual(requests[0].gclid, "STALE_THEME_GCLID_123456");
  assert.equal(requests[0].last_touch_landing_url, "https://puremajestypet.com/en-ca/products/collagen");
  assert.equal(requests[0].first_touch_source, "google");
  assert.equal(requests[0].first_touch_medium, "organic");
  assert.equal(requests[0].first_touch_campaign, "dog_health_guide");
  assert.deepEqual(writes, []);
});

test("phased rollout reads an active legacy paid click without writing legacy storage", async () => {
  const now = Date.UTC(2026, 8, 1);
  const accesses = [];
  const requests = [];
  const localMap = new Map([["pmp_paid_attribution_v3", JSON.stringify({
    landing_url: "https://puremajestypet.com/products/collagen?utm_source=google&utm_medium=cpc",
    // Transitional readers must support legacy Unix seconds as well as ms.
    captured_at: Math.floor((now - DAY) / 1000),
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "legacy_search",
    gclid: "LEGACY_GCLID_123456",
  })]]);
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    localMap,
    clock: { now },
    onLocalAccess: (operation, key) => accesses.push([operation, key]),
  });

  await checkoutBody(storefront, { items: [] });
  assert.equal(requests[0].gclid, "LEGACY_GCLID_123456");
  assert.equal(requests[0].last_touch_source, "google");
  assert.equal(requests[0].last_touch_campaign, "legacy_search");
  assert.equal(accesses.some(([operation]) => operation !== "get"), false);
});

test("a newer legacy click wins a stale active canonical during rollback recovery", async () => {
  const now = Date.UTC(2026, 8, 1);
  const requests = [];
  const localMap = new Map([
    ["pmp:attribution", JSON.stringify({
      schemaVersion: 3,
      journeyId: "journey-rollback-123456",
      startedAt: now - 3 * DAY,
      expiresAt: now + 87 * DAY,
      firstEntry: {},
      firstFree: {},
      lastPaid: {
        clickIds: { gclid: "STALE_CANONICAL_GCLID_123" },
        capturedAt: now - 3 * DAY,
      },
    })],
    ["pmp_paid_attribution_v3", JSON.stringify({
      msclkid: "NEWER_ROLLBACK_MSCLKID_123",
      captured_at: now - DAY,
    })],
  ]);
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, { localMap, clock: { now } });

  await checkoutBody(storefront, { items: [] });
  assert.equal(requests[0].journey_id, "journey-rollback-123456");
  assert.equal(requests[0].msclkid, "NEWER_ROLLBACK_MSCLKID_123");
  assert.equal("gclid" in requests[0], false);
});

test("current paid URL survives the first-page race before the async pixel write", async () => {
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    href: "https://puremajestypet.com/en-ca/?msclkid=FIRST_PAGE_MSCLKID_123456",
  });
  await checkoutBody(storefront, { items: [] });
  assert.equal(requests[0].msclkid, "FIRST_PAGE_MSCLKID_123456");
  assert.equal(requests[0].last_touch_source, "microsoft");
  assert.equal(requests[0].last_touch_medium, "cpc");
});

test("an older paid URL cannot overwrite a newer click from another tab", async () => {
  const checkoutNow = Date.UTC(2026, 8, 3);
  const clock = { now: checkoutNow - 2 * DAY };
  const requests = [];
  const localMap = new Map([["pmp:attribution:paid:new-tab-event-123456", JSON.stringify({
    schemaVersion: 1,
    journeyId: "journey-newer-tab-123456",
    startedAt: checkoutNow - DAY,
    firstEntry: {},
    firstFree: {},
    lastPaid: {
      eventId: "new-tab-event-123456",
      clickIds: { msclkid: "NEWER_TAB_MSCLKID_123456" },
      capturedAt: checkoutNow - DAY,
    },
  })]]);
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    localMap,
    clock,
    href: "https://puremajestypet.com/?gclid=OLDER_OPEN_TAB_GCLID_123456",
  });
  clock.now = checkoutNow;

  await checkoutBody(storefront, { items: [] });
  assert.equal(requests[0].journey_id, "journey-newer-tab-123456");
  assert.equal(requests[0].msclkid, "NEWER_TAB_MSCLKID_123456");
  assert.equal("gclid" in requests[0], false);
});

test("a paid URL left open beyond 90 days cannot resurrect its click id", async () => {
  const start = Date.UTC(2026, 4, 1);
  const clock = { now: start };
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    clock,
    href: "https://puremajestypet.com/?gclid=OPEN_TAB_EXPIRED_GCLID_123456",
  });
  clock.now = start + 91 * DAY;

  await checkoutBody(storefront, { items: [] });
  assert.equal("gclid" in requests[0], false);
  assert.equal("last_touch_source" in requests[0], false);
});

test("an immutable paid journal repairs a concurrently stale canonical at checkout", async () => {
  const now = Date.UTC(2026, 8, 1);
  const requests = [];
  const localMap = new Map();
  localMap.set("pmp:attribution", JSON.stringify({
      schemaVersion: 3,
      journeyId: "journey-stale-tab-123456",
      startedAt: now - 2_000,
      expiresAt: now + 90 * DAY,
      firstEntry: {},
      firstFree: {},
      lastPaid: {
        clickIds: { gclid: "CONCURRENT_OLD_GCLID_123" },
        capturedAt: now - 2_000,
      },
    }));
  // The journal must not disappear behind an arbitrary localStorage key cap.
  for (let i = 0; i < 2_005; i += 1) localMap.set(`unrelated-${i}`, "x");
  localMap.set("pmp:attribution:paid:event-newer-123456", JSON.stringify({
      schemaVersion: 1,
      journeyId: "journey-new-tab-123456",
      startedAt: now - 1_000,
      firstEntry: { landingUrl: "https://puremajestypet.com/en-ca/", capturedAt: now - 1_000 },
      firstFree: {},
      lastPaid: {
        clickIds: { msclkid: "CONCURRENT_NEW_MSCLKID_123" },
        capturedAt: now - 1_000,
      },
    }));
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, { localMap, clock: { now } });

  await checkoutBody(storefront, { items: [] });
  assert.equal(requests[0].journey_id, "journey-new-tab-123456");
  assert.equal(requests[0].msclkid, "CONCURRENT_NEW_MSCLKID_123");
  assert.equal("gclid" in requests[0], false);
});

test("journal tie-breaking preserves canonical first-free context in the same journey", async () => {
  const now = Date.UTC(2026, 8, 1);
  const capturedAt = now - 1_000;
  const journeyId = "journey-shared-context-123456";
  const requests = [];
  const localMap = new Map([
    ["pmp:attribution", JSON.stringify({
      schemaVersion: 3,
      journeyId,
      startedAt: now - DAY,
      expiresAt: now + 90 * DAY,
      firstEntry: {},
      firstFree: {
        landingUrl: "https://puremajestypet.com/blogs/news/dog-health",
        source: "google",
        medium: "organic",
        capturedAt: now - DAY,
      },
      lastPaid: {
        eventId: "event-aaaaaa-123456",
        clickIds: { gclid: "TIED_OLD_GCLID_123456" },
        capturedAt,
      },
    })],
    ["pmp:attribution:paid:event-zzzzzz-123456", JSON.stringify({
      schemaVersion: 1,
      journeyId,
      startedAt: now - DAY,
      firstEntry: {},
      firstFree: {},
      lastPaid: {
        eventId: "event-zzzzzz-123456",
        clickIds: { msclkid: "TIED_NEW_MSCLKID_123456" },
        capturedAt,
      },
    })],
  ]);
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, { localMap, clock: { now } });

  await checkoutBody(storefront, { items: [] });
  assert.equal(requests[0].journey_id, journeyId);
  assert.equal(requests[0].msclkid, "TIED_NEW_MSCLKID_123456");
  assert.equal("gclid" in requests[0], false);
  assert.equal(requests[0].first_touch_source, "google");
  assert.equal(requests[0].first_touch_medium, "organic");
});

test("a chain of pending journals uses the preceding resolved journey without losing its latest click", async () => {
  const now = Date.UTC(2026, 8, 1);
  const requests = [];
  const localMap = new Map([
    ["pmp:attribution:paid:event-prior-123456", JSON.stringify({
      schemaVersion: 1,
      contextPending: false,
      journeyId: "journey-prior-context-123456",
      startedAt: now - 2_000,
      firstEntry: {},
      firstFree: {
        landingUrl: "https://puremajestypet.com/blogs/news/guide",
        source: "google",
        medium: "organic",
        capturedAt: now - 2_000,
      },
      lastPaid: {
        eventId: "event-prior-123456",
        clickIds: { gclid: "PRIOR_GCLID_123456" },
        capturedAt: now - 2_000,
      },
    })],
    ["pmp:attribution:paid:event-pending-123456", JSON.stringify({
      schemaVersion: 1,
      contextPending: true,
      journeyId: "stale-preliminary-journey-123456",
      startedAt: now - 3_000,
      firstEntry: {},
      firstFree: {},
      lastPaid: {
        eventId: "event-pending-123456",
        clickIds: { msclkid: "PENDING_NEW_MSCLKID_123456" },
        capturedAt: now - 1_000,
      },
    })],
    ["pmp:attribution:paid:event-latest-pending-123456", JSON.stringify({
      schemaVersion: 1,
      contextPending: true,
      journeyId: "another-stale-journey-123456",
      startedAt: now - 3_000,
      firstEntry: {},
      firstFree: {},
      lastPaid: {
        eventId: "event-latest-pending-123456",
        clickIds: { sccid: "PENDING_LATEST_SCCID_123456" },
        capturedAt: now - 500,
      },
    })],
  ]);
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, { localMap, clock: { now } });

  await checkoutBody(storefront, { items: [] });
  assert.equal(requests[0].journey_id, "journey-prior-context-123456");
  assert.equal(requests[0].sccid, "PENDING_LATEST_SCCID_123456");
  assert.equal("msclkid" in requests[0], false);
  assert.equal("gclid" in requests[0], false);
  assert.equal(requests[0].first_touch_source, "google");
});

test("canonical paid UTM without a click id remains an active last-paid touch", async () => {
  const now = Date.UTC(2026, 8, 1);
  const requests = [];
  const localMap = new Map([["pmp:attribution", JSON.stringify({
    schemaVersion: 3,
    journeyId: "journey-utm-paid-123456",
    startedAt: now - DAY,
    expiresAt: now + 89 * DAY,
    firstEntry: {},
    firstFree: {},
    lastPaid: {
      clickIds: {},
      landingUrl: "https://puremajestypet.com/products/collagen?utm_source=instagram&utm_medium=paid-social",
      source: "instagram",
      medium: "paid-social",
      campaign: "retargeting",
      capturedAt: now - DAY,
    },
  })]]);
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, { localMap, clock: { now } });
  await checkoutBody(storefront, { items: [] });
  assert.equal(requests[0].journey_id, "journey-utm-paid-123456");
  assert.equal(requests[0].last_touch_source, "instagram");
  assert.equal(requests[0].last_touch_medium, "paid_social");
  assert.equal(requests[0].last_touch_campaign, "retargeting");
});

test("checkout bridge rejects expired canonical attribution and a forged journey id", async () => {
  const now = Date.UTC(2026, 8, 1);
  const localMap = new Map([["pmp:attribution", JSON.stringify({
    schemaVersion: 3, journeyId: "journey-expired-123456", startedAt: now - 1000,
    expiresAt: now - 1, firstEntry: {}, firstFree: {},
    lastPaid: { clickIds: { gclid: "TEST_FAKE_EXPIRED_001" }, capturedAt: now - 1000 },
    writer: "pmp-custom-pixel",
  })]]);
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body)); return new FakeResponse({});
  }, { localMap, clock: { now } });
  await checkoutBody(storefront, { items: [], journey_id: "forged-journey-123456" });
  assert.equal("gclid" in requests[0], false);
  assert.equal("journey_id" in requests[0], false);
});

test("denied Shopify consent avoids storage and removes every attribution identifier", async () => {
  const now = Date.UTC(2026, 8, 1);
  const accesses = [];
  const requests = [];
  const localMap = new Map([["pmp:attribution", JSON.stringify({
    schemaVersion: 3,
    journeyId: "journey-private-123456",
    startedAt: now - 1_000,
    expiresAt: now + DAY,
    firstEntry: {},
    firstFree: {},
    lastPaid: { clickIds: { gclid: "PRIVATE_GCLID_123456" }, capturedAt: now - 1_000 },
  })]]);
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    localMap,
    clock: { now },
    customerPrivacy: { userCanBeTracked: () => false },
    onLocalAccess: (operation, key) => accesses.push([operation, key]),
  });

  await checkoutBody(storefront, {
    items: [],
    journey_id: "forged-journey-123456",
    attribution_model: "forged",
    landing_url: "https://example.com/private",
    utm_source: "google",
    gclid: "BODY_GCLID_123456",
    fbp: "fb.1.1785600000000.ValidBrowser123",
    fbc: "fb.1.1785600000000.ValidClickCookie123",
    external_id: "browser_123456",
    ga_client_id: "123.456",
    first_touch_source: "google",
    last_paid_source: "google",
  });

  assert.deepEqual(accesses, []);
  for (const key of [
    "journey_id", "attribution_model", "landing_url", "utm_source", "gclid",
    "fbp", "fbc", "external_id", "ga_client_id", "first_touch_source", "last_paid_source",
  ]) assert.equal(key in requests[0], false, key);
});

test("without dated browser state the bridge discards body-supplied journey and click ids", async () => {
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  });
  await checkoutBody(storefront, {
    items: [], journey_id: "forged-journey-123456", gclid: "UNDATED_BODY_GCLID_123456",
  });
  assert.equal("journey_id" in requests[0], false);
  assert.equal("gclid" in requests[0], false);
});

test("loading the ScriptTag twice does not double-wrap fetch or checkout analytics", async () => {
  let nativeCalls = 0;
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    nativeCalls += 1;
    requests.push(JSON.parse(init.body));
    return new FakeResponse(successfulCheckout());
  });
  const wrappedFetch = storefront.window.fetch;

  storefront.runScript();
  assert.equal(storefront.window.fetch, wrappedFetch);
  await checkoutBody(storefront, { items: [] });

  assert.equal(nativeCalls, 1);
  assert.equal(requests.length, 1);
  assert.equal(storefront.google.filter((event) => event[1] === "begin_checkout").length, 1);
});
