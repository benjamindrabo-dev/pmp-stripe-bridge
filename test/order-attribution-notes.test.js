import assert from "node:assert/strict";
import test from "node:test";

import { entryAttributionAttributes } from "../api/stripe-webhook.js";

test("surfaces a Google free product listing without labelling it as SEO", () => {
  assert.deepEqual(entryAttributionAttributes({
    landing_page: "https://www.puremajestypet.com/products/liquid-collagen-for-dogs",
    referrer: "https://www.google.com/",
    utm_source: "google",
    utm_medium: "product_sync",
    utm_campaign: "sag_organic",
    utm_content: "sag_organic",
  }), {
    entry_page: "https://www.puremajestypet.com/products/liquid-collagen-for-dogs",
    entry_basis: "session_landing",
    entry_page_type: "product",
    entry_page_handle: "liquid-collagen-for-dogs",
    entry_referrer: "https://www.google.com/",
    entry_channel: "Google free listing (inferred)",
    entry_source: "google",
    entry_medium: "product_sync",
    entry_campaign: "sag_organic",
    seo_organic: null,
  });
});

test("marks an untagged search-engine visit as inferred organic SEO", () => {
  assert.deepEqual(entryAttributionAttributes({
    landing_page: "https://www.puremajestypet.com/blogs/news/dog-yeast-infection-treatment",
    referrer: "https://www.google.ca/",
  }), {
    entry_page: "https://www.puremajestypet.com/blogs/news/dog-yeast-infection-treatment",
    entry_basis: "session_landing",
    entry_page_type: "article",
    entry_page_handle: "dog-yeast-infection-treatment",
    entry_referrer: "https://www.google.ca/",
    entry_channel: "Google organic search / SEO (inferred)",
    entry_source: null,
    entry_medium: null,
    entry_campaign: null,
    seo_organic: "yes (inferred)",
  });
});

test("paid click IDs take precedence over organic-looking browser signals", () => {
  const attributes = entryAttributionAttributes({
    landing_page: "https://www.puremajestypet.com/products/dog-yeast-infection-treatment",
    referrer: "https://www.google.com/",
    utm_source: "google",
    utm_medium: "organic",
    gclid: "paid-click-id",
  });

  assert.equal(attributes.entry_page, "https://www.puremajestypet.com/products/dog-yeast-infection-treatment");
  assert.equal(attributes.entry_channel, "Google Ads (paid)");
  assert.equal(attributes.seo_organic, null);
});

test("keeps a recorded first-touch SEO entry when a later touch has a paid click ID", () => {
  const attributes = entryAttributionAttributes({
    first_touch_landing: "https://www.puremajestypet.com/blogs/news/dog-yeast-infection-treatment",
    first_touch_referrer: "https://www.google.com/",
    first_touch_source: "google",
    first_touch_medium: "organic",
    landing_page: "https://www.puremajestypet.com/products/dog-yeast-infection-treatment",
    gclid: "later-paid-click-id",
  });

  assert.equal(attributes.entry_page, "https://www.puremajestypet.com/blogs/news/dog-yeast-infection-treatment");
  assert.equal(attributes.entry_basis, "first_touch");
  assert.equal(attributes.entry_page_type, "article");
  assert.equal(attributes.entry_page_handle, "dog-yeast-infection-treatment");
  assert.equal(attributes.entry_channel, "Google organic search / SEO (inferred)");
  assert.equal(attributes.seo_organic, "yes (inferred)");
});

test("omits entry attributes when no entry signal is available", () => {
  assert.deepEqual(entryAttributionAttributes({ tracking_version: "pmp_v3" }), {});
});
