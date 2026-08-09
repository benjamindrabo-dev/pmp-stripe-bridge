// POST /api/create-checkout
// Called from the Shopify "Buy Now" button (embedded Stripe Checkout).
// Body: { items: [{ variant_id, title, quantity, price_cents, image }], currency, note? }
// `currency` comes from the Shopify cart (cart.currency) so the customer is
// charged in the currency they see on the storefront (per Shopify Markets).
// Returns { clientSecret } — the storefront mounts Stripe's EMBEDDED Checkout
// with it (ui_mode=embedded), so the payment form renders on our own site
// with no redirect. After payment, Stripe redirects to return_url; the webhook
// (stripe-webhook.js) creates the paid Shopify order.

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.STORE_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Upstash Redis REST — now checks the response so a bad token fails loudly.
async function kvSet(key, value) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}?EX=2592000`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
        body: JSON.stringify(value),
      });
      if (r.ok) return;
      lastError = new Error("Upstash set failed: " + r.status + " " + (await r.text()));
    } catch (e) {
      lastError = e;
    }
    // Short retries cover transient Redis/network failures without keeping the
    // shopper waiting for several seconds. We never continue without the cart:
    // the webhook needs it to create the matching Shopify order after payment.
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 120));
  }
  throw lastError || new Error("Upstash set failed");
}

async function createStripeSession(params) {
  const post = async (body) => {
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = { error: { message: "Invalid response from Stripe" } };
    }
    return { response, data };
  };

  return post(params);
}

// ---- Server-side price validation (FAIL-CLOSED) ----
// The browser sends price_cents; any skipped check is an exploit path, so:
//  - currencies outside the store's whitelist are REJECTED (this also excludes
//    zero-decimal currencies like JPY, which the cents-based pipeline can't
//    handle correctly);
//  - unknown variants are REJECTED;
//  - a market/currency mismatch is REJECTED;
//  - the ONLY fail-open path is a genuine Shopify API outage, which a shopper
//    cannot trigger from the browser (inputs are numeric-cast, never echoed).
// The floor is tiered by unit count to match the bundle app's real discounts
// (Buy 2 −20% → 0.80, Buy 3 get 1 free → 0.75): single units get no discount.
const MARKET_COUNTRY = { USD: "US", CAD: "CA", GBP: "GB", AUD: "AU", EUR: "DE", NZD: "NZ" };
const ALLOWED_CURRENCIES = String(process.env.ALLOWED_CURRENCIES || "USD CAD GBP AUD EUR NZD").trim().split(/\s+/);

function reject(msg) { const e = new Error(msg); e.status = 400; return e; }

function safeText(value, max = 500) {
  if (typeof value !== "string") return null;
  const clean = value.trim().replace(/[\u0000-\u001F\u007F]/g, "");
  return clean ? clean.slice(0, max) : null;
}

function safePageUrl(value) {
  const clean = safeText(value, 800);
  if (!clean) return null;
  try {
    const u = new URL(clean);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.username = "";
    u.password = "";
    u.hash = "";
    u.search = "";
    return (u.origin + u.pathname).slice(0, 500);
  } catch {
    return null;
  }
}

function minRatioForUnits(units) {
  if (units >= 4) return 0.73; // Buy 3 get 1 free = 0.75 legit
  if (units >= 2) return 0.78; // Buy 2 −20% = 0.80 legit
  return 0.97;                 // single unit: no automatic discount exists
}

// Native theme bundles. Prices are never trusted from the browser: Shopify's
// contextual catalog price is the source of truth for every market/currency.
// The browser only identifies which of the three published offers was selected.
const NATIVE_BUNDLE_VARIANT_IDS = new Set([
  43676450193482, 43433440903242, 43449461669962, 43449177636938,
  43433415802954, 43668777631818, 43675418656842, 43449159516234,
  43405787168842, 43449778765898, 43349565112394, 43660914163786,
  43660092473418, 43433439887434, 43449777160266,
]);

function canonicalNativeBundleLines(item, catalogCents) {
  const variantId = Number(item.variant_id);
  if (!NATIVE_BUNDLE_VARIANT_IDS.has(variantId)) return null;

  const quantity = Number(item.quantity);
  const selectedBundle = Number(item.bundle_quantity);
  if (![1, 3, 5].includes(selectedBundle) || selectedBundle !== quantity) return null;

  const base = { ...item, variant_id: variantId };
  delete base.bundle_quantity;

  if (quantity === 1) {
    return [{
      ...base,
      quantity: 1,
      price_cents: catalogCents,
      title: String(item.title || "Pure Majesty product"),
    }];
  }

  const paidQuantity = quantity === 3 ? 2 : 3;
  const freeQuantity = quantity - paidQuantity;
  const offer = quantity === 3 ? "Buy 2, get 1 free" : "Buy 3, get 2 free";
  return [
    {
      ...base,
      quantity: paidQuantity,
      price_cents: catalogCents,
      title: String(item.title || "Pure Majesty product") + " — " + offer,
    },
    {
      ...base,
      quantity: freeQuantity,
      price_cents: 0,
      title: String(item.title || "Pure Majesty product") + " — free units",
    },
  ];
}

async function assertPricesLegit(items, CUR) {
  const cur = CUR.toUpperCase();
  if (!ALLOWED_CURRENCIES.includes(cur)) throw reject("Unsupported currency");
  if (items.length > 50) throw reject("Too many items");
  for (const it of items) {
    const qn = Number(it.quantity);
    if (!Number.isInteger(qn) || qn < 1 || qn > 50) throw reject("Invalid quantity");
    const pc = Number(it.price_cents);
    if (!Number.isFinite(pc) || pc < 0) throw reject("Invalid price");
  }

  const country = MARKET_COUNTRY[cur];
  const ids = items.map((it) => `gid://shopify/ProductVariant/${Number(it.variant_id)}`);
  const q = `query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant { id contextualPricing(context:{country:${country}}){ price { amount currencyCode } } } } }`;
  let j = null;
  try {
    const r = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2026-01/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, variables: { ids } }),
    });
    j = await r.json();
  } catch (e) {
    console.error("price-check FAIL-CLOSED (Shopify unreachable):", String(e && e.message || e));
    throw new Error("Price service unavailable");
  }

  const nodes = j && j.data && j.data.nodes;
  if (!Array.isArray(nodes)) {
    console.error("price-check FAIL-CLOSED (bad Shopify response):", JSON.stringify(j || {}).slice(0, 200));
    throw new Error("Price service unavailable");
  }

  const priceById = {};
  for (const n of nodes) {
    if (n && n.contextualPricing && n.contextualPricing.price) {
      if (String(n.contextualPricing.price.currencyCode).toUpperCase() !== cur) {
        throw reject("Currency not available for this market");
      }
      priceById[n.id] = Number(n.contextualPricing.price.amount);
    }
  }

  const normalized = [];
  let catalog = 0;
  let given = 0;
  let validatedUnits = 0;

  for (const it of items) {
    const variantId = Number(it.variant_id);
    const price = priceById[`gid://shopify/ProductVariant/${variantId}`];
    if (price == null) throw reject("Unknown product variant");

    const quantity = Number(it.quantity);
    const catalogCents = Math.round(price * 100);
    const bundleLines = canonicalNativeBundleLines(it, catalogCents);
    if (bundleLines) {
      normalized.push(...bundleLines);
      continue;
    }

    normalized.push({ ...it, variant_id: variantId, quantity });
    catalog += price * quantity;
    given += (Number(it.price_cents) / 100) * quantity;
    validatedUnits += quantity;
  }

  if (validatedUnits > 0) {
    const ratio = Number(process.env.MIN_TOTAL_RATIO || minRatioForUnits(validatedUnits));
    if (given < catalog * ratio - 0.01 || given > catalog * 1.02 + 0.01) {
      console.error(`price-check REJECTED: given=${given.toFixed(2)} catalog=${catalog.toFixed(2)} ${cur} units=${validatedUnits}`);
      throw reject("Price validation failed");
    }
  }

  return normalized;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const {
      items: requestedItems, note, currency, fbp, fbc, external_id,
      landing_url, referrer,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      gclid, gbraid, wbraid, ttclid, msclkid,
    } = req.body || {};
    if (!Array.isArray(requestedItems) || requestedItems.length === 0) {
      return res.status(400).json({ error: "Empty cart" });
    }
    // Currency follows the Shopify cart; env CURRENCY is only a fallback.
    const CUR = String(currency || process.env.CURRENCY || "usd").toLowerCase();

    // Never trust browser-sent prices — verify against Shopify first.
    const items = await assertPricesLegit(requestedItems, CUR);

    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("ui_mode", "embedded"); // classic Embedded Checkout (works on all API versions; "embedded_page" needs API 2026-03-25.dahlia)
    params.append("locale", "en"); // force English UI (avoid region-based fr-CA)
    // Do not send payment_method_types. For Checkout Sessions, omission lets
    // Stripe select the methods enabled in the Dashboard and eligible for this
    // shopper/currency. We deliberately do not send automatic_payment_methods:
    // older Checkout API versions can reject that PaymentIntent-style parameter.
    // Embedded uses return_url only (no success_url/cancel_url). Stripe sends the
    // shopper here after payment; the webhook creates the Shopify order.
    const returnBase = process.env.SUCCESS_URL || "https://example.com/thank-you";
    params.append(
      "return_url",
      returnBase + (returnBase.includes("?") ? "&" : "?") + "session_id={CHECKOUT_SESSION_ID}"
    );
    params.append("billing_address_collection", "auto");
    // Promo codes. Shopify's own discount CODES are unreachable now (they only
    // apply in the native checkout we bypass), so codes are created in Stripe:
    // Dashboard → Product catalogue → Coupons → Promotion codes. Stripe enforces
    // the rules itself (percent/amount, expiry, max redemptions, minimum order,
    // first-time customer), and the webhook writes the discount onto the Shopify
    // order so the books match. Shopify AUTOMATIC discounts (Bundle & Save) are
    // unaffected — they are already baked into the line prices we send.
    params.append("allow_promotion_codes", "true");

    // Attribution is stored on the Stripe Session as operational metadata, so
    // every payment attempt can be reconciled in Stripe even if the browser
    // closes before the thank-you page. Values are sanitized and size-limited.
    const attribution = {
      tracking_version: "pmp_v2",
      // Stable pseudonymous person key: several Checkout Sessions created by
      // the same browser can be counted as one person without card data/PII.
      person_id: safeText(external_id, 64),
      browser_id: safeText(external_id, 64),
      fbp: safeText(fbp, 255),
      fbc: safeText(fbc, 255),
      landing_page: safePageUrl(landing_url),
      referrer: safePageUrl(referrer),
      utm_source: safeText(utm_source, 100),
      utm_medium: safeText(utm_medium, 100),
      utm_campaign: safeText(utm_campaign, 200),
      utm_content: safeText(utm_content, 200),
      utm_term: safeText(utm_term, 200),
      gclid: safeText(gclid, 255),
      gbraid: safeText(gbraid, 255),
      wbraid: safeText(wbraid, 255),
      ttclid: safeText(ttclid, 255),
      msclkid: safeText(msclkid, 255),
    };
    Object.entries(attribution).forEach(([key, value]) => {
      if (value) params.append(`metadata[${key}]`, value);
    });
    if (attribution.browser_id) params.append("client_reference_id", attribution.browser_id);
    // Worldwide shipping: every country Stripe supports for shipping addresses.
    // (The 4 sanctioned countries CU/IR/KP/SY are omitted, plus RU.) To restrict
    // where you sell, trim this list (e.g. keep only "CA US GB ...").
    const SHIP_COUNTRIES = ("AC AD AE AF AG AI AL AM AO AQ AR AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CD CF CG CH CI CK CL CM CN CO CR CV CW CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IS IT JE JM JO JP KE KG KH KI KM KN KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MK ML MM MN MO MQ MR MS MT MU MV MW MX MY MZ NA NC NE NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PY QA RE RO RS RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SZ TA TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VN VU WF WS XK YE YT ZA ZM ZW").split(" ");
    SHIP_COUNTRIES.forEach((c, i) => params.append(`shipping_address_collection[allowed_countries][${i}]`, c));

    items.forEach((it, i) => {
      params.append(`line_items[${i}][price_data][currency]`, CUR);
      params.append(`line_items[${i}][price_data][product_data][name]`, String(it.title || "Item").slice(0, 250));
      // Recovery data: if Redis is unavailable much later when a delayed payment
      // settles, the webhook can rebuild the Shopify line from Stripe itself.
      params.append(`line_items[${i}][price_data][product_data][metadata][shopify_variant_id]`, String(Number(it.variant_id)));
      params.append(`line_items[${i}][price_data][unit_amount]`, String(Number(it.price_cents)));
      params.append(`line_items[${i}][quantity]`, String(Number(it.quantity) || 1));
      // Product image (shown on the Stripe Checkout page, like Shopify does).
      if (it.image) {
        let img = String(it.image);
        if (img.indexOf("//") === 0) img = "https:" + img;
        params.append(`line_items[${i}][price_data][product_data][images][0]`, img);
      }
    });

    const shipping = Number(process.env.FLAT_SHIPPING_CENTS || 0);
    if (shipping > 0) {
      const i = items.length;
      params.append(`line_items[${i}][price_data][currency]`, CUR);
      params.append(`line_items[${i}][price_data][product_data][name]`, "Shipping");
      params.append(`line_items[${i}][price_data][unit_amount]`, String(shipping));
      params.append(`line_items[${i}][quantity]`, "1");
    }

    const stripeResult = await createStripeSession(params);
    const r = stripeResult.response;
    const data = stripeResult.data;
    if (!r.ok) {
      console.error("Stripe error", data);
      return res.status(502).json({ error: "Stripe create session failed", detail: data.error });
    }

    // Store the cart (incl. currency + presentment prices) so the webhook can
    // rebuild the Shopify order in the same currency and amount.
    await kvSet(`sess:${data.id}`, {
      items: items.map((it) => ({ variant_id: it.variant_id, quantity: it.quantity, price_cents: Number(it.price_cents) })),
      currency: CUR,
      note: note || "",
      // Ad-attribution signals captured at checkout time; the webhook forwards
      // them to Meta's Conversions API for accurate match quality.
      fbp: attribution.fbp,
      fbc: attribution.fbc,
      // Same stable browser id the pixel uses for Advanced Matching, so the
      // server event and the browser event describe the SAME person.
      external_id: attribution.browser_id,
      landing_url: attribution.landing_page,
      referrer: attribution.referrer,
      utm_source: attribution.utm_source,
      utm_medium: attribution.utm_medium,
      utm_campaign: attribution.utm_campaign,
      utm_content: attribution.utm_content,
      utm_term: attribution.utm_term,
      gclid: attribution.gclid,
      gbraid: attribution.gbraid,
      wbraid: attribution.wbraid,
      ttclid: attribution.ttclid,
      msclkid: attribution.msclkid,
      ua: req.headers["user-agent"] || null,
      ip: String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || null,
    });

    return res.status(200).json({ clientSecret: data.client_secret, sessionId: data.id });
  } catch (e) {
    console.error(e);
    if (e && e.status === 400) return res.status(400).json({ error: e.message });
    return res.status(500).json({ error: "Server error", detail: String(e.message || e) });
  }
}
