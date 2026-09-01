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

function storageFrom(map, onAccess = () => {}) {
  return {
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

test("keeps literal first entry, earliest free touch and latest paid touch across returns", async () => {
  const localMap = new Map();
  const start = Date.UTC(2026, 7, 1, 12, 0, 0);

  storefrontHarness(async () => new FakeResponse({}), {
    localMap,
    clock: { now: start },
    href: "https://puremajestypet.com/products/collagen",
  });
  storefrontHarness(async () => new FakeResponse({}), {
    localMap,
    clock: { now: start + 1_000 },
    href: "https://puremajestypet.com/blogs/news/dog-collagen-guide",
    referrer: "https://www.google.com/search?q=collagen+for+dogs",
  });
  storefrontHarness(async () => new FakeResponse({}), {
    localMap,
    clock: { now: start + 2_000 },
    href: "https://puremajestypet.com/products/collagen?utm_source=google&utm_medium=cpc&utm_campaign=collagen_search&gclid=GCLID123456",
    referrer: "https://www.google.com/",
  });

  const requests = [];
  const returning = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    localMap,
    clock: { now: start + 3_000 },
    href: "https://puremajestypet.com/products/yeast",
  });
  await checkoutBody(returning, { items: [] });

  const body = requests[0];
  assert.equal(body.attribution_model, "last_paid_else_first_free_v1");
  assert.equal(body.first_entry_landing_url, "https://puremajestypet.com/products/collagen");
  assert.equal(body.first_entry_source, "direct");
  assert.equal(body.first_entry_medium, "none");
  assert.equal(body.first_touch_landing_url, "https://puremajestypet.com/blogs/news/dog-collagen-guide");
  assert.equal(body.first_touch_source, "google");
  assert.equal(body.first_touch_medium, "organic");
  assert.equal(body.last_touch_source, "google");
  assert.equal(body.last_touch_medium, "cpc");
  assert.equal(body.last_touch_campaign, "collagen_search");
  assert.equal(body.gclid, "GCLID123456");
});

test("checkout in an older tab refreshes the newer paid touch from another tab", async () => {
  const localMap = new Map();
  const start = Date.UTC(2026, 7, 2, 12, 0, 0);
  const requests = [];
  const googleTab = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    localMap,
    clock: { now: start },
    href: "https://puremajestypet.com/products/collagen?utm_source=google&utm_medium=cpc&gclid=GOOGLECLICK123",
  });

  storefrontHarness(async () => new FakeResponse({}), {
    localMap,
    clock: { now: start + 5_000 },
    href: "https://puremajestypet.com/products/yeast?utm_source=meta&utm_medium=paid_social&utm_campaign=yeast_retargeting&fbclid=METACLICK12345",
    referrer: "https://l.facebook.com/",
  });

  await checkoutBody(googleTab, { items: [] });
  const body = requests[0];
  assert.equal(body.last_touch_source, "meta");
  assert.equal(body.last_touch_medium, "paid_social");
  assert.equal(body.last_touch_campaign, "yeast_retargeting");
  assert.equal(body.fbclid, "METACLICK12345");
  assert.match(body.fbc, /^fb\.1\.\d+\.METACLICK12345$/);
  assert.equal("gclid" in body, false);
});

test("a bare fbclid is retained as free Meta traffic and never becomes last-paid", async () => {
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    href: "https://puremajestypet.com/products/collagen?fbclid=UNPAIDMETA123",
    referrer: "https://l.facebook.com/",
  });

  await checkoutBody(storefront, { items: [] });
  const body = requests[0];
  assert.equal(body.first_touch_source, "facebook");
  assert.equal(body.first_touch_medium, "organic_social");
  assert.equal("last_touch_source" in body, false);
  assert.equal(body.fbclid, "UNPAIDMETA123");
  assert.match(body.fbc, /^fb\.1\.\d+\.UNPAIDMETA123$/);
});

test("Meta paid UTM keeps a valid fbc even without a raw fbclid", async () => {
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    href: "https://puremajestypet.com/products/collagen?utm_source=instagram&utm_medium=paid-social&utm_campaign=retargeting",
  });

  await checkoutBody(storefront, {
    items: [],
    fbc: "fb.1.1785600000000.ValidMetaCookie123",
  });
  const body = requests[0];
  assert.equal(body.last_touch_source, "instagram");
  assert.equal(body.last_touch_medium, "paid_social");
  assert.equal(body.fbc, "fb.1.1785600000000.ValidMetaCookie123");
});

test("a non-Meta paid touch clears an unrelated fbc", async () => {
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    href: "https://puremajestypet.com/products/collagen?utm_source=google&utm_medium=paid_search&gclid=GOOGLECLICK456",
  });

  await checkoutBody(storefront, {
    items: [],
    fbc: "fb.1.1785600000000.StaleMetaCookie123",
  });
  assert.equal(requests[0].gclid, "GOOGLECLICK456");
  assert.equal("fbc" in requests[0], false);
});

test("invalid body identifiers are stripped and cannot invent a paid touch", async () => {
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  });

  await checkoutBody(storefront, {
    items: [],
    gclid: "shopper@example.com",
    fbclid: "bad id with spaces",
    fbc: "fb.1.not-a-time.bad",
    fbp: "not-a-browser-cookie",
  });
  const body = requests[0];
  assert.equal("gclid" in body, false);
  assert.equal("fbclid" in body, false);
  assert.equal("fbc" in body, false);
  assert.equal("fbp" in body, false);
  assert.equal("last_touch_source" in body, false);
});

test("a valid paid identifier supplied by the theme seeds last-paid only when absent", async () => {
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  });

  await checkoutBody(storefront, {
    items: [],
    landing_url: "https://puremajestypet.com/products/collagen",
    gclid: "THEMEGCLID12345",
  });
  const body = requests[0];
  assert.equal(body.last_touch_source, "google");
  assert.equal(body.last_touch_medium, "cpc");
  assert.equal(body.gclid, "THEMEGCLID12345");
});

test("migrates an unexpired legacy paid record without inventing historical first entry", async () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  const localMap = new Map([["pmp_paid_attribution_v3", JSON.stringify({
    landing_url: "https://puremajestypet.com/products/yeast?utm_source=google&utm_medium=cpc&gclid=LEGACYGCLID123",
    referrer: "https://www.google.com/",
    captured_at: now - 10_000,
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "legacy_paid",
    gclid: "LEGACYGCLID123",
  })]]);
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    localMap,
    clock: { now },
    href: "https://puremajestypet.com/products/collagen",
  });

  await checkoutBody(storefront, { items: [] });
  const body = requests[0];
  assert.equal(body.first_entry_landing_url, "https://puremajestypet.com/products/collagen");
  assert.equal(body.first_entry_source, "direct");
  assert.equal(body.last_touch_campaign, "legacy_paid");
  assert.equal(body.gclid, "LEGACYGCLID123");
});

test("migrates the earliest clearly free legacy touch and ignores a paid generic fallback", async () => {
  const now = Date.UTC(2026, 7, 4, 12, 0, 0);
  const localMap = new Map([
    ["pmp_paid_attribution_v3", JSON.stringify({
      landing_url: "https://puremajestypet.com/blogs/news/yeast-guide",
      referrer: "https://www.google.com/",
      captured_at: now - 20_000,
      utm_source: "google",
      utm_medium: "organic",
    })],
    ["pmp_last_touch_v1", JSON.stringify({
      landing_url: "https://puremajestypet.com/products/yeast",
      captured_at: now - 10_000,
      utm_source: "google",
      utm_medium: "cpc",
      gclid: "UNTRUSTEDPAID123",
    })],
  ]);
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, { localMap, clock: { now } });

  await checkoutBody(storefront, { items: [] });
  const body = requests[0];
  assert.equal(body.first_touch_landing_url, "https://puremajestypet.com/blogs/news/yeast-guide");
  assert.equal(body.first_touch_source, "google");
  assert.equal(body.first_touch_medium, "organic");
  assert.equal("last_touch_source" in body, false);
  assert.equal("gclid" in body, false);
});

test("does not replay the polluted legacy session landing as a new paid touch", async () => {
  const sessionMap = new Map([["pmp_landing_url",
    "https://puremajestypet.com/products/yeast?utm_source=google&utm_medium=cpc&gclid=STALEGCLID123",
  ]]);
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    sessionMap,
    href: "https://puremajestypet.com/products/collagen",
  });

  await checkoutBody(storefront, { items: [] });
  assert.equal(requests[0].first_entry_source, "direct");
  assert.equal("last_touch_source" in requests[0], false);
  assert.equal("gclid" in requests[0], false);
});

test("an expired own-session landing cannot replay its paid touch", async () => {
  const now = Date.UTC(2026, 7, 5, 12, 0, 0);
  const old = now - (31 * 60 * 1000);
  const sessionMap = new Map([["pmp:attribution:session-landing:v1", JSON.stringify({
    capturedAt: old,
    fingerprint: "old-paid-touch",
    touch: {
      landing_url: "https://puremajestypet.com/products/yeast?utm_source=google&utm_medium=cpc&gclid=OLDSESSION123",
      referrer: "https://www.google.com/",
      source: "google",
      medium: "cpc",
      campaign: "old_session",
      gclid: "OLDSESSION123",
      at: new Date(old).toISOString(),
    },
  })]]);
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    sessionMap,
    clock: { now },
    href: "https://puremajestypet.com/products/collagen",
  });

  await checkoutBody(storefront, { items: [] });
  assert.equal(requests[0].first_entry_source, "direct");
  assert.equal("last_touch_source" in requests[0], false);
  assert.equal("gclid" in requests[0], false);
});

test("denied Shopify consent prevents attribution storage access and removes identifiers", async () => {
  let allowed = false;
  const accesses = [];
  const sessionAccesses = [];
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    href: "https://puremajestypet.com/products/collagen",
    customerPrivacy: { userCanBeTracked: () => allowed },
    onLocalAccess: (operation, key) => accesses.push([operation, key]),
    onSessionAccess: (operation, key) => sessionAccesses.push([operation, key]),
  });

  assert.deepEqual(accesses, []);
  assert.deepEqual(sessionAccesses, []);
  await checkoutBody(storefront, {
    items: [],
    attribution_model: "forged",
    landing_url: "https://example.com/private",
    utm_source: "google",
    gclid: "CONSENTGCLID123",
    fbp: "fb.1.1785600000000.ValidBrowser123",
    fbc: "fb.1.1785600000000.ValidClickCookie123",
    external_id: "browser_123",
    ga_client_id: "123.456",
    first_touch_source: "google",
    last_paid_source: "google",
  });

  const body = requests[0];
  assert.deepEqual(accesses, []);
  assert.deepEqual(sessionAccesses, []);
  for (const key of [
    "attribution_model", "landing_url", "utm_source", "gclid", "fbp", "fbc",
    "external_id", "ga_client_id", "first_touch_source", "last_paid_source",
  ]) assert.equal(key in body, false, key);
  assert.deepEqual(body.items, []);
});

test("consent granted after page load captures the current visit at checkout", async () => {
  let allowed = false;
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    href: "https://puremajestypet.com/products/collagen",
    customerPrivacy: { userCanBeTracked: () => allowed },
  });

  allowed = true;
  storefront.location.href = "https://puremajestypet.com/products/yeast?utm_source=instagram&utm_medium=dm&utm_campaign=dm_marie";
  await checkoutBody(storefront, { items: [] });
  const body = requests[0];
  assert.equal(body.first_entry_landing_url,
    "https://puremajestypet.com/products/yeast");
  assert.equal(body.first_touch_source, "instagram");
  assert.equal(body.first_touch_medium, "dm");
  assert.equal(body.first_touch_campaign, "dm_marie");
  assert.equal("last_touch_source" in body, false);
});

test("email-like PII is absent from persisted state and the checkout attribution body", async () => {
  const localMap = new Map();
  const sessionMap = new Map();
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    localMap,
    sessionMap,
    href: "https://puremajestypet.com/customers/shopper%40example.com?utm_source=google&utm_medium=cpc&utm_campaign=lead%2540example.com&gclid=SAFEGCLID12345",
    referrer: "https://referrer.example/path/buyer%40example.com?email=buyer%40example.com",
  });

  await checkoutBody(storefront, {
    items: [],
    landing_url: "https://puremajestypet.com/products/yeast?email=customer%40example.com",
    referrer: "https://partner.example/customer%40example.com?email=customer%40example.com",
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "customer@example.com",
    utm_content: "customer%2540example.com",
    utm_term: "safe keyword",
    external_id: "customer@example.com",
    ga_client_id: "customer%40example.com",
    gclid: "SAFEGCLID12345",
  });

  const storedText = [...localMap.values(), ...sessionMap.values()].join("\n");
  const body = requests[0];
  assert.equal(storedText.includes("shopper"), false);
  assert.equal(storedText.includes("buyer"), false);
  assert.equal(storedText.includes("%40"), false);
  assert.equal(storedText.includes("@"), false);
  assert.equal(body.first_entry_landing_url, "https://puremajestypet.com/");
  assert.equal(body.last_touch_source, "google");
  assert.equal(body.last_touch_medium, "cpc");
  assert.equal(body.last_touch_campaign, "");
  assert.equal(body.gclid, "SAFEGCLID12345");
  assert.equal(body.utm_source, "google");
  assert.equal(body.utm_medium, "cpc");
  assert.equal(body.utm_term, "safe keyword");
  assert.equal("utm_campaign" in body, false);
  assert.equal("utm_content" in body, false);
  assert.equal("external_id" in body, false);
  assert.equal("ga_client_id" in body, false);
  assert.equal(JSON.stringify(body).includes("%40"), false);
  assert.equal(JSON.stringify(body).includes("@"), false);
});

test("expired attribution is rejected from both storage and the in-memory cache", async () => {
  const start = Date.UTC(2026, 7, 6, 12, 0, 0);
  const clock = { now: start };
  const requests = [];
  const storefront = storefrontHarness(async (_input, init) => {
    requests.push(JSON.parse(init.body));
    return new FakeResponse({});
  }, {
    clock,
    href: "https://puremajestypet.com/products/collagen?utm_source=google&utm_medium=cpc&gclid=EXPIRINGGCLID123",
  });

  clock.now += 91 * 24 * 60 * 60 * 1000;
  storefront.location.href = "https://puremajestypet.com/products/yeast";
  storefront.document.referrer = "";
  await checkoutBody(storefront, { items: [] });

  const body = requests[0];
  assert.equal(body.first_entry_landing_url, "https://puremajestypet.com/products/yeast");
  assert.equal(body.first_entry_source, "direct");
  assert.equal("last_touch_source" in body, false);
  assert.equal("gclid" in body, false);
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
