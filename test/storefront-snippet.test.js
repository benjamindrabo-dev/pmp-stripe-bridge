import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const snippet = await readFile(
  new URL("../shopify-snippet-pay-with-stripe.liquid", import.meta.url),
  "utf8",
);

test("tracks begin_checkout only after Embedded Checkout mounts", () => {
  const mount = snippet.indexOf("embeddedCheckout.mount(\"#pmp-stripe-checkout\")");
  const beginCheckout = snippet.indexOf("window.PMPCheckoutEvents.beginCheckout(checkoutResponse)");

  assert.notEqual(mount, -1);
  assert.notEqual(beginCheckout, -1);
  assert.ok(mount < beginCheckout);
});

test("routes create-session and mount failures through checkout_error", () => {
  assert.match(snippet, /reportError\(checkoutResponse \? "mount_checkout" : "create_checkout", error\)/);
  assert.match(snippet, /window\.PMPCheckoutEvents\.checkoutError/);
});
