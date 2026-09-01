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
  if (options.crypto) window.crypto = options.crypto;
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

test("checkout bridge reads canonical pixel attribution and writes only the canonical fallback key", async () => {
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
  assert.deepEqual(writes, [["set", "pmp:attribution"]]);
  assert.equal(JSON.parse(localMap.get("pmp:attribution")).writer, "pmp-storefront-fallback-v3");
  assert.equal(writes.some(([, key]) => ["pmp_paid_attribution_v3", "pmp:attribution:v1"].includes(key)), false);
});

test("fallback migrates an active legacy click without deleting or rewriting its source key", async () => {
  const now = Date.UTC(2026, 8, 1);
  const accesses = [];
  const requests = [];
  const legacyRaw = JSON.stringify({
    landing_url: "https://puremajestypet.com/products/collagen?utm_source=google&utm_medium=cpc",
    // Transitional readers must support legacy Unix seconds as well as ms.
    captured_at: Math.floor((now - DAY) / 1000),
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "legacy_search",
    gclid: "LEGACY_GCLID_123456",
  });
  const emptyV1Raw = JSON.stringify({
    version: 2,
    journeyId: "empty-legacy-journey-123456",
    startedAt: "not-a-date",
    expiresAt: "not-a-date",
    lastPaid: {},
  });
  const localMap = new Map([
    ["pmp_paid_attribution_v3", legacyRaw],
    ["pmp:attribution:v1", emptyV1Raw],
  ]);
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
  assert.equal(localMap.get("pmp_paid_attribution_v3"), legacyRaw);
  assert.equal(localMap.get("pmp:attribution:v1"), emptyV1Raw);
  assert.equal(accesses.some(([operation, key]) => operation !== "get" && key === "pmp_paid_attribution_v3"), false);
  const canonical = JSON.parse(localMap.get("pmp:attribution"));
  assert.equal(canonical.schemaVersion, 3);
  assert.equal(canonical.writer, "pmp-storefront-fallback-v3");
  assert.equal(canonical.lastPaid.clickIds.gclid, "LEGACY_GCLID_123456");
  assert.equal(canonical.expiresAt, now - DAY + 90 * DAY);
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
  const localMap = new Map();
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    localMap,
    href: "https://puremajestypet.com/en-ca/?msclkid=FIRST_PAGE_MSCLKID_123456",
  });
  const canonical = JSON.parse(localMap.get("pmp:attribution"));
  assert.equal(canonical.schemaVersion, 3);
  assert.equal(canonical.writer, "pmp-storefront-fallback-v3");
  assert.equal(canonical.lastPaid.clickIds.msclkid, "FIRST_PAGE_MSCLKID_123456");
  assert.equal(canonical.expiresAt, canonical.lastPaid.capturedAt + 90 * DAY);
  const journals = Array.from(localMap.keys()).filter((key) => key.startsWith("pmp:attribution:paid:"));
  assert.equal(journals.length, 1);
  assert.equal(JSON.parse(localMap.get(journals[0])).contextPending, false);

  await checkoutBody(storefront, { items: [] });
  assert.equal(requests[0].journey_id, canonical.journeyId);
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
    schemaVersion: 3, journeyId: "journey-expired-123456", startedAt: now - 91 * DAY,
    expiresAt: now - 1, firstEntry: {}, firstFree: {},
    lastPaid: { clickIds: { gclid: "TEST_FAKE_EXPIRED_001" }, capturedAt: now - 91 * DAY },
    writer: "pmp-custom-pixel",
  })]]);
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body)); return new FakeResponse({});
  }, { localMap, clock: { now } });
  await checkoutBody(storefront, { items: [], journey_id: "forged-journey-123456" });
  assert.equal("gclid" in requests[0], false);
  assert.equal(typeof requests[0].journey_id, "string");
  assert.notEqual(requests[0].journey_id, "forged-journey-123456");
  assert.notEqual(requests[0].journey_id, "journey-expired-123456");
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

test("fallback keeps one paid click through direct, email, organic, and referral visits without renewing it", () => {
  const started = Date.UTC(2026, 8, 1);
  const localMap = new Map();
  let uuid = 0;
  const crypto = {
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  };
  const visit = (offset, href, referrer = "") => storefrontHarness(
    async () => new FakeResponse({}),
    { localMap, clock: { now: started + offset }, href, referrer, crypto },
  );

  visit(0, "https://puremajestypet.com/?gclid=PAID_GCLID_KEEP_123456");
  const initial = JSON.parse(localMap.get("pmp:attribution"));
  const initialJourney = initial.journeyId;
  const initialExpiry = initial.expiresAt;
  const initialPaidAt = initial.lastPaid.capturedAt;

  visit(5 * DAY, "https://puremajestypet.com/en-ca/");
  visit(10 * DAY, "https://puremajestypet.com/en-ca/?utm_source=newsletter&utm_medium=email&utm_campaign=fall");
  visit(15 * DAY, "https://puremajestypet.com/products/collagen", "https://www.google.com/");
  visit(20 * DAY, "https://puremajestypet.com/blogs/news/guide", "https://example.org/article");

  const final = JSON.parse(localMap.get("pmp:attribution"));
  assert.equal(final.schemaVersion, 3);
  assert.equal(final.writer, "pmp-storefront-fallback-v3");
  assert.equal(final.journeyId, initialJourney);
  assert.equal(final.lastPaid.clickIds.gclid, "PAID_GCLID_KEEP_123456");
  assert.equal(final.lastPaid.capturedAt, initialPaidAt);
  assert.equal(final.expiresAt, initialExpiry);
  assert.equal(final.firstFree.source, "newsletter");
  assert.equal(final.firstFree.medium, "email");
});

test("a campaign-only free visit can seed firstFree without affecting lastPaid", () => {
  const now = Date.UTC(2026, 8, 1);
  const localMap = new Map();
  storefrontHarness(async () => new FakeResponse({}), {
    localMap,
    clock: { now },
    href: "https://puremajestypet.com/?utm_campaign=unpaid_creator_link",
    crypto: { randomUUID: () => "05000000-0000-4000-8000-000000000001" },
  });

  const state = JSON.parse(localMap.get("pmp:attribution"));
  assert.equal(state.firstFree.campaign, "unpaid_creator_link");
  assert.equal(state.firstFree.source, "direct");
  assert.equal(state.firstFree.medium, "none");
  assert.deepEqual(state.lastPaid, {});
  assert.equal(state.expiresAt, 0);
});

test("a second paid click replaces the first and starts exactly one new 90-day window", () => {
  const started = Date.UTC(2026, 8, 1);
  const localMap = new Map();
  let uuid = 0;
  const crypto = {
    randomUUID: () => `10000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  };
  storefrontHarness(async () => new FakeResponse({}), {
    localMap,
    clock: { now: started },
    href: "https://puremajestypet.com/?gclid=FIRST_PAID_GCLID_123456",
    crypto,
  });
  const first = JSON.parse(localMap.get("pmp:attribution"));

  const secondAt = started + 7 * DAY;
  storefrontHarness(async () => new FakeResponse({}), {
    localMap,
    clock: { now: secondAt },
    href: "https://puremajestypet.com/en-ca/?msclkid=SECOND_PAID_MSCLKID_123456",
    crypto,
  });
  const second = JSON.parse(localMap.get("pmp:attribution"));
  assert.equal(second.journeyId, first.journeyId);
  assert.equal(second.lastPaid.clickIds.msclkid, "SECOND_PAID_MSCLKID_123456");
  assert.equal("gclid" in second.lastPaid.clickIds, false);
  assert.equal(second.lastPaid.capturedAt, secondAt);
  assert.equal(second.expiresAt, secondAt + 90 * DAY);
});

test("fallback recognizes all eight click identifiers and explicit paid UTM traffic", () => {
  const clickKeys = ["gclid", "gbraid", "wbraid", "dclid", "fbclid", "msclkid", "ttclid", "sccid"];
  const started = Date.UTC(2026, 8, 1);
  const localMap = new Map();
  let uuid = 0;
  const crypto = {
    randomUUID: () => `20000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  };

  clickKeys.forEach((key, index) => {
    const value = `TEST_${key.toUpperCase()}_123456`;
    storefrontHarness(async () => new FakeResponse({}), {
      localMap,
      clock: { now: started + index * 1_000 },
      href: `https://puremajestypet.com/en-ca/?${key}=${value}`,
      crypto,
    });
    const state = JSON.parse(localMap.get("pmp:attribution"));
    assert.equal(state.lastPaid.clickIds[key], value, key);
    assert.equal(state.expiresAt, started + index * 1_000 + 90 * DAY, key);
  });

  const paidUtmAt = started + clickKeys.length * 1_000;
  storefrontHarness(async () => new FakeResponse({}), {
    localMap,
    clock: { now: paidUtmAt },
    href: "https://puremajestypet.com/?utm_source=instagram&utm_medium=paid-social&utm_campaign=retargeting",
    crypto,
  });
  const paidUtm = JSON.parse(localMap.get("pmp:attribution"));
  assert.deepEqual(paidUtm.lastPaid.clickIds, {});
  assert.equal(paidUtm.lastPaid.source, "instagram");
  assert.equal(paidUtm.lastPaid.medium, "paid_social");
  assert.equal(paidUtm.lastPaid.campaign, "retargeting");
  assert.equal(paidUtm.expiresAt, paidUtmAt + 90 * DAY);
});

test("fallback never persists opaque account tokens or email-like paths", () => {
  const now = Date.UTC(2026, 8, 1);
  const localMap = new Map();
  storefrontHarness(async () => new FakeResponse({}), {
    localMap,
    clock: { now },
    href: "https://puremajestypet.com/en-ca/account/activate/OPAQUE_SECRET_TOKEN_123456?gclid=SAFE_GCLID_123456",
    crypto: { randomUUID: () => "40000000-0000-4000-8000-000000000001" },
  });

  const state = JSON.parse(localMap.get("pmp:attribution"));
  assert.equal(state.firstEntry.landingUrl, "https://puremajestypet.com/en-ca/");
  assert.equal(state.lastPaid.landingUrl, "https://puremajestypet.com/en-ca/");
  assert.equal(JSON.stringify(state).includes("OPAQUE_SECRET_TOKEN"), false);
  assert.equal(state.lastPaid.clickIds.gclid, "SAFE_GCLID_123456");
});

test("fallback skips an implausible timestamp when a valid legacy timestamp follows", () => {
  const now = Date.UTC(2026, 8, 1);
  const validCapturedAt = now - DAY;
  const localMap = new Map([["pmp_paid_attribution_v3", JSON.stringify({
    lastPaid: {
      gclid: "LEGACY_VALID_DATE_GCLID_123456",
      capturedAt: 1e100,
      captured_at: validCapturedAt,
    },
  })]]);
  storefrontHarness(async () => new FakeResponse({}), {
    localMap,
    clock: { now },
    crypto: { randomUUID: () => "50000000-0000-4000-8000-000000000001" },
  });

  const state = JSON.parse(localMap.get("pmp:attribution"));
  assert.equal(state.lastPaid.clickIds.gclid, "LEGACY_VALID_DATE_GCLID_123456");
  assert.equal(state.lastPaid.capturedAt, validCapturedAt);
  assert.equal(state.lastPaid.dateUncertain, false);
  assert.equal(state.expiresAt, validCapturedAt + 90 * DAY);
});

test("undated legacy paid data is migrated for audit without receiving a fresh TTL", async () => {
  const now = Date.UTC(2026, 8, 1);
  const legacyRaw = JSON.stringify({
    version: 2,
    journeyId: "legacy-undated-journey-123456",
    startedAt: "not-a-date",
    expiresAt: "also-not-a-date",
    lastPaid: { gclid: "LEGACY_UNDATED_GCLID_123456", capturedAt: "unknown" },
  });
  const localMap = new Map([["pmp:attribution:v1", legacyRaw]]);
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, { localMap, clock: { now } });

  const state = JSON.parse(localMap.get("pmp:attribution"));
  assert.equal(state.lastPaid.clickIds.gclid, "LEGACY_UNDATED_GCLID_123456");
  assert.equal(state.lastPaid.dateUncertain, true);
  assert.equal(state.lastPaid.capturedAt, 0);
  assert.equal(state.expiresAt, 0);
  assert.equal(localMap.get("pmp:attribution:v1"), legacyRaw);

  await checkoutBody(storefront, { items: [] });
  assert.equal("gclid" in requests[0], false);
});

test("an expired paid journey rotates instead of being renewed by a later direct visit", async () => {
  const started = Date.UTC(2026, 4, 1);
  const localMap = new Map();
  let uuid = 0;
  const crypto = {
    randomUUID: () => `30000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  };
  storefrontHarness(async () => new FakeResponse({}), {
    localMap,
    clock: { now: started },
    href: "https://puremajestypet.com/?gclid=EXPIRES_GCLID_123456",
    crypto,
  });
  const oldState = JSON.parse(localMap.get("pmp:attribution"));

  const requests = [];
  const afterExpiry = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    localMap,
    clock: { now: started + 91 * DAY },
    href: "https://puremajestypet.com/en-ca/",
    crypto,
  });
  const rotated = JSON.parse(localMap.get("pmp:attribution"));
  assert.notEqual(rotated.journeyId, oldState.journeyId);
  assert.deepEqual(rotated.lastPaid, {});
  assert.equal(rotated.expiresAt, 0);
  assert.equal(Array.from(localMap.keys()).some((key) => key.startsWith("pmp:attribution:paid:")), false);

  await checkoutBody(afterExpiry, { items: [] });
  assert.equal("gclid" in requests[0], false);
});

test("without prior browser state the fallback creates a journey but discards body-supplied identifiers", async () => {
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  });
  await checkoutBody(storefront, {
    items: [], journey_id: "forged-journey-123456", gclid: "UNDATED_BODY_GCLID_123456",
  });
  assert.equal(typeof requests[0].journey_id, "string");
  assert.notEqual(requests[0].journey_id, "forged-journey-123456");
  assert.equal("gclid" in requests[0], false);
});

test("loading the ScriptTag twice does not double-wrap fetch or checkout analytics", async () => {
  let nativeCalls = 0;
  const requests = [];
  const writes = [];
  const storefront = storefrontHarness(async (_input, init) => {
    nativeCalls += 1;
    requests.push(JSON.parse(init.body));
    return new FakeResponse(successfulCheckout());
  }, { onLocalAccess: (operation, key) => {
    if (operation === "set") writes.push(key);
  } });
  const wrappedFetch = storefront.window.fetch;
  const writesAfterFirstLoad = writes.length;

  storefront.runScript();
  assert.equal(storefront.window.fetch, wrappedFetch);
  assert.equal(writes.length, writesAfterFirstLoad);
  await checkoutBody(storefront, { items: [] });

  assert.equal(nativeCalls, 1);
  assert.equal(requests.length, 1);
  assert.equal(storefront.google.filter((event) => event[1] === "begin_checkout").length, 1);
});
