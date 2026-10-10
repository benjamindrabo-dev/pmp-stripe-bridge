import assert from "node:assert/strict";
import test from "node:test";
import { spanishMarketReturnBase } from "../lib/create-checkout-base.js";

const base = "https://www.puremajestypet.com/pages/thank-you";
test("Spain selector works with the legacy unlocalized cart URL", () => {
  assert.equal(spanishMarketReturnBase(base, "https://www.puremajestypet.com/cart", "ES", "es"), "https://www.puremajestypet.com/es-es/pages/thank-you");
  assert.equal(spanishMarketReturnBase(base, null, "ES", "es"), "https://www.puremajestypet.com/es-es/pages/thank-you");
  assert.equal(spanishMarketReturnBase(base, null, "MX", "es"), base);
  assert.equal(spanishMarketReturnBase(base, null, "ES", "en"), base);
});
test("Spanish cart keeps its locale without forwarding cart query values", () => {
  assert.equal(spanishMarketReturnBase(base, "https://puremajestypet.com/es-es/cart?key=private"), "https://www.puremajestypet.com/es-es/pages/thank-you");
});
test("already localized return is idempotent and configured query is preserved", () => {
  const url = "https://www.puremajestypet.com/es-es/pages/thank-you?source=checkout";
  assert.equal(spanishMarketReturnBase(url, "https://www.puremajestypet.com/es-es/cart"), url);
});
test("replaces an old market prefix without duplication", () => {
  assert.equal(spanishMarketReturnBase("https://www.puremajestypet.com/fr-fr/pages/thank-you", "https://www.puremajestypet.com/es-es/cart"), "https://www.puremajestypet.com/es-es/pages/thank-you");
});
test("other markets, invalid input and foreign hosts do not change checkout", () => {
  for (const cart of [null, "invalid", "https://evil.example/es-es/cart", "http://www.puremajestypet.com/es-es/cart", "https://www.puremajestypet.com/de-de/cart", "https://www.puremajestypet.com/cart", "https://www.puremajestypet.com/es-es/cartography"]) {
    assert.equal(spanishMarketReturnBase(base, cart), base);
  }
});
test("unrelated configured destinations remain unchanged", () => {
  const url = "https://www.puremajestypet.com/checkout-complete";
  assert.equal(spanishMarketReturnBase(url, "https://www.puremajestypet.com/es-es/cart"), url);
});
