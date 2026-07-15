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
  const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}?EX=86400`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error("Upstash set failed: " + r.status + " " + (await r.text()));
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { items, note, currency } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Empty cart" });
    }
    // Currency follows the Shopify cart; env CURRENCY is only a fallback.
    const CUR = String(currency || process.env.CURRENCY || "usd").toLowerCase();

    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("ui_mode", "embedded"); // classic Embedded Checkout (works on all API versions; "embedded_page" needs API 2026-03-25.dahlia)
    params.append("locale", "en"); // force English UI (avoid region-based fr-CA)
    // Embedded uses return_url only (no success_url/cancel_url). Stripe sends the
    // shopper here after payment; the webhook creates the Shopify order.
    params.append("return_url", (process.env.SUCCESS_URL || "https://example.com/thank-you") + "?session_id={CHECKOUT_SESSION_ID}");
    params.append("billing_address_collection", "auto");
    // Worldwide shipping: every country Stripe supports for shipping addresses.
    // (The 4 sanctioned countries CU/IR/KP/SY are omitted, plus RU.) To restrict
    // where you sell, trim this list (e.g. keep only "CA US GB ...").
    const SHIP_COUNTRIES = ("AC AD AE AF AG AI AL AM AO AQ AR AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CD CF CG CH CI CK CL CM CN CO CR CV CW CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IS IT JE JM JO JP KE KG KH KI KM KN KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MK ML MM MN MO MQ MR MS MT MU MV MW MX MY MZ NA NC NE NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PY QA RE RO RS RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SZ TA TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VN VU WF WS XK YE YT ZA ZM ZW").split(" ");
    SHIP_COUNTRIES.forEach((c, i) => params.append(`shipping_address_collection[allowed_countries][${i}]`, c));

    items.forEach((it, i) => {
      params.append(`line_items[${i}][price_data][currency]`, CUR);
      params.append(`line_items[${i}][price_data][product_data][name]`, String(it.title || "Item").slice(0, 250));
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

    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const data = await r.json();
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
    });

    return res.status(200).json({ clientSecret: data.client_secret });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", detail: String(e.message || e) });
  }
}
