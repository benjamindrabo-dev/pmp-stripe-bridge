import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_US_CAD_OVERRIDE_UNTIL,
  convertLinePricesByCatalog,
  normalizeCountry,
  shouldApplyUsCadOverride,
} from "../lib/us-cad-override.js";

const BEFORE_DEADLINE = Date.parse("2026-09-03T00:29:59.999Z");
const AT_DEADLINE = Date.parse(DEFAULT_US_CAD_OVERRIDE_UNTIL);

test("normalizes a two-letter country and rejects invalid values", () => {
  assert.equal(normalizeCountry(" us "), "US");
  assert.equal(normalizeCountry("USA"), null);
  assert.equal(normalizeCountry(null), null);
});

test("applies only to US checkouts displayed in USD before the deadline", () => {
  assert.equal(shouldApplyUsCadOverride({
    displayCurrency: "usd",
    checkoutCountry: "US",
    now: BEFORE_DEADLINE,
  }), true);

  assert.equal(shouldApplyUsCadOverride({
    displayCurrency: "USD",
    checkoutCountry: null,
    now: BEFORE_DEADLINE,
  }), false);

  assert.equal(shouldApplyUsCadOverride({
    displayCurrency: "USD",
    checkoutCountry: "CA",
    now: BEFORE_DEADLINE,
  }), false);

  assert.equal(shouldApplyUsCadOverride({
    displayCurrency: "CAD",
    checkoutCountry: "US",
    now: BEFORE_DEADLINE,
  }), false);

  assert.equal(shouldApplyUsCadOverride({
    displayCurrency: "USD",
    checkoutCountry: "US",
    now: AT_DEADLINE,
  }), false);
});

test("uses Shopify market-price ratios and preserves free gift lines", () => {
  const gid = "gid://shopify/ProductVariant/43433440903242";
  const items = [
    { variant_id: 43433440903242, quantity: 1, price_cents: 3199 },
    { variant_id: 43433440903242, quantity: 1, price_cents: 2559 },
    { variant_id: 43433440903242, quantity: 1, price_cents: 0 },
  ];

  const result = convertLinePricesByCatalog({
    items,
    sourcePriceById: { [gid]: 31.99 },
    targetPriceById: { [gid]: 45 },
  });

  assert.deepEqual(result.map((item) => item.price_cents), [4500, 3600, 0]);
});

test("fails closed when a CAD catalog price is unavailable", () => {
  assert.throws(() => convertLinePricesByCatalog({
    items: [{ variant_id: 43433440903242, quantity: 1, price_cents: 3199 }],
    sourcePriceById: { "gid://shopify/ProductVariant/43433440903242": 31.99 },
    targetPriceById: {},
  }), /Currency conversion price unavailable/);
});
