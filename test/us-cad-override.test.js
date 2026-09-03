import assert from "node:assert/strict";
import test from "node:test";

import {
  convertLinePricesByCatalog,
  normalizeCountry,
  shouldApplyUsCadOverride,
} from "../lib/us-cad-override.js";

test("normalizes a two-letter country and rejects invalid values", () => {
  assert.equal(normalizeCountry(" us "), "US");
  assert.equal(normalizeCountry("USA"), null);
  assert.equal(normalizeCountry(null), null);
});

test("remains active for US checkouts displayed in USD until manually disabled", () => {
  assert.equal(shouldApplyUsCadOverride({
    displayCurrency: "usd",
    checkoutCountry: "US",
    now: Date.parse("2099-01-01T00:00:00.000Z"),
  }), true);

  assert.equal(shouldApplyUsCadOverride({
    displayCurrency: "USD",
    checkoutCountry: null,
  }), false);

  assert.equal(shouldApplyUsCadOverride({
    displayCurrency: "USD",
    checkoutCountry: "CA",
  }), false);

  assert.equal(shouldApplyUsCadOverride({
    displayCurrency: "CAD",
    checkoutCountry: "US",
  }), false);
});

test("cannot expire automatically from legacy deadline inputs", () => {
  assert.equal(shouldApplyUsCadOverride({
    displayCurrency: "USD",
    checkoutCountry: "US",
    now: Date.parse("2099-01-01T00:00:00.000Z"),
    until: "2000-01-01T00:00:00.000Z",
  }), true);
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
