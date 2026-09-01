import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../shopify/pmp-paid-attribution.custom-pixel.js", import.meta.url), "utf8");
const DAY = 24 * 60 * 60 * 1000;
let harnessSequence = 0;

function harness({
  now = Date.UTC(2026, 8, 1), values = {}, sharedStore = null, sharedStorage = null,
  tickOnNow = false,
} = {}) {
  const store = sharedStore || new Map();
  Object.entries(values).forEach(([key, value]) => store.set(key, value));
  const handlers = {};
  const harnessId = ++harnessSequence;
  let journeySequence = 0;
  const browser = { localStorage: sharedStorage || {
    async getItem(key) { return store.get(key) || null; },
    async setItem(key, value) { store.set(key, String(value)); },
    async removeItem(key) { store.delete(key); },
    async length() { return store.size; },
    async key(index) { return Array.from(store.keys())[index] || null; },
  } };
  const analytics = { subscribe(name, handler) { handlers[name] = handler; } };
  const context = vm.createContext({
    analytics, browser, URL, Date: class extends Date {
      static now() { const value = now; if (tickOnNow) now += 1; return value; }
    },
    Promise, Math, setTimeout: (callback) => setImmediate(callback),
    crypto: {
      randomUUID: () => `journey-fixture-${harnessId}-${String(++journeySequence).padStart(6, "0")}`,
    },
  });
  vm.runInContext(source, context);
  async function visit(url, referrer = "") {
    handlers.page_viewed({
      timestamp: new Date(now).toISOString(),
      context: { document: { location: { href: url }, referrer } },
    });
    // Flush the pixel's serialized promise chain, including repair rounds.
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    return JSON.parse(store.get("pmp:attribution"));
  }
  return { store, visit, setNow(value) { now = value; } };
}

test("fake paid clicks persist across direct and Markets visits and last click wins", async () => {
  const h = harness();
  let state = await h.visit("https://puremajestypet.com/products/a?gclid=TEST_FAKE_GCLID_001");
  assert.equal(state.lastPaid.clickIds.gclid, "TEST_FAKE_GCLID_001");
  assert.equal("migrated" in state.lastPaid, false);
  const firstExpiry = state.expiresAt;
  h.setNow(Date.UTC(2026, 8, 2));
  state = await h.visit("https://puremajestypet.com/en-ca/products/b");
  assert.equal(state.lastPaid.clickIds.gclid, "TEST_FAKE_GCLID_001");
  assert.equal(state.expiresAt, firstExpiry);
  h.setNow(Date.UTC(2026, 8, 3));
  state = await h.visit("https://puremajestypet.com/en-ca/products/b?msclkid=TEST_FAKE_MSCLKID_002");
  assert.deepEqual(Object.keys(state.lastPaid.clickIds), ["msclkid"]);
  assert.equal(state.lastPaid.clickIds.msclkid, "TEST_FAKE_MSCLKID_002");
});

test("migrates both legacy formats, keeps the newest dated paid click, and is idempotent", async () => {
  const now = Date.UTC(2026, 8, 1);
  const h = harness({ now, values: {
    // Legacy writers used both Unix seconds and milliseconds.
    pmp_paid_attribution_v3: JSON.stringify({
      gclid: "TEST_FAKE_OLD_001",
      captured_at: Math.floor((now - 2 * DAY) / 1000),
    }),
    "pmp:attribution:v1": JSON.stringify({
      firstFree: {
        landing_url: "https://puremajestypet.com/blogs/news/dog-health",
        referrer: "https://www.google.com/",
        source: "google",
        medium: "organic",
        campaign: "legacy_guide",
        captured_at: now - 3 * DAY,
      },
      lastPaid: { clickIds: { ttclid: "TEST_FAKE_NEW_002" }, capturedAt: now - DAY },
    }),
  } });
  const once = await h.visit("https://puremajestypet.com/products/a");
  const twice = await h.visit("https://puremajestypet.com/products/a");
  assert.equal(once.lastPaid.clickIds.ttclid, "TEST_FAKE_NEW_002");
  assert.equal(once.firstFree.source, "google");
  assert.equal(once.firstFree.medium, "organic");
  assert.equal(once.firstFree.campaign, "legacy_guide");
  assert.deepEqual(twice.lastPaid, once.lastPaid);
  assert.equal(h.store.has("pmp_paid_attribution_v3"), true);
  assert.equal(h.store.has("pmp:attribution:v1"), true);
});

test("empty legacy lastPaid cannot overwrite valid canonical attribution", async () => {
  const now = Date.UTC(2026, 8, 1);
  const canonical = {
    schemaVersion: 3, journeyId: "journey-valid-123456", startedAt: now - DAY,
    expiresAt: now + 89 * DAY, firstEntry: {}, firstFree: {},
    lastPaid: { clickIds: { sccid: "TEST_FAKE_SCCID_001" }, landingUrl: "", capturedAt: now - DAY },
    writer: "pmp-custom-pixel",
  };
  const h = harness({ now, values: {
    "pmp:attribution": JSON.stringify(canonical),
    "pmp:attribution:v1": JSON.stringify({ lastPaid: {} }),
  } });
  const state = await h.visit("https://puremajestypet.com/");
  assert.equal(state.lastPaid.clickIds.sccid, "TEST_FAKE_SCCID_001");
});

test("undated legacy paid signal is retained but receives no invented 90-day validity", async () => {
  const h = harness({ values: {
    pmp_paid_attribution_v3: JSON.stringify({ dclid: "TEST_FAKE_DCLID_001" }),
  } });
  const state = await h.visit("https://puremajestypet.com/");
  assert.equal(state.lastPaid.clickIds.dclid, "TEST_FAKE_DCLID_001");
  assert.equal(state.lastPaid.dateUncertain, true);
  assert.equal(state.expiresAt, 0);
});

test("expired attribution is cleared and a direct visit does not renew it", async () => {
  const start = Date.UTC(2026, 4, 1);
  const h = harness({ now: start });
  await h.visit("https://puremajestypet.com/?wbraid=TEST_FAKE_WBRAID_001");
  h.setNow(start + 91 * DAY);
  const state = await h.visit("https://puremajestypet.com/");
  assert.deepEqual(Object.keys(state.lastPaid), []);
  assert.equal(state.expiresAt, 0);
});

test("captures every supported click identifier with the same 90-day contract", async () => {
  for (const key of ["gclid", "gbraid", "wbraid", "dclid", "fbclid", "msclkid", "ttclid", "sccid"]) {
    const h = harness();
    const value = `TEST_FAKE_${key.toUpperCase()}_123456`;
    const state = await h.visit(`https://puremajestypet.com/en-ca/?${key}=${value}`);
    assert.deepEqual(Object.keys(state.lastPaid.clickIds), [key]);
    assert.equal(state.lastPaid.clickIds[key], value);
    assert.equal(state.expiresAt - state.lastPaid.capturedAt, 90 * DAY);
  }
});

test("persistent URLs exclude email-like data and reject oversized click identifiers", async () => {
  const h = harness();
  const state = await h.visit(
    "https://puremajestypet.com/customers/shopper%40example.com" +
    "?email=shopper%40example.com&utm_campaign=lead%2540example.com" +
    "&utm_source=google&gclid=SAFE_GCLID_123456",
  );
  const serialized = h.store.get("pmp:attribution");
  assert.equal(state.lastPaid.clickIds.gclid, "SAFE_GCLID_123456");
  assert.equal(state.lastPaid.landingUrl, "https://puremajestypet.com/?utm_source=google&gclid=SAFE_GCLID_123456");
  assert.doesNotMatch(serialized, /shopper|%40|@/i);

  const oversized = "A".repeat(256);
  const cleanHarness = harness();
  const clean = await cleanHarness.visit(`https://puremajestypet.com/?gclid=${oversized}`);
  assert.deepEqual(Object.keys(clean.lastPaid), []);
  assert.equal(clean.firstEntry.landingUrl, "https://puremajestypet.com/");
});

test("captures the earliest identifiable free touch after a direct entry", async () => {
  const h = harness();
  let state = await h.visit("https://puremajestypet.com/products/collagen");
  assert.equal(state.firstEntry.source, "direct");
  assert.deepEqual(Object.keys(state.firstFree), []);

  h.setNow(Date.UTC(2026, 8, 2));
  state = await h.visit(
    "https://puremajestypet.com/blogs/news/dog-health",
    "https://www.google.com/search?q=dog+health",
  );
  assert.equal(state.firstFree.source, "google");
  assert.equal(state.firstFree.medium, "organic");
  assert.equal(state.firstFree.landingUrl, "https://puremajestypet.com/blogs/news/dog-health");
});

test("the first free journey survives an advancing clock before canonical storage exists", async () => {
  const h = harness({ tickOnNow: true });
  const state = await h.visit(
    "https://puremajestypet.com/blogs/news/dog-health",
    "https://www.google.com/search?q=dog+health",
  );
  assert.equal(state.firstEntry.source, "google");
  assert.equal(state.firstFree.source, "google");
  assert.equal(state.firstFree.medium, "organic");
});

test("the first free journey survives rotation of an expired canonical with an advancing clock", async () => {
  const now = Date.UTC(2026, 8, 1);
  const h = harness({ now, tickOnNow: true, values: {
    "pmp:attribution": JSON.stringify({
      schemaVersion: 3,
      journeyId: "expired-direct-journey-123456",
      startedAt: now - 91 * DAY,
      expiresAt: 0,
      firstEntry: { landingUrl: "https://puremajestypet.com/old", capturedAt: now - 91 * DAY },
      firstFree: {},
      lastPaid: {},
    }),
  } });
  const state = await h.visit(
    "https://puremajestypet.com/blogs/news/new-guide",
    "https://www.google.com/search?q=new+guide",
  );
  assert.notEqual(state.journeyId, "expired-direct-journey-123456");
  assert.equal(state.firstEntry.source, "google");
  assert.equal(state.firstFree.source, "google");
  assert.equal(state.firstFree.medium, "organic");
});

test("captures an explicit paid UTM even when the ad platform supplies no click id", async () => {
  const h = harness();
  const state = await h.visit(
    "https://puremajestypet.com/products/collagen" +
    "?utm_source=instagram&utm_medium=paid-social&utm_campaign=retargeting",
  );
  assert.deepEqual(Object.keys(state.lastPaid.clickIds), []);
  assert.equal(state.lastPaid.source, "instagram");
  assert.equal(state.lastPaid.medium, "paid-social");
  assert.equal(state.expiresAt - state.lastPaid.capturedAt, 90 * DAY);
});

test("uses valid legacy fallbacks when preferred fields are malformed", async () => {
  const now = Date.UTC(2026, 8, 1);
  const h = harness({ now, values: {
    pmp_paid_attribution_v3: JSON.stringify({
      gclid: "bad id with spaces",
      clickIds: { gclid: "VALID_FALLBACK_GCLID_123" },
      capturedAt: "not-a-date",
      at: new Date(now - DAY).toISOString(),
      landingUrl: "javascript:alert(1)",
      landing_url: "https://puremajestypet.com/products/collagen?utm_source=google",
      source: "shopper@example.com",
      utm_source: "google",
    }),
  } });
  const state = await h.visit("https://puremajestypet.com/");
  assert.equal(state.lastPaid.clickIds.gclid, "VALID_FALLBACK_GCLID_123");
  assert.equal(state.lastPaid.capturedAt, now - DAY);
  assert.equal(state.lastPaid.source, "google");
  assert.match(state.lastPaid.landingUrl, /products\/collagen/);
});

test("rotates a direct-only journey after 90 days", async () => {
  const start = Date.UTC(2026, 4, 1);
  const h = harness({ now: start });
  const first = await h.visit("https://puremajestypet.com/products/a");
  h.setNow(start + 91 * DAY);
  const rotated = await h.visit("https://puremajestypet.com/products/b");
  assert.notEqual(rotated.journeyId, first.journeyId);
  assert.equal(rotated.startedAt, start + 91 * DAY);
  assert.equal(rotated.firstEntry.landingUrl, "https://puremajestypet.com/products/b");
});

test("collapses sensitive checkout and account paths before persistence", async () => {
  const checkout = await harness().visit(
    "https://puremajestypet.com/checkouts/cn/opaque-preauth-token?gclid=SAFE_GCLID_123456",
  );
  assert.equal(checkout.lastPaid.landingUrl, "https://puremajestypet.com/?gclid=SAFE_GCLID_123456");

  const account = await harness().visit(
    "https://puremajestypet.com/en-ca/account/orders/customer-token?utm_source=email",
  );
  assert.equal(account.firstEntry.landingUrl, "https://puremajestypet.com/en-ca/?utm_source=email");
  assert.doesNotMatch(JSON.stringify(account), /customer-token|opaque-preauth-token/);
});

test("expired legacy context is migrated once and cannot undo journey rotation", async () => {
  const start = Date.UTC(2026, 4, 1);
  const h = harness({ now: start, values: {
    pmp_paid_attribution_v3: JSON.stringify({ dclid: "UNDATED_LEGACY_DCLID_123" }),
    "pmp:attribution:v1": JSON.stringify({
      firstFree: {
        landing_url: "https://puremajestypet.com/blogs/news/old-guide",
        source: "google",
        medium: "organic",
        captured_at: start - DAY,
      },
    }),
  } });
  const first = await h.visit("https://puremajestypet.com/products/a");
  assert.equal(first.lastPaid.clickIds.dclid, "UNDATED_LEGACY_DCLID_123");
  assert.equal(first.firstFree.source, "google");

  h.setNow(start + 91 * DAY);
  const rotated = await h.visit("https://puremajestypet.com/products/b");
  assert.notEqual(rotated.journeyId, first.journeyId);
  assert.deepEqual(Object.keys(rotated.lastPaid), []);
  assert.deepEqual(Object.keys(rotated.firstFree), []);
  assert.equal(rotated.firstEntry.landingUrl, "https://puremajestypet.com/products/b");
});

test("a changed legacy record is imported after a temporary pixel rollback", async () => {
  const start = Date.UTC(2026, 4, 1);
  const h = harness({ now: start, values: {
    pmp_paid_attribution_v3: JSON.stringify({
      gclid: "LEGACY_GCLID_BEFORE_ROLLBACK",
      captured_at: start - DAY,
    }),
  } });
  const first = await h.visit("https://puremajestypet.com/products/a");
  assert.equal(first.lastPaid.clickIds.gclid, "LEGACY_GCLID_BEFORE_ROLLBACK");

  const afterRollback = start + DAY;
  h.store.set("pmp_paid_attribution_v3", JSON.stringify({
    msclkid: "LEGACY_MSCLKID_DURING_ROLLBACK",
    captured_at: afterRollback,
  }));
  h.setNow(afterRollback);
  const recovered = await h.visit("https://puremajestypet.com/products/b");
  assert.deepEqual(Object.keys(recovered.lastPaid.clickIds), ["msclkid"]);
  assert.equal(recovered.lastPaid.clickIds.msclkid, "LEGACY_MSCLKID_DURING_ROLLBACK");
});

test("a later tab preserves first-free context written by another tab", async () => {
  const sharedStore = new Map();
  const firstTab = harness({ sharedStore });
  const secondTab = harness({ sharedStore });
  await firstTab.visit("https://puremajestypet.com/products/collagen");
  await secondTab.visit(
    "https://puremajestypet.com/blogs/news/dog-health",
    "https://www.google.com/search?q=dog+health",
  );
  const state = await firstTab.visit("https://puremajestypet.com/products/yeast");
  assert.equal(state.firstFree.source, "google");
  assert.equal(state.firstFree.medium, "organic");
  assert.equal(state.firstFree.landingUrl, "https://puremajestypet.com/blogs/news/dog-health");
});

test("simultaneous stale tabs reconcile to the newest paid click", async () => {
  const sharedStore = new Map();
  const initialWrites = [];
  const sharedStorage = {
    async getItem(key) { return sharedStore.get(key) || null; },
    async setItem(key, value) {
      if (key === "pmp:attribution" && initialWrites.length < 2) {
        return new Promise((resolve) => {
          initialWrites.push({ value: String(value), resolve });
          if (initialWrites.length !== 2) return;
          const sorted = initialWrites.slice().sort((left, right) => {
            const a = JSON.parse(left.value).lastPaid.capturedAt;
            const b = JSON.parse(right.value).lastPaid.capturedAt;
            return b - a;
          });
          // Reproduce the harmful ordering: the newer click lands first and the
          // stale writer overwrites it last before either repair round begins.
          sharedStore.set(key, sorted[0].value);
          sharedStore.set(key, sorted[1].value);
          initialWrites.forEach((write) => write.resolve());
        });
      }
      sharedStore.set(key, String(value));
    },
    async removeItem(key) { sharedStore.delete(key); },
    async length() { return sharedStore.size; },
    async key(index) { return Array.from(sharedStore.keys())[index] || null; },
  };
  const oldTime = Date.UTC(2026, 8, 1);
  const oldTab = harness({ now: oldTime, sharedStore, sharedStorage });
  const newTab = harness({ now: oldTime + 1_000, sharedStore, sharedStorage });

  await Promise.all([
    oldTab.visit("https://puremajestypet.com/?gclid=SIMULTANEOUS_OLD_GCLID"),
    newTab.visit("https://puremajestypet.com/?msclkid=SIMULTANEOUS_NEW_MSCLKID"),
  ]);
  const state = JSON.parse(sharedStore.get("pmp:attribution"));
  assert.deepEqual(Object.keys(state.lastPaid.clickIds), ["msclkid"]);
  assert.equal(state.lastPaid.clickIds.msclkid, "SIMULTANEOUS_NEW_MSCLKID");
  assert.equal(
    Array.from(sharedStore.keys()).filter((key) => key.startsWith("pmp:attribution:paid:")).length,
    2,
  );
});

test("a new paid click resolves a pending chain to the newest stable journal journey", async () => {
  const now = Date.UTC(2026, 8, 1);
  const sharedStore = new Map([
    ["pmp:attribution", JSON.stringify({
      schemaVersion: 3,
      journeyId: "stale-canonical-journey-123456",
      startedAt: now - 3_000,
      expiresAt: now + 90 * DAY,
      firstEntry: {},
      firstFree: {},
      lastPaid: {
        eventId: "event-old-123456",
        clickIds: { gclid: "STALE_CANONICAL_GCLID_123" },
        capturedAt: now - 3_000,
      },
    })],
    ["pmp:attribution:paid:event-new-123456", JSON.stringify({
      schemaVersion: 1,
      contextPending: false,
      journeyId: "newest-journal-journey-123456",
      startedAt: now - 2_000,
      firstEntry: { landingUrl: "https://puremajestypet.com/blogs/news/guide", capturedAt: now - 2_000 },
      firstFree: {
        landingUrl: "https://puremajestypet.com/blogs/news/guide",
        source: "google",
        medium: "organic",
        capturedAt: now - 2_000,
      },
      lastPaid: {
        eventId: "event-new-123456",
        clickIds: { gclid: "NEWEST_JOURNAL_GCLID_123" },
        capturedAt: now - 2_000,
      },
    })],
    ["pmp:attribution:paid:event-pending-123456", JSON.stringify({
      schemaVersion: 1,
      contextPending: true,
      journeyId: "stale-canonical-journey-123456",
      startedAt: now - 3_000,
      firstEntry: {},
      firstFree: {},
      lastPaid: {
        eventId: "event-pending-123456",
        clickIds: { msclkid: "PENDING_CHAIN_MSCLKID_123" },
        capturedAt: now - 1_000,
      },
    })],
  ]);
  const h = harness({ now, sharedStore });
  const state = await h.visit(
    "https://puremajestypet.com/?sccid=FOURTH_VISIT_SCCID_123456",
  );
  assert.equal(state.journeyId, "newest-journal-journey-123456");
  assert.equal(state.lastPaid.clickIds.sccid, "FOURTH_VISIT_SCCID_123456");
  assert.equal(state.firstFree.source, "google");
  assert.equal(state.firstFree.medium, "organic");
});

test("a paid click is journaled before localStorage key enumeration", async () => {
  const sharedStore = new Map();
  const operations = [];
  const sharedStorage = {
    async getItem(key) { operations.push(`get:${key}`); return sharedStore.get(key) || null; },
    async setItem(key, value) {
      operations.push(`set:${key}`);
      sharedStore.set(key, String(value));
    },
    async removeItem(key) { operations.push(`remove:${key}`); sharedStore.delete(key); },
    async length() { operations.push("length"); return sharedStore.size; },
    async key(index) { operations.push(`key:${index}`); return Array.from(sharedStore.keys())[index] || null; },
  };
  const h = harness({ sharedStore, sharedStorage });
  await h.visit("https://puremajestypet.com/?gclid=FAST_JOURNAL_GCLID_123456");
  const journalWrite = operations.findIndex((operation) => operation.startsWith("set:pmp:attribution:paid:"));
  const firstEnumeration = operations.indexOf("length");
  assert.ok(journalWrite >= 0);
  assert.ok(firstEnumeration >= 0);
  assert.ok(journalWrite < firstEnumeration);
});

test("paid journal pruning keeps the newest click and at most 64 active entries", async () => {
  const now = Date.UTC(2026, 8, 1);
  const sharedStore = new Map();
  for (let i = 0; i < 70; i += 1) {
    const eventId = `journal-event-${String(i).padStart(3, "0")}`;
    sharedStore.set(`pmp:attribution:paid:${eventId}`, JSON.stringify({
      schemaVersion: 1,
      journeyId: `journal-journey-${String(i).padStart(3, "0")}`,
      startedAt: now - i * 1_000,
      firstEntry: {},
      firstFree: {},
      lastPaid: {
        eventId,
        clickIds: { gclid: `JOURNAL_GCLID_${String(i).padStart(3, "0")}` },
        capturedAt: now - i * 1_000,
      },
    }));
  }
  const h = harness({ now, sharedStore });
  const state = await h.visit("https://puremajestypet.com/products/a");
  const journalKeys = Array.from(sharedStore.keys())
    .filter((key) => key.startsWith("pmp:attribution:paid:"));
  assert.equal(journalKeys.length, 64);
  assert.equal(state.lastPaid.clickIds.gclid, "JOURNAL_GCLID_000");
});
