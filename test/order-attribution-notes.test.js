import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyEntryChannel,
  createShopifyOrder,
  entryAttributionAttributes,
  orderAttributionAttributes,
} from "../api/stripe-webhook.js";

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

test("normalizes paid medium spaces and hyphens and recognizes every supported ad platform", () => {
  const cases = [
    ["google", "paid search", {}, "Google Ads (paid)", "google"],
    ["ig", "paid-social", {}, "Meta Ads (paid)", "meta"],
    ["fb", "paid social", {}, "Meta Ads (paid)", "meta"],
    [null, null, { dclid: "Display_Click_123456" }, "Google Ads (paid)", "google"],
    [null, null, { fbclid: "Meta_Click_123456" }, "Meta Ads (paid)", "meta"],
    [null, null, { msclkid: "0123456789abcdef0123456789abcdef" }, "Microsoft Ads (paid)", "microsoft"],
    [null, null, { ttclid: "TikTok_Click_123456" }, "TikTok Ads (paid)", "tiktok"],
    [null, null, { sccid: "Snap_Click_123456" }, "Snapchat Ads (paid)", "snapchat"],
  ];
  for (const [source, medium, attribution, label, platform] of cases) {
    const channel = classifyEntryChannel({ attribution, source, medium });
    assert.equal(channel.label, label);
    assert.equal(channel.platform, platform);
    assert.equal(channel.paid, true);
  }
});

test("treats fbclid as paid by contract while fbc alone remains only a matching cookie", () => {
  const channel = classifyEntryChannel({
    attribution: {
      fbclid: "OrganicMetaClick_123",
      fbc: "fb.1.1720000000000.OrganicMetaClick_123",
    },
    source: "instagram",
    medium: "organic social",
  });
  assert.equal(channel.paid, true);
  assert.equal(channel.label, "Meta Ads (paid)");

  const selected = orderAttributionAttributes({
    fbc: "fb.1.1720000000000.OrganicMetaClick_123",
    first_touch_landing: "https://puremajestypet.com/products/liquid-collagen-for-dogs",
    first_touch_source: "ig",
    first_touch_medium: "dm",
  });
  assert.equal(selected.basis, "first_free_click");
  assert.equal(selected.channel.label, "Instagram DM");
  assert.equal(selected.channel.paid, false);
});

test("uses the latest paid touch as primary and retains the earliest free touch", () => {
  const selected = orderAttributionAttributes({
    tracking_version: "pmp_v4",
    first_entry_landing: "https://puremajestypet.com/blogs/news/dog-yeast-infection-treatment",
    first_entry_referrer: "https://google.com/",
    first_entry_source: "google",
    first_entry_medium: "organic",
    first_entry_at: "2026-08-25T10:00:00Z",
    first_touch_landing: "https://puremajestypet.com/blogs/news/dog-yeast-infection-treatment",
    first_touch_referrer: "https://google.com/",
    first_touch_source: "google",
    first_touch_medium: "organic",
    first_touch_campaign: "yeast-guide",
    first_touch_at: "2026-08-25T10:00:00Z",
    last_touch_landing: "https://puremajestypet.com/products/dog-yeast-infection-treatment",
    last_touch_source: "facebook",
    last_touch_medium: "paid social",
    last_touch_campaign: "yeast-retargeting",
    last_touch_at: "2026-08-31T13:15:00Z",
  });

  assert.equal(selected.basis, "last_paid_click");
  assert.equal(selected.channel.label, "Meta Ads (paid)");
  assert.equal(selected.attributes.attribution_source, "facebook");
  assert.equal(selected.attributes.first_free_source, "google");
  assert.equal(selected.attributes.last_paid_source, "facebook");
  assert.equal(selected.attributes.entry_page, "https://puremajestypet.com/blogs/news/dog-yeast-infection-treatment");
  assert.equal(selected.attributes.entry_basis, "first_entry");
});

test("falls back to the earliest free touch when no paid touch exists", () => {
  const selected = orderAttributionAttributes({
    landing_page: "https://puremajestypet.com/products/liquid-collagen-for-dogs",
    first_touch_landing: "https://puremajestypet.com/blogs/news/best-collagen-for-dogs",
    first_touch_referrer: "https://www.google.ca/",
    first_touch_source: "google",
    first_touch_medium: "organic search",
    first_touch_at: "2026-08-20T10:00:00Z",
  });
  assert.equal(selected.basis, "first_free_click");
  assert.equal(selected.channel.label, "Google organic search / SEO (inferred)");
  assert.equal(selected.attributes.attribution_landing, "https://puremajestypet.com/blogs/news/best-collagen-for-dogs");
});

test("does not mislabel a direct first entry as a first free click", () => {
  const selected = orderAttributionAttributes({
    first_entry_landing: "https://puremajestypet.com/",
    first_entry_source: "(direct)",
    first_entry_medium: "(none)",
    first_touch_landing: "https://puremajestypet.com/",
    first_touch_source: "direct",
    first_touch_medium: "none",
    landing_page: "https://puremajestypet.com/products/liquid-collagen-for-dogs",
  });
  assert.equal(selected.basis, "current_session");
  assert.equal(selected.channel.label, "Direct / unknown");
  assert.equal(selected.attributes.first_free_landing, undefined);
});

test("uses an identifiable first entry as the first-free report fallback", () => {
  const selected = orderAttributionAttributes({
    first_entry_landing: "https://puremajestypet.com/products/liquid-collagen-for-dogs",
    first_entry_source: "instagram",
    first_entry_medium: "dm",
  });
  assert.equal(selected.basis, "first_free_click");
  assert.equal(selected.attributes.first_free_source, "instagram");
  assert.equal(selected.attributes.first_free_medium, "dm");
});

test("classifies an explicit Google paid UTM without requiring gclid", () => {
  const selected = orderAttributionAttributes({
    landing_page: "https://puremajestypet.com/products/liquid-collagen-for-dogs",
    utm_source: "google",
    utm_medium: "paid search",
    utm_campaign: "collagen-shopping",
  });
  assert.equal(selected.basis, "last_paid_click");
  assert.equal(selected.channel.label, "Google Ads (paid)");
  assert.equal(selected.attributes.last_paid_source, "google");
  assert.equal(selected.attributes.last_paid_medium, "paid search");
});

async function captureShopifyOrder(options) {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (_url, request) => {
    captured = JSON.parse(request.body).order;
    return {
      ok: true,
      status: 201,
      async json() { return { order: { id: 12345, order_number: 1900, total_price: "10.00" } }; },
    };
  };
  try {
    await createShopifyOrder({
      items: [{ variant_id: 123, quantity: 1, price_cents: 1000 }],
      currency: "usd",
      email: "buyer@example.com",
      phone: null,
      shipping: null,
      billing: null,
      note: null,
      sessionId: "cs_test_attribution_123",
      discount: null,
      chargedCents: 1000,
      ...options,
    });
    return captured;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function attributesMap(order) {
  return Object.fromEntries((order.note_attributes || []).map(({ name, value }) => [name, value]));
}

test("writes a human acquisition summary, report fields and attribution tags to the Shopify order", async () => {
  const order = await captureShopifyOrder({
    attribution: {
      tracking_version: "pmp_v4",
      journey_id: "journey-order-123456",
      attribution_model: "last_paid_else_first_free_v1",
      first_entry_landing: "https://puremajestypet.com/blogs/news/dog-yeast-infection-treatment",
      first_entry_referrer: "https://www.google.com/",
      first_entry_source: "google",
      first_entry_medium: "organic",
      first_entry_at: "2026-08-20T10:00:00Z",
      first_touch_landing: "https://puremajestypet.com/blogs/news/dog-yeast-infection-treatment",
      first_touch_referrer: "https://www.google.com/",
      first_touch_source: "google",
      first_touch_medium: "organic",
      first_touch_campaign: "yeast-guide",
      first_touch_at: "2026-08-20T10:00:00Z",
      last_touch_landing: "https://puremajestypet.com/products/dog-yeast-infection-treatment",
      last_touch_source: "instagram",
      last_touch_medium: "paid-social",
      last_touch_campaign: "yeast-retargeting",
      last_touch_at: "2026-08-31T13:15:00Z",
      fbc: "fb.1.1720000000000.MetaClick_ABC-123",
    },
  });
  const attrs = attributesMap(order);

  assert.match(order.note, /Acquisition: Meta Ads \(paid\) \(last paid click\)\./);
  assert.match(order.note, /Page: https:\/\/puremajestypet\.com\/products\/dog-yeast-infection-treatment\./);
  assert.match(order.note, /First entry: https:\/\/puremajestypet\.com\/blogs\/news\/dog-yeast-infection-treatment\./);
  assert.equal(attrs.attribution_model, "last_paid_else_first_free_v1");
  assert.equal(attrs.pmp_journey_id, "journey-order-123456");
  assert.equal(attrs.attribution_basis, "last_paid_click");
  assert.equal(attrs.attribution_channel, "Meta Ads (paid)");
  assert.equal(attrs.first_entry_source, "google");
  assert.equal(attrs.entry_page_type, "article");
  assert.equal(attrs.first_touch_source, "google");
  assert.equal(attrs.first_free_source, "google");
  assert.equal(attrs.last_touch_source, "instagram");
  assert.equal(attrs.last_paid_source, "instagram");
  assert.equal(attrs.meta_ads_paid, "yes");
  assert.equal(attrs.meta_fbc, "fb.1.1720000000000.MetaClick_ABC-123");
  assert.equal(attrs.meta_ads_fbc, "fb.1.1720000000000.MetaClick_ABC-123");
  assert.match(order.tags, /attribution_last_paid/);
  assert.match(order.tags, /meta_ads_paid/);
  assert.doesNotMatch(order.tags, /seo_organic/);
});

test("tags free Shopping, SEO and every paid click platform for Shopify reports", async () => {
  const explicitGooglePaid = await captureShopifyOrder({
    sessionId: "cs_test_google_utm_123",
    attribution: {
      landing_page: "https://puremajestypet.com/products/liquid-collagen-for-dogs",
      utm_source: "google",
      utm_medium: "paid search",
      utm_campaign: "collagen-shopping",
    },
  });
  assert.equal(attributesMap(explicitGooglePaid).google_ads_paid, "yes");
  assert.equal(attributesMap(explicitGooglePaid).google_ads_gclid, undefined);
  assert.match(explicitGooglePaid.tags, /google_ads_paid/);

  const freeListing = await captureShopifyOrder({
    sessionId: "cs_test_free_listing_123",
    attribution: {
      first_touch_landing: "https://puremajestypet.com/products/liquid-collagen-for-dogs",
      first_touch_referrer: "https://www.google.com/",
      first_touch_source: "google",
      first_touch_medium: "product_sync",
      first_touch_campaign: "sag_organic",
    },
  });
  assert.match(freeListing.tags, /attribution_first_free/);
  assert.match(freeListing.tags, /google_free_listing/);
  assert.doesNotMatch(freeListing.tags, /seo_organic/);

  const seo = await captureShopifyOrder({
    sessionId: "cs_test_seo_123",
    attribution: {
      first_touch_landing: "https://puremajestypet.com/blogs/news/best-collagen-for-dogs",
      first_touch_referrer: "https://www.google.ca/",
      first_touch_source: "google",
      first_touch_medium: "organic",
    },
  });
  assert.match(seo.tags, /attribution_first_free/);
  assert.match(seo.tags, /seo_organic/);

  const microsoft = await captureShopifyOrder({
    sessionId: "cs_test_microsoft_123",
    attribution: { msclkid: "0123456789abcdef0123456789abcdef" },
  });
  assert.equal(attributesMap(microsoft).microsoft_ads_paid, "yes");
  assert.equal(attributesMap(microsoft).microsoft_ads_msclkid, "0123456789abcdef0123456789abcdef");
  assert.match(microsoft.tags, /microsoft_ads_paid/);

  const tiktok = await captureShopifyOrder({
    sessionId: "cs_test_tiktok_123",
    attribution: { ttclid: "TikTok_Click_123456" },
  });
  assert.equal(attributesMap(tiktok).tiktok_ads_paid, "yes");
  assert.equal(attributesMap(tiktok).tiktok_ads_ttclid, "TikTok_Click_123456");
  assert.match(tiktok.tags, /tiktok_ads_paid/);

  const googleDisplay = await captureShopifyOrder({
    sessionId: "cs_test_google_display_123",
    attribution: { dclid: "Display_Click_123456" },
  });
  assert.equal(attributesMap(googleDisplay).google_ads_paid, "yes");
  assert.equal(attributesMap(googleDisplay).google_ads_dclid, "Display_Click_123456");
  assert.match(googleDisplay.tags, /google_ads_paid/);

  const snapchat = await captureShopifyOrder({
    sessionId: "cs_test_snapchat_123",
    attribution: { sccid: "Snap_Click_123456" },
  });
  assert.equal(attributesMap(snapchat).snapchat_ads_paid, "yes");
  assert.equal(attributesMap(snapchat).snapchat_ads_sccid, "Snap_Click_123456");
  assert.match(snapchat.tags, /snapchat_ads_paid/);

  const metaRedirect = await captureShopifyOrder({
    sessionId: "cs_test_meta_redirect_123",
    attribution: { fbclid: "Meta_Click_123456" },
  });
  assert.equal(attributesMap(metaRedirect).meta_ads_paid, "yes");
  assert.equal(attributesMap(metaRedirect).meta_ads_fbclid, "Meta_Click_123456");
  assert.match(metaRedirect.tags, /meta_ads_paid/);
});

test("removes invalid click IDs and PII from attribution before creating the Shopify order", async () => {
  const order = await captureShopifyOrder({
    sessionId: "cs_test_sanitization_123",
    attribution: {
      first_entry_landing: "https://puremajestypet.com/customers/leaked@example.com?email=leaked@example.com",
      first_entry_source: "leaked@example.com",
      first_entry_medium: "organic",
      first_touch_landing: "https://puremajestypet.com/pages/leaked%40example.com",
      first_touch_source: "leaked@example.com",
      first_touch_medium: "dm",
      gclid: "leaked@example.com",
      msclkid: "spaces are invalid",
      ttclid: "javascript:alert(1)",
      fbclid: "bad/value",
      fbc: "fb.1.not-a-time.bad/value",
    },
  });
  const attrs = attributesMap(order);
  const serialized = JSON.stringify({ note: order.note, note_attributes: order.note_attributes, tags: order.tags });

  assert.equal(attrs.first_entry_landing, "https://puremajestypet.com/");
  assert.equal(attrs.first_touch_landing, "https://puremajestypet.com/");
  assert.equal(attrs.first_entry_source, undefined);
  assert.equal(attrs.google_ads_gclid, undefined);
  assert.equal(attrs.microsoft_ads_msclkid, undefined);
  assert.equal(attrs.tiktok_ads_ttclid, undefined);
  assert.equal(attrs.meta_fbclid, undefined);
  assert.equal(attrs.meta_fbc, undefined);
  assert.doesNotMatch(serialized, /leaked@example\.com/);
  assert.doesNotMatch(order.tags, /_ads_paid/);
});
